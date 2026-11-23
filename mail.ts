import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const alias = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const lifetime = 10 * 60_000;
export const relayAlias = "omp-talk";
const root = join(process.env.OMP_TERN_TALK_HOME ?? join(homedir(), ".omp", "tern-talk"), "peers");
const linkHome = process.env.TERN_LINK_HOME ?? (process.platform === "win32"
	? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "tern-link")
	: join(homedir(), ".tern-link"));
const terminalControl = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

export type Peer = { key: string; name: string; pane: string; pid: number; automatic?: true };
export type Message = { v: 1; id: string; from: string; sender: string; to: string; text: string } &
	({ kind: "request"; deadline?: number } | { kind: "discover" | "reply" | "rejected" | "directory" });
export type Delivery = { host?: string; message: Message };

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object") return false;
	const m = value as Message;
	return m.v === 1 && typeof m.id === "string" && id.test(m.id) && typeof m.from === "string" && alias.test(m.from) &&
		typeof m.sender === "string" && id.test(m.sender) && typeof m.text === "string" && !!m.text.trim() && !terminalControl.test(m.text) &&
		typeof m.to === "string" && (m.kind === "request" ? alias.test(m.to) &&
			(m.deadline === undefined || (Number.isSafeInteger(m.deadline) && m.deadline > 0)) :
			m.kind === "discover" ? m.to === relayAlias :
				(m.kind === "reply" || m.kind === "rejected" || m.kind === "directory") && id.test(m.to));
}

export function encode(message: Message): string {
	if (!isMessage(message)) throw new Error("Invalid Tern talk message (empty or containing terminal controls).");
	const body = JSON.stringify(message);
	if (Buffer.byteLength(body) > 4096) throw new Error("Message exceeds tern-link’s 4 KiB limit; shorten the text.");
	return body;
}

export function decode(body: string): Message | undefined {
	if (Buffer.byteLength(body) > 4096) return;
	try {
		const value: unknown = JSON.parse(body);
		if (isMessage(value)) return value;
	} catch { /* Not an omp-talk frame. */ }
}

async function readJson(path: string) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function relayRegistration() {
	return readJson(join(linkHome, "aliases", `${relayAlias}.json`));
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
	// Bun otherwise inherits its startup environment, before relay overrides.
	const child = Bun.spawn([command, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
	const [output, error, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
	if (code !== 0) throw new Error(error.trim() || `${command} exited with status ${code}`);
	return output.trim();
}

export const paneAlias = /^pane-\d+$/;

function blockAlias(value: string | null | undefined): string | undefined {
	const normalized = value?.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+|-+$/g, "").slice(0, 64);
	if (normalized && alias.test(normalized) && !paneAlias.test(normalized)) return normalized;
}

export async function visiblePanes(scope: "local" | "relay" = "local"): Promise<PaneDirectory> {
	type Block = { id: number; live: boolean; exited?: number | null; title?: string; cwd?: string };
	const list = JSON.parse(await run("tern", ["ls", "--json"])) as {
		sessions: { tabs: { name: string | null; blocks: Block[] }[] }[];
	};
	const panes = new Map<string, { name: string; label: string }>();
	for (const { tabs } of list.sessions) {
		for (const tab of tabs) {
			const tabLabel = tab.name?.trim();
			const tabName = blockAlias(tabLabel);
			for (const block of tab.blocks) {
				if (!block.live || block.exited != null) continue;
				const title = block.title?.replace(/^[\s\p{Co}\uFE0F]+/u, "").trim();
				const titleLabel = title && !/^omp$/i.test(title) ? title : undefined;
				// Generated task titles stay local; don't advertise them across hosts.
				const publishedTitle = scope === "local" || (titleLabel && alias.test(titleLabel)) ? titleLabel : undefined;
				const cwdLabel = block.cwd?.split(/[/\\]/).filter(Boolean).at(-1);
				const label = tabLabel || publishedTitle || cwdLabel || "Unnamed omp block";
				const name = tabName ?? blockAlias(publishedTitle) ?? blockAlias(cwdLabel) ?? `pane-${block.id}`;
				panes.set(String(block.id), { name, label });
			}
		}
	}
	return panes;
}

export async function remoteSend(host: string, message: Message): Promise<string> {
	const discovery = message.kind === "discover" || message.kind === "directory";
	return run("tern-link", ["send", "--no-enter", ...(discovery ? ["--ttl", "15"] : []), `${host}/${relayAlias}`, encode(message)]);
}

export async function remoteHosts(): Promise<string[]> {
	const dir = await readJson(join(linkHome, "dir.json"));
	if (!Array.isArray(dir?.hosts)) return [];
	return dir.hosts.flatMap((peer: { name: string; aliases: string[] }) =>
		typeof peer?.name === "string" && alias.test(peer.name) && Array.isArray(peer.aliases) && peer.aliases.includes(relayAlias) ? [peer.name] : []);
}

export async function remoteAvailable(host: string): Promise<boolean> {
	return (await remoteHosts()).includes(host);
}
