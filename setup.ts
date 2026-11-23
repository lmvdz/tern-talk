#!/usr/bin/env bun
// One command to install Tern Talk on this machine and on any of your machines reachable over SSH.
//   bun setup.ts [-i IDENTITY_FILE] [user@]host ...
// Each host gets bun and omp when missing, this exact package (pushed over SSH, no GitHub login needed),
// `omp install`, and a Windows firewall rule for the Tailscale range. Then every host is checked end to end.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { port, tailnet } from "./net.ts";

const here = dirname(Bun.fileURLToPath(import.meta.url));
const { version } = await Bun.file(join(here, "package.json")).json() as { version: string };
const release = `tern-talk-${version}`;

const args = process.argv.slice(2);
const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
const targets: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "-i" && args[i + 1]) sshOptions.push("-i", args[++i]);
	else if (args[i] === "-h" || args[i] === "--help") {
		console.log("Usage: bun setup.ts [-i IDENTITY_FILE] [user@]host ...\nInstalls Tern Talk here and on each host, then checks that every host answers.");
		process.exit(0);
	} else targets.push(args[i]);
}

type Result = { host: string; target: string; os?: string; ok: boolean; notes: string[] };
const results: Result[] = [];

function log(host: string, text: string) {
	for (const line of text.trimEnd().split(/\r?\n/)) if (line.trim()) console.log(`[${host}] ${line}`);
}

async function exec(command: string[], input?: string, options: { inherit?: boolean } = {}): Promise<{ code: number; out: string }> {
	const child = Bun.spawn(command, {
		stdin: input === undefined ? (options.inherit ? "inherit" : "ignore") : new TextEncoder().encode(input),
		stdout: options.inherit ? "inherit" : "pipe", stderr: options.inherit ? "inherit" : "pipe",
	});
	if (options.inherit) return { code: await child.exited, out: "" };
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, out: out + err };
}

const ssh = (target: string, command: string[], input?: string) => exec(["ssh", ...sshOptions, target, ...command], input);

// Package files, as a tarball in a temp directory.
const staging = await mkdtemp(join(tmpdir(), "tern-talk-"));
const bundle = join(staging, `${release}.tgz`);
const files = (await readdir(here)).filter(name => /\.ts$/.test(name) || ["package.json", "README.md", "THIRD_PARTY_NOTICES"].includes(name));
const packed = await exec(["tar", "-czf", bundle, "-C", here, ...files]);
if (packed.code) throw new Error(`Could not pack ${here}: ${packed.out}`);

const unixInstall = (archive: string) => `set -e
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then echo "installing bun"; curl -fsSL https://bun.sh/install | bash >/dev/null; fi
if ! command -v omp >/dev/null 2>&1; then echo "installing omp"; curl -fsSL https://omp.sh/install | sh; fi
dest="$HOME/.omp/tern-talk-releases/${version}"
rm -rf "$dest"; mkdir -p "$dest"
tar -xzf "${archive}" -C "$dest"; rm -f "${archive}"
omp install "$dest"
command -v tern >/dev/null 2>&1 && echo "tern: $(tern --version)" || echo "TERN_MISSING"
command -v tailscale >/dev/null 2>&1 || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || echo "TAILSCALE_MISSING"
`;

const windowsInstall = (archive: string) => `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:Path = "$HOME\\.bun\\bin;$HOME\\.local\\bin;" + $env:Path
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { 'installing bun'; irm https://bun.sh/install.ps1 | iex | Out-Null; $env:Path = "$HOME\\.bun\\bin;" + $env:Path }
if (-not (Get-Command omp -ErrorAction SilentlyContinue)) { 'installing omp'; irm https://omp.sh/install.ps1 | iex }
$dest = Join-Path $HOME '.omp\\tern-talk-releases\\${version}'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force $dest | Out-Null
tar.exe -xzf '${archive}' -C $dest
Remove-Item -Force '${archive}'
omp install $dest
if ($LASTEXITCODE) { throw "omp install failed" }
if (Get-Command tern -ErrorAction SilentlyContinue) { "tern: $(tern --version)" } else { 'TERN_MISSING' }
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { 'TAILSCALE_MISSING' }
if (-not (Get-NetFirewallRule -DisplayName 'Tern Talk' -ErrorAction SilentlyContinue)) {
  try { New-NetFirewallRule -DisplayName 'Tern Talk' -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null; 'firewall rule added' }
  catch { 'FIREWALL_NEEDS_ADMIN' }
}
`;

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

function interpret(result: Result, out: string, ok: boolean) {
	log(result.host, out);
	result.ok = ok;
	if (out.includes("TERN_MISSING")) result.notes.push("Tern is not installed (run `tern remote setup` to it from a Tern machine)");
	if (out.includes("TAILSCALE_MISSING")) { result.ok = false; result.notes.push("Tailscale CLI not found"); }
	if (out.includes("FIREWALL_NEEDS_ADMIN")) {
		result.notes.push(`firewall: run elevated once: New-NetFirewallRule -DisplayName 'Tern Talk' -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress 100.64.0.0/10 -Action Allow`);
	}
}

async function installLocal(): Promise<Result> {
	const result: Result = { host: "local", target: "local", os: process.platform, ok: false, notes: [] };
	const archive = join(homedir(), `${release}.tgz`);
	await Bun.write(archive, Bun.file(bundle));
	const run = process.platform === "win32"
		? await exec(["powershell", "-NoProfile", "-EncodedCommand", encoded(windowsInstall(archive))])
		: await exec(["sh", "-s"], unixInstall(archive));
	interpret(result, run.out, run.code === 0);
	return result;
}

// First contact: when the host refuses every key, ask for its password once and install this machine's key.
async function authorize(target: string): Promise<void> {
	if ((await ssh(target, ["exit"])).code !== 255 || !process.stdin.isTTY) return;
	const identity = sshOptions.includes("-i") ? [`${sshOptions[sshOptions.indexOf("-i") + 1].replace(/^~/, homedir())}.pub`] : [];
	let key = "";
	for (const path of [...identity, join(homedir(), ".ssh", "id_ed25519.pub"), join(homedir(), ".ssh", "id_rsa.pub")]) {
		if (await Bun.file(path).exists()) { key = (await Bun.file(path).text()).trim(); break; }
	}
	if (!key) {
		const generated = join(homedir(), ".ssh", "id_ed25519");
		await exec(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", generated]);
		key = (await Bun.file(`${generated}.pub`).text()).trim();
	}
	const password = await readSecret(`[${target}] no SSH key accepted. Password for ${target} (asked once, to install this machine's key): `);
	// Hand the password to ssh through SSH_ASKPASS; Windows ssh does not always get a console from a child process.
	const askpass = join(staging, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
	const reader = join(staging, "askpass.ts");
	await Bun.write(reader, "process.stdout.write(`${process.env.TERN_TALK_SSH_PASSWORD}\\n`);\n");
	await Bun.write(askpass, process.platform === "win32" ? `@"${process.execPath}" "${reader}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${reader}"\n`);
	if (process.platform !== "win32") await exec(["chmod", "700", askpass]);
	const child = Bun.spawn(["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "NumberOfPasswordPrompts=1", target,
		`umask 077; mkdir -p ~/.ssh && echo '${key.replace(/'/g, "")}' >> ~/.ssh/authorized_keys`], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0", TERN_TALK_SSH_PASSWORD: password },
	});
	const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	console.log(code ? `[${target}] key install failed: ${error.trim().split("\n").at(-1)}` : `[${target}] key installed`);
}

async function readSecret(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	let secret = "";
	try {
		for await (const chunk of process.stdin) {
			for (const char of String(chunk)) {
				if (char === "\r" || char === "\n") return secret;
				if (char === "\x03") process.exit(130);
				secret = char === "\x7f" || char === "\b" ? secret.slice(0, -1) : secret + char;
			}
		}
		return secret;
	} finally {
		process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stdout.write("\n");
	}
}

async function installRemote(target: string): Promise<Result> {
	const host = target.replace(/^[^@]*@/, "");
	const result: Result = { host, target, ok: false, notes: [] };
	const probe = await ssh(target, ["uname", "-s"]);
	if (probe.code === 255) {
		result.notes.push(`SSH failed: ${probe.out.trim().split("\n").at(-1)}`);
		return result;
	}
	const windows = probe.code !== 0 || !/^(Linux|Darwin)/.test(probe.out.trim());
	result.os = windows ? "windows" : probe.out.trim().toLowerCase();
	const archive = windows ? `${release}.tgz` : `/tmp/${release}.tgz`;
	const copy = await exec(["scp", "-q", ...sshOptions, bundle, `${target}:${archive}`]);
	if (copy.code) {
		result.notes.push(`copy failed: ${copy.out.trim()}`);
		return result;
	}
	const run = windows
		? await ssh(target, ["powershell", "-NoProfile", "-EncodedCommand", encoded(windowsInstall(archive))])
		: await ssh(target, ["sh", "-l", "-s"], unixInstall(archive));
	interpret(result, run.out, run.code === 0);
	return result;
}

// Starts each host's service briefly (it exits after two idle minutes) and checks it from here and back.
async function verify(result: Result, controller: string) {
	if (!result.ok) return;
	if (result.target === "local") {
		spawn(process.execPath, [join(homedir(), ".omp", "tern-talk-releases", version, "daemon.ts")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
	} else if (result.os === "windows") {
		// A plain child would die with the SSH session's job object; WMI starts it outside.
		await ssh(result.target, ["powershell", "-NoProfile", "-EncodedCommand",
			encoded(`$d = Join-Path $HOME '.omp\\tern-talk-releases\\${version}\\daemon.ts'; $b = (Get-Command bun -ErrorAction SilentlyContinue).Source; if (-not $b) { $b = "$HOME\\.bun\\bin\\bun.exe" }; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "\`"$b\`" \`"$d\`"" } | Out-Null`)]);
	} else {
		await ssh(result.target, ["sh", "-l", "-c", `'export PATH="$HOME/.bun/bin:$PATH"; nohup bun "$HOME/.omp/tern-talk-releases/${version}/daemon.ts" >/dev/null 2>&1 &'`]);
	}
	await Bun.sleep(2500);
	const net = await tailnet(true);
	const name = result.target === "local" ? net.self.name : (net.peers.find(peer => peer.name === result.host.toLowerCase() || peer.ip === result.host)?.name ?? result.host);
	result.host = name;
	const node = name === net.self.name ? net.self : net.peers.find(peer => peer.name === name);
	if (!node) {
		result.ok = false;
		result.notes.push("not on this tailnet");
		return;
	}
	try {
		const response = await fetch(`http://${node.ip}:${port}/v1/health`, { signal: AbortSignal.timeout(4000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		result.notes.push(`reachable from ${net.self.name}`);
	} catch (error) {
		result.ok = false;
		result.notes.push(`service not reachable from ${net.self.name}: ${error instanceof Error ? error.message : error}`);
		return;
	}
	if (result.target === "local") return;
	const url = `http://${controller}:${port}/v1/health`;
	const check = result.os === "windows"
		? await ssh(result.target, ["curl.exe", "-fsS", "-m", "4", url])
		: await ssh(result.target, ["curl", "-fsS", "-m", "4", url]);
	if (check.code === 0) result.notes.push(`reaches ${net.self.name}`);
	else {
		result.ok = false;
		result.notes.push(`cannot reach ${net.self.name}: ${check.out.trim()}`);
	}
}

try {
	const self = await tailnet(true).catch(error => { throw new Error(`Tailscale must be running here: ${error.message}`); });
	console.log(`Tern Talk ${version}: setting up ${self.self.name}${targets.length ? ` and ${targets.join(", ")}` : ""}`);
	results.push(await installLocal());
	for (const target of targets) await authorize(target);
	results.push(...await Promise.all(targets.map(installRemote)));
	for (const result of results) {
		if (!result.notes.some(note => note.startsWith("Tern is not installed")) || result.target === "local" || !Bun.which("tern")) continue;
		console.log(`[${result.host}] installing Tern with \`tern remote setup ${result.target}\``);
		if ((await exec(["tern", "remote", "setup", result.target], undefined, { inherit: true })).code === 0) {
			result.notes = result.notes.filter(note => !note.startsWith("Tern is not installed"));
			result.notes.push("Tern installed and attached to this window");
		}
	}
	await Promise.all(results.map(result => verify(result, self.self.ip)));
} finally {
	await rm(staging, { recursive: true, force: true });
}

console.log("");
// Windows often admits Tailscale traffic without a rule; the hint only matters when a check failed.
const allOk = results.every(result => result.ok);
for (const result of results) {
	const notes = allOk ? result.notes.filter(note => !note.startsWith("firewall:")) : result.notes;
	console.log(`${result.ok ? "ok  " : "FAIL"} ${result.host.padEnd(24)} ${notes.join("; ")}`);
}
console.log("\nRestart omp sessions in Tern on each host to load this version. Then type @HOST/ and pick a block.");
process.exit(allOk ? 0 : 1);
