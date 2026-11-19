import { isKeyId } from '../shared/crypto.js';
// The search algorithm node: this file is the coordinator. The node's state lives on
// AlgorithmNode below; the routes and the domain logic around them are grouped by
// subject in ./routes, and the shared building blocks live next to it. Every public
// method of the node is kept here, delegating to the module that holds its logic.

import { join } from 'node:path';
import { type Account } from '../node/ledger.js';
import { type BaseConfig, BaseNode, DEFAULT_NODE_TOR, type NodeOptions } from '../node/node.js';
import { defaultCryptoPaymentConfigs } from '../node/payments.js';
import { type Ctx, HttpError, badRequest } from '../shared/node/http.js';
import { log } from '../shared/node/log.js';
import { type AccountLinkProposal, type AccountLinkResponse, type AlgorithmInfo, type AlgorithmPricing, type AlgorithmRewards, type BloomStorageTier, type ClaimRequest, type ClaimResponse, type ContentItem, type CreatorAccountLinkRequest, type CreatorContentRequest, type CreatorContentResponse, type CreatorContentSuggestion, type CreatorIconRequest, type CreatorIconResponse, type CreatorIconSuggestion, type CreatorInfo, type GroupSuggestion, type GroupSuggestionRequest, type GroupSuggestionResponse, type PeerDiscoverCriteria, type PeerEntry, type Preferences, type ReportResponse, type SubmissionRequest, type SuggestionRequest, type TopicCreateRequest, type TopicCreateResponse, type TopicInfo, type TopicSuggestion, type TopicSuggestionRequest, type TopicSuggestionResponse } from '../shared/protocol.js';
import { JsonFile } from '../shared/node/store.js';
import { type CreatorKind, RATINGS, type Rating, TOPICS } from '../shared/taxonomy.js';
import { type RankingConfig, STRATEGY_DESCRIPTIONS } from './ranking.js';
import { type ClaimConfig, claimDefaults } from './metrics.js';
import { Crawler, type CrawlerConfig, crawlerDefaults } from './crawler/crawler.js';
import { type Discovered } from './crawler/types.js';
import { type CreatorRecord, type Entry, Registry } from './registry.js';
import { prioritize, sourceKeyOf } from './sources.js';
import { BLOOM_EXPECTED_ITEMS, BLOOM_EXPECTED_MAX, BloomFilter, type BloomFilterData, optimalHashCount } from '../shared/bloom.js';
import { type ContributionData, type Submission, type Suggestion } from './contributions.js';
import { type CensorshipData, type CommentsData } from './routes/comments.js';
import { acceptAccountLink, acceptCreatorContent, acceptCreatorIcon, acceptSuggestion, linkAccounts, report, suggest, suggestCreatorContent, suggestCreatorIcon } from './routes/suggestions.js';
import { acceptSubmission, claim, importCatalog, submit } from './routes/content.js';
import { acceptGroupSuggestion, acceptTopicSuggestion, createTopic, groupView, topicView } from './routes/creators.js';
import { startPeering, stopPeering } from './routes/peers.js';
import { registerContentRoutes } from './routes/content.js';
import { registerCommentsRoutes } from './routes/comments.js';
import { registerCreatorsRoutes } from './routes/creators.js';
import { registerSuggestionsRoutes } from './routes/suggestions.js';
import { registerPeersRoutes } from './routes/peers.js';
import { registerPeerSyncRoutes } from './routes/peer-sync.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerSyndicationRoutes } from './routes/syndication.js';
import * as creators from './routes/creators.js';
import * as suggestions from './routes/suggestions.js';
import * as content from './routes/content.js';
import * as peers from './routes/peers.js';

export { nativeSuggestions } from './support.js';
export { normalizeCensorWord, censorTokens, isCensoredVariant } from './routes/comments.js';

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
  /**
   * Whether anyone may propose accounts for a creator without the creator's key (only
   * external links to the creator, and the operator decides whether to link them).
   */
  allowUnsignedAccountLinks: boolean;
  /**
   * How the operator's console lists the catalog and the creators: lazy loading (more
   * as you scroll) or pagination, with how many items per page for each.
   */
  console: {
    catalog: { paging: 'lazy' | 'pages'; perPage: number };
    creators: { paging: 'lazy' | 'pages'; perPage: number };
  };
  /** Finding content on other platforms (YouTube, PeerTube, Mastodon, Flickr…) by itself. */
  crawler: CrawlerConfig;
  /**
   * How strongly each source of content is favoured in feeds and searches, 0–10 (0 =
   * never shown). Sources not listed are at 5, except VibeShare's own content at 10.
   */
  sources: { priorities: Record<string, number> };
  /**
   * Seen-content bloom filters clients send so this node stops suggesting what they have
   * already seen: small ones travel inside requests (at most `inlineMaxBits` bits), one may
   * be kept per account for the prices and durations the operator sets (`tiers`), and the
   * account's own much larger filter is kept long term (at most `accountMaxBits` bits),
   * refreshed by hand or by the client's resubmission job.
   */
  bloom: {
    inlineMaxBits: number;
    accountMaxBits: number;
    storage: { tiers: BloomStorageTier[] };
  };
  /**
   * Comments on content pages: a hash-chained log the clients verify themselves. The node
   * writes the ids and times, rate limits each account, and may keep the data of a comment
   * back while its block header stays.
   */
  comments: {
    /** The most comment blocks one account may add per hour (0 = unlimited). */
    maxPerHour: number;
    /** The longest comment, in characters. */
    maxLength: number;
    /** Where comment data is kept: here (the default), or sent to a content provider. */
    storage: 'node' | 'provider';
    /** The content provider that keeps the comment data when storage is 'provider'. */
    provider?: { url: string };
  };
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
    transfers: { minSenderBalance: 1000 },
    signup: { grant: 100, powBits: 0, anonymous: true, perIpPerHour: 30 },
    payments: [{ id: 'voucher', type: 'voucher' }, ...defaultCryptoPaymentConfigs()],
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
    allowUnsignedAccountLinks: true,
    console: {
      catalog: { paging: 'lazy', perPage: 50 },
      creators: { paging: 'lazy', perPage: 50 },
    },
    crawler: crawlerDefaults(),
    sources: { priorities: { vibeshare: 10 } },
    bloom: {
      inlineMaxBits: 32_768,
      accountMaxBits: 1_048_576,
      storage: {
        tiers: [
          { id: 'day', label: '1 day · up to 32 Kibit', maxBits: 32_768, durationSeconds: 86_400, price: 1 },
          { id: 'week', label: '1 week · up to 256 Kibit', maxBits: 262_144, durationSeconds: 604_800, price: 5 },
          { id: 'month', label: '30 days · up to 1 Mibit', maxBits: 1_048_576, durationSeconds: 2_592_000, price: 20 },
        ],
      },
    },
    comments: { maxPerHour: 30, maxLength: 2_000, storage: 'node' },
    peering: {
      peers: [],
      job: { enabled: false, intervalMs: 3_600_000, adopt: true, limit: 50 },
      respondIntervalMs: 0,
      bootstrap: [],
      maxPeers: 32,
    },
  };
}

export class AlgorithmNode extends BaseNode<AlgorithmConfig> {
  readonly registry: Registry;
  contributions: JsonFile<ContributionData>;
  /** Seen-content bloom filters kept for accounts: a paid copy (until it expires), and the
   *  account's own much larger filter, kept long term until it is dropped. */
  blooms: JsonFile<{
    stored: Record<string, { filter: BloomFilterData; expiresAt: string }>;
    accounts: Record<string, { filter: BloomFilterData; updatedAt: string }>;
  }>;
  /** Comments on content pages: one hash-chained log per content id. */
  comments: JsonFile<CommentsData>;
  /** The operator's censored words: two small sets kept on the comments page. */
  censorship: JsonFile<CensorshipData>;

  readonly crawler: Crawler;
  lastPrune = 0;
  /** Preview images being fetched right now (a few at a time). */
  thumbFetching = 0;

  constructor(options: NodeOptions<AlgorithmConfig>) {
    super('algorithm', algorithmDefaults(), options);
    this.registry = new Registry(this.path('registry.json'), options.dataDir ? join(options.dataDir, 'thumbnails') : null, this.traces);
    this.contributions = new JsonFile(this.path('contributions.json'), () => ({
      votes: {},
      suggestions: {},
      submissions: {},
      creatorSuggestions: {},
      iconSuggestions: {},
      accountLinks: {},
      groupSuggestions: {},
      topicSuggestions: {},
    }));
    this.blooms = new JsonFile(this.path('blooms.json'), () => ({ stored: {}, accounts: {} }));
    this.blooms.data.accounts ??= {};
    this.comments = new JsonFile(this.path('comments.json'), () => ({ sections: {}, recent: {} }));
    this.censorship = new JsonFile(this.path('censorship.json'), (): CensorshipData => ({ words: [], adjacent: [] }));
    this.censorship.data.words ??= [];
    this.censorship.data.adjacent ??= [];
    // Nothing is kept for a content page that has no comments: drop the empty sections
    // that earlier versions left behind when a page was merely read.
    for (const [key, section] of Object.entries(this.comments.data.sections)) {
      if (!section.blocks.length) {
        delete this.comments.data.sections[key];
        this.comments.changed();
      }
    }
    this.crawler = new Crawler(
      () => this.config.crawler,
      this.path('crawler.json'),
      (items) => this.ingest(items),
      (url) => this.transport(url.href)?.fetch,
      this.traces
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
    this.traces.trace('basic', 'algorithm.crawler', 'function:ingest', {
      message: `${added} new of ${items.length} discovered`,
      data: { items: items.length, added },
    });
    return added;
  }

  /**
   * Keeps the preview image of a video, stream or image here, once. Serving content to
   * clients then never has to look the preview up on the platform again.
   */
  cacheThumbnail(entry: Entry): void {
    if (entry.thumbnail || !entry.thumbnailUrl || this.thumbFetching >= 4) return;
    const url = entry.thumbnailUrl;
    if (!/^https?:\/\//.test(url)) return;
    this.thumbFetching++;
    const started = Date.now();
    void (async () => {
      // One event per preview fetch: what was asked for and what came of it.
      let outcome = 'stored';
      let status: number | undefined;
      let bytes = 0;
      try {
        const send = this.transport(url)?.fetch ?? fetch;
        const response = await send(url, { signal: AbortSignal.timeout(15_000) });
        status = response.status;
        const type = (response.headers.get('content-type') ?? '').split(';')[0];
        if (!response.ok) outcome = `http ${response.status}`;
        else if (!/^image\/(jpeg|png|webp)$/.test(type)) outcome = `not an image (${type.slice(0, 30) || 'no type'})`;
        else {
          const data = Buffer.from(await response.arrayBuffer());
          bytes = data.length;
          if (!data.length) outcome = 'empty image';
          else if (data.length > 200 * 1024) outcome = 'too large';
          else this.registry.setThumbnail(entry.id, `data:${type};base64,${data.toString('base64')}`);
        }
      } catch (error) {
        outcome = 'failed';
        log.debug(`Preview of ${entry.id}: ${(error as Error).message}`);
        this.traces.trace('error', 'algorithm.thumbnails', 'function:cacheThumbnail', {
          message: `${entry.id.slice(0, 24)} preview failed`,
          error: (error as Error).message,
        });
      } finally {
        this.thumbFetching--;
        this.traces.trace('dependency', 'algorithm.thumbnails', 'fetch preview', {
          message: `${entry.id.slice(0, 24)} · ${outcome}`,
          data: this.traces.summarize({ id: entry.id.slice(0, 32), url, method: 'GET', ms: Date.now() - started, status, bytes, outcome }),
        });
      }
    })();
  }

  async start(): Promise<void> {
    await super.start();
    this.crawler.start();
    startPeering(this);
  }

  async stop(): Promise<void> {
    stopPeering(this);
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
      bloom: { inlineMaxBits: config.bloom.inlineMaxBits, accountMaxBits: config.bloom.accountMaxBits, storage: config.bloom.storage },
      maxCreatorAccounts: config.maxCreatorAccounts,
    };
  }

  protected validateConfig(config: AlgorithmConfig): void {
    if (!RATINGS.includes(config.policy.maxRating) || !RATINGS.includes(config.policy.defaultMaxRating)) {
      throw badRequest('Unknown rating in policy');
    }
    for (const [key, value] of Object.entries(config.sources?.priorities ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) throw badRequest(`Priority of ${key} must be 0–10`);
    }
    if (!['node', 'provider'].includes(config.comments?.storage)) throw badRequest('comments.storage is node or provider');
    if (config.comments.storage === 'provider' && !config.comments.provider?.url) {
      throw badRequest('comments.storage provider needs comments.provider.url');
    }
    const crawler = config.crawler;
    if (!Array.isArray(crawler.blockedSources) || crawler.blockedSources.some((key) => typeof key !== 'string')) {
      throw badRequest('crawler.blockedSources is a list of source names');
    }
    for (const list of [crawler.sites?.allow, crawler.sites?.block]) {
      if (!Array.isArray(list) || list.some((site) => typeof site !== 'string')) throw badRequest('crawler.sites.allow and .block are lists of sites');
    }
    if (!Array.isArray(crawler.modules) || crawler.modules.some((path) => typeof path !== 'string')) {
      throw badRequest('crawler.modules is a list of module paths');
    }
    for (const [id, adapter] of Object.entries(crawler.adapters) as [string, { dailyLimit?: unknown; searchShare?: unknown }][]) {
      if (adapter.dailyLimit !== undefined && !(Number(adapter.dailyLimit) >= 0)) throw badRequest(`${id}: daily limit must be 0 or more`);
      if (adapter.searchShare !== undefined && !(Number(adapter.searchShare) >= 0 && Number(adapter.searchShare) <= 1)) {
        throw badRequest(`${id}: the share kept for searches is between 0 and 1`);
      }
    }
    const bloom = config.bloom;
    if (!Number.isInteger(bloom.inlineMaxBits) || bloom.inlineMaxBits < 8 || bloom.inlineMaxBits > 1_048_576) {
      throw badRequest('bloom.inlineMaxBits is a bit count between 8 and 1,048,576');
    }
    if (!Number.isInteger(bloom.accountMaxBits) || bloom.accountMaxBits < 8 || bloom.accountMaxBits > 1_048_576) {
      throw badRequest('bloom.accountMaxBits is a bit count between 8 and 1,048,576');
    }
    for (const list of [config.console?.catalog, config.console?.creators]) {
      if (!list || !['lazy', 'pages'].includes(list.paging)) throw badRequest('console paging is lazy or pages');
      if (!Number.isInteger(list.perPage) || list.perPage < 5 || list.perPage > 500) throw badRequest('console perPage is between 5 and 500');
    }
    if (!Array.isArray(bloom.storage?.tiers)) throw badRequest('bloom.storage.tiers is a list of storage tiers');
    const tierIds = new Set<string>();
    for (const tier of bloom.storage.tiers) {
      if (typeof tier.id !== 'string' || !tier.id.trim() || tierIds.has(tier.id)) throw badRequest('Every bloom storage tier needs its own id');
      tierIds.add(tier.id);
      if (!(Number(tier.maxBits) >= 1) || !(Number(tier.durationSeconds) >= 0) || !(Number(tier.price) >= 0)) {
        throw badRequest(`${tier.id}: a bloom storage tier has maxBits, durationSeconds and a price`);
      }
    }
  }

  /**
   * What feeds and searches may serve: crawler finds of blocked sources are left out, and
   * source priorities reorder the rest (priority 0 hides a source).
   */
  bySource(entries: Entry[]): Entry[] {
    const blocked = new Set(this.config.crawler.blockedSources);
    const servable = blocked.size ? entries.filter((entry) => !(entry.origin === 'crawler' && blocked.has(sourceKeyOf(entry)))) : entries;
    return prioritize(servable, this.config.sources.priorities, this.traces);
  }

  charge(ctx: Ctx, price: number, reason: string): Account | undefined {
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

  preferencesOf(input: Preferences | undefined): Preferences {
    const preferences = { ...(input ?? {}) };
    if (!preferences.maxRating || !RATINGS.includes(preferences.maxRating)) preferences.maxRating = this.config.policy.defaultMaxRating;
    return preferences;
  }

  /** One public result, with preview URLs unless this request explicitly declined them. */
  clientView(entry: Entry, previews: boolean, nativeSuggestion = false): ContentItem {
    const item = this.registry.view(entry);
    if (!previews) delete item.thumbnail;
    return { ...item, nativeSuggestion: nativeSuggestion || undefined };
  }

  limitOf(value: unknown): number {
    const limit = Math.floor(Number(value ?? this.config.pageSize));
    return Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : this.config.pageSize));
  }

  /** The page size of the operator's console lists (5–500, 100 when not given). */
  listLimit(value: string | null): number {
    const limit = Math.floor(Number(value));
    return Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.max(5, limit)) : 100;
  }

  canEarn(account: Account): boolean {
    return !this.config.rewards.requireIdentity || account.kind === 'key';
  }

  /** The user's stored filter on this node, while it has not expired. */
  storedBloom(accountId: string): BloomFilter | null {
    const record = this.blooms.data.stored[accountId];
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      delete this.blooms.data.stored[accountId];
      this.blooms.changed();
      return null;
    }
    try {
      return BloomFilter.from(record.filter);
    } catch (error) {
      // A stored filter that no longer reads is dropped from the request, not fatal.
      this.traces.trace('error', 'algorithm.bloom', 'function:storedBloom', {
        message: `${accountId.slice(0, 16)} stored filter unreadable`,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /** The account's own long-term filter here, kept until it is dropped. */
  accountBloom(accountId: string): BloomFilter | null {
    const record = this.blooms.data.accounts[accountId];
    if (!record) return null;
    try {
      return BloomFilter.from(record.filter);
    } catch (error) {
      this.traces.trace('error', 'algorithm.bloom', 'function:accountBloom', {
        message: `${accountId.slice(0, 16)} account filter unreadable`,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /** A filter sent or stored in its `{ v, m, k, data }` form; refused when it is malformed. */
  parseBloom(value: unknown, maxBits: number): BloomFilter | null {
    if (value === undefined || value === null) return null;
    const data = value as Partial<BloomFilterData>;
    if (data.v !== 1 || !Number.isInteger(data.m) || Number(data.m) < 1 || Number(data.m) > maxBits) {
      throw badRequest(`A bloom filter is at most ${maxBits} bits`);
    }
    const expected = Number(data.n ?? BLOOM_EXPECTED_ITEMS);
    if (!Number.isInteger(expected) || expected < 1 || expected > BLOOM_EXPECTED_MAX) {
      throw badRequest(`A bloom filter is made for 1 to ${BLOOM_EXPECTED_MAX} items`);
    }
    if (!Number.isInteger(data.k) || Number(data.k) !== optimalHashCount(Number(data.m), expected)) {
      throw badRequest(`A bloom filter of ${data.m} bits for ${expected} items uses ${optimalHashCount(Number(data.m), expected)} hash functions`);
    }
    try {
      return BloomFilter.from(data as BloomFilterData);
    } catch {
      throw badRequest('The bloom filter bits do not match its size');
    }
  }

  /** The filters of one request: the account's copies kept here, plus the one carried along. */
  seenFilters(ctx: Ctx, body: { bloom?: unknown }): BloomFilter[] {
    const filters: BloomFilter[] = [];
    const account = this.auth.account(ctx);
    if (account) {
      const stored = this.storedBloom(account.id);
      if (stored) filters.push(stored);
      const own = this.accountBloom(account.id);
      if (own) filters.push(own);
    }
    const inline = this.parseBloom(body.bloom, this.config.bloom.inlineMaxBits);
    if (inline) filters.push(inline);
    return filters;
  }

  /** Leaves out content the user has seen: any of its cid or links colliding is enough. */
  withoutSeen(entries: Entry[], filters: BloomFilter[]): Entry[] {
    if (!filters.length) return entries;
    const kept = entries.filter((entry) => {
      const identity = { id: entry.id, contentId: entry.contentId, link: entry.link, sources: entry.sources };
      return !filters.some((filter) => filter.seesContent(identity));
    });
    // One summary of the seen-filter pass: how much it hid, never what it hid.
    this.traces.trace('basic', 'algorithm.bloom', 'function:withoutSeen', {
      message: `${entries.length - kept.length} of ${entries.length} items already seen`,
      data: { filters: filters.length, before: entries.length, hidden: entries.length - kept.length },
    });
    return kept;
  }

  lookup(id: string) {
    const result = this.registry.lookup(id);
    if (result.status === 'unknown' || result.status === 'blocked') return { ...result, id };
    return result;
  }

  /** Moderation entries travel with the same peers content metadata syncs with. */
  protected moderationPeers(): string[] {
    return this.config.peering.peers.map((peer) => peer.ref);
  }

  peeringTimer: ReturnType<typeof setInterval> | null = null;
  /** When each peer was last answered, so the node responds at its own pace. */
  respondTimes = new Map<string, number>();

  /** The config as stored, before command line overrides are merged over it: routes
   *  that save config edits write through here and call configChanged(). */
  get configData(): AlgorithmConfig {
    return this.configFile.data;
  }

  /** Marks the config file changed after a route edited `configData` in place. */
  configChanged(): void {
    this.configFile.changed();
  }

  groupView(rawId: string): { group: CreatorInfo; members: CreatorInfo[]; items: ContentItem[] } {
    return creators.groupView(this, rawId);
  }

  topicView(rawId: string): { topic: TopicInfo; items: ContentItem[] } {
    return creators.topicView(this, rawId);
  }

  createTopic(_account: Account, body: TopicCreateRequest): TopicCreateResponse {
    return creators.createTopic(this, _account, body);
  }

  suggestGroup(account: Account, rawId: string, body: GroupSuggestionRequest): GroupSuggestionResponse {
    return creators.suggestGroup(this, account, rawId, body);
  }

  acceptGroupSuggestion(suggestion: GroupSuggestion): number {
    return creators.acceptGroupSuggestion(this, suggestion);
  }

  suggestTopic(account: Account, rawId: string, body: TopicSuggestionRequest): TopicSuggestionResponse {
    return creators.suggestTopic(this, account, rawId, body);
  }

  acceptTopicSuggestion(suggestion: TopicSuggestion): number {
    return creators.acceptTopicSuggestion(this, suggestion);
  }

  suggest(account: Account, body: SuggestionRequest) {
    return suggestions.suggest(this, account, body);
  }

  acceptSuggestion(suggestion: Suggestion): void {
    suggestions.acceptSuggestion(this, suggestion);
  }

  linkAccounts(account: Account, body: CreatorAccountLinkRequest): AccountLinkResponse {
    return suggestions.linkAccounts(this, account, body);
  }

  acceptAccountLink(proposal: AccountLinkProposal): CreatorRecord {
    return suggestions.acceptAccountLink(this, proposal);
  }

  suggestCreatorContent(account: Account, rawCreator: string, body: CreatorContentRequest): CreatorContentResponse {
    return suggestions.suggestCreatorContent(this, account, rawCreator, body);
  }

  acceptCreatorContent(suggestion: CreatorContentSuggestion): number {
    return suggestions.acceptCreatorContent(this, suggestion);
  }

  suggestCreatorIcon(account: Account, rawCreator: string, body: CreatorIconRequest): CreatorIconResponse {
    return suggestions.suggestCreatorIcon(this, account, rawCreator, body);
  }

  acceptCreatorIcon(suggestion: CreatorIconSuggestion): number {
    return suggestions.acceptCreatorIcon(this, suggestion);
  }

  report(ctx: Ctx, account: Account, raw: string): ReportResponse {
    return suggestions.report(this, ctx, account, raw);
  }

  claim(ctx: Ctx, account: Account, body: ClaimRequest): ClaimResponse {
    return content.claim(this, ctx, account, body);
  }

  submit(account: Account, body: SubmissionRequest): Submission {
    return content.submit(this, account, body);
  }

  acceptSubmission(submission: Submission, overrides: Partial<Entry> & { creatorName?: string; creatorKind?: CreatorKind }): Entry {
    return content.acceptSubmission(this, submission, overrides);
  }

  discover(criteria: PeerDiscoverCriteria): PeerEntry[] {
    return peers.discover(this, criteria);
  }

  async runPeerSearch(): Promise<{ peer: string; items: number; adopted: number; error?: string }[]> {
    return peers.runPeerSearch(this);
  }

  async bootstrapPeers(): Promise<string[]> {
    return peers.bootstrapPeers(this);
  }

  async importCatalog(provider: string, limit: number): Promise<{ queued: number; skipped: number }> {
    return content.importCatalog(this, provider, limit);
  }

  /**
   * A creator id is not an account id: the credits go to the account of the creator's
   * signing key (the key its manifests are signed with). Without a key the creator
   * cannot receive credits yet — the caller tells the user to use a vk1… id instead.
   */
  protected override resolveCreatorAccount(creatorId: string): { id: string; name?: string } | null {
    const creator = this.registry.creator(creatorId);
    if (!creator) return null;
    const key = (creator.keys ?? []).find((candidate) => isKeyId(candidate));
    return key ? { id: key, name: creator.name } : null;
  }

  protected adminStatus(): Record<string, unknown> {
    const data = this.contributions.data;
    return {
      registry: this.registry.stats(),
      pending: {
        suggestions: Object.values(data.suggestions).filter((s) => s.status === 'pending').length,
        submissions: Object.values(data.submissions).filter((s) => s.status === 'pending').length,
        creatorSuggestions: Object.values(data.creatorSuggestions ?? {}).filter((s) => s.status === 'pending').length,
        iconSuggestions: Object.values(data.iconSuggestions ?? {}).filter((s) => s.status === 'pending').length,
        accountLinks: Object.values(data.accountLinks ?? {}).filter((p) => p.status === 'pending').length,
        groupSuggestions: Object.values(data.groupSuggestions ?? {}).filter((s) => s.status === 'pending').length,
        topicSuggestions: Object.values(data.topicSuggestions ?? {}).filter((s) => s.status === 'pending').length,
      },
    };
  }

  flush(): void {
    super.flush();
    this.registry.flush();
    this.contributions.flush();
    this.censorship.flush();
    this.crawler.flush();
  }

  protected registerRoutes(): void {
    registerContentRoutes(this);
    registerCommentsRoutes(this);
    registerCreatorsRoutes(this);
    registerSuggestionsRoutes(this);
    registerPeersRoutes(this);
    registerPeerSyncRoutes(this);
    registerAdminRoutes(this);
    registerSyndicationRoutes(this);
  }
}

