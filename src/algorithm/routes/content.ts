// The content surface: feed, search, lookup, seen-content filters, thumbnails,
// submissions and platform-metric claims, plus importing a provider's catalog.

import type { AlgorithmNode } from '../node.js';
import { type Account } from '../../node/ledger.js';
import { isKeyId, randomId, verifySignature } from '../../shared/crypto.js';
import { contentIdOf, validateManifest } from '../../shared/content.js';
import { type Ctx, HttpError, badRequest, forbidden, immutableHeaders, notFound, notModified, readJson, requestJson } from '../../shared/node/http.js';
import { log } from '../../shared/node/log.js';
import { parseNodeRef } from '../../shared/noderef.js';
import { type ClaimRequest, type ClaimResponse, type ContentItem, type FeedRequest, PAGE_LIMITS, type Page, SUGGESTION_KINDS, type SearchRequest, type SubmissionRequest, claimSigningPayload, pageLimit } from '../../shared/protocol.js';
import { baseId } from '../../shared/sources.js';
import { type CreatorKind, FORMATS, type Format, RATINGS } from '../../shared/taxonomy.js';
import { rank } from '../ranking.js';
import { claimMultiplier, claimRuleFor } from '../metrics.js';
import { cleanData, type Entry, identityOf } from '../registry.js';
import { SOURCE_CATALOG, sourceKeyOf } from '../sources.js';
import { nativeSuggestions, pageOf, slug } from '../support.js';
import { type Submission } from '../contributions.js';

/**
 * A client reports the popularity numbers it saw for the content on its platform
 * (views, likes, comments, subscribers, upvotes…). Only numbers the node did not have
 * yet count as new information, and only those pay: `base × multiplier`, where the
 * multiplier sums one weight per enabled metric of the source and is then multiplied
 * by the recency factor (exponential decay to 1×). The multiplier is never below 1.
 */
export function claim(node: AlgorithmNode, ctx: Ctx, account: Account, body: ClaimRequest): ClaimResponse {
  const trimmed = String(body.id ?? '').trim();
  if (!trimmed) throw badRequest('id is required');
  const raw = body.metrics;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('metrics is required');
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 16)) {
    const name = key.trim().slice(0, 32);
    const number = Number(value);
    if (!name || !Number.isFinite(number) || number < 0) throw badRequest(`metrics.${key} must be a positive number`);
    metrics[name] = Math.min(number, 1e15);
  }
  if (!Object.keys(metrics).length) throw badRequest('metrics is required');
  let publishedAt: string | undefined;
  if (body.publishedAt !== undefined && body.publishedAt !== null && body.publishedAt !== '') {
    const time = Date.parse(String(body.publishedAt));
    if (!Number.isFinite(time)) throw badRequest('publishedAt must be a date like 2024-05-01');
    if (time > Date.now() + 86_400_000) throw badRequest('publishedAt cannot be in the future');
    publishedAt = new Date(time).toISOString();
  }
  const { key, contentId, link } = identityOf({ id: trimmed });
  let entry = node.registry.findByRef(trimmed);
  const known = Boolean(entry);
  if (!entry) {
    // The node learns of the content itself: kept for review, like a report.
    entry = node.registry.upsert({ id: key, contentId, link, status: 'pending', origin: 'report' });
  }
  // New information: a number higher than any the node kept for this content.
  const stats = (entry.platformStats ??= {});
  const updated: string[] = [];
  for (const [name, value] of Object.entries(metrics)) {
    if (value > (stats[name] ?? -1)) {
      stats[name] = value;
      updated.push(name);
    }
  }
  const newInfo = updated.length > 0;
  let credited = 0;
  let multiplier = 1;
  // The platform these numbers come from, however the client named it.
  const source = body.source ? String(body.source).slice(0, 32) : sourceKeyOf({ id: entry.id, adapter: entry.adapter });
  if (newInfo) {
    multiplier = claimMultiplier(claimRuleFor(node.config.claims, source), metrics, publishedAt ?? entry.publishedAt, undefined, node.traces).multiplier;
    const claims = node.config.claims;
    if (claims.base > 0 && node.canEarn(account) && node.ledger.daily(account, 'claims') < claims.dailyCap) {
      node.ledger.addDaily(account, 'claims', 1);
      credited = Math.max(1, Math.round(claims.base * multiplier));
      const updatedAccount = node.ledger.credit(account.id, credited, 'claim', entry.id);
      ctx.res.setHeader('x-vs-balance', String(updatedAccount.balance));
    }
    if (publishedAt && entry.origin === 'report') entry.publishedAt = publishedAt;
    entry.updatedAt = new Date().toISOString();
    node.registry.changed();
  }
  // What came of the platform metrics this client reported (one event per claim).
  node.traces.trace('dependency', 'algorithm.metrics', 'function:claim', {
    message: `${source.slice(0, 24)} · ${newInfo ? `${updated.length} new` : 'nothing new'}`,
    data: {
      platform: source.slice(0, 32),
      ok: newInfo,
      updated: updated.length,
      credited,
      multiplier: Math.round(multiplier * 100) / 100,
      account: account.id.slice(0, 16),
    },
  });
  return { known, newInfo, credited, multiplier, updated };
}
export function submit(node: AlgorithmNode, account: Account, body: SubmissionRequest): Submission {
  const identity = identityOf({ id: body.id, link: body.link });
  const full = String(body.id ?? body.link ?? identity.key);
  if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('A title is required');
  const existing = node.registry.get(identity.key);
  if (existing?.status === 'listed') throw new HttpError(409, 'already_listed', 'This content is already listed');
  if (existing?.status === 'blocked') throw forbidden('This content is blocked on this node');
  const pending = Object.values(node.contributions.data.submissions).find(
    (s) => baseId(s.contentId) === identity.key && s.status === 'pending'
  );
  if (pending) throw new HttpError(409, 'already_submitted', 'This content is already waiting for review');
  if (body.format !== undefined && !FORMATS.includes(body.format)) throw badRequest('Unknown format');
  if (body.rating !== undefined && !RATINGS.includes(body.rating)) throw badRequest('Unknown rating');
  let verifiedCreator: string | undefined;
  const proof = body.creatorProof;
  if (proof) {
    if (!isKeyId(proof.key) || Math.abs(Date.now() - Number(proof.ts)) > 15 * 60_000) throw badRequest('Bad or stale creatorProof');
    if (!verifySignature(proof.key, claimSigningPayload(node.identity.id, identity.key, Number(proof.ts)), String(proof.sig))) {
      throw badRequest('creatorProof signature does not match');
    }
    verifiedCreator = proof.key;
  }
  if (node.config.pricing.submission > 0) node.ledger.debit(account.id, node.config.pricing.submission, 'submission', identity.key);
  const { thumbnail, creatorProof: _proof, ...request } = body;
  if (thumbnail) node.registry.setThumbnail(identity.key, thumbnail);
  const submission: Submission = {
    id: randomId('sub-', 8),
    contentId: full,
    accountId: account.id,
    request: {
      ...request,
      providers: (request.providers ?? []).filter((ref) => parseNodeRef(ref)).slice(0, 8),
      topics: [...new Set([...(request.topics ?? []), ...(request.tags ?? [])])].slice(0, 16),
    },
    verifiedCreator,
    hasThumbnail: Boolean(thumbnail),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  node.contributions.data.submissions[submission.id] = submission;
  node.contributions.changed();
  if (node.config.policy.autoListSubmissions) acceptSubmission(node, submission, {});
  node.traces.trace('basic', 'algorithm.submissions', 'function:submit', {
    message: `${submission.id} · ${identity.key.slice(0, 24)} · ${submission.status}`,
    data: {
      id: submission.id,
      content: identity.key.slice(0, 32),
      account: account.id.slice(0, 16),
      thumbnail: submission.hasThumbnail,
      verifiedCreator: Boolean(verifiedCreator),
      status: submission.status,
    },
  });
  return submission;
}
export function acceptSubmission(node: AlgorithmNode, submission: Submission, overrides: Partial<Entry> & { creatorName?: string; creatorKind?: CreatorKind }): Entry {
  const request = submission.request;
  let creatorId: string | undefined;
  const name = overrides.creatorName ?? request.creator?.name;
  const kind = overrides.creatorKind ?? request.creator?.kind ?? 'unknown';
  if (submission.verifiedCreator) {
    creatorId = submission.verifiedCreator;
    const known = node.registry.creator(creatorId);
    node.registry.upsertCreator({ id: creatorId, name: known?.name ?? name ?? creatorId.slice(0, 12), kind: known?.kind ?? kind, keys: [creatorId] });
  } else if (name) {
    creatorId = `name:${slug(name)}`;
    if (!node.registry.creator(creatorId)) node.registry.upsertCreator({ id: creatorId, name, kind });
  }
  const entry = node.registry.upsert({
    id: submission.contentId,
    link: request.link,
    status: 'listed',
    title: request.title,
    description: request.description,
    format: request.format ?? 'other',
    rating: request.rating ?? 'all',
    topics: [...new Set([...(request.topics ?? []), ...(request.tags ?? [])])],
    language: request.language,
    durationSeconds: request.durationSeconds,
    gallery: (request.gallery ?? []).slice(0, 64).map((url) => ({ url, type: 'image' as const })),
    providers: request.providers,
    publishedAt: request.publishedAt,
    thumbnail: submission.hasThumbnail || undefined,
    data: cleanData(submission.request.data),
    creatorId,
    origin: 'submission',
    ...overrides,
  });
  submission.status = 'accepted';
  submission.reviewedAt = new Date().toISOString();
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.submissions', 'function:acceptSubmission', {
    message: `${submission.id} accepted → ${entry.id.slice(0, 24)}`,
    data: { id: submission.id, content: entry.id.slice(0, 32), creator: creatorId?.slice(0, 32), account: submission.accountId.slice(0, 16) },
  });
  return entry;
}
/**
 * Reads a provider's catalog and queues what it hosts for review. Nothing is
 * listed until the operator accepts it: the node decides what it shows.
 */
export async function importCatalog(node: AlgorithmNode, provider: string, limit: number): Promise<{ queued: number; skipped: number }> {
  const ref = parseNodeRef(provider);
  if (!ref) throw badRequest('provider must be a node reference or URL');
  let queued = 0;
  let skipped = 0;
  let offset = 0;
  while (queued + skipped < limit) {
    const catalogUrl = `${ref.url}/v1/catalog?offset=${offset}&limit=100`;
    const catalogStarted = Date.now();
    const page = await requestJson<{
      items: { cid: string; name: string; createdAt: string; meta?: SubmissionRequest; sources?: string[]; creator?: { id: string; name?: string; kind?: CreatorKind } }[];
      next?: number;
    }>(catalogUrl, { transport: node.transport(ref.url) });
    node.traces.trace('dependency', 'algorithm.import', 'provider catalog', {
      message: `${ref.url.slice(0, 40)} · ${page.items.length} items`,
      data: node.traces.summarize({ provider: ref.url.slice(0, 80), url: catalogUrl, method: 'GET', ms: Date.now() - catalogStarted, offset, items: page.items.length }),
    });
    for (const item of page.items) {
      const id = [item.cid, ...(item.sources ?? [])].join('~');
      const known = node.registry.get(item.cid);
      const pending = Object.values(node.contributions.data.submissions).some((s) => s.contentId.split('~')[0] === item.cid);
      if (known || pending) {
        skipped++;
        continue;
      }
      const meta = item.meta ?? ({} as Partial<SubmissionRequest>);
      const verifiedCreator = item.creator ? await verifyCreator(node, ref.url, item.cid) : undefined;
      const submission: Submission = {
        id: randomId('sub-', 8),
        contentId: id,
        accountId: 'import',
        request: {
          id,
          title: meta.title ?? item.name,
          description: meta.description,
          format: meta.format,
          rating: meta.rating,
          topics: [...new Set([...(meta.topics ?? []), ...(((meta.tags as string[] | undefined) ?? []))])],
          language: meta.language,
          durationSeconds: meta.durationSeconds,
          creator: item.creator ? { name: item.creator.name, kind: item.creator.kind } : undefined,
          providers: [provider],
          publishedAt: item.createdAt,
        },
        verifiedCreator,
        hasThumbnail: false,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      node.contributions.data.submissions[submission.id] = submission;
      queued++;
    }
    if (page.next === undefined || !page.items.length) break;
    offset = page.next;
  }
  node.contributions.changed();
  log.info(`Queued ${queued} items from ${ref.url} for review`);
  node.traces.trace('basic', 'algorithm.import', 'function:importCatalog', {
    message: `${queued} queued · ${skipped} skipped`,
    data: { provider: ref.url.slice(0, 80), queued, skipped },
  });
  return { queued, skipped };
}
/** Fetches the manifest and checks its creator signature here, rather than trusting the provider. */
export async function verifyCreator(node: AlgorithmNode, providerUrl: string, cid: string): Promise<string | undefined> {
  try {
    const manifest = validateManifest(await requestJson(`${providerUrl}/v1/content/${cid}`, { transport: node.transport(providerUrl) }));
    return contentIdOf(manifest) === cid ? manifest.creator?.id : undefined;
  } catch (error) {
    // The manifest check is swallowed into "no verified creator"; the import goes on.
    node.traces.trace('error', 'algorithm.import', 'function:verifyCreator', {
      message: `${cid.slice(0, 24)} unverifiable`,
      error: (error as Error).message,
      data: { cid: cid.slice(0, 32), provider: providerUrl.slice(0, 80) },
    });
    return undefined;
  }
}
/**
 * The images medium's rule, kept on this side too: a VibeShare-native picture leads
 * the medium, seen or not. The client applies the same rule to the page when it
 * arrives — but it can only exempt what the node still returns, so when the request
 * asks for the image medium the seen filters must keep their hands off the native
 * pictures and lists here, or the reader who has seen them once never sees them
 * recommended again (exactly what the operator reported).
 */
function leadsImagesMedium(formats: Format[] | undefined, entry: Entry): boolean {
  return Boolean(formats?.includes('image')) && entry.id.startsWith('vs1') && (entry.format === 'image' || entry.format === 'image-list');
}

export function registerContentRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
  const data = () => node.contributions.data;
    router.get('/v1/taxonomy', () => ({
      formats: FORMATS,
      ratings: RATINGS,
      topics: node.config.topics,
      suggestionKinds: SUGGESTION_KINDS,
      platforms: SOURCE_CATALOG,
    }));

    router.post('/v1/feed', async (ctx) => {
      const body = await readJson<FeedRequest>(ctx.req);
      node.charge(ctx, node.config.pricing.feed, 'feed');
      const seen = node.seenFilters(ctx, body);
      const preferences = node.preferencesOf(body.preferences);
      const ranked = await rank(node.registry.visible(preferences, node.config.policy.maxRating), {
        preferences,
        seed: String(body.seed ?? new Date().toISOString().slice(0, 13)),
        now: Date.now(),
        config: node.config.ranking,
        trace: node.traces,
      });
      // An explore page is always led by a few VibeShare-published pieces, even ones the
      // reader has seen before; in the images medium EVERY native picture and list leads
      // it, seen or not (see leadsImagesMedium). Everything else respects the seen filters.
      const first = nativeSuggestions(ranked, preferences.formats);
      const rest = ranked.filter((entry) => !first.includes(entry));
      const leads = rest.filter((entry) => leadsImagesMedium(preferences.formats, entry));
      const page = pageOf(
        node.bySource([...first, ...leads, ...node.withoutSeen(rest.filter((entry) => !leadsImagesMedium(preferences.formats, entry)), seen)]),
        body.cursor,
        pageLimit('feed', body.limit, node.config.pageSize)
      );
      // One summary per feed page: the strategy, the primary blend and what went out.
      node.traces.trace('basic', 'algorithm.feed', 'function:feedPage', {
        message: `${node.config.ranking.strategy} · ${page.items.length} of ${ranked.length} items`,
        data: {
          strategy: node.config.ranking.strategy,
          candidates: ranked.length,
          primary: first.length,
          items: page.items.length,
          seenFilters: seen.length,
        },
      });
      return { ...page, items: page.items.map((entry) => node.clientView(entry, body.previews !== false, first.includes(entry))) } satisfies Page<ContentItem>;
    });

    router.post('/v1/search', async (ctx) => {
      const body = await readJson<SearchRequest>(ctx.req);
      if (typeof body.query !== 'string') throw badRequest('query is required');
      const started = Date.now();
      node.charge(ctx, node.config.pricing.search, 'search');
      const seen = node.seenFilters(ctx, body);
      // The first page of a search also asks other platforms (briefly) for the query.
      const query = body.query.trim();
      if (!body.cursor && query && !/^(format|topic):/.test(query)) await node.crawler.search(query);
      // A search that names the user's subscribed creators looks for their new content
      // on their platforms as well, briefly — best-effort, the catalog answers as is.
      const subscribed = [...(body.filters?.creatorIds ?? []), ...(body.filters?.preferredCreators ?? [])];
      if (subscribed.length) await node.crawler.refreshCreators(subscribed).wait(500);
      const filters = node.preferencesOf(body.filters);
      let visible = node.registry.visible(filters, node.config.policy.maxRating);
      if (body.filters?.creator) visible = visible.filter((entry) => entry.creatorId === body.filters!.creator);
      const platform = String(body.filters?.platform ?? '').slice(0, 40);
      if (platform) visible = visible.filter((entry) => sourceKeyOf(entry) === platform);
      const searched = node.registry
        .search(
          visible,
          body.query.slice(0, 300),
          body.sort ?? 'relevance',
          // The seed the client sent drives every non-deterministic step of the ranking,
          // and the trace id carries its search version and parameters: the same trace id
          // and the same parameters reproduce the same exact results.
          body.trace || body.seed ? `${String(body.trace ?? '').slice(0, 200)}:${String(body.seed ?? '').slice(0, 200)}` : ''
        )
        .map(({ entry }) => entry);
      // A few VibeShare-published pieces come first, whatever the ranking — the ones
      // matching the query, or simply whatever is published when the page just explores —
      // and in the images medium every native picture and list leads it, seen or not
      // (see leadsImagesMedium). Everything else respects the seen filters.
      const first = nativeSuggestions(searched, filters.formats);
      const rest = searched.filter((entry) => !first.includes(entry));
      const leads = rest.filter((entry) => leadsImagesMedium(filters.formats, entry));
      const results = node.bySource([
        ...first,
        ...leads,
        ...node.withoutSeen(rest.filter((entry) => !leadsImagesMedium(filters.formats, entry)), seen),
      ]);
      const page = pageOf(results, body.cursor, pageLimit('search', body.limit, node.config.pageSize));
      // One summary per search: how long the query took and how much it found.
      const ms = Date.now() - started;
      node.traces.trace('basic', 'algorithm.search', 'function:searchPage', {
        message: `${body.query.length} char query · ${searched.length} matches · ${ms} ms`,
        data: {
          queryLength: body.query.length,
          matches: searched.length,
          results: results.length,
          items: page.items.length,
          seenFilters: seen.length,
          ms,
        },
      });
      return { ...page, items: page.items.map((entry) => node.clientView(entry, body.previews !== false, first.includes(entry))) } satisfies Page<ContentItem>;
    });

    router.post('/v1/lookup', async (ctx) => {
      const body = await readJson<{ ids?: string[] }>(ctx.req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, PAGE_LIMITS.lookupIds).map(String) : [];
      node.charge(ctx, node.config.pricing.lookup, 'lookup');
      const items = ids.map((id) => node.lookup(id));
      // One summary per lookup batch (the per-id decisions live in the registry).
      const counts = { listed: 0, blocked: 0, unknown: 0 };
      for (const item of items) counts[item.status === 'listed' || item.status === 'blocked' ? item.status : 'unknown']++;
      node.traces.trace('basic', 'algorithm.lookup', 'function:lookup', {
        message: `${ids.length} ids · ${counts.listed} listed · ${counts.blocked} blocked · ${counts.unknown} unknown`,
        data: { ids: ids.length, ...counts },
      });
      return { items };
    });

    router.get('/v1/content/:id', (ctx) => {
      node.charge(ctx, node.config.pricing.lookup, 'lookup');
      const result = node.lookup(ctx.params.id);
      node.traces.trace('basic', 'algorithm.lookup', 'function:lookup', {
        message: `${ctx.params.id.slice(0, 24)} · ${result.status}`,
        data: { id: ctx.params.id.slice(0, 32), status: result.status },
      });
      return result;
    });

    // Seen-content bloom filters kept here for a while: the operator's tiers say how many
    // bits and for how long, at what price. Suggestions skip whatever collides with them.
    router.get('/v1/bloom', (ctx) => {
      const account = node.auth.require(ctx);
      const stored = node.storedBloom(account.id);
      return {
        filter: stored?.toJSON(),
        expiresAt: node.blooms.data.stored[account.id]?.expiresAt,
        tiers: node.config.bloom.storage.tiers,
      };
    });

    router.put('/v1/bloom', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<{ tier?: string; filter?: unknown }>(ctx.req, 1024 * 1024);
      const tier = node.config.bloom.storage.tiers.find((t) => t.id === String(body.tier ?? ''));
      if (!tier) throw badRequest('Unknown storage tier');
      const filter = node.parseBloom(body.filter, tier.maxBits);
      if (!filter) throw badRequest('filter is required');
      node.charge(ctx, tier.price, 'bloom storage');
      // A renewal keeps what is left of the old term and adds the new one to it.
      const previous = node.blooms.data.stored[account.id];
      const from = Math.max(Date.now(), previous ? Date.parse(previous.expiresAt) : 0);
      const expiresAt = new Date(from + Number(tier.durationSeconds) * 1000).toISOString();
      node.blooms.data.stored[account.id] = { filter: filter.toJSON(), expiresAt };
      node.blooms.changed();
      node.traces.trace('basic', 'algorithm.bloom', 'function:storeBloom', {
        message: `${account.id.slice(0, 12)} · ${tier.id} · until ${expiresAt.slice(0, 10)}`,
        data: { account: account.id.slice(0, 16), tier: tier.id, maxBits: tier.maxBits, renewed: Boolean(previous), expiresAt },
      });
      return { filter: filter.toJSON(), expiresAt, tiers: node.config.bloom.storage.tiers };
    });

    router.delete('/v1/bloom', (ctx) => {
      const account = node.auth.require(ctx);
      const existed = Boolean(node.blooms.data.stored[account.id]);
      delete node.blooms.data.stored[account.id];
      node.blooms.changed();
      node.traces.trace('basic', 'algorithm.bloom', 'function:dropBloom', {
        message: `${account.id.slice(0, 12)} · ${existed ? 'dropped' : 'nothing stored'}`,
        data: { account: account.id.slice(0, 16), removed: existed },
      });
      return { tiers: node.config.bloom.storage.tiers };
    });

    // The account's own much larger filter: kept here long term (until it is dropped), and
    // refreshed at any time — by hand in the client's settings, or by its resubmission job.
    // It never travels inside search requests: this node applies it while searching instead.
    router.get('/v1/account-filter', (ctx) => {
      const account = node.auth.require(ctx);
      const record = node.blooms.data.accounts[account.id];
      return {
        filter: record?.filter,
        updatedAt: record?.updatedAt,
        maxBits: node.config.bloom.accountMaxBits,
      };
    });

    router.put('/v1/account-filter', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<{ filter?: unknown }>(ctx.req, 1024 * 1024);
      const filter = node.parseBloom(body.filter, node.config.bloom.accountMaxBits);
      if (!filter) throw badRequest('filter is required');
      const updatedAt = new Date().toISOString();
      node.blooms.data.accounts[account.id] = { filter: filter.toJSON(), updatedAt };
      node.blooms.changed();
      node.traces.trace('basic', 'algorithm.bloom', 'function:storeAccountFilter', {
        message: `${account.id.slice(0, 12)} · ${node.config.bloom.accountMaxBits} bits max`,
        data: { account: account.id.slice(0, 16), maxBits: node.config.bloom.accountMaxBits, updatedAt },
      });
      return { filter: filter.toJSON(), updatedAt, maxBits: node.config.bloom.accountMaxBits };
    });

    router.delete('/v1/account-filter', (ctx) => {
      const account = node.auth.require(ctx);
      const existed = Boolean(node.blooms.data.accounts[account.id]);
      delete node.blooms.data.accounts[account.id];
      if (existed) node.blooms.changed();
      node.traces.trace('basic', 'algorithm.bloom', 'function:dropAccountFilter', {
        message: `${account.id.slice(0, 12)} · ${existed ? 'dropped' : 'nothing stored'}`,
        data: { account: account.id.slice(0, 16), removed: existed },
      });
      return { maxBits: node.config.bloom.accountMaxBits };
    });

    // Comments on a content page: the whole hash-chained history, always. Clients verify
    // every block header and signature themselves before showing anything. Which comment
    // data rides along is the node's decision (a client only suggests an order), and only
    // the first screen of it goes out at once — `?offset=` brings the next as the reader
    // scrolls, with every block header again.
    router.get('/v1/thumbnails/:key', (ctx) => {
      const key = ctx.params.key;
      const data = node.registry.thumbnail(key);
      if (!data) throw notFound('No thumbnail');
      // The key names a slot (it derives from the content id) and a thumbnail can be
      // re-uploaded under it, so the weak form is the honest one: a hint of sameness,
      // not the byte-exact promise a content id makes. Replaced thumbnails are an
      // operator action, so the long cache still applies.
      if (notModified(ctx, key, { weak: true })) return;
      const type = data[0] === 0x89 ? 'image/png' : data[0] === 0x52 ? 'image/webp' : 'image/jpeg';
      ctx.res.writeHead(200, { 'content-type': type, 'content-length': data.length, ...immutableHeaders(key, { weak: true }) }).end(data);
    });

    router.post('/v1/submissions', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<SubmissionRequest>(ctx.req, 512 * 1024);
      return submit(node, account, body);
    });

    router.get('/v1/submissions/mine', (ctx) => {
      const account = node.auth.require(ctx);
      return {
        submissions: Object.values(data().submissions)
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, PAGE_LIMITS.mine),
      };
    });

    // A client that played content from outside the network reports its id or link
    // here; the node keeps what it did not have and rewards the reporter.
    router.post('/v1/claims', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<ClaimRequest>(ctx.req);
      return claim(node, ctx, account, body);
    });
    router.get('/v1/admin/submissions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const submissions = Object.values(node.contributions.data.submissions)
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({ ...s, thumbnail: s.hasThumbnail ? `/v1/thumbnails/${node.registry.thumbKey(s.contentId)}` : undefined }));
      return { submissions };
    });
    router.post('/v1/admin/submissions/:id/:action', async (ctx) => {
      admin(ctx);
      const submission = node.contributions.data.submissions[ctx.params.id];
      if (!submission) throw notFound('No such submission');
      const body = await readJson<Partial<Entry> & { note?: string; creatorName?: string; creatorKind?: CreatorKind }>(ctx.req);
      if (ctx.params.action === 'accept') {
        const { note, ...overrides } = body;
        submission.note = note;
        return acceptSubmission(node, submission, overrides);
      }
      if (ctx.params.action === 'reject') {
        submission.status = 'rejected';
        submission.note = body.note;
        submission.reviewedAt = new Date().toISOString();
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:rejectSubmission', {
          message: `${submission.id} rejected`,
          data: { id: submission.id, content: submission.contentId.slice(0, 32), note: (body.note ?? '').slice(0, 80) },
        });
        return submission;
      }
      throw notFound();
    });
}

