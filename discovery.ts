// Process-based agent discovery inspired by Wolfgang Schoenberger's tern-control (MIT).
// https://github.com/wolfiesch/tern-control — see THIRD_PARTY_NOTICES.
import { tern } from "./mail.ts";

const binaries: Record<string, string> = {
	omp: "omp", pi: "Pi", claude: "Claude Code", codex: "Codex",
	opencode: "OpenCode", gemini: "Gemini CLI", amp: "Amp",
	"cursor-agent": "Cursor Agent", kiro: "Kiro", "kiro-cli": "Kiro",
	grok: "Grok", copilot: "Copilot",
};

type Process = { name?: string; argv?: string[] };

function executable(path: string): string {
	return (path.split(/[/\\]/).at(-1) ?? "").toLowerCase().replace(/\.exe$/, "");
}

function agentKind(process?: Process): string | undefined {
	const argv = process?.argv;
	const binary = executable(argv?.[0] || process?.name || "");
	if (Object.hasOwn(binaries, binary)) return binaries[binary];
	if (!argv || !/^(bun|node|deno|tsx)$/.test(binary)) return;
	const script = argv[argv[1] === "run" && binary !== "node" ? 2 : 1]?.replaceAll("\\", "/");
	if (!script) return;
	const named = executable(script); // npm's executable symlinks
	if (Object.hasOwn(binaries, named)) return binaries[named];
	if (/(?:^|\/)@openai\/codex\/bin\/codex\.js$/.test(script)) return "Codex";
	if (/(?:^|\/)@google\/gemini-cli\/bundle\/gemini\.js$/.test(script)) return "Gemini CLI";
	if (/(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/.test(script)) return "Claude Code";
	if (/(?:^|\/)(?:@mariozechner\/pi-coding-agent\/dist|@earendil-works\/pi-coding-agent\/dist\/bundle)\/cli\.js$/.test(script)) return "Pi";
	if (/(?:^|\/)(?:@oh-my-pi\/pi-coding-agent\/dist\/cli\.js|coding-agent\/(?:scripts\/omp\.ts|src\/cli\.ts))$/.test(script)) return "omp";
}

export async function discoverAgents(paneIds: string[]): Promise<{ pane: string; kind: string }[]> {
	if (!paneIds.length) return [];
	// Runs behind the picker's cached directory, so it can wait for slow `tern process` calls (~0.7 s on Windows).
	const signal = AbortSignal.timeout(3_000);
	const pending = paneIds.values();
	const discovered: { pane: string; kind: string }[] = [];
	await Promise.all(Array.from({ length: Math.min(8, paneIds.length) }, async () => {
		for (let next = pending.next(); !next.done && !signal.aborted; next = pending.next()) {
			const pane = next.value;
			try {
				const probe = Bun.spawn([tern, "process", pane, "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal });
				const [output, code] = await Promise.all([probe.stdout.text(), probe.exited]);
				if (code !== 0) continue;
				const process: { foreground?: Process | null; child?: Process | null } = JSON.parse(output);
				const kind = agentKind(process.foreground ?? process.child ?? undefined);
				if (kind) discovered.push({ pane, kind });
			} catch { /* A pane may close before its process can be inspected. */ }
		}
	}));
	return discovered;
}
