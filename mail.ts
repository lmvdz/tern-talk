import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const alias = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const lifetime = 10 * 60_000;
const root = join(process.env.OMP_TERN_TALK_HOME ?? join(homedir(), ".omp", "tern-talk"), "peers");
const terminalControl = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const maxMessage = 60 * 1024;

export type Peer = { key: string; name: string; pane: string; pid: number; automatic?: true };
export type Message = { v: 2; id: string; from: string; sender: string; to: string; text: string } &
	({ kind: "request"; deadline?: number } | { kind: "reply" });
export type Delivery = { host?: string; message: Message };

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object") return false;
	const m = value as Message;
	return m.v === 2 && typeof m.id === "string" && id.test(m.id) && typeof m.from === "string" && alias.test(m.from) &&
		typeof m.sender === "string" && id.test(m.sender) && typeof m.text === "string" && !!m.text.trim() && !terminalControl.test(m.text) &&
		typeof m.to === "string" && (m.kind === "request" ? alias.test(m.to) &&
			(m.deadline === undefined || (Number.isSafeInteger(m.deadline) && m.deadline > 0)) :
			m.kind === "reply" && id.test(m.to));
}

export function encode(message: Message): string {
	if (!isMessage(message)) throw new Error("Invalid Tern talk message (empty or containing terminal controls).");
	const body = JSON.stringify(message);
	if (Buffer.byteLength(body) > maxMessage) throw new Error("Message exceeds Tern talk’s 60 KiB limit; shorten the text.");
	return body;
}

export function decode(body: string): Message | undefined {
	if (Buffer.byteLength(body) > maxMessage) return;
	try {
		const value: unknown = JSON.parse(body);
		if (isMessage(value)) return value;
	} catch { /* Not a Tern talk message. */ }
}

async function readJson(path: string) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function names(path: string): Promise<string[]> {
	try { return await readdir(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return [];
	}
}

export async function register(name: string, pane: string, automatic?: true): Promise<Peer> {
	const peer = { key: randomUUID(), name, pane, pid: process.pid, automatic };
	const dir = join(root, peer.key);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, "peer.tmp");
	await writeFile(temp, JSON.stringify(peer), { mode: 0o600 });
	await rename(temp, join(dir, "peer.json"));
	return peer;
}

export async function unregister(peer: Peer): Promise<void> {
	await rm(join(root, peer.key), { recursive: true, force: true });
}

export async function peerByKey(key: string): Promise<Peer | undefined> {
	if (!id.test(key)) return;
	const peer: Peer | undefined = await readJson(join(root, key, "peer.json"));
	if (!peer || peer.key !== key || !alias.test(peer.name) || !/^\d+$/.test(peer.pane) || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
	try { process.kill(peer.pid, 0); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		throw error;
	}
	return peer;
}

export type PaneDirectory = ReadonlyMap<string, { name: string; label: string }>;
export type PeerAddress = { address: string; name: string; label: string; pane: string };

const noPanes: PaneDirectory = new Map();

export async function livePeers(panes?: PaneDirectory): Promise<Peer[]> {
	const peers = await Promise.all((await names(root)).map(peerByKey));
	return peers.filter((peer): peer is Peer => !!peer && (!panes || panes.has(peer.pane)));
}

export function peerName(peer: Peer, panes: PaneDirectory = noPanes): string {
	return (peer.automatic && panes.get(peer.pane)?.name) || peer.name;
}

export function peersByName(name: string, peers: Peer[], panes: PaneDirectory = noPanes): Peer[] {
	return peers.filter(peer => name === `pane-${peer.pane}` || name === peerName(peer, panes));
}

export function peerAddresses(peers: Peer[], panes: PaneDirectory = noPanes, excludePane?: string): PeerAddress[] {
	const counts = new Map<string, number>();
	const paneCounts = new Map<string, number>();
	const candidates = peers.map(peer => {
		const name = peerName(peer, panes);
		counts.set(name, (counts.get(name) ?? 0) + 1);
		paneCounts.set(peer.pane, (paneCounts.get(peer.pane) ?? 0) + 1);
		const label = (peer.automatic && panes.get(peer.pane)?.label) || (paneAlias.test(name) ? "Unnamed omp block" : name);
		return { name, label, pane: peer.pane };
	});
	return candidates.flatMap(candidate => {
		if (candidate.pane === excludePane) return [];
		if (counts.get(candidate.name) === 1) return [{ ...candidate, address: candidate.name }];
		return paneCounts.get(candidate.pane) === 1 ? [{ ...candidate, address: `pane-${candidate.pane}` }] : [];
	}).sort((a, b) => a.label.localeCompare(b.label) || a.pane.localeCompare(b.pane));
}

export async function enqueue(peer: Peer, delivery: Delivery): Promise<void> {
	encode(delivery.message);
	const path = join(root, peer.key, `${randomUUID()}.msg`);
	const temp = `${path}.tmp`;
	await writeFile(temp, JSON.stringify(delivery), { mode: 0o600 });
	await rename(temp, path);
}

export async function drain(peer: Peer, receive: (delivery: Delivery) => void): Promise<void> {
	const dir = join(root, peer.key);
	for (const file of await names(dir)) {
		if (!file.endsWith(".msg")) continue;
		const path = join(dir, file);
		const delivery = await readJson(path) as Delivery | undefined;
		if (delivery && isMessage(delivery.message)) receive(delivery);
		await rm(path, { force: true });
	}
}

export async function run(command: string, args: string[]): Promise<string> {
	// Pass the current environment explicitly; Bun otherwise uses its startup environment.
	const child = Bun.spawn([command, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
	const [output, error, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
	if (code !== 0) throw new Error(error.trim() || `${command} exited with status ${code}`);
	return output.trim();
}

export const paneAlias = /^pane-\d+$/;

// Returns the last loaded value at once and reloads it in the background once older than maxAge.
// Only the first call, or one after a failure, waits for the load.
export function refreshing<T>(maxAge: number, load: () => Promise<T>): (fresh?: boolean) => Promise<T> {
	let value: Promise<T> | undefined;
	let at = 0;
	let reloading = false;
	return (fresh = false) => {
		if (!value || fresh) {
			const next = load();
			value = next;
			at = Date.now();
			next.catch(() => { if (value === next) value = undefined; });
			return next;
		}
		if (Date.now() - at > maxAge && !reloading) {
			reloading = true;
			// Spawning a process blocks for ~0.1 s on Windows; start the reload after this caller is served.
			setTimeout(() => load().then(loaded => { value = Promise.resolve(loaded); at = Date.now(); }, () => {}).finally(() => { reloading = false; }), 50);
		}
		return value;
	};
}

// The service runs outside Tern panes, where `tern` may not be on PATH (macOS app bundle).
export const tern = process.env.TERN_BIN ?? Bun.which("tern") ??
	["/Applications/Tern.app/Contents/MacOS/tern", "/usr/local/bin/tern"].find(path => existsSync(path)) ?? "tern";

function blockAlias(value: string | null | undefined): string | undefined {
	const normalized = value?.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+|-+$/g, "").slice(0, 64);
	if (normalized && alias.test(normalized) && !paneAlias.test(normalized)) return normalized;
}

export async function visiblePanes(): Promise<PaneDirectory> {
	type Block = { id: number; live: boolean; exited?: number | null; title?: string; cwd?: string };
	const list = JSON.parse(await run(tern, ["ls", "--json"])) as {
		sessions: { tabs: { name: string | null; blocks: Block[] }[] }[];
	};
	const panes = new Map<string, { name: string; label: string; full?: string }>();
	for (const { tabs } of list.sessions) {
		for (const tab of tabs) {
			const tabLabel = tab.name?.trim();
			const tabName = blockAlias(tabLabel);
			for (const block of tab.blocks) {
				if (!block.live || block.exited != null) continue;
				const title = block.title?.replace(/^[\s\p{Co}\uFE0F]+/u, "").trim();
				const titleLabel = title && !/^omp$/i.test(title) ? title : undefined;
				// omp task titles read "CODE: description"; the code is the address.
				const titleCode = titleLabel && /^([A-Za-z0-9][A-Za-z0-9_.-]{0,31}):\s/.exec(titleLabel)?.[1];
				const cwdLabel = block.cwd?.split(/[/\\]/).filter(Boolean).at(-1);
				const label = tabLabel || titleLabel || cwdLabel || "Unnamed omp block";
				const name = tabName ?? blockAlias(titleCode || titleLabel) ?? blockAlias(cwdLabel) ?? `pane-${block.id}`;
				panes.set(String(block.id), { name, label, full: !tabName && titleCode ? blockAlias(titleLabel) : undefined });
			}
		}
	}
	// Two blocks with the same code ("TERN: …") fall back to their full titles before pane IDs.
	const counts = new Map<string, number>();
	for (const { name } of panes.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
	for (const [id, pane] of panes) {
		panes.set(id, { name: (counts.get(pane.name) ?? 0) > 1 && pane.full ? pane.full : pane.name, label: pane.label });
	}
	return panes;
}
