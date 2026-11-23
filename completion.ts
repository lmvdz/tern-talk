import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { discoverAgents } from "./discovery.ts";
import { livePeers, paneAlias, peerAddresses, visiblePanes, type Peer, type PeerAddress } from "./mail.ts";
import { remoteAliases, remoteHosts } from "./net.ts";

const cacheLifetime = 30_000;
const menuWait = 4_000;

function tokenAt(lines: string[], row: number, col: number) {
	if (row !== 0) return;
	const line = lines[row] ?? "";
	const before = line.slice(0, col);
	const talk = /^\s*talk\s+with\s+(@\S*)$/i.exec(before);
	if (talk) return { prefix: talk[1], bare: false };
	// Only a leading @ token can start a conversation. Leave @file in prose alone.
	if (lines.length !== 1 || !/^\s*@(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]*)?)?$/.test(line)) return;
	const bare = /^\s*(@\S*)$/.exec(before);
	if (bare) return { prefix: bare[1], bare: true };
}

async function waitForMenu(result: Promise<string[]>, signal?: AbortSignal): Promise<string[]> {
	const timeout = AbortSignal.timeout(menuWait);
	const done = signal ? AbortSignal.any([timeout, signal]) : timeout;
	if (done.aborted) return [];
	const { promise, resolve } = Promise.withResolvers<string[]>();
	const abort = () => resolve([]);
	done.addEventListener("abort", abort, { once: true });
	try { return await Promise.race([result, promise]); }
	finally { done.removeEventListener("abort", abort); }
}

type Lookup = { expires: number; result: Promise<string[]> };
type LocalDirectory = { peers: PeerAddress[]; visible: { pane: string; name: string; label: string; kind: string }[] };
// The editor passes these rows through to SelectList, which supports disabled items.
type PickerItem = AutocompleteItem & { disabled?: true };

export function addressCompletion(pane: string, currentPeer: () => Peer | undefined) {
	const remote = new Map<string, Lookup>();
	let recent: { expires: number; result: Promise<LocalDirectory> } | undefined;
	const ternItems = new WeakMap<AutocompleteItem, { address: string; name: string } | { command: string }>();

	function local() {
		if (recent && recent.expires > Date.now()) return recent.result;
		const result = visiblePanes().then(async panes => {
			const listeners = await livePeers(panes);
			const registered = new Set(listeners.map(peer => peer.pane));
			registered.add(pane);
			const detected = await discoverAgents([...panes.keys()].filter(id => !registered.has(id)));
			const visible = detected.map(agent => ({ ...agent, ...panes.get(agent.pane)! }))
				.sort((a, b) => a.label.localeCompare(b.label) || a.pane.localeCompare(b.pane));
			return { peers: peerAddresses(listeners, panes, pane), visible };
		}).catch(() => ({ peers: [], visible: [] }));
		recent = { result, expires: Date.now() + 1_000 };
		return result;
	}

	function discover(host: string, signal?: AbortSignal): Promise<string[]> {
		if (!currentPeer() || signal?.aborted) return Promise.resolve([]);
		let lookup = remote.get(host);
		if (!lookup || lookup.expires <= Date.now()) {
			lookup = { expires: Date.now() + cacheLifetime, result: remoteAliases(host).catch(() => []) };
			remote.set(host, lookup);
		}
		return waitForMenu(lookup.result, signal);
	}

	async function suggestions(prefix: string, signal?: AbortSignal) {
		const slash = prefix.indexOf("/");
		const hosts = remoteHosts().catch(() => []);
		const query = prefix.toLowerCase();
		const items: PickerItem[] = [];
		function add(item: AutocompleteItem, address = item.value, name = address) {
			if (!address.toLowerCase().startsWith(query) && !name.toLowerCase().startsWith(query)) return;
			ternItems.set(item, { address, name });
			items.push(item);
		}
		if (slash < 0) {
			const [{ peers, visible }, knownHosts] = await Promise.all([local(), hosts]);
			for (const peer of peers) {
				const name = `@${peer.name}`;
				const address = `@${peer.address}`;
				add({
					value: name === address ? address : `${name} · ${address}`,
					label: `@${peer.label}`,
					description: paneAlias.test(peer.address) ? `Local omp block · pane ${peer.pane}` : "Local omp block",
				}, address, name);
			}
			for (const host of knownHosts.sort()) add({ value: `@${host}/`, label: `@${host}/`, description: "Remote Tern host · browse blocks" });
			for (const agent of visible) {
				if (!`@${agent.name.toLowerCase()}`.startsWith(query) && !`@${agent.kind.toLowerCase()}`.startsWith(query)) continue;
				items.push({
					value: `tern-discovery:${agent.pane}`,
					label: agent.label,
					description: `${agent.kind} · No Tern talk address`,
					disabled: true,
				});
			}
		} else {
			const host = prefix.slice(1, slash).toLowerCase();
			if (!(await hosts).includes(host)) return null;
			for (const name of await discover(host, signal)) {
				const value = `@${host}/${name}`;
				add({ value, label: value, description: "Remote omp block" });
			}
		}
		return items;
	}

	async function getSuggestions(
		token: { prefix: string; bare: boolean },
		canReplaceDraft: boolean,
		getFiles: () => Promise<{ items: AutocompleteItem[]; prefix: string } | null>,
		signal?: AbortSignal,
	) {
		const peer = currentPeer();
		const [matches, paths] = await Promise.all([peer ? suggestions(token.prefix, signal) : undefined, token.bare ? getFiles() : undefined]);
		const items = matches ?? [];
		if (signal?.aborted) return null;
		if (canReplaceDraft && token.prefix === "@" && (!peer || !items.length)) {
			const item = {
				value: "@",
				label: peer ? "No other omp blocks" : "Enable Tern talk",
				description: peer ? "Open another omp block in Tern · Tab for help" : "Tern talk is off in this block · Tab, then Enter to enable",
				descriptionMatch: true,
			};
			ternItems.set(item, { command: peer ? "/tern-talk" : "/tern-talk start" });
			items.push(item);
		}
		if (paths?.items.length) {
			if (!items.length) return paths;
			// Native popup rows are keyed by value. A file and a block may have the same name.
			const keys = new Set(paths.items.map(item => item.value));
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (!keys.has(item.value)) continue;
				const chain = item.value.endsWith("/") ? "/" : "";
				let key = `${item.value} · Tern${chain}`;
				while (keys.has(key)) key = `${key}·${chain}`;
				const distinct = { ...item, value: key };
				const pick = ternItems.get(item);
				if (pick) ternItems.set(distinct, pick);
				items[i] = distinct;
				keys.add(key);
			}
			// Preserve file selection when Tern only has informational rows or a setup action.
			const merged = items.every(item => item.disabled || item.descriptionMatch) ? [...paths.items, ...items] : [...items, ...paths.items];
			return { items: merged, prefix: token.prefix };
		}
		return items.length ? { items, prefix: token.prefix } : null;
	}

	function wrap(base: AutocompleteProvider): AutocompleteProvider {
		return {
			getSuggestions(lines, row, col, signal, onPartial) {
				const token = tokenAt(lines, row, col);
				const getFiles = () => base.getSuggestions(lines, row, col, signal, onPartial);
				return token ? getSuggestions(token, lines.length === 1 && col === lines[0].length, getFiles, signal) : getFiles();
			},
			getForceFileSuggestions: base.getForceFileSuggestions && ((lines, row, col, signal) => {
				const token = tokenAt(lines, row, col);
				const getFiles = () => base.getForceFileSuggestions!(lines, row, col, signal);
				return token ? getSuggestions(token, lines.length === 1 && col === lines[0].length, getFiles, signal) : getFiles();
			}),
			shouldTriggerFileCompletion(lines, row, col) {
				return !!tokenAt(lines, row, col) || (base.shouldTriggerFileCompletion?.(lines, row, col) ?? true);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if ("disabled" in item && item.disabled) return { lines, cursorLine, cursorCol };
				const pick = ternItems.get(item);
				const token = tokenAt(lines, cursorLine, cursorCol);
				if (!pick) {
					// A relative file picked at the start must not be mistaken for a peer address.
					const file = token?.bare && /^@[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)?$/i.test(item.value)
						? { ...item, value: `@./${item.value.slice(1)}` }
						: item;
					return base.applyCompletion(lines, cursorLine, cursorCol, file, prefix);
				}
				if (!token) return { lines, cursorLine, cursorCol };
				if ("command" in pick) {
					if (token.prefix !== "@" || lines.length !== 1 || cursorCol !== lines[0].length) return { lines, cursorLine, cursorCol };
					return { lines: [pick.command], cursorLine: 0, cursorCol: pick.command.length };
				}
				const query = token.prefix.toLowerCase();
				if (!pick.address.toLowerCase().startsWith(query) && !pick.name.toLowerCase().startsWith(query)) return { lines, cursorLine, cursorCol };
				const line = lines[cursorLine];
				const start = cursorCol - token.prefix.length;
				const tail = line.slice(cursorCol).replace(/^\S*/, "");
				const suffix = pick.address.endsWith("/") || tail || lines.length > 1 ? "" : token.bare ? " " : " about ";
				const insert = pick.address + suffix;
				const next = lines.slice();
				next[cursorLine] = line.slice(0, start) + insert + tail;
				return { lines: next, cursorLine, cursorCol: start + insert.length };
			},
			getInlineHint: base.getInlineHint?.bind(base),
			trySyncSlashCompletion: base.trySyncSlashCompletion?.bind(base),
			trySyncModelMentionCompletion: base.trySyncModelMentionCompletion?.bind(base),
			trySyncInlineReplace: base.trySyncInlineReplace?.bind(base),
		};
	}

	return { wrap, clear() {
		remote.clear();
		recent = undefined;
	} };
}
