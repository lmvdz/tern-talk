// Plain-English addressing: "tell TERN on lars macbook to check the tests" → "@larss-macbook-pro/TERN check the tests".
// Returns undefined unless the block (and host, when named) resolves to exactly one listening omp block,
// so ordinary prompts such as "tell me about X" stay with the agent.
import type { PeerAddress } from "./mail.ts";
import { remoteAliases, remoteHosts, tailnet, type Node } from "./net.ts";

const verb = /^(?:tell|ask|message|msg|ping|have)\s+/i;
const lead = /^(?:to|that|:|,|-)\s*/i;
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Host words such as "lars macbook" or "linux" match when each word appears in the host's name, label or OS.
function hostMatches(phrase: string[], candidates: Node[]): Node[] {
	return candidates.filter(node => {
		const haystack = squash(`${node.name} ${node.label} ${node.os}`);
		return phrase.every(word => squash(word) && haystack.includes(squash(word)));
	});
}

function pick(name: string, blocks: { address: string; label: string }[]): string | undefined {
	const wanted = name.toLowerCase();
	const found = blocks.filter(block => block.address.toLowerCase() === wanted);
	return found.length === 1 ? found[0].address : undefined;
}

export async function naturalAddress(input: string, local: () => Promise<PeerAddress[]>): Promise<string | undefined> {
	const start = verb.exec(input);
	if (!start) return;
	const words = input.slice(start[0].length).split(/\s+/).filter(Boolean);
	const name = words.shift()?.replace(/^@/, "").replace(/[,:]+$/, "");
	if (!name) return;
	let rest = words;
	let host: string | undefined;
	let namedHere = false;
	if (/^(?:on|at)$/i.test(rest[0] ?? "")) {
		const [net, live] = await Promise.all([tailnet(), remoteHosts()]);
		const candidates = [net.self, ...net.peers.filter(peer => live.includes(peer.name))];
		// Longest host phrase first, leaving at least one word of prompt.
		for (let size = Math.min(4, rest.length - 2); size >= 1 && !host; size--) {
			const matches = hostMatches(rest.slice(1, 1 + size), candidates);
			if (matches.length === 1) {
				host = matches[0].name;
				rest = rest.slice(1 + size);
			}
		}
		if (!host) return;
		if (host === net.self.name) {
			host = undefined;
			namedHere = true;
		} else {
			const target = pick(name, await remoteAliases(host).catch(() => []));
			const text = rest.join(" ").replace(lead, "").trim();
			return target && text ? `@${host}/${target} ${text}` : undefined;
		}
	}
	const text = rest.join(" ").replace(lead, "").trim();
	if (!text) return;
	const here = pick(name, (await local()).map(peer => ({ address: peer.address, label: peer.label })));
	if (here) return `@${here} ${text}`;
	if (namedHere) return;
	// No host named and nothing local: a unique block of that name on another machine.
	const hosts = await remoteHosts();
	const found = (await Promise.all(hosts.map(async remote => {
		const target = pick(name, await remoteAliases(remote).catch(() => []));
		return target ? `@${remote}/${target}` : undefined;
	}))).filter(Boolean);
	return found.length === 1 ? `${found[0]} ${text}` : undefined;
}
