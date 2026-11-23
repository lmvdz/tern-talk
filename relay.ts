// Launched by /tern-talk relay in a dedicated Tern terminal.
import { randomUUID } from "node:crypto";
import "./relay-env.ts";
import { alias, decode, enqueue, id, lifetime, livePeers, peerAddresses, peerByKey, peersByName, relayAlias, relayRegistration, remoteSend, run, visiblePanes } from "./mail.ts";

const open = "\x1b[200~";
const close = "\x1b[201~";
const header = /^\[tern-link from=[^@\s]+@(\S+) id=(\S+?)(?: · [^\r\n]*)?\]$/;
const pane = process.env.TERN_PANE;
if (!pane || !/^\d+$/.test(pane) || !process.stdin.isTTY || !process.stdout.isTTY) {
	throw new Error("Run /tern-talk relay from an omp block in Tern.");
}
if (await relayRegistration()) throw new Error(`tern-link already has an ${relayAlias} listener. Close the existing relay first.`);

const seen = new Map<string, number>();
const relayKey = randomUUID();

async function receive(frame: string) {
	const lines = frame.split(/\r\n|\r|\n/);
	const match = lines.length === 2 && header.exec(lines[0]);
	if (!match) return;
	const [, host, receipt] = match;
	if (!alias.test(host) || !id.test(receipt) || seen.has(receipt)) return;
	const message = decode(lines[1]);
	if (!message) return;

	// The port records the receipt after writing to the PTY. Allow it to finish.
	let proof = "";
	for (const delay of [100, 250, 500]) {
		await Bun.sleep(delay);
		try { proof = await run("tern-link", ["verify", receipt]); break; }
		catch { /* The unverified paste can never reach a mailbox. */ }
	}
	const at = Date.parse(/^at: (.+)$/m.exec(proof)?.[1] ?? "");
	const now = Date.now();
	if (!proof.split(/\r?\n/).includes(`origin host: ${host}`) || !/^outcome: delivered$/m.test(proof) ||
		!proof.split(/\r?\n/).some(line => line.startsWith("to: ") && line.endsWith(`/${relayAlias} (pane ${pane})`)) ||
		!(at <= now && now - at < lifetime)) return;
	for (const [key, until] of seen) if (until <= now) seen.delete(key);
	seen.set(receipt, at + lifetime);

	const panes = message.kind === "discover" || message.kind === "request"
		? await visiblePanes("relay").catch(() => undefined)
		: undefined;

	if (message.kind === "discover") {
		const names = peerAddresses(await livePeers(), panes).map(peer => peer.address);
		// Aliases are ASCII and comma-free. Reserve space for the fixed envelope.
		const joined = names.join(",");
		const text = joined.length > 3800 ? joined.slice(0, joined.lastIndexOf(",", 3800)) : joined;
		await remoteSend(host, { v: 1, kind: "directory", id: message.id, sender: relayKey,
			from: relayAlias, to: message.sender, text: text || "-" });
		return;
	}

	if (message.kind === "request") {
		const targets = peersByName(message.to, await livePeers(), panes);
		if (targets.length === 1) await enqueue(targets[0], { host, message });
		else await remoteSend(host, { v: 1, kind: "rejected", id: message.id, sender: relayKey, from: message.to, to: message.sender,
			text: targets.length ? "That omp alias is ambiguous on this host." : "No omp session is listening as that alias on this host." });
	} else {
		const peer = await peerByKey(message.to);
		if (peer) await enqueue(peer, { host, message });
	}
}

// Bracketed paste, not individual lines: one transport delivery is one frame.
// Enter after a paste is ignored. Nothing typed here ever reaches a shell.
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004h\x1b]2;omp-talk relay\x07");
function interrupt() { process.stdin.destroy(); }
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
	await run("tern-link", ["listen", relayAlias]);
	console.log(`omp-talk relay listening in pane ${pane}. Ctrl+C to stop.`);
	let buffer = "";
	let receiving = false;
	input: for await (const chunk of process.stdin) {
		buffer += chunk;
		for (;;) {
			if (!receiving) {
				const start = buffer.indexOf(open);
				const interruptAt = buffer.indexOf("\x03");
				if (interruptAt >= 0 && (start < 0 || interruptAt < start)) break input;
				if (start < 0) { buffer = buffer.slice(1 - open.length); break; }
				buffer = buffer.slice(start + open.length);
				receiving = true;
			}
			const end = buffer.indexOf(close);
			if (end < 0) {
				if (buffer.length > 8192) { buffer = ""; receiving = false; }
				break;
			}
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + close.length);
			receiving = false;
			try { if (frame.length <= 8192) await receive(frame); }
			catch (error) { console.error("omp-talk relay:", error); }
		}
	}
} finally {
	process.stdout.write("\x1b[?2004l");
	if (!process.stdin.destroyed) process.stdin.setRawMode(false);
	if ((await relayRegistration())?.pane === pane) await run("tern-link", ["unlisten", relayAlias]);
}
