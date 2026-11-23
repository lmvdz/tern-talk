// This host's Tern talk service. omp sessions start it on demand; it exits once none have listened for a while.
// It binds only the Tailscale address and accepts only this tailnet user's own untagged machines.
import { decode, enqueue, lifetime, livePeers, peerAddresses, peerByKey, peersByName, visiblePanes } from "./mail.ts";
import { port, tailnet, trusted, type Node } from "./net.ts";

const idleExitMs = 2 * 60_000;
const maxBody = 64 * 1024;

const { self } = await tailnet(true);

async function caller(address: string | undefined): Promise<Node | undefined> {
	if (!address) return;
	const ip = address.replace(/^::ffff:/, "");
	if (ip === self.ip) return self;
	for (const fresh of [false, true]) {
		const net = await tailnet(fresh);
		const peer = net.peers.find(peer => peer.ip === ip);
		if (peer) return trusted(net, peer) ? peer : undefined;
	}
}

function fail(status: number, error: string) {
	return Response.json({ error }, { status });
}

const seen = new Map<string, number>();

async function receive(host: string, body: string): Promise<Response> {
	const message = decode(body);
	if (!message) return fail(400, "Invalid Tern talk message.");
	const now = Date.now();
	for (const [key, until] of seen) if (until <= now) seen.delete(key);
	const receipt = `${host}/${message.kind}/${message.id}`;
	if (seen.has(receipt)) return Response.json({ ok: true });
	if (message.kind === "request") {
		const panes = await visiblePanes().catch(() => undefined);
		const targets = peersByName(message.to, await livePeers(), panes);
		if (targets.length !== 1) {
			return fail(404, targets.length ? `@${message.to} is ambiguous on @${self.name}.` : `No omp session is listening as @${message.to} on @${self.name}.`);
		}
		await enqueue(targets[0], { host, message });
	} else {
		const peer = await peerByKey(message.to);
		if (!peer) return fail(404, `The requesting omp session on @${self.name} is no longer listening.`);
		await enqueue(peer, { host, message });
	}
	seen.set(receipt, now + lifetime);
	return Response.json({ ok: true });
}

const server = Bun.serve({
	hostname: self.ip,
	port,
	async fetch(request, srv) {
		const peer = await caller(srv.requestIP(request)?.address).catch(() => undefined);
		if (!peer) return fail(403, "Only your own machines on this tailnet may use Tern talk.");
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/v1/health") return Response.json({ name: self.name, v: 2 });
		if (request.method === "GET" && pathname === "/v1/aliases") {
			const panes = await visiblePanes().catch(() => undefined);
			return Response.json(peerAddresses(await livePeers(), panes).map(({ address, label }) => ({ address, label })));
		}
		if (request.method === "POST" && pathname === "/v1/message") {
			const body = await request.text();
			if (Buffer.byteLength(body) > maxBody) return fail(413, "Message too large.");
			return receive(peer.name, body);
		}
		return fail(404, "Not found.");
	},
});

console.log(`tern-talk: @${self.name} listening on ${self.ip}:${server.port}`);

let lastListener = Date.now();
setInterval(async () => {
	if ((await livePeers().catch(() => [])).length) lastListener = Date.now();
	else if (Date.now() - lastListener > idleExitMs) {
		server.stop();
		process.exit(0);
	}
}, 15_000);
