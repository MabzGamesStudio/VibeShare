// Malicious nodes for developer testing: a provider that lies about its bytes, an
// algorithm node that lies about its comments, and a client that misbehaves. They speak
// just enough of the protocol to connect to honest peers and clients, and every behavior
// here is exactly what the honest side is expected to refuse. Never part of production:
// only `npm run demo --malicious` and the tests start these.
import type { AddressInfo } from 'node:net';
import { blockHash, commentDataHash, commentIdAt, commentSigningPayload, type CommentBlock, type CommentData } from '../shared/comments.js';
import { canonicalJson } from '../shared/encoding.js';
import { generateIdentity, randomToken, signData, type Identity } from '../shared/crypto.js';
import { createHttpServer, readJson, Router, type Ctx } from '../shared/http.js';
import { infoSigningPayload, PROTOCOL_VERSION, SOFTWARE } from '../shared/protocol.js';

/** One signed /v1/info answer, enough for a NodeClient to accept the node. */
function signedInfo(identity: Identity, type: 'provider' | 'algorithm', name: string, url: string) {
  const info = {
    v: PROTOCOL_VERSION,
    type,
    id: identity.id,
    name,
    description: 'Malicious test node — developer testing only',
    software: SOFTWARE,
    time: new Date().toISOString(),
    url,
    signup: { grant: 0, powBits: 0, anonymous: true },
    payments: [],
    peers: [],
  };
  return { info, sig: signData(identity, infoSigningPayload(canonicalJson(info))) };
}

/** Sends `count` requests at once and swallows whatever comes back. */
export async function flood(target: string, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, () => fetch(target).then(() => undefined, () => undefined)));
}

/** A provider node that serves bytes that do not match what they claim to be. */
export interface MaliciousProvider {
  url(): string;
  reference(): string;
  /** How long the delayed route holds a response before answering (0 = at once). */
  setDelay(ms: number): void;
  flood(target: string, count: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startMaliciousProvider(port = 0): Promise<MaliciousProvider> {
  const identity = generateIdentity();
  const router = new Router();
  let delayMs = 60_000;
  let base = '';
  router.get('/v1/info', () => signedInfo(identity, 'provider', 'Malicious provider', base));
  // A “session”, in name only — honest clients always negotiate one before paying for
  // what they fetch, even here.
  const session = () => ({ token: randomToken(16), accountId: 'evil', expiresAt: new Date(Date.now() + 3600_000).toISOString(), balance: 0 });
  router.post('/v1/auth/session', session);
  router.post('/v1/auth/anonymous', session);
  // Data that does not match the content id hash: the honest client must refuse it.
  router.get('/v1/content/:cid', (ctx) => ({
    v: 1,
    name: 'not this content',
    chunkSize: 1024,
    chunks: [],
    createdAt: new Date().toISOString(),
    cidAsked: ctx.params.cid,
  }));
  router.get('/v1/chunks/:id', () => Buffer.from('these bytes hash to something else entirely'));
  // A vvsh object that is not what its hash names — one wrong chunk in a stream's clothing.
  router.get('/v1/vvsh/objects/:hash', () => Buffer.from('a vvsh chunk that does not match its hash'));
  // A response held back far past any client's patience.
  router.get('/v1/slow', async (ctx: Ctx) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    ctx.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ slow: true }));
    return undefined;
  });
  const server = createHttpServer({ router, cors: true, name: 'malicious-provider' });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: () => base,
    reference: () => `vs:provider:${identity.id}@${base}`,
    setDelay: (ms: number) => {
      delayMs = ms;
    },
    flood: (target, count) => flood(target, count),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export type CommentAttack = 'none' | 'tamper' | 'delete' | 'badsig';

/** An algorithm node whose comment chain is a lie: tampered, cut, or badly signed. */
export interface MaliciousAlgorithm {
  url(): string;
  reference(): string;
  /** The comment chain this node serves, attacked in the chosen way. */
  setComments(blocks: CommentBlock[], attack: CommentAttack): void;
  flood(target: string, count: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startMaliciousAlgorithm(port = 0): Promise<MaliciousAlgorithm> {
  const identity = generateIdentity();
  const router = new Router();
  let blocks: CommentBlock[] = [];
  let attack: CommentAttack = 'none';
  let base = '';
  const attacked = (): CommentBlock[] => {
    const out = blocks.map((block) => JSON.parse(JSON.stringify(block)) as CommentBlock);
    if (attack === 'tamper' && out[1]?.data) out[1].data = { ...out[1].data, text: 'Two lies' };
    if (attack === 'delete' && out.length > 2) out.splice(1, 1);
    if (attack === 'badsig' && out[0]?.data?.key) out[0].data = { ...out[0].data, sig: randomToken(64) };
    return out;
  };
  router.get('/v1/info', () => signedInfo(identity, 'algorithm', 'Malicious algorithm', base));
  // A “session”, in name only — honest clients always negotiate one before paying for
  // what they fetch, even here.
  const session = () => ({ token: randomToken(16), accountId: 'evil', expiresAt: new Date(Date.now() + 3600_000).toISOString(), balance: 0 });
  router.post('/v1/auth/session', session);
  router.post('/v1/auth/anonymous', session);
  router.get('/v1/comments/:content', () => ({ blocks: attacked(), votes: {} }));
  router.post('/v1/comments/:content', async (ctx: Ctx) => {
    const body = await readJson<{ text?: string }>(ctx.req);
    const text = String(body.text ?? '');
    const data: CommentData = { id: commentIdAt('root', blocks.at(-1)?.hash ?? '', text), text, time: new Date().toISOString(), replyFrom: 'root' };
    const prev = blocks.at(-1)?.hash ?? '';
    const dataHash = commentDataHash(data);
    const block: CommentBlock = { prev, dataHash, hash: blockHash(prev, dataHash, data.id), id: data.id, data };
    blocks = [...blocks, block];
    return block;
  });
  const server = createHttpServer({ router, cors: true, name: 'malicious-algorithm' });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: () => base,
    reference: () => `vs:algorithm:${identity.id}@${base}`,
    setComments: (next, mode) => {
      blocks = next;
      attack = mode;
    },
    flood: (target, count) => flood(target, count),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** A client that misbehaves: comments it cannot sign, and floods of requests. */
export interface MaliciousClient {
  identity: Identity;
  /** Posts a comment whose signature is not by the key it names. */
  commentWithBadSignature(algorithmUrl: string, contentId: string): Promise<number>;
  flood(target: string, count: number): Promise<void>;
}

export function startMaliciousClient(): MaliciousClient {
  const identity = generateIdentity();
  return {
    identity,
    async commentWithBadSignature(algorithmUrl, contentId) {
      const answer = await fetch(`${algorithmUrl}/v1/comments/${encodeURIComponent(contentId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'signed by nobody', key: identity.id, sig: randomToken(64) }),
      });
      return answer.status;
    },
    flood: (target, count) => flood(target, count),
  };
}

/** The whole malicious bundle: provider, algorithm and client, for `demo --malicious`. */
export interface MaliciousNetwork {
  provider: MaliciousProvider;
  algorithm: MaliciousAlgorithm;
  client: MaliciousClient;
  stop(): Promise<void>;
}

export async function startMaliciousNetwork(): Promise<MaliciousNetwork> {
  const [provider, algorithm] = await Promise.all([startMaliciousProvider(), startMaliciousAlgorithm()]);
  const client = startMaliciousClient();
  return {
    provider,
    algorithm,
    client,
    stop: async () => {
      await provider.stop();
      await algorithm.stop();
    },
  };
}

/** A comment chain that verifies as it stands — the attacks take it apart from there. */
export function sampleCommentChain(): CommentBlock[] {
  const identity = generateIdentity();
  const blocks: CommentBlock[] = [];
  let prev = '';
  for (const text of ['one', 'two', 'three']) {
    const data: CommentData = {
      id: commentIdAt('root', prev, text, identity.id),
      text,
      key: identity.id,
      sig: signData(identity, commentSigningPayload({ key: identity.id, replyFrom: 'root', text })),
      time: new Date().toISOString(),
      replyFrom: 'root',
    };
    const dataHash = commentDataHash(data);
    blocks.push({ prev, dataHash, hash: blockHash(prev, dataHash, data.id), id: data.id, data });
    prev = blocks.at(-1)!.hash;
  }
  return blocks;
}

/** Keeps the demo lively: every round a flood at each honest node. */
export function startMaliciousLoops(network: MaliciousNetwork, honest: { providerUrl: string; algorithmUrl: string }): () => void {
  const timer = setInterval(() => {
    void network.provider.flood(`${honest.providerUrl}/v1/has`, 20);
    void network.algorithm.flood(`${honest.algorithmUrl}/v1/peers/peers`, 20);
    void network.client.flood(`${honest.providerUrl}/v1/info`, 20);
  }, 30_000);
  return () => clearInterval(timer);
}