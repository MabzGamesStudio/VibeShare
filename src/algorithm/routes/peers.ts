// Peering with other nodes: answering metadata and discover questions, this
// node's own peer-search job, and picking up new peers (bootstrap).

import type { AlgorithmNode } from '../node.js';
import { type Ctx, HttpError, badRequest, forbidden, readJson } from '../../shared/node/http.js';
import { log } from '../../shared/node/log.js';
import { parseNodeRef } from '../../shared/noderef.js';
import { NodeClient } from '../../shared/nodeclient.js';
import { type PeerDiscoverCriteria, type PeerEntry } from '../../shared/protocol.js';
import { peerLinkFromAlgorithm } from '../../shared/peering.js';
import { baseId } from '../../shared/sources.js';
import { RATINGS, normalizeTag } from '../../shared/taxonomy.js';
import { type Entry } from '../registry.js';
import { sourceKeyOf } from '../sources.js';

/** The peer the caller is, when this node serves it. */
export function requirePeer(node: AlgorithmNode, ctx: Ctx): { ref: string; url: string; id: string } {
  const account = node.auth.require(ctx);
  for (const peer of node.config.peering.peers) {
    if (!peer.serve) continue;
    const ref = parseNodeRef(peer.ref);
    if (ref?.id === account.id) return { ref: peer.ref, url: ref.url, id: ref.id };
  }
  throw forbidden('Not a peer of this node');
}
/** A client talking to one configured peer as this node. */
export function peerClient(node: AlgorithmNode, peer: { ref: string }): NodeClient {
  const ref = parseNodeRef(peer.ref)!;
  return new NodeClient({
    url: ref.url,
    expectedId: ref.id,
    expectedType: ref.type ?? 'algorithm',
    auth: 'identity',
    identity: node.identity,
    transport: () => node.transport(ref.url),
  });
}
/** The peers this node may ask, optionally only one of them. */
export function peersToFetch(node: AlgorithmNode, only?: string): { ref: string }[] {
  return node.config.peering.peers.filter((peer) => peer.fetch && (!only || peer.ref === only));
}
/** What peers see of an entry: more than the public catalog, less than the operator. */
export function peerView(node: AlgorithmNode, entry: Entry): PeerEntry {
  const item = node.registry.view(entry);
  return {
    ...item,
    sources: entry.sources,
    status: entry.status,
    platformStats: entry.platformStats && Object.keys(entry.platformStats).length ? entry.platformStats : undefined,
  };
}
/** Entries matching what a peer asked for, by its criteria. */
export function discover(node: AlgorithmNode, criteria: PeerDiscoverCriteria): PeerEntry[] {
  const filters = criteria.filters ?? {};
  const wantedRating = filters.maxRating ? RATINGS.indexOf(filters.maxRating) : RATINGS.length - 1;
  const formats = filters.formats?.length ? new Set(filters.formats) : null;
  const topics = filters.topics?.length ? new Set(filters.topics.map(normalizeTag)) : null;
  const metrics = criteria.metrics ?? [];
  const wanted = node.registry.all().filter((entry) => {
    if (entry.status === 'blocked') return false;
    if (criteria.platform && sourceKeyOf(entry) !== criteria.platform) return false;
    const has = criteria.has ?? 'any';
    if (has === 'cid' && !entry.contentId) return false;
    if (has === 'link' && !entry.link) return false;
    if (has === 'both' && !(entry.contentId && entry.link)) return false;
    if (formats && !formats.has(entry.format)) return false;
    if (RATINGS.indexOf(entry.rating) > wantedRating) return false;
    if (topics && !entry.topics.some((topic) => topics.has(normalizeTag(topic)))) return false;
    for (const metric of metrics) {
      const value = entry.platformStats?.[metric.key];
      if (value === undefined) return false;
      if (metric.min !== undefined && value < metric.min) return false;
      if (metric.max !== undefined && value > metric.max) return false;
    }
    return true;
  });
  const score = (entry: Entry) => Object.values(entry.platformStats ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const algorithm = criteria.algorithm ?? 'new';
  if (algorithm === 'random') {
    for (let i = wanted.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [wanted[i], wanted[j]] = [wanted[j], wanted[i]];
    }
  } else if (algorithm === 'popular') {
    wanted.sort((a, b) => score(b) - score(a) || b.publishedAt.localeCompare(a.publishedAt));
  } else {
    wanted.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  return wanted
    .slice(0, Math.min(200, Math.max(1, Number(criteria.limit) || 50)))
    .map((entry) => peerView(node, entry));
}
/** Takes a peer's entry into the catalog as pending (the operator decides after). */
export function adoptPeerEntry(node: AlgorithmNode, item: PeerEntry): void {
  const key = baseId(item.id);
  const existing = node.registry.get(key);
  if (!existing) {
    node.registry.upsert({
      id: key,
      status: 'pending',
      origin: 'peer',
      title: item.title,
      description: item.description,
      format: item.format,
      rating: item.rating,
      topics: item.topics,
      language: item.language,
      durationSeconds: item.durationSeconds,
      publishedAt: item.publishedAt,
      pageUrl: item.pageUrl,
      thumbnailUrl: /^https?:/.test(item.thumbnail ?? '') ? item.thumbnail : undefined,
    });
  }
  const entry = node.registry.get(key);
  if (entry && item.platformStats) {
    const stats = entry.platformStats ?? {};
    for (const [name, value] of Object.entries(item.platformStats)) stats[name] = Math.max(stats[name] ?? -1, value);
    entry.platformStats = stats;
    node.registry.changed();
  }
}
/** Requires a peer and turns away one asking more often than the node responds. */
export function respondGate(node: AlgorithmNode, ctx: Ctx): { ref: string; url: string; id: string } {
  const peer = requirePeer(node, ctx);
  const gap = Math.max(0, Math.round(Number(node.config.peering.respondIntervalMs) || 0));
  const now = Date.now();
  const last = node.respondTimes.get(peer.id) ?? 0;
  if (gap && now - last < gap) {
    throw new HttpError(429, 'too_many', `This node answers a peer at most once every ${gap} ms`);
  }
  node.respondTimes.set(peer.id, now);
  return peer;
}
/** One round of the continuous job: ask each peer for discoveries and take them in. */
export async function runPeerSearch(node: AlgorithmNode): Promise<{ peer: string; items: number; adopted: number; error?: string }[]> {
  const job = node.config.peering.job;
  const results: { peer: string; items: number; adopted: number; error?: string }[] = [];
  for (const entry of peersToFetch(node)) {
    const client = peerClient(node, entry);
    const discoverStarted = Date.now();
    try {
      const answer = await client.json<{ items: PeerEntry[] }>('/v1/peers/discover', {
        body: { criteria: { algorithm: 'new', limit: job.limit } },
        timeoutMs: 60_000,
      });
      const items = answer.items ?? [];
      let adopted = 0;
      if (job.adopt) for (const item of items) (adoptPeerEntry(node, item), adopted++);
      results.push({ peer: entry.ref, items: items.length, adopted });
      // One outcome per peer asked (each is its own outgoing call).
      node.traces.trace('dependency', 'algorithm.peers', 'peer discover', {
        message: `${entry.ref.slice(0, 48)} · ${items.length} items · ${adopted} adopted`,
        data: node.traces.summarize({ peer: entry.ref.slice(0, 80), url: `${client.url}/v1/peers/discover`, method: 'POST', ms: Date.now() - discoverStarted, items: items.length, adopted }),
      });
    } catch (error) {
      results.push({ peer: entry.ref, items: 0, adopted: 0, error: (error as Error).message });
      node.traces.trace('error', 'algorithm.peers', 'peer discover', {
        message: entry.ref.slice(0, 48),
        error: (error as Error).message,
        data: node.traces.summarize({ peer: entry.ref.slice(0, 80), url: `${client.url}/v1/peers/discover`, method: 'POST', ms: Date.now() - discoverStarted }),
      });
    }
  }
  // One summary of the round (a peer failing is tolerated — the round goes on).
  node.traces.trace('basic', 'algorithm.peers', 'function:runPeerSearch', {
    message: `${results.length} peers · ${results.reduce((sum, r) => sum + r.items, 0)} items`,
    data: {
      peers: results.length,
      items: results.reduce((sum, r) => sum + r.items, 0),
      adopted: results.reduce((sum, r) => sum + r.adopted, 0),
      failed: results.filter((r) => r.error).length,
    },
  });
  return results;
}
/** Starts (or restarts) the continuous peer-search job at the configured cadence. */
export function startPeering(node: AlgorithmNode): void {
  stopPeering(node);
  // A new node with bootstrap seeds finds its first peers right away.
  if (node.config.peering.bootstrap?.length) {
    void bootstrapPeers(node).catch((error) => {
      log.debug(`Peer bootstrap: ${(error as Error).message}`);
      node.traces.trace('error', 'algorithm.peers', 'function:bootstrapPeers', { error: (error as Error).message });
    });
  }
  const job = node.config.peering.job;
  if (!job.enabled) return;
  const interval = Math.max(5_000, Math.round(Number(job.intervalMs) || 3_600_000));
  node.peeringTimer = setInterval(() => {
    void runPeerSearch(node).catch((error) => {
      log.debug(`Peer-search job: ${(error as Error).message}`);
      node.traces.trace('error', 'algorithm.peers', 'function:runPeerSearch', { error: (error as Error).message });
    });
    // Keep widening the peer set over time (peer exchange), so reach stays broad.
    void bootstrapPeers(node).catch((error) => {
      log.debug(`Peer bootstrap: ${(error as Error).message}`);
      node.traces.trace('error', 'algorithm.peers', 'function:bootstrapPeers', { error: (error as Error).message });
    });
  }, interval);
  node.peeringTimer.unref?.();
}
export function stopPeering(node: AlgorithmNode): void {
  if (node.peeringTimer) clearInterval(node.peeringTimer);
  node.peeringTimer = null;
}
/**
 * Picks up to `count` references spread across key-id space and hosts, so the peer set
 * stays wide and does not cluster around a few nodes.
 */
export function diversify(node: AlgorithmNode, refs: string[], count: number): string[] {
  if (count <= 0) return [];
  const hostOf = (ref: string): string => {
    try {
      return new URL(parseNodeRef(ref)?.url ?? '').host;
    } catch {
      return ref;
    }
  };
  const parsed = refs
    .map((ref) => ({ ref, id: parseNodeRef(ref)?.id ?? '', host: hostOf(ref) }))
    .filter((r) => r.id && r.id !== node.identity?.id);
  const buckets = new Map<string, typeof parsed>();
  for (const r of parsed) {
    const key = r.id.slice(0, 2).toLowerCase();
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  const chosen: string[] = [];
  const perHost = new Map<string, number>();
  const order = [...buckets.keys()];
  for (let round = 0; chosen.length < count; round++) {
    let added = false;
    for (const key of order) {
      const pick = buckets.get(key)![round];
      if (!pick) continue;
      const used = perHost.get(pick.host) ?? 0;
      if (used >= 2) continue; // at most a couple of peers per host keeps it spread out
      perHost.set(pick.host, used + 1);
      chosen.push(pick.ref);
      added = true;
      if (chosen.length >= count) break;
    }
    if (!added) break;
  }
  return chosen;
}
/**
 * Bootstrapping: a new node learns peers from its bootstrap seeds and from the peers it
 * already has (peer exchange), and keeps a wide, unclustered set of them up to `maxPeers`.
 */
export async function bootstrapPeers(node: AlgorithmNode): Promise<string[]> {
  const peering = node.config.peering;
  const max = Math.max(1, peering.maxPeers || 32);
  const room = Math.max(0, max - peering.peers.length);
  if (!room) return [];
  const known = new Set(peering.peers.map((peer) => peer.ref));
  const sources = [...(peering.bootstrap ?? []), ...peering.peers.slice(0, 3).map((peer) => peer.ref)];
  const learned: string[] = [];
  for (const ref of sources) {
    if (learned.length > max * 3) break;
    const before = learned.length;
    const client = peerClient(node, { ref });
    const exchangeStarted = Date.now();
    try {
      const answer = await client.json<{ self?: string; peers?: string[] }>('/v1/peers/peers', { timeoutMs: 15_000 });
      for (const candidate of [answer.self, ...(answer.peers ?? [])]) {
        const ref2 = String(candidate ?? '').trim();
        if (!ref2 || known.has(ref2) || learned.includes(ref2)) continue;
        if (parseNodeRef(ref2)) learned.push(ref2);
      }
      node.traces.trace('dependency', 'algorithm.peers', 'peer exchange', {
        message: `${ref.slice(0, 48)} · ${learned.length - before} learned`,
        data: node.traces.summarize({ peer: ref.slice(0, 80), url: `${client.url}/v1/peers/peers`, method: 'GET', ms: Date.now() - exchangeStarted, learned: learned.length - before }),
      });
    } catch (error) {
      // The seed or peer is offline; try the next one.
      node.traces.trace('error', 'algorithm.peers', 'peer exchange', {
        message: ref.slice(0, 48),
        error: (error as Error).message,
        data: node.traces.summarize({ peer: ref.slice(0, 80), url: `${client.url}/v1/peers/peers`, method: 'GET', ms: Date.now() - exchangeStarted }),
      });
    }
  }
  const chosen = diversify(node, learned, room);
  const added: string[] = [];
  for (const ref of chosen) {
    if (peering.peers.some((peer) => peer.ref === ref)) continue;
    peering.peers.push({ ref, fetch: true, serve: true });
    added.push(ref);
  }
  if (added.length) node.configChanged();
  node.traces.trace('basic', 'algorithm.peers', 'function:bootstrapPeers', {
    message: `${learned.length} learned · ${added.length} peers added`,
    data: { learned: learned.length, added: added.length, peers: peering.peers.length },
  });
  return added;
}
export function registerPeersRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
  const peer = (ctx: Ctx) => respondGate(node, ctx);
    router.get('/v1/peers/peers', () => ({
      self: node.reference(),
      peers: diversify(node, 
        node.config.peering.peers.map((entry) => entry.ref),
        Math.min(16, Math.max(1, node.config.peering.maxPeers || 16))
      ),
    }));

    router.post('/v1/peers/metadata', async (ctx) => {
      peer(ctx);
      const body = await readJson<{ id?: string; link?: string }>(ctx.req);
      const ref = String(body.id ?? body.link ?? '').trim();
      if (!ref) throw badRequest('id or link is required');
      const entry = node.registry.findByRef(ref);
      return { entry: entry ? peerView(node, entry) : null };
    });

    router.post('/v1/peers/discover', async (ctx) => {
      peer(ctx);
      const body = await readJson<{ criteria?: PeerDiscoverCriteria }>(ctx.req);
      return { items: discover(node, body.criteria ?? {}) };
    });

    // A full-catalog push (manual content sync) lands here in bounded batches: content
    // entries with their metadata, topics, creators and groups, and comment chains.
    // The answering cadence is not charged for these (a sync is many batches, not an
    // answer to a question), but the caller must be a peer this node serves, and every
    // batch is strictly validated before anything is stored.
    router.post('/v1/admin/peers/search', async (ctx) => {
      admin(ctx);
      return { results: await runPeerSearch(node) };
    });
    router.post('/v1/admin/peers/job', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ enabled?: boolean; intervalMs?: number; adopt?: boolean; limit?: number; respondIntervalMs?: number }>(ctx.req);
      const peering = node.config.peering;
      if (body.enabled !== undefined) peering.job.enabled = Boolean(body.enabled);
      if (body.intervalMs !== undefined) peering.job.intervalMs = Math.max(5_000, Math.round(Number(body.intervalMs) || 0));
      if (body.adopt !== undefined) peering.job.adopt = Boolean(body.adopt);
      if (body.limit !== undefined) peering.job.limit = Math.max(1, Math.min(200, Math.round(Number(body.limit) || 50)));
      if (body.respondIntervalMs !== undefined) peering.respondIntervalMs = Math.max(0, Math.round(Number(body.respondIntervalMs) || 0));
      node.configChanged();
      startPeering(node);
      return { peering };
    });
    router.post('/v1/admin/peers/bootstrap', async (ctx) => {
      admin(ctx);
      const added = await bootstrapPeers(node);
      return { added, peers: node.config.peering.peers };
    });

    router.get('/v1/admin/peers', (ctx) => {
      admin(ctx);
      return {
        peers: node.config.peering.peers,
        // The same relationships in the vocabulary every node kind shares (src/shared/peering.ts).
        links: node.config.peering.peers.map(peerLinkFromAlgorithm),
        job: node.config.peering.job,
        respondIntervalMs: node.config.peering.respondIntervalMs,
        maxPeers: node.config.peering.maxPeers,
        bootstrap: node.config.peering.bootstrap,
      };
    });
    router.put('/v1/admin/peers', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ peers?: { ref: string; fetch?: boolean; serve?: boolean }[] }>(ctx.req);
      const peers = (body.peers ?? []).slice(0, 100).map((entry) => {
        const ref = parseNodeRef(String(entry.ref ?? ''));
        if (!ref) throw badRequest('Every peer must be a node reference');
        return { ref: String(entry.ref).trim(), fetch: entry.fetch !== false, serve: entry.serve !== false };
      });
      node.configData.peering = { ...node.configData.peering, peers };
      node.configChanged();
      return { peers };
    });
    router.post('/v1/admin/peers/metadata', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ peer?: string; id?: string; link?: string; adopt?: boolean }>(ctx.req);
      const peers = peersToFetch(node, body.peer);
      if (!peers.length) throw badRequest('No peer set to fetch from');
      const ref = String(body.id ?? body.link ?? '').trim();
      if (!ref) throw badRequest('id or link is required');
      const results: { peer: string; entry?: PeerEntry; error?: string }[] = [];
      for (const entry of peers) {
        const client = peerClient(node, entry);
        const metadataStarted = Date.now();
        try {
          const answer = await client.json<{ entry: PeerEntry | null }>('/v1/peers/metadata', {
            body: { id: body.id, link: body.link },
            timeoutMs: 30000,
          });
          if (answer.entry && body.adopt) adoptPeerEntry(node, answer.entry);
          results.push({ peer: entry.ref, entry: answer.entry ?? undefined });
          node.traces.trace('dependency', 'algorithm.peers', 'peer metadata', {
            message: `${entry.ref.slice(0, 48)} · ${answer.entry ? 'found' : 'unknown'}`,
            data: node.traces.summarize({ peer: entry.ref.slice(0, 80), url: `${client.url}/v1/peers/metadata`, method: 'POST', ms: Date.now() - metadataStarted, ref: ref.slice(0, 80), found: Boolean(answer.entry), adopted: Boolean(answer.entry && body.adopt) }),
          });
        } catch (error) {
          results.push({ peer: entry.ref, error: (error as Error).message });
          node.traces.trace('error', 'algorithm.peers', 'peer metadata', {
            message: entry.ref.slice(0, 48),
            error: (error as Error).message,
            data: node.traces.summarize({ peer: entry.ref.slice(0, 80), url: `${client.url}/v1/peers/metadata`, method: 'POST', ms: Date.now() - metadataStarted }),
          });
        }
      }
      return { results };
    });
    router.post('/v1/admin/peers/discover', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ peer?: string; criteria?: PeerDiscoverCriteria; adopt?: boolean }>(ctx.req);
      const peers = peersToFetch(node, body.peer);
      if (!peers.length) throw badRequest('No peer set to fetch from');
      const results: { peer: string; items: PeerEntry[]; error?: string }[] = [];
      for (const entry of peers) {
        const client = peerClient(node, entry);
        const discoverStarted = Date.now();
        try {
          const answer = await client.json<{ items: PeerEntry[] }>('/v1/peers/discover', {
            body: { criteria: body.criteria ?? {} },
            timeoutMs: 60000,
          });
          if (body.adopt) for (const item of answer.items) adoptPeerEntry(node, item);
          results.push({ peer: entry.ref, items: answer.items });
          node.traces.trace('dependency', 'algorithm.peers', 'peer discover', {
            message: `${entry.ref.slice(0, 48)} · ${answer.items.length} items`,
            data: node.traces.summarize({ peer: entry.ref.slice(0, 80), url: `${client.url}/v1/peers/discover`, method: 'POST', ms: Date.now() - discoverStarted, items: answer.items.length, adopted: body.adopt ? answer.items.length : 0 }),
          });
        } catch (error) {
          results.push({ peer: entry.ref, items: [], error: (error as Error).message });
          node.traces.trace('error', 'algorithm.peers', 'peer discover', {
            message: entry.ref.slice(0, 48),
            error: (error as Error).message,
            data: node.traces.summarize({ peer: entry.ref.slice(0, 80), url: `${client.url}/v1/peers/discover`, method: 'POST', ms: Date.now() - discoverStarted }),
          });
        }
      }
      return { results };
    });

    // Manual content sync: one call pushes one bounded batch of this node's full catalog
    // to one node — topics, then creators and groups, then content entries, then the
    // comment chains — and reports per-category progress. The console drives the loop
    // and resumes it: every call names the category and the cursor of the last item it
    // sent, so a retry sends exactly what is still missing.
}

