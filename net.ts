// Cross-host transport: one small HTTP service per host, reachable only on its Tailscale address.
// The sender's host name comes from the tailnet (WireGuard source address), never from the message.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { alias, encode, refreshing, type Message } from "./mail.ts";

export const port = Number(process.env.TERN_TALK_PORT) || 7470;

export type Node = { name: string; ip: string; user: number; tagged: boolean; online: boolean; os: string };
export type Tailnet = { self: Node; peers: Node[] };

function tailscaleBinary(): string {
	if (process.env.TAILSCALE_BIN) return process.env.TAILSCALE_BIN;
	const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	return process.platform === "darwin" && !Bun.which("tailscale") && existsSync(mac) ? mac : "tailscale";
}

type StatusNode = { DNSName?: string; HostName?: string; TailscaleIPs?: string[]; UserID?: number; Tags?: string[] | null; Online?: boolean; OS?: string };

function node(status: StatusNode): Node | undefined {
	const name = (status.DNSName?.split(".")[0] || status.HostName || "").toLowerCase();
	const ip = status.TailscaleIPs?.find(address => address.includes("."));
	if (!alias.test(name) || !ip || typeof status.UserID !== "number") return;
	return { name, ip, user: status.UserID, tagged: !!status.Tags?.length, online: !!status.Online, os: status.OS ?? "" };
}

// `tailscale status` takes about a second on Windows; callers get the last result while it reloads.
export const tailnet = refreshing(10_000, async (): Promise<Tailnet> => {
	const child = Bun.spawn([tailscaleBinary(), "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
	const [output, error, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
	if (code !== 0) throw new Error(`tailscale status failed: ${error.trim() || `exit ${code}`}`);
	const status = JSON.parse(output) as { Self?: StatusNode; Peer?: Record<string, StatusNode> };
	const self = status.Self && node(status.Self);
	if (!self) throw new Error("Tailscale is not connected on this host.");
	const peers = Object.values(status.Peer ?? {}).flatMap(peer => node(peer) ?? []);
	return { self, peers };
});

// Only this tailnet user's own, untagged machines may talk to each other.
export function trusted(net: Tailnet, candidate: Node): boolean {
	return candidate.user === net.self.user && !candidate.tagged && !net.self.tagged;
}

async function hostNode(host: string): Promise<Node> {
	const net = await tailnet();
	if (host === net.self.name) return net.self;
	const peer = net.peers.find(peer => peer.name === host) ?? (await tailnet(true)).peers.find(peer => peer.name === host);
	if (!peer || !trusted(net, peer)) throw new Error(`@${host} is not one of your machines on this tailnet.`);
	if (!peer.online) throw new Error(`@${host} is offline in Tailscale.`);
	return peer;
}

async function call(host: string, path: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
	const target = await hostNode(host);
	try {
		return await fetch(`http://${target.ip}:${port}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(init.timeout ?? 5000) });
	} catch {
		throw new Error(`No Tern talk service answered on @${host}. An omp session must be running in Tern there; run setup.ts for that host if it has none.`);
	}
}

// Delivers a request or reply. The receiving service rejects unknown aliases immediately.
export async function remoteSend(host: string, message: Message): Promise<void> {
	const response = await call(host, "/v1/message", { method: "POST", body: encode(message), headers: { "content-type": "application/json" } });
	if (response.ok) return;
	const detail = await response.json().catch(() => undefined) as { error?: string } | undefined;
	throw new Error(detail?.error ?? `@${host} refused the message (HTTP ${response.status}).`);
}

export type RemoteBlock = { address: string; label: string };

export async function remoteAliases(host: string, signal?: AbortSignal): Promise<RemoteBlock[]> {
	const response = await call(host, "/v1/aliases", { signal });
	if (!response.ok) return [];
	const blocks = await response.json().catch(() => []) as unknown;
	return Array.isArray(blocks) ? blocks.filter((block): block is RemoteBlock =>
		typeof block?.address === "string" && alias.test(block.address) && typeof block.label === "string") : [];
}

// Online machines of this user that answer as Tern talk hosts, this one excluded.
export const remoteHosts = refreshing(30_000, async (): Promise<string[]> => {
	const net = await tailnet();
	const candidates = net.peers.filter(peer => peer.online && trusted(net, peer));
	const live = await Promise.all(candidates.map(async peer => {
		try {
			const response = await fetch(`http://${peer.ip}:${port}/v1/health`, { signal: AbortSignal.timeout(1200) });
			return response.ok ? peer.name : undefined;
		} catch { return undefined; }
	}));
	return live.filter((name): name is string => !!name);
});

function bunBinary(): string {
	const home = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
	return Bun.which("bun") ?? (existsSync(home) ? home : "bun");
}

// Starts this host's service unless it already answers. A second concurrent start loses the port and exits.
export async function ensureService(): Promise<void> {
	const { self } = await tailnet();
	try {
		const response = await fetch(`http://${self.ip}:${port}/v1/health`, { signal: AbortSignal.timeout(800) });
		if (response.ok) return;
	} catch { /* Not running. */ }
	const child = spawn(bunBinary(), [fileURLToPath(new URL("./daemon.ts", import.meta.url))], {
		detached: true, stdio: "ignore", windowsHide: true, env: process.env,
	});
	child.unref();
}
