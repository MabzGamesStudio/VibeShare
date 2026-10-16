import { join } from 'node:path';
import type { Account } from '../commerce/ledger.js';
import { BaseNode, DEFAULT_NODE_TOR, type BaseConfig, type NodeOptions } from '../commerce/node.js';
import { isKeyId, randomId, verifySignature } from '../shared/crypto.js';
import { contentIdOf, validateManifest } from '../shared/content.js';
import { badRequest, forbidden, HttpError, notFound, readJson, requestJson, type Ctx } from '../shared/http.js';
import { log } from '../shared/log.js';
import { parseNodeRef } from '../shared/noderef.js';
import { NodeClient } from '../shared/nodeclient.js';
import {
  claimSigningPayload,
  SUGGESTION_KINDS,
  type AlgorithmInfo,
  type AlgorithmPricing,
  type AlgorithmRewards,
  type ClaimRequest,
  type ClaimResponse,
  type FeedRequest,
  type Page,
  type PeerDiscoverCriteria,
  type PeerEntry,
  type Preferences,
  type ReportRequest,
  type ReportResponse,
  type SearchRequest,
  type SubmissionRequest,
  type SuggestionKind,
  type SuggestionRequest,
  type ContentItem,
} from '../shared/protocol.js';
import { baseId, parseContentId } from '../shared/sources.js';
import { JsonFile } from '../shared/store.js';
import { FORMATS, normalizeTag, RATINGS, TOPICS, type CreatorKind, type Format, type Rating } from '../shared/taxonomy.js';
import { rank, STRATEGY_DESCRIPTIONS, type RankingConfig } from './ranking.js';
import { claimDefaults, claimMultiplier, claimRuleFor, type ClaimConfig } from './metrics.js';
import { Crawler, crawlerDefaults, type CrawlerConfig } from './crawler/crawler.js';
import type { Discovered } from './crawler/types.js';
import { Registry, identityOf, normalizeLink, type Entry, type EntryInput } from './registry.js';
import { prioritize, priorityOf, SOURCE_CATALOG, sourceKeyOf } from './sources.js';

export interface AlgorithmConfig extends BaseConfig {
  pricing: AlgorithmPricing;
  rewards: AlgorithmRewards;
  ranking: RankingConfig;
  /**
   * What clients earn for reporting platform popularity numbers (claims) about content,
   * and the per-source credit multipliers of every metric.
   */
  claims: ClaimConfig;
  policy: {
    /** Highest rating this node ever returns (e.g. 13+ for a family node). */
    maxRating: Rating;
    /** Rating ceiling when the client sends no preference. */
    defaultMaxRating: Rating;
    /** List submissions without review (the creator's metadata is trusted). */
    autoListSubmissions: boolean;
  };
  /** Topics offered to clients. */
  topics: string[];
  pageSize: number;
  /** The most accounts a creator may link together (YouTube, TikTok, Twitter…). */
  maxCreatorAccounts: number;
  /** Finding content on other platforms (YouTube, PeerTube, Mastodon, Flickr…) by itself. */
  crawler: CrawlerConfig;
  /**
   * How strongly each source of content is favoured in feeds and searches, 0–10 (0 =
   * never shown). Sources not listed are at 5, except VibeShare's own content at 10.
   */
  sources: { priorities: Record<string, number> };
  /** Exchanging content metadata and discoveries with other nodes. */
  peering: {
    /**
     * Other nodes (usually other algorithm nodes). `fetch`: this node may ask the peer
     * for metadata and discoveries; `serve`: the peer may ask this node.
     */
    peers: { ref: string; fetch: boolean; serve: boolean }[];
    /** The continuous peer-search job: ask peers for discoveries on a timer. */
    job: {
      /** Run the job at all (otherwise peers are only asked from the dashboard). */
      enabled: boolean;
      /** How often it asks each peer for new content (ms). */
      intervalMs: number;
      /** Take what it finds into the catalog as pending (the operator reviews after). */
      adopt: boolean;
      /** How many finds to take from each peer per round. */
      limit: number;
    };
    /**
     * How often this node answers one peer's metadata/discover requests, at the least
     * (ms). A peer asking more often is turned away, so the operator sets how often it
     * responds to peers and keeps its own load bounded.
     */
    respondIntervalMs: number;
    /**
     * Seed node references a new node bootstraps from when it has no peers yet, and to
     * widen its reach over time (peer exchange). Kept small and diverse on purpose, so
     * the network spreads out instead of clustering.
     */
    bootstrap: string[];
    /** The most peers to keep (the widest reach this node holds at once). */
    maxPeers: number;
  };
}

export function algorithmDefaults(): AlgorithmConfig {
  return {
    name: 'VibeShare algorithm',
    description: 'A VibeShare search algorithm node.',
    host: '0.0.0.0',
    port: 7702,
    trustProxy: false,
    tor: { ...DEFAULT_NODE_TOR },
    signup: { grant: 100, powBits: 0, anonymous: true, perIpPerHour: 30 },
    payments: [{ id: 'voucher', type: 'voucher' }],
    peers: [],
    pricing: { feed: 0, search: 0, lookup: 0, submission: 0 },
    rewards: { vote: 1, voteDailyCap: 50, acceptedSuggestion: 10, report: 2, reportDailyCap: 100, requireIdentity: false, autoAcceptAgreement: 3 },
    claims: claimDefaults(),
    ranking: {
      strategy: 'balanced',
      weights: { quality: 1, recency: 1, preference: 1.5, discovery: 0.3 },
      halfLifeHours: 72,
      gravity: 1.5,
    },
    policy: { maxRating: 'nsfw', defaultMaxRating: '18+', autoListSubmissions: false },
    topics: [...TOPICS],
    pageSize: 24,
    maxCreatorAccounts: 8,
    crawler: crawlerDefaults(),
    sources: { priorities: { vibeshare: 10 } },
    peering: {
      peers: [],
      job: { enabled: false, intervalMs: 3_600_000, adopt: true, limit: 50 },
      respondIntervalMs: 0,
      bootstrap: [],
      maxPeers: 32,
    },
  };
}

interface Suggestion {
  id: string;
  contentId: string;
  kind: SuggestionKind;
  value: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  /** Everyone who made this same suggestion, with their reason and evidence. */
  votes: { account: string; reason: string; timestamp?: number; at: string; platform?: string }[];
}

interface Submission {
  id: string;
  contentId: string;
  accountId: string;
  request: Omit<SubmissionRequest, 'thumbnail' | 'creatorProof'>;
  verifiedCreator?: string;
  hasThumbnail: boolean;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  note?: string;
}

interface ContributionData {
  votes: Record<string, Record<string, 1 | -1>>;
  suggestions: Record<string, Suggestion>;
  submissions: Record<string, Submission>;
}

function offsetOf(cursor: string | undefined): number {
  const value = Number(cursor ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function pageOf<T>(items: T[], cursor: string | undefined, limit: number): Page<T> {
  const offset = offsetOf(cursor);
  const slice = items.slice(offset, offset + limit);
  return { items: slice, cursor: offset + limit < items.length ? String(offset + limit) : undefined, total: items.length };
}

function slug(text: string): string {
  return normalizeTag(text).slice(0, 40) || 'creator';
}

export class AlgorithmNode extends BaseNode<AlgorithmConfig> {
  readonly registry: Registry;
  private contributions: JsonFile<ContributionData>;

  readonly crawler: Crawler;
  private lastPrune = 0;
  /** Preview images being fetched right now (a few at a time). */
  private thumbFetching = 0;

  constructor(options: NodeOptions<AlgorithmConfig>) {
    super('algorithm', algorithmDefaults(), options);
    this.registry = new Registry(this.path('registry.json'), options.dataDir ? join(options.dataDir, 'thumbnails') : null);
    this.contributions = new JsonFile(this.path('contributions.json'), () => ({ votes: {}, suggestions: {}, submissions: {} }));
    this.crawler = new Crawler(
      () => this.config.crawler,
      this.path('crawler.json'),
      (items) => this.ingest(items),
      (url) => this.transport(url.href)?.fetch
    );
  }

  /** Takes in what the crawler found, following the operator's policy. Returns how many entries are new. */
  ingest(items: Discovered[]): number {
    const config = this.config.crawler;
    let added = 0;
    for (const item of items) {
      const result = this.registry.upsertDiscovered(item, { autoList: config.autoList, defaultRating: config.defaultRating });
      if (result === 'added') added++;
      if (result !== 'invalid') {
        const entry = this.registry.get(item.id);
        if (entry) this.cacheThumbnail(entry);
      }
    }
    if (added && Date.now() - this.lastPrune > 60_000) {
      this.lastPrune = Date.now();
      this.registry.prune(config.maxEntries);
    }
    return added;
  }

  /**
   * Keeps the preview image of a video, stream or image here, once. Serving content to
   * clients then never has to look the preview up on the platform again.
   */
  private cacheThumbnail(entry: Entry): void {
    if (entry.thumbnail || !entry.thumbnailUrl || this.thumbFetching >= 4) return;
    const url = entry.thumbnailUrl;
    if (!/^https?:\/\//.test(url)) return;
    this.thumbFetching++;
    void (async () => {
      try {
        const send = this.transport(url)?.fetch ?? fetch;
        const response = await send(url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return;
        const type = (response.headers.get('content-type') ?? '').split(';')[0];
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 200 * 1024) return;
        this.registry.setThumbnail(entry.id, `data:${type};base64,${bytes.toString('base64')}`);
      } catch (error) {
        log.debug(`Preview of ${entry.id}: ${(error as Error).message}`);
      } finally {
        this.thumbFetching--;
      }
    })();
  }

  async start(): Promise<void> {
    await super.start();
    this.crawler.start();
    this.startPeering();
  }

  async stop(): Promise<void> {
    this.stopPeering();
    this.crawler.stop();
    await super.stop();
  }

  protected extraInfo(): Partial<AlgorithmInfo> {
    const config = this.config;
    return {
      type: 'algorithm',
      pricing: config.pricing,
      rewards: config.rewards,
      ranking: {
        strategy: config.ranking.strategy,
        description: config.ranking.description ?? STRATEGY_DESCRIPTIONS[config.ranking.strategy],
      },
      taxonomy: { topics: config.topics },
      stats: (({ listed, blocked, creators, discovered }) => ({ listed, blocked, creators, discovered }))(this.registry.stats()),
      discovery: {
        crawling: config.crawler.enabled,
        searchesPlatforms: config.crawler.enabled && config.crawler.searchPlatforms,
        platforms: Object.entries(config.crawler.adapters)
          .filter(([, adapter]) => adapter.enabled)
          .map(([id]) => id),
      },
    };
  }

  protected validateConfig(config: AlgorithmConfig): void {
    if (!RATINGS.includes(config.policy.maxRating) || !RATINGS.includes(config.policy.defaultMaxRating)) {
      throw badRequest('Unknown rating in policy');
    }
    for (const [key, value] of Object.entries(config.sources?.priorities ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) throw badRequest(`Priority of ${key} must be 0–10`);
    }
    const crawler = config.crawler;
    if (!Array.isArray(crawler.blockedSources) || crawler.blockedSources.some((key) => typeof key !== 'string')) {
      throw badRequest('crawler.blockedSources is a list of source names');
    }
    for (const list of [crawler.sites?.allow, crawler.sites?.block]) {
      if (!Array.isArray(list) || list.some((site) => typeof site !== 'string')) throw badRequest('crawler.sites.allow and .block are lists of sites');
    }
    for (const [id, adapter] of Object.entries(crawler.adapters) as [string, { dailyLimit?: unknown; searchShare?: unknown }][]) {
      if (adapter.dailyLimit !== undefined && !(Number(adapter.dailyLimit) >= 0)) throw badRequest(`${id}: daily limit must be 0 or more`);
      if (adapter.searchShare !== undefined && !(Number(adapter.searchShare) >= 0 && Number(adapter.searchShare) <= 1)) {
        throw badRequest(`${id}: the share kept for searches is between 0 and 1`);
      }
    }
  }

  /**
   * What feeds and searches may serve: crawler finds of blocked sources are left out, and
   * source priorities reorder the rest (priority 0 hides a source).
   */
  private bySource(entries: Entry[]): Entry[] {
    const blocked = new Set(this.config.crawler.blockedSources);
    const servable = blocked.size ? entries.filter((entry) => !(entry.origin === 'crawler' && blocked.has(sourceKeyOf(entry)))) : entries;
    return prioritize(servable, this.config.sources.priorities);
  }

  private charge(ctx: Ctx, price: number, reason: string): Account | undefined {
    const account = this.auth.account(ctx);
    if (price <= 0) {
      // Clients learn their balance from the answer instead of asking for it.
      if (account) ctx.res.setHeader('x-vs-balance', String(account.balance));
      return account;
    }
    if (!account) throw new HttpError(401, 'unauthorized', `This node charges ${price} credits for ${reason}`);
    const updated = this.ledger.debit(account.id, price, reason);
    ctx.res.setHeader('x-vs-charged', String(price));
    ctx.res.setHeader('x-vs-balance', String(updated.balance));
    return account;
  }

  private preferencesOf(input: Preferences | undefined): Preferences {
    const preferences = { ...(input ?? {}) };
    if (!preferences.maxRating || !RATINGS.includes(preferences.maxRating)) preferences.maxRating = this.config.policy.defaultMaxRating;
    return preferences;
  }

  private limitOf(value: unknown): number {
    const limit = Math.floor(Number(value ?? this.config.pageSize));
    return Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : this.config.pageSize));
  }

  private canEarn(account: Account): boolean {
    return !this.config.rewards.requireIdentity || account.kind === 'key';
  }

  // -------------------------------------------------------------------------

  protected registerRoutes(): void {
    const router = this.router;

    router.get('/v1/taxonomy', () => ({
      formats: FORMATS,
      ratings: RATINGS,
      topics: this.config.topics,
      suggestionKinds: SUGGESTION_KINDS,
      platforms: SOURCE_CATALOG,
    }));

    router.post('/v1/feed', async (ctx) => {
      const body = await readJson<FeedRequest>(ctx.req);
      this.charge(ctx, this.config.pricing.feed, 'feed');
      const preferences = this.preferencesOf(body.preferences);
      const visible = this.registry.visible(preferences, this.config.policy.maxRating);
      const ranked = await rank(visible, {
        preferences,
        seed: String(body.seed ?? new Date().toISOString().slice(0, 13)),
        now: Date.now(),
        config: this.config.ranking,
      });
      const page = pageOf(this.bySource(ranked), body.cursor, this.limitOf(body.limit));
      return { ...page, items: page.items.map((entry) => this.registry.view(entry)) } satisfies Page<ContentItem>;
    });

    router.post('/v1/search', async (ctx) => {
      const body = await readJson<SearchRequest>(ctx.req);
      if (typeof body.query !== 'string') throw badRequest('query is required');
      this.charge(ctx, this.config.pricing.search, 'search');
      // The first page of a search also asks other platforms (briefly) for the query.
      const query = body.query.trim();
      if (!body.cursor && query && !/^(format|topic):/.test(query)) await this.crawler.search(query);
      const filters = this.preferencesOf(body.filters);
      let visible = this.registry.visible(filters, this.config.policy.maxRating);
      if (body.filters?.creator) visible = visible.filter((entry) => entry.creatorId === body.filters!.creator);
      const platform = String(body.filters?.platform ?? '').slice(0, 40);
      if (platform) visible = visible.filter((entry) => sourceKeyOf(entry) === platform);
      const results = this.bySource(this.registry.search(visible, body.query.slice(0, 300), body.sort ?? 'relevance').map(({ entry }) => entry));
      const page = pageOf(results, body.cursor, this.limitOf(body.limit));
      return { ...page, items: page.items.map((entry) => this.registry.view(entry)) } satisfies Page<ContentItem>;
    });

    router.post('/v1/lookup', async (ctx) => {
      const body = await readJson<{ ids?: string[] }>(ctx.req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [];
      this.charge(ctx, this.config.pricing.lookup, 'lookup');
      return { items: ids.map((id) => this.lookup(id)) };
    });

    router.get('/v1/content/:id', (ctx) => {
      this.charge(ctx, this.config.pricing.lookup, 'lookup');
      return this.lookup(ctx.params.id);
    });

    router.get('/v1/thumbnails/:key', (ctx) => {
      const data = this.registry.thumbnail(ctx.params.key);
      if (!data) throw notFound('No thumbnail');
      const type = data[0] === 0x89 ? 'image/png' : data[0] === 0x52 ? 'image/webp' : 'image/jpeg';
      ctx.res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'public, max-age=86400' }).end(data);
    });

    router.post('/v1/creators/latest', async (ctx) => {
      const body = await readJson<{ creators?: string[]; preferences?: Preferences; cursor?: string; limit?: number }>(ctx.req);
      const creators = new Set((body.creators ?? []).slice(0, 500).map(String));
      this.charge(ctx, this.config.pricing.feed, 'subscriptions');
      const preferences = this.preferencesOf(body.preferences);
      const items = this.registry
        .visible(preferences, this.config.policy.maxRating)
        .filter((entry) => entry.creatorId && creators.has(entry.creatorId))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      const page = pageOf(items, body.cursor, this.limitOf(body.limit));
      return { ...page, items: page.items.map((entry) => this.registry.view(entry)) };
    });

    router.get('/v1/creators', (ctx) => {
      const q = (ctx.query.get('q') ?? '').toLowerCase();
      const creators = Object.values(this.registry.data.creators)
        .filter((creator) => creator.status === 'listed' && (!q || creator.name.toLowerCase().includes(q) || creator.id.includes(q)))
        .slice(0, 50);
      return { creators };
    });

    router.get('/v1/creators/:id', (ctx) => {
      const creator = this.registry.creator(ctx.params.id);
      if (!creator || creator.status === 'blocked') throw notFound('Unknown creator');
      const items = this.registry
        .visible(this.preferencesOf({}), this.config.policy.maxRating)
        .filter((entry) => entry.creatorId === creator.id)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 100)
        .map((entry) => this.registry.view(entry));
      const { status: _status, addedAt: _added, ...info } = creator;
      return { creator: info, items };
    });

    this.contributionRoutes();
    this.peerRoutes();
    this.adminRoutes();
  }

  private lookup(id: string) {
    const result = this.registry.lookup(id);
    if (result.status === 'unknown' || result.status === 'blocked') return { ...result, id };
    return result;
  }

  // -------------------------------------------------------------------------
  // Services clients are rewarded for: votes, tag/rating suggestions with evidence, submissions

  private contributionRoutes(): void {
    const router = this.router;
    const data = () => this.contributions.data;

    router.post('/v1/votes', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<{ id?: string; vote?: number }>(ctx.req);
      const entry = this.registry.get(String(body.id ?? ''));
      if (!entry || entry.status !== 'listed') throw notFound('Only listed content can be voted on');
      const vote = Number(body.vote);
      if (![1, -1, 0].includes(vote)) throw badRequest('vote is 1 (like), -1 (dislike) or 0 (none)');
      const votes = (data().votes[entry.id] ??= {});
      const previous = votes[account.id];
      const first = previous === undefined;
      if (previous === 1) entry.likes--;
      if (previous === -1) entry.dislikes--;
      if (vote === 0) delete votes[account.id];
      else {
        votes[account.id] = vote as 1 | -1;
        if (vote === 1) entry.likes++;
        else entry.dislikes++;
      }
      this.registry.changed();
      this.contributions.changed();
      let credited = 0;
      const rewards = this.config.rewards;
      if (first && vote !== 0 && rewards.vote > 0 && this.canEarn(account) && this.ledger.daily(account, 'votes') < rewards.voteDailyCap) {
        this.ledger.addDaily(account, 'votes', 1);
        const updated = this.ledger.credit(account.id, rewards.vote, 'vote', entry.id);
        ctx.res.setHeader('x-vs-balance', String(updated.balance));
        credited = rewards.vote;
      }
      return { likes: entry.likes, dislikes: entry.dislikes, vote, credited };
    });

    router.get('/v1/votes/:id', (ctx) => {
      const account = this.auth.require(ctx);
      const key = baseId(ctx.params.id);
      return { vote: data().votes[key]?.[account.id] ?? 0 };
    });

    router.post('/v1/suggestions', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<SuggestionRequest>(ctx.req);
      return this.suggest(account, body);
    });

    router.get('/v1/suggestions/mine', (ctx) => {
      const account = this.auth.require(ctx);
      const mine = Object.values(data().suggestions)
        .filter((s) => s.votes.some((v) => v.account === account.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200)
        .map(({ votes, ...rest }) => ({ ...rest, agreeing: votes.length }));
      return { suggestions: mine };
    });

    router.post('/v1/submissions', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<SubmissionRequest>(ctx.req, 512 * 1024);
      return this.submit(account, body);
    });

    router.get('/v1/submissions/mine', (ctx) => {
      const account = this.auth.require(ctx);
      return {
        submissions: Object.values(data().submissions)
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    // A client that played content from outside the network reports its id or link
    // here; the node keeps what it did not have and rewards the reporter.
    router.post('/v1/reports', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<ReportRequest>(ctx.req);
      return this.report(ctx, account, String(body.id ?? ''));
    });

    // Platform popularity numbers (views, likes, comments, subscribers…) the client saw:
    // only what is new to the node pays, times the source's credit multipliers.
    router.post('/v1/claims', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<ClaimRequest>(ctx.req);
      return this.claim(ctx, account, body);
    });
  }

  private validateSuggestion(kind: SuggestionKind, raw: string): string {
    const value = raw.trim();
    switch (kind) {
      case 'format':
        if (!FORMATS.includes(value as Format)) throw badRequest(`Unknown format ${value}`);
        return value;
      case 'rating':
        if (!RATINGS.includes(value as Rating)) throw badRequest(`Unknown rating ${value}`);
        return value;
      case 'tag':
      case 'topic': {
        const tag = normalizeTag(value);
        if (!tag) throw badRequest('Empty tag');
        return tag;
      }
      case 'creator': {
        if (!value || value.length > 120) throw badRequest('A creator name is required (at most 120 characters)');
        return value;
      }
      case 'published': {
        const time = Date.parse(value);
        if (!Number.isFinite(time)) throw badRequest('A publish time is a date like 2024-05-01 or 2024-05-01T12:00:00Z');
        if (time > Date.now() + 86_400_000) throw badRequest('A publish time cannot be in the future');
        return new Date(time).toISOString();
      }
      case 'report':
        return value.slice(0, 64) || 'other';
      case 'source': {
        // A link to the content on another platform; one content id can carry several.
        return normalizeLink(value);
      }
      case 'duplicate': {
        const identity = identityOf({ id: value });
        return identity.key || value.slice(0, 4096);
      }
    }
  }

  suggest(account: Account, body: SuggestionRequest) {
    const entry = this.registry.get(String(body.id ?? ''));
    if (!entry) throw notFound('The node does not know this content');
    if (!SUGGESTION_KINDS.includes(body.kind)) throw badRequest(`kind is one of ${SUGGESTION_KINDS.join(', ')}`);
    const value = this.validateSuggestion(body.kind, String(body.value ?? ''));
    const reason = String(body.reason ?? '').trim().slice(0, 1000);
    if (reason.length < 3) throw badRequest('Say why (reason)');
    const timestamp =
      body.timestamp !== undefined && Number.isFinite(Number(body.timestamp)) && Number(body.timestamp) >= 0
        ? Math.round(Number(body.timestamp) * 10) / 10
        : undefined;
    const suggestions = this.contributions.data.suggestions;
    let suggestion = Object.values(suggestions).find(
      (s) => s.contentId === entry.id && s.kind === body.kind && s.value === value && s.status === 'pending'
    );
    if (!suggestion) {
      suggestion = {
        id: randomId('sug-', 8),
        contentId: entry.id,
        kind: body.kind,
        value,
        status: 'pending',
        createdAt: new Date().toISOString(),
        votes: [],
      };
      suggestions[suggestion.id] = suggestion;
    }
    if (!suggestion.votes.some((vote) => vote.account === account.id)) {
      suggestion.votes.push({
        account: account.id,
        reason,
        timestamp,
        at: new Date().toISOString(),
        platform: body.platform ? String(body.platform).slice(0, 32) : undefined,
      });
    }
    this.contributions.changed();
    const needed = this.config.rewards.autoAcceptAgreement;
    if (needed > 0 && body.kind !== 'report' && suggestion.votes.length >= needed) this.acceptSuggestion(suggestion);
    const { votes, ...rest } = suggestion;
    return { ...rest, agreeing: votes.length };
  }

  acceptSuggestion(suggestion: Suggestion): void {
    if (suggestion.status !== 'pending') return;
    const entry = this.registry.get(suggestion.contentId);
    if (entry) {
      switch (suggestion.kind) {
        case 'tag':
          if (!entry.tags.includes(suggestion.value)) entry.tags.push(suggestion.value);
          break;
        case 'topic':
          if (!entry.topics.includes(suggestion.value)) entry.topics.push(suggestion.value);
          break;
        case 'format':
          entry.format = suggestion.value as Format;
          break;
        case 'rating':
          entry.rating = suggestion.value as Rating;
          break;
        case 'creator': {
          // Missing information a client provided: the creator of the content.
          const id = `name:${slug(suggestion.value)}`;
          this.registry.upsertCreator({ id, name: suggestion.value, kind: 'unknown' });
          entry.creatorId = id;
          break;
        }
        case 'published':
          entry.publishedAt = suggestion.value;
          break;
        case 'source':
          // Missing sources of the content: one content id can carry several.
          if (entry.sources.length < 16 && !entry.sources.includes(suggestion.value) && suggestion.value !== entry.id) {
            entry.sources.push(suggestion.value);
          }
          break;
        case 'duplicate':
          // Reported as a duplicate of another id; kept as evidence for the operator.
          break;
        case 'report':
          break;
      }
      const first = suggestion.votes[0];
      if (first && suggestion.kind !== 'report') {
        entry.notes = entry.notes.filter((note) => !(note.kind === suggestion.kind && note.value === suggestion.value));
        entry.notes.push({ kind: suggestion.kind, value: suggestion.value, reason: first.reason, timestamp: first.timestamp });
      }
      entry.updatedAt = new Date().toISOString();
      this.registry.changed();
    }
    suggestion.status = 'accepted';
    suggestion.reviewedAt = new Date().toISOString();
    const reward = this.config.rewards.acceptedSuggestion;
    for (const vote of suggestion.votes) {
      const account = this.ledger.get(vote.account);
      if (account && reward > 0 && this.canEarn(account)) this.ledger.credit(account.id, reward, `accepted ${suggestion.kind}`, suggestion.id);
    }
    this.contributions.changed();
  }

  /**
   * A client reports the content id or link it played from outside the network. What the
   * node did not have is kept for review, and the reporter earns credits for finding it.
   */
  report(ctx: Ctx, account: Account, raw: string): ReportResponse {
    const trimmed = raw.trim();
    if (!trimmed) throw badRequest('id is required');
    const { key, contentId, link } = identityOf({ id: trimmed });
    const existing = this.registry.findByRef(trimmed);
    let newInfo = false;
    if (!existing) {
      this.registry.upsert({ id: key, contentId, link, status: 'pending', origin: 'report' });
      newInfo = true;
    } else if ((contentId && !existing.contentId) || (link && !existing.link)) {
      // The node knew the content, but not the content id (or the link) it was played from.
      this.registry.upsert({ id: existing.id, contentId: contentId ?? existing.contentId, link: link ?? existing.link });
      newInfo = true;
    }
    let credited = 0;
    const rewards = this.config.rewards;
    if (newInfo && rewards.report > 0 && this.canEarn(account) && this.ledger.daily(account, 'reports') < rewards.reportDailyCap) {
      this.ledger.addDaily(account, 'reports', 1);
      const updated = this.ledger.credit(account.id, rewards.report, 'report', key);
      ctx.res.setHeader('x-vs-balance', String(updated.balance));
      credited = rewards.report;
    }
    return { known: !newInfo, credited };
  }

  /**
   * A client reports the popularity numbers it saw for the content on its platform
   * (views, likes, comments, subscribers, upvotes…). Only numbers the node did not have
   * yet count as new information, and only those pay: `base × multiplier`, where the
   * multiplier sums one weight per enabled metric of the source and is then multiplied
   * by the recency factor (exponential decay to 1×). The multiplier is never below 1.
   */
  claim(ctx: Ctx, account: Account, body: ClaimRequest): ClaimResponse {
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
    let entry = this.registry.findByRef(trimmed);
    const known = Boolean(entry);
    if (!entry) {
      // The node learns of the content itself: kept for review, like a report.
      entry = this.registry.upsert({ id: key, contentId, link, status: 'pending', origin: 'report' });
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
    if (newInfo) {
      const source = body.source ? String(body.source).slice(0, 32) : sourceKeyOf({ id: entry.id, adapter: entry.adapter });
      multiplier = claimMultiplier(claimRuleFor(this.config.claims, source), metrics, publishedAt ?? entry.publishedAt).multiplier;
      const claims = this.config.claims;
      if (claims.base > 0 && this.canEarn(account) && this.ledger.daily(account, 'claims') < claims.dailyCap) {
        this.ledger.addDaily(account, 'claims', 1);
        credited = Math.max(1, Math.round(claims.base * multiplier));
        const updatedAccount = this.ledger.credit(account.id, credited, 'claim', entry.id);
        ctx.res.setHeader('x-vs-balance', String(updatedAccount.balance));
      }
      if (publishedAt && entry.origin === 'report') entry.publishedAt = publishedAt;
      entry.updatedAt = new Date().toISOString();
      this.registry.changed();
    }
    return { known, newInfo, credited, multiplier, updated };
  }

  submit(account: Account, body: SubmissionRequest): Submission {
    const identity = identityOf({ id: body.id, link: body.link });
    const full = String(body.id ?? body.link ?? identity.key);
    if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('A title is required');
    const existing = this.registry.get(identity.key);
    if (existing?.status === 'listed') throw new HttpError(409, 'already_listed', 'This content is already listed');
    if (existing?.status === 'blocked') throw forbidden('This content is blocked on this node');
    const pending = Object.values(this.contributions.data.submissions).find(
      (s) => baseId(s.contentId) === identity.key && s.status === 'pending'
    );
    if (pending) throw new HttpError(409, 'already_submitted', 'This content is already waiting for review');
    if (body.format !== undefined && !FORMATS.includes(body.format)) throw badRequest('Unknown format');
    if (body.rating !== undefined && !RATINGS.includes(body.rating)) throw badRequest('Unknown rating');
    let verifiedCreator: string | undefined;
    const proof = body.creatorProof;
    if (proof) {
      if (!isKeyId(proof.key) || Math.abs(Date.now() - Number(proof.ts)) > 15 * 60_000) throw badRequest('Bad or stale creatorProof');
      if (!verifySignature(proof.key, claimSigningPayload(this.identity.id, identity.key, Number(proof.ts)), String(proof.sig))) {
        throw badRequest('creatorProof signature does not match');
      }
      verifiedCreator = proof.key;
    }
    if (this.config.pricing.submission > 0) this.ledger.debit(account.id, this.config.pricing.submission, 'submission', identity.key);
    const { thumbnail, creatorProof: _proof, ...request } = body;
    if (thumbnail) this.registry.setThumbnail(identity.key, thumbnail);
    const submission: Submission = {
      id: randomId('sub-', 8),
      contentId: full,
      accountId: account.id,
      request: {
        ...request,
        providers: (request.providers ?? []).filter((ref) => parseNodeRef(ref)).slice(0, 8),
        tags: (request.tags ?? []).slice(0, 32),
        topics: (request.topics ?? []).slice(0, 16),
      },
      verifiedCreator,
      hasThumbnail: Boolean(thumbnail),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.contributions.data.submissions[submission.id] = submission;
    this.contributions.changed();
    if (this.config.policy.autoListSubmissions) this.acceptSubmission(submission, {});
    return submission;
  }

  acceptSubmission(submission: Submission, overrides: Partial<Entry> & { creatorName?: string; creatorKind?: CreatorKind }): Entry {
    const request = submission.request;
    let creatorId: string | undefined;
    const name = overrides.creatorName ?? request.creator?.name;
    const kind = overrides.creatorKind ?? request.creator?.kind ?? 'unknown';
    if (submission.verifiedCreator) {
      creatorId = submission.verifiedCreator;
      const known = this.registry.creator(creatorId);
      this.registry.upsertCreator({ id: creatorId, name: known?.name ?? name ?? creatorId.slice(0, 12), kind: known?.kind ?? kind, keys: [creatorId] });
    } else if (name) {
      creatorId = `name:${slug(name)}`;
      if (!this.registry.creator(creatorId)) this.registry.upsertCreator({ id: creatorId, name, kind });
    }
    const entry = this.registry.upsert({
      id: submission.contentId,
      link: request.link,
      status: 'listed',
      title: request.title,
      description: request.description,
      format: request.format ?? 'other',
      rating: request.rating ?? 'all',
      topics: request.topics,
      tags: request.tags,
      language: request.language,
      durationSeconds: request.durationSeconds,
      providers: request.providers,
      publishedAt: request.publishedAt,
      thumbnail: submission.hasThumbnail || undefined,
      creatorId,
      origin: 'submission',
      ...overrides,
    });
    submission.status = 'accepted';
    submission.reviewedAt = new Date().toISOString();
    this.contributions.changed();
    return entry;
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Peering: nodes ask each other for content metadata (of a cid or a link) and
  // for new ids and links matching some criteria.

  /** The peer the caller is, when this node serves it. */
  private requirePeer(ctx: Ctx): { ref: string; url: string; id: string } {
    const account = this.auth.require(ctx);
    for (const peer of this.config.peering.peers) {
      if (!peer.serve) continue;
      const ref = parseNodeRef(peer.ref);
      if (ref?.id === account.id) return { ref: peer.ref, url: ref.url, id: ref.id };
    }
    throw forbidden('Not a peer of this node');
  }

  /** A client talking to one configured peer as this node. */
  private peerClient(peer: { ref: string }): NodeClient {
    const ref = parseNodeRef(peer.ref)!;
    return new NodeClient({
      url: ref.url,
      expectedId: ref.id,
      expectedType: ref.type ?? 'algorithm',
      auth: 'identity',
      identity: this.identity,
      transport: () => this.transport(ref.url),
    });
  }

  /** The peers this node may ask, optionally only one of them. */
  private peersToFetch(only?: string): { ref: string }[] {
    return this.config.peering.peers.filter((peer) => peer.fetch && (!only || peer.ref === only));
  }

  /** What peers see of an entry: more than the public catalog, less than the operator. */
  private peerView(entry: Entry): PeerEntry {
    const item = this.registry.view(entry);
    return {
      ...item,
      sources: entry.sources,
      status: entry.status,
      platformStats: entry.platformStats && Object.keys(entry.platformStats).length ? entry.platformStats : undefined,
    };
  }

  /** Entries matching what a peer asked for, by its criteria. */
  discover(criteria: PeerDiscoverCriteria): PeerEntry[] {
    const filters = criteria.filters ?? {};
    const wantedRating = filters.maxRating ? RATINGS.indexOf(filters.maxRating) : RATINGS.length - 1;
    const formats = filters.formats?.length ? new Set(filters.formats) : null;
    const topics = filters.topics?.length ? new Set(filters.topics.map(normalizeTag)) : null;
    const tags = filters.tags?.length ? new Set(filters.tags.map(normalizeTag)) : null;
    const metrics = criteria.metrics ?? [];
    const wanted = this.registry.all().filter((entry) => {
      if (entry.status === 'blocked') return false;
      if (criteria.platform && sourceKeyOf(entry) !== criteria.platform) return false;
      const has = criteria.has ?? 'any';
      if (has === 'cid' && !entry.contentId) return false;
      if (has === 'link' && !entry.link) return false;
      if (has === 'both' && !(entry.contentId && entry.link)) return false;
      if (formats && !formats.has(entry.format)) return false;
      if (RATINGS.indexOf(entry.rating) > wantedRating) return false;
      if (topics && !entry.topics.some((topic) => topics.has(normalizeTag(topic)))) return false;
      if (tags && !entry.tags.some((tag) => tags.has(normalizeTag(tag)))) return false;
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
      .map((entry) => this.peerView(entry));
  }

  /** Takes a peer's entry into the catalog as pending (the operator decides after). */
  private adoptPeerEntry(item: PeerEntry): void {
    const key = baseId(item.id);
    const existing = this.registry.get(key);
    if (!existing) {
      this.registry.upsert({
        id: key,
        status: 'pending',
        origin: 'peer',
        title: item.title,
        description: item.description,
        format: item.format,
        rating: item.rating,
        topics: item.topics,
        tags: item.tags,
        language: item.language,
        durationSeconds: item.durationSeconds,
        publishedAt: item.publishedAt,
        pageUrl: item.pageUrl,
        thumbnailUrl: /^https?:/.test(item.thumbnail ?? '') ? item.thumbnail : undefined,
      });
    }
    const entry = this.registry.get(key);
    if (entry && item.platformStats) {
      const stats = entry.platformStats ?? {};
      for (const [name, value] of Object.entries(item.platformStats)) stats[name] = Math.max(stats[name] ?? -1, value);
      entry.platformStats = stats;
      this.registry.changed();
    }
  }

  // -------------------------------------------------------------------------
  // A continuous peer-search job (keep asking peers for discoveries on a timer),
  // and the cadence at which this node answers peers.

  private peeringTimer: ReturnType<typeof setInterval> | null = null;
  /** When each peer was last answered, so the node responds at its own pace. */
  private respondTimes = new Map<string, number>();

  /** Requires a peer and turns away one asking more often than the node responds. */
  private respondGate(ctx: Ctx): { ref: string; url: string; id: string } {
    const peer = this.requirePeer(ctx);
    const gap = Math.max(0, Math.round(Number(this.config.peering.respondIntervalMs) || 0));
    const now = Date.now();
    const last = this.respondTimes.get(peer.id) ?? 0;
    if (gap && now - last < gap) {
      throw new HttpError(429, 'too_many', `This node answers a peer at most once every ${gap} ms`);
    }
    this.respondTimes.set(peer.id, now);
    return peer;
  }

  /** One round of the continuous job: ask each peer for discoveries and take them in. */
  async runPeerSearch(): Promise<{ peer: string; items: number; adopted: number; error?: string }[]> {
    const job = this.config.peering.job;
    const results: { peer: string; items: number; adopted: number; error?: string }[] = [];
    for (const entry of this.peersToFetch()) {
      try {
        const answer = await this.peerClient(entry).json<{ items: PeerEntry[] }>('/v1/peers/discover', {
          body: { criteria: { algorithm: 'new', limit: job.limit } },
          timeoutMs: 60_000,
        });
        const items = answer.items ?? [];
        let adopted = 0;
        if (job.adopt) for (const item of items) (this.adoptPeerEntry(item), adopted++);
        results.push({ peer: entry.ref, items: items.length, adopted });
      } catch (error) {
        results.push({ peer: entry.ref, items: 0, adopted: 0, error: (error as Error).message });
      }
    }
    return results;
  }

  /** Starts (or restarts) the continuous peer-search job at the configured cadence. */
  private startPeering(): void {
    this.stopPeering();
    // A new node with bootstrap seeds finds its first peers right away.
    if (this.config.peering.bootstrap?.length) {
      void this.bootstrapPeers().catch((error) => log.debug(`Peer bootstrap: ${(error as Error).message}`));
    }
    const job = this.config.peering.job;
    if (!job.enabled) return;
    const interval = Math.max(5_000, Math.round(Number(job.intervalMs) || 3_600_000));
    this.peeringTimer = setInterval(() => {
      void this.runPeerSearch().catch((error) => log.debug(`Peer-search job: ${(error as Error).message}`));
      // Keep widening the peer set over time (peer exchange), so reach stays broad.
      void this.bootstrapPeers().catch((error) => log.debug(`Peer bootstrap: ${(error as Error).message}`));
    }, interval);
    this.peeringTimer.unref?.();
  }

  private stopPeering(): void {
    if (this.peeringTimer) clearInterval(this.peeringTimer);
    this.peeringTimer = null;
  }

  /**
   * Picks up to `count` references spread across key-id space and hosts, so the peer set
   * stays wide and does not cluster around a few nodes.
   */
  private diversify(refs: string[], count: number): string[] {
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
      .filter((r) => r.id && r.id !== this.identity?.id);
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
  async bootstrapPeers(): Promise<string[]> {
    const peering = this.config.peering;
    const max = Math.max(1, peering.maxPeers || 32);
    const room = Math.max(0, max - peering.peers.length);
    if (!room) return [];
    const known = new Set(peering.peers.map((peer) => peer.ref));
    const sources = [...(peering.bootstrap ?? []), ...peering.peers.slice(0, 3).map((peer) => peer.ref)];
    const learned: string[] = [];
    for (const ref of sources) {
      if (learned.length > max * 3) break;
      try {
        const answer = await this.peerClient({ ref }).json<{ self?: string; peers?: string[] }>('/v1/peers/peers', { timeoutMs: 15_000 });
        for (const candidate of [answer.self, ...(answer.peers ?? [])]) {
          const ref2 = String(candidate ?? '').trim();
          if (!ref2 || known.has(ref2) || learned.includes(ref2)) continue;
          if (parseNodeRef(ref2)) learned.push(ref2);
        }
      } catch {
        // The seed or peer is offline; try the next one.
      }
    }
    const chosen = this.diversify(learned, room);
    const added: string[] = [];
    for (const ref of chosen) {
      if (peering.peers.some((peer) => peer.ref === ref)) continue;
      peering.peers.push({ ref, fetch: true, serve: true });
      added.push(ref);
    }
    if (added.length) this.configFile.changed();
    return added;
  }

  private peerRoutes(): void {
    const router = this.router;
    const peer = (ctx: Ctx) => this.respondGate(ctx);

    // A public bootstrap directory: a wide, unclustered sample of who this node peers
    // with (and itself), so a new node can find peers without being one yet.
    router.get('/v1/peers/peers', () => ({
      self: this.reference(),
      peers: this.diversify(
        this.config.peering.peers.map((entry) => entry.ref),
        Math.min(16, Math.max(1, this.config.peering.maxPeers || 16))
      ),
    }));

    router.post('/v1/peers/metadata', async (ctx) => {
      peer(ctx);
      const body = await readJson<{ id?: string; link?: string }>(ctx.req);
      const ref = String(body.id ?? body.link ?? '').trim();
      if (!ref) throw badRequest('id or link is required');
      const entry = this.registry.findByRef(ref);
      return { entry: entry ? this.peerView(entry) : null };
    });

    router.post('/v1/peers/discover', async (ctx) => {
      peer(ctx);
      const body = await readJson<{ criteria?: PeerDiscoverCriteria }>(ctx.req);
      return { items: this.discover(body.criteria ?? {}) };
    });
  }

  private adminRoutes(): void {
    const router = this.router;
    const admin = (ctx: Ctx) => this.requireAdmin(ctx);

    // The continuous peer-search job: run a round now, or change how often it runs and
    // how often this node answers peers.
    router.post('/v1/admin/peers/search', async (ctx) => {
      admin(ctx);
      return { results: await this.runPeerSearch() };
    });
    router.post('/v1/admin/peers/job', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ enabled?: boolean; intervalMs?: number; adopt?: boolean; limit?: number; respondIntervalMs?: number }>(ctx.req);
      const peering = this.config.peering;
      if (body.enabled !== undefined) peering.job.enabled = Boolean(body.enabled);
      if (body.intervalMs !== undefined) peering.job.intervalMs = Math.max(5_000, Math.round(Number(body.intervalMs) || 0));
      if (body.adopt !== undefined) peering.job.adopt = Boolean(body.adopt);
      if (body.limit !== undefined) peering.job.limit = Math.max(1, Math.min(200, Math.round(Number(body.limit) || 50)));
      if (body.respondIntervalMs !== undefined) peering.respondIntervalMs = Math.max(0, Math.round(Number(body.respondIntervalMs) || 0));
      this.configFile.changed();
      this.startPeering();
      return { peering };
    });
    router.post('/v1/admin/peers/bootstrap', async (ctx) => {
      admin(ctx);
      const added = await this.bootstrapPeers();
      return { added, peers: this.config.peering.peers };
    });

    router.get('/v1/admin/content', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status');
      const q = (ctx.query.get('q') ?? '').toLowerCase();
      const items = this.registry
        .all()
        .filter((entry) => (!status || entry.status === status) && (!q || entry.title.toLowerCase().includes(q) || entry.id.includes(q)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        // The preview image kept on this node (or the remote one of discovered content).
        .map((entry) => ({
          ...entry,
          thumbnail: entry.thumbnail ? `/v1/thumbnails/${this.registry.thumbKey(entry.id)}` : entry.thumbnailUrl,
        }));
      return pageOf(items, ctx.query.get('cursor') ?? undefined, 100);
    });
    router.put('/v1/admin/content', async (ctx) => {
      admin(ctx);
      const body = await readJson<Partial<Entry> & { id: string; thumbnail?: string | boolean }>(ctx.req, 512 * 1024);
      const { thumbnail, ...rest } = body;
      // Whatever the operator touches is theirs: the crawler will not change it again.
      const entry = this.registry.upsert({ ...rest, origin: rest.origin ?? 'operator' });
      if (typeof thumbnail === 'string') this.registry.setThumbnail(entry.id, thumbnail);
      else this.cacheThumbnail(entry);
      return this.registry.get(entry.id);
    });
    router.post('/v1/admin/content/:id/block', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ reason?: string }>(ctx.req);
      return this.registry.block(ctx.params.id, body.reason);
    });
    router.post('/v1/admin/blocklist', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ ids?: string[]; reason?: string }>(ctx.req, 4 * 1024 * 1024);
      const ids = (body.ids ?? []).filter((id) => parseContentId(String(id)));
      for (const id of ids) this.registry.block(id, body.reason);
      return { blocked: ids.length };
    });
    router.delete('/v1/admin/content/:id', (ctx) => {
      admin(ctx);
      return { removed: this.registry.remove(ctx.params.id) };
    });
    router.get('/v1/admin/creators', (ctx) => {
      admin(ctx);
      return { creators: Object.values(this.registry.data.creators) };
    });
    router.put('/v1/admin/creators', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ id: string; accounts?: { platform: string; handle: string; url?: string }[] }>(ctx.req);
      if (Array.isArray(body.accounts) && body.accounts.length > Math.max(0, this.config.maxCreatorAccounts)) {
        throw badRequest(`A creator may link at most ${this.config.maxCreatorAccounts} accounts`);
      }
      return this.registry.upsertCreator(body);
    });
    router.get('/v1/admin/suggestions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(this.contributions.data.suggestions)
        .filter((s) => s.status === status)
        .sort((a, b) => b.votes.length - a.votes.length || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({ ...s, title: this.registry.get(s.contentId)?.title }));
      return { suggestions };
    });
    router.post('/v1/admin/suggestions/:id/:action', (ctx) => {
      admin(ctx);
      const suggestion = this.contributions.data.suggestions[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        if (suggestion.kind === 'report') this.registry.block(suggestion.contentId, `reported: ${suggestion.value}`);
        this.acceptSuggestion(suggestion);
      } else if (ctx.params.action === 'reject') {
        suggestion.status = 'rejected';
        suggestion.reviewedAt = new Date().toISOString();
        this.contributions.changed();
      } else throw notFound();
      return { ok: true };
    });
    router.get('/v1/admin/submissions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const submissions = Object.values(this.contributions.data.submissions)
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({ ...s, thumbnail: s.hasThumbnail ? `/v1/thumbnails/${this.registry.thumbKey(s.contentId)}` : undefined }));
      return { submissions };
    });
    router.post('/v1/admin/submissions/:id/:action', async (ctx) => {
      admin(ctx);
      const submission = this.contributions.data.submissions[ctx.params.id];
      if (!submission) throw notFound('No such submission');
      const body = await readJson<Partial<Entry> & { note?: string; creatorName?: string; creatorKind?: CreatorKind }>(ctx.req);
      if (ctx.params.action === 'accept') {
        const { note, ...overrides } = body;
        submission.note = note;
        return this.acceptSubmission(submission, overrides);
      }
      if (ctx.params.action === 'reject') {
        submission.status = 'rejected';
        submission.note = body.note;
        submission.reviewedAt = new Date().toISOString();
        this.contributions.changed();
        return submission;
      }
      throw notFound();
    });
    router.get('/v1/admin/crawler', (ctx) => {
      admin(ctx);
      return this.crawler.status();
    });
    // Every source, with its priority, whether the crawler may use it and how much it gave.
    router.get('/v1/admin/sources', (ctx) => {
      admin(ctx);
      const counts = new Map<string, { listed: number; pending: number }>();
      for (const entry of this.registry.all()) {
        const key = sourceKeyOf(entry);
        const count = counts.get(key) ?? { listed: 0, pending: 0 };
        if (entry.status === 'listed') count.listed++;
        if (entry.status === 'pending') count.pending++;
        counts.set(key, count);
      }
      const crawlable = new Set(this.crawler.status().adapters.map((adapter) => adapter.id));
      return {
        sources: SOURCE_CATALOG.map((source) => ({
          ...source,
          priority: priorityOf(source.key, this.config.sources.priorities),
          crawled: crawlable.has(source.key),
          blocked: this.config.crawler.blockedSources.includes(source.key),
          ...(counts.get(source.key) ?? { listed: 0, pending: 0 }),
        })),
        sites: this.config.crawler.sites,
      };
    });
    router.post('/v1/admin/crawler/run', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ adapter?: string; target?: string }>(ctx.req);
      try {
        return await this.crawler.runOnce(body.adapter, body.target);
      } catch (error) {
        throw new HttpError(502, 'crawl_failed', (error as Error).message);
      }
    });
    router.post('/v1/admin/crawler/seeds', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ url?: string }>(ctx.req);
      let url: URL;
      try {
        url = new URL(String(body.url ?? ''));
      } catch {
        throw badRequest('url must be an http(s) URL');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('url must be an http(s) URL');
      const seeds = this.configFile.data.crawler.adapters.web.seeds;
      if (!seeds.includes(url.toString())) seeds.push(url.toString());
      this.configFile.changed();
      return { seeds };
    });
    router.post('/v1/admin/content/bulk', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ ids?: string[]; status?: 'listed' | 'blocked' | 'forget'; reason?: string }>(ctx.req, 4 * 1024 * 1024);
      const ids = (body.ids ?? []).map(String).slice(0, 5000);
      for (const id of ids) {
        if (body.status === 'forget') this.registry.remove(id);
        else if (body.status === 'blocked') this.registry.block(id, body.reason);
        else if (body.status === 'listed') this.registry.upsert({ id, status: 'listed', origin: 'operator' });
      }
      return { updated: ids.length };
    });
    router.post('/v1/admin/import', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ provider?: string; limit?: number }>(ctx.req);
      return this.importCatalog(String(body.provider ?? ''), Math.min(1000, Number(body.limit ?? 200)));
    });
    // Peering with other nodes: metadata of a cid or a link, and discoveries by criteria.
    router.get('/v1/admin/peers', (ctx) => {
      admin(ctx);
      return { peers: this.config.peering.peers };
    });
    router.put('/v1/admin/peers', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ peers?: { ref: string; fetch?: boolean; serve?: boolean }[] }>(ctx.req);
      const peers = (body.peers ?? []).slice(0, 100).map((entry) => {
        const ref = parseNodeRef(String(entry.ref ?? ''));
        if (!ref) throw badRequest('Every peer must be a node reference');
        return { ref: String(entry.ref).trim(), fetch: entry.fetch !== false, serve: entry.serve !== false };
      });
      this.configFile.data.peering = { ...this.configFile.data.peering, peers };
      this.configFile.changed();
      return { peers };
    });
    router.post('/v1/admin/peers/metadata', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ peer?: string; id?: string; link?: string; adopt?: boolean }>(ctx.req);
      const peers = this.peersToFetch(body.peer);
      if (!peers.length) throw badRequest('No peer set to fetch from');
      const ref = String(body.id ?? body.link ?? '').trim();
      if (!ref) throw badRequest('id or link is required');
      const results: { peer: string; entry?: PeerEntry; error?: string }[] = [];
      for (const entry of peers) {
        try {
          const answer = await this.peerClient(entry).json<{ entry: PeerEntry | null }>('/v1/peers/metadata', {
            body: { id: body.id, link: body.link },
            timeoutMs: 30000,
          });
          if (answer.entry && body.adopt) this.adoptPeerEntry(answer.entry);
          results.push({ peer: entry.ref, entry: answer.entry ?? undefined });
        } catch (error) {
          results.push({ peer: entry.ref, error: (error as Error).message });
        }
      }
      return { results };
    });
    router.post('/v1/admin/peers/discover', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ peer?: string; criteria?: PeerDiscoverCriteria; adopt?: boolean }>(ctx.req);
      const peers = this.peersToFetch(body.peer);
      if (!peers.length) throw badRequest('No peer set to fetch from');
      const results: { peer: string; items: PeerEntry[]; error?: string }[] = [];
      for (const entry of peers) {
        try {
          const answer = await this.peerClient(entry).json<{ items: PeerEntry[] }>('/v1/peers/discover', {
            body: { criteria: body.criteria ?? {} },
            timeoutMs: 60000,
          });
          if (body.adopt) for (const item of answer.items) this.adoptPeerEntry(item);
          results.push({ peer: entry.ref, items: answer.items });
        } catch (error) {
          results.push({ peer: entry.ref, items: [], error: (error as Error).message });
        }
      }
      return { results };
    });
  }

  /**
   * Reads a provider's catalog and queues what it hosts for review. Nothing is
   * listed until the operator accepts it: the node decides what it shows.
   */
  async importCatalog(provider: string, limit: number): Promise<{ queued: number; skipped: number }> {
    const ref = parseNodeRef(provider);
    if (!ref) throw badRequest('provider must be a node reference or URL');
    let queued = 0;
    let skipped = 0;
    let offset = 0;
    while (queued + skipped < limit) {
      const page = await requestJson<{
        items: { cid: string; name: string; createdAt: string; meta?: SubmissionRequest; sources?: string[]; creator?: { id: string; name?: string; kind?: CreatorKind } }[];
        next?: number;
      }>(`${ref.url}/v1/catalog?offset=${offset}&limit=100`, { transport: this.transport(ref.url) });
      for (const item of page.items) {
        const id = [item.cid, ...(item.sources ?? [])].join('~');
        const known = this.registry.get(item.cid);
        const pending = Object.values(this.contributions.data.submissions).some((s) => s.contentId.split('~')[0] === item.cid);
        if (known || pending) {
          skipped++;
          continue;
        }
        const meta = item.meta ?? ({} as Partial<SubmissionRequest>);
        const verifiedCreator = item.creator ? await this.verifyCreator(ref.url, item.cid) : undefined;
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
            topics: meta.topics,
            tags: meta.tags,
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
        this.contributions.data.submissions[submission.id] = submission;
        queued++;
      }
      if (page.next === undefined || !page.items.length) break;
      offset = page.next;
    }
    this.contributions.changed();
    log.info(`Queued ${queued} items from ${ref.url} for review`);
    return { queued, skipped };
  }

  /** Fetches the manifest and checks its creator signature here, rather than trusting the provider. */
  private async verifyCreator(providerUrl: string, cid: string): Promise<string | undefined> {
    try {
      const manifest = validateManifest(await requestJson(`${providerUrl}/v1/content/${cid}`, { transport: this.transport(providerUrl) }));
      return contentIdOf(manifest) === cid ? manifest.creator?.id : undefined;
    } catch {
      return undefined;
    }
  }

  protected adminStatus(): Record<string, unknown> {
    const data = this.contributions.data;
    return {
      registry: this.registry.stats(),
      pending: {
        suggestions: Object.values(data.suggestions).filter((s) => s.status === 'pending').length,
        submissions: Object.values(data.submissions).filter((s) => s.status === 'pending').length,
      },
    };
  }

  flush(): void {
    super.flush();
    this.registry.flush();
    this.contributions.flush();
    this.crawler.flush();
  }
}
