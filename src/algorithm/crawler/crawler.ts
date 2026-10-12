import { log } from '../../shared/log.js';
import { JsonFile } from '../../shared/store.js';
import { TOPICS, type Rating } from '../../shared/taxonomy.js';
import { flickr, openverse, wikimedia, type FlickrConfig, type OpenverseConfig, type WikimediaConfig } from './adapters/images.js';
import { bluesky, lemmy, mastodon, type BlueskyConfig, type LemmyConfig, type MastodonConfig } from './adapters/social.js';
import { archive, dailymotion, peertube, youtube, type ArchiveConfig, type DailymotionConfig, type PeerTubeConfig, type YouTubeConfig } from './adapters/video.js';
import {
  API_ADAPTERS,
  deviantart,
  europeana,
  freesound,
  giphy,
  imgur,
  instagram,
  jamendo,
  pexels,
  reddit,
  spotify,
  tenor,
  tumblr,
  twitch,
  unsplash,
  vimeo,
  x,
} from './adapters/apis.js';
import { crawlPage, webDefaults, type WebConfig } from './adapters/web.js';
import { FetchFailed, PoliteFetcher, RobotsDisallowed, SiteBlocked } from './fetcher.js';
import { identifyLink } from './oembed.js';
import { BudgetUsed, type Adapter, type CrawlContext, type Discovered } from './types.js';
import { sourceKeyOf, sourceOfHost } from '../sources.js';

export interface CrawlerConfig {
  /** Discover content continuously in the background. */
  enabled: boolean;
  /** Sent with every request; robots.txt groups are matched against its first word. */
  userAgent: string;
  /** Work units running at the same time. */
  concurrency: number;
  /** Pause after each unit of work, per worker. */
  pauseMs: number;
  /** Minimum time between two requests to the same host (robots.txt Crawl-delay can raise it). */
  hostDelayMs: number;
  timeoutMs: number;
  /** Most entries the crawler keeps; the oldest unvoted ones go first. */
  maxEntries: number;
  /** List what the crawler finds right away (otherwise it waits in Review as "pending"). */
  autoList: boolean;
  /** Age rating of discovered content the platform did not flag. */
  defaultRating: Rating;
  /** Topics and words used to look for new content on platforms. */
  queries: string[];
  /** Also look for what users of this node search for. */
  learnFromSearches: boolean;
  /** Search the platforms too when a client searches this node. */
  searchPlatforms: boolean;
  /** How long a client search waits for platform results. */
  searchTimeoutMs: number;
  searchCacheMinutes: number;
  /** Crawl private network addresses (only for tests and intranets). */
  allowPrivateAddresses: boolean;
  /** Spacing of official API calls to one host (their own rate limits apply too). */
  apiDelayMs: number;
  /** Sources (platforms) the crawler must not use; their earlier finds are not served either. */
  blockedSources: string[];
  /** Websites (domains, subdomains included): never fetch `block`; with `allow` set, crawl only those sites' pages. */
  sites: { allow: string[]; block: string[] };
  adapters: {
    youtube: YouTubeConfig;
    peertube: PeerTubeConfig;
    dailymotion: DailymotionConfig;
    archive: ArchiveConfig;
    wikimedia: WikimediaConfig;
    openverse: OpenverseConfig;
    flickr: FlickrConfig;
    mastodon: MastodonConfig;
    bluesky: BlueskyConfig;
    lemmy: LemmyConfig;
    web: WebConfig;
    vimeo: typeof vimeo.defaults;
    twitch: typeof twitch.defaults;
    unsplash: typeof unsplash.defaults;
    pexels: typeof pexels.defaults;
    giphy: typeof giphy.defaults;
    tenor: typeof tenor.defaults;
    imgur: typeof imgur.defaults;
    deviantart: typeof deviantart.defaults;
    europeana: typeof europeana.defaults;
    reddit: typeof reddit.defaults;
    tumblr: typeof tumblr.defaults;
    x: typeof x.defaults;
    instagram: typeof instagram.defaults;
    spotify: typeof spotify.defaults;
    jamendo: typeof jamendo.defaults;
    freesound: typeof freesound.defaults;
  };
}

type AdapterId = keyof CrawlerConfig['adapters'];

const PLATFORM_ADAPTERS = [youtube, peertube, dailymotion, archive, wikimedia, openverse, flickr, mastodon, bluesky, lemmy, ...API_ADAPTERS] as unknown as Adapter[];

type Purpose = 'crawl' | 'search';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A domain list entry matches the host itself and its subdomains. */
function onList(host: string, list: string[]): boolean {
  const clean = host.toLowerCase().replace(/^www\./, '');
  return list.some((entry) => {
    const domain = entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    return domain && (clean === domain || clean.endsWith(`.${domain}`));
  });
}

export function crawlerDefaults(): CrawlerConfig {
  return {
    enabled: true,
    userAgent: 'VibeShareBot/0.1 (+https://github.com/MabzGamesStudio/VibeShare)',
    concurrency: 2,
    pauseMs: 4000,
    hostDelayMs: 2000,
    timeoutMs: 15000,
    maxEntries: 20000,
    autoList: true,
    defaultRating: '13+',
    queries: ['science', 'music', 'nature', 'art', 'travel', 'cooking', 'gaming', 'history', 'technology', 'comedy'],
    learnFromSearches: true,
    searchPlatforms: true,
    searchTimeoutMs: 3000,
    searchCacheMinutes: 30,
    allowPrivateAddresses: false,
    apiDelayMs: 250,
    blockedSources: [],
    sites: { allow: [], block: [] },
    adapters: {
      youtube: youtube.defaults as YouTubeConfig,
      peertube: peertube.defaults as PeerTubeConfig,
      dailymotion: dailymotion.defaults as DailymotionConfig,
      archive: archive.defaults as ArchiveConfig,
      wikimedia: wikimedia.defaults as WikimediaConfig,
      openverse: openverse.defaults as OpenverseConfig,
      flickr: flickr.defaults as FlickrConfig,
      mastodon: mastodon.defaults as MastodonConfig,
      bluesky: bluesky.defaults as BlueskyConfig,
      lemmy: lemmy.defaults as LemmyConfig,
      web: webDefaults,
      vimeo: vimeo.defaults,
      twitch: twitch.defaults,
      unsplash: unsplash.defaults,
      pexels: pexels.defaults,
      giphy: giphy.defaults,
      tenor: tenor.defaults,
      imgur: imgur.defaults,
      deviantart: deviantart.defaults,
      europeana: europeana.defaults,
      reddit: reddit.defaults,
      tumblr: tumblr.defaults,
      x: x.defaults,
      instagram: instagram.defaults,
      spotify: spotify.defaults,
      jamendo: jamendo.defaults,
      freesound: freesound.defaults,
    },
  };
}

export interface AdapterStats {
  runs: number;
  found: number;
  added: number;
  errors: number;
  blocked: number;
  lastRun?: string;
  lastError?: string;
}

/** Official API calls of one adapter today, by kind of work. */
interface ApiUsage {
  day: string;
  crawl: number;
  search: number;
  /** After a 429 (too many requests): no calls until then. */
  pausedUntil?: number;
}

interface CrawlerState {
  usage: Record<string, ApiUsage>;
  cursors: Record<string, number>;
  frontier: { url: string; depth: number; seed: string }[];
  identify: { url: string; title?: string }[];
  seen: string[];
  searches: Record<string, { count: number; last: number }>;
  stats: Record<string, AdapterStats>;
}

/** Hands discovered content to the registry; returns how many entries were new. */
export type Ingest = (items: Discovered[]) => number;

const MAX_FRONTIER = 20_000;
const MAX_IDENTIFY = 5_000;
const MAX_SEEN = 50_000;

/**
 * The algorithm node's crawler. It cycles through units of work — a PeerTube instance,
 * a Mastodon hashtag, a YouTube channel feed, a topic search on Openverse, a page of a
 * seed site, a platform link to identify — politely (robots.txt, per-host delays), and
 * hands everything it finds to the registry. Client searches also fan out to platforms.
 */
export class Crawler {
  readonly fetcher: PoliteFetcher;
  private store: JsonFile<CrawlerState>;
  private seen: Set<string>;
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private searchCache = new Map<string, number>();
  private searching = new Map<string, Promise<number>>();
  private readonly ctx: CrawlContext;
  private tokens = new Map<string, { token: string; expires: number; credentials: string }>();

  constructor(
    private readonly config: () => CrawlerConfig,
    statePath: string | null,
    private readonly ingest: Ingest,
    /** A fetch through Tor for this URL when the node sends the crawler through Tor. */
    transport?: (url: URL) => typeof fetch | undefined
  ) {
    this.fetcher = new PoliteFetcher({
      userAgent: config().userAgent,
      defaultDelayMs: () => this.config().hostDelayMs,
      timeoutMs: () => this.config().timeoutMs,
      allowPrivate: () => this.config().allowPrivateAddresses,
      apiDelayMs: () => this.config().apiDelayMs,
      blocked: (host) => this.hostBlocked(host),
      transport,
    });
    this.ctx = this.contextFor(null, 'crawl');
    this.store = new JsonFile<CrawlerState>(
      statePath,
      () => ({ usage: {}, cursors: {}, frontier: [], identify: [], seen: [], searches: {}, stats: {} }),
      5000
    );
    this.store.data.usage ??= {};
    this.seen = new Set(this.store.data.seen);
  }

  private get state(): CrawlerState {
    return this.store.data;
  }

  private stats(id: string): AdapterStats {
    return (this.state.stats[id] ??= { runs: 0, found: 0, added: 0, errors: 0, blocked: 0 });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  flush(): void {
    this.state.seen = [...this.seen].slice(-MAX_SEEN);
    this.store.flush();
  }

  private tick(): void {
    const config = this.config();
    if (!config.enabled || this.active >= Math.max(1, config.concurrency)) return;
    this.active++;
    void this.runOnce()
      .catch((error) => log.debug(`crawler: ${(error as Error).message}`))
      .finally(() => {
        const release = setTimeout(() => this.active--, this.config().pauseMs);
        release.unref?.();
      });
  }

  /** Discovery queries: configured topics plus what people searched for lately. */
  queries(): string[] {
    const config = this.config();
    const base = config.queries.length ? config.queries : [...TOPICS];
    if (!config.learnFromSearches) return base;
    const week = Date.now() - 7 * 86400_000;
    const learnt = Object.entries(this.state.searches)
      .filter(([, entry]) => entry.last > week)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([query]) => query);
    return [...new Set([...base, ...learnt])];
  }

  // ------------------------------------------------------------------ sources and sites

  private sourceBlocked(key: string): boolean {
    return this.config().blockedSources.includes(key);
  }

  /** Sites the operator blocked, and the hosts of blocked platforms. */
  private hostBlocked(host: string): boolean {
    const config = this.config();
    if (onList(host, config.sites.block)) return true;
    const source = sourceOfHost(host);
    return Boolean(source && this.sourceBlocked(source));
  }

  /** Pages the web crawler may visit: with an allow list, only those sites. */
  private pageAllowed(url: string): boolean {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    const allow = this.config().sites.allow;
    return !this.hostBlocked(host) && (!allow.length || onList(host, allow));
  }

  // ------------------------------------------------------------------ official APIs

  /** Whether an API adapter has every credential it needs. */
  configured(adapter: Adapter): boolean {
    if (!adapter.api) return true;
    const config = this.adapterConfig(adapter.id);
    return adapter.api.credentials.every((field) => typeof config[field.key] === 'string' && (config[field.key] as string).trim() !== '');
  }

  private usage(id: string): ApiUsage {
    const usage = this.state.usage[id];
    if (!usage || usage.day !== today()) return (this.state.usage[id] = { day: today(), crawl: 0, search: 0, pausedUntil: usage?.pausedUntil });
    return usage;
  }

  /**
   * Whether `units` more API work fits today's budget: crawling stays within its share,
   * client searches may use what is left of the whole day's budget.
   */
  budgetLeft(id: string, purpose: Purpose, units = 1): boolean {
    const config = this.adapterConfig(id);
    const limit = Math.max(0, Number(config.dailyLimit ?? 0));
    const share = Math.min(1, Math.max(0, Number(config.searchShare ?? 0.5)));
    const usage = this.usage(id);
    if ((usage.pausedUntil ?? 0) > Date.now()) return false;
    const used = usage.crawl + usage.search;
    if (purpose === 'search') return used + units <= limit;
    return usage.crawl + units <= limit * (1 - share) && used + units <= limit;
  }

  /** The tools an adapter works with; API calls count against its budget for `purpose`. */
  private contextFor(adapter: Adapter | null, purpose: Purpose): CrawlContext {
    const id = adapter?.id ?? 'none';
    return {
      fetcher: this.fetcher,
      api: async (url, request = {}) => {
        const units = Math.max(1, request.units ?? 1);
        if (!this.budgetLeft(id, purpose, units)) throw new BudgetUsed(id);
        this.usage(id)[purpose] += units;
        this.store.changed();
        try {
          return await this.fetcher.api(url, request);
        } catch (error) {
          if (error instanceof FetchFailed && error.status === 429) {
            // Too many requests: wait as long as asked (an hour when it does not say).
            this.usage(id).pausedUntil = Date.now() + (error.retryAfter ?? 3600) * 1000;
          }
          throw error;
        }
      },
      token: async (get) => {
        const credentials = JSON.stringify(adapter?.api?.credentials.map((field) => this.adapterConfig(id)[field.key]) ?? []);
        const cached = this.tokens.get(id);
        if (cached && cached.credentials === credentials && cached.expires > Date.now()) return cached.token;
        const fresh = await get();
        this.tokens.set(id, { token: fresh.token, credentials, expires: Date.now() + Math.max(60, (fresh.expiresIn ?? 3600) - 60) * 1000 });
        return fresh.token;
      },
    };
  }

  /** Adapters that may work now: switched on, source not blocked, credentials present. */
  private enabledAdapters(): Adapter[] {
    const adapters = this.config().adapters as unknown as Record<string, { enabled?: boolean }>;
    return PLATFORM_ADAPTERS.filter(
      (adapter) => adapters[adapter.id]?.enabled !== false && !this.sourceBlocked(adapter.id) && (adapter.api?.optional || this.configured(adapter))
    );
  }

  private adapterConfig(id: string): Record<string, unknown> {
    return (this.config().adapters as unknown as Record<string, Record<string, unknown>>)[id] ?? {};
  }

  /** The kinds of work available right now, in rotation order. */
  private lanes(): string[] {
    // API adapters whose crawling budget is spent for today wait until tomorrow.
    const lanes = this.enabledAdapters()
      .filter((adapter) => !adapter.api || adapter.api.optional || this.budgetLeft(adapter.id, 'crawl'))
      .map((adapter) => adapter.id);
    const web = this.config().adapters.web;
    if (web.enabled && !this.sourceBlocked('web') && (this.state.frontier.length || web.seeds.some((seed) => !this.seen.has(seed)))) lanes.push('web');
    if (this.state.identify.length) lanes.push('identify');
    return lanes;
  }

  private remember(url: string): boolean {
    if (this.seen.has(url)) return false;
    this.seen.add(url);
    if (this.seen.size > MAX_SEEN * 1.2) this.seen = new Set([...this.seen].slice(-MAX_SEEN));
    return true;
  }

  private queueLinks(identify: { url: string; title?: string }[], pages: { url: string; depth: number; seed: string }[]): void {
    identify = identify.filter((link) => this.pageAllowed(link.url));
    pages = pages.filter((page) => this.pageAllowed(page.url));
    for (const link of identify) {
      if (this.state.identify.length >= MAX_IDENTIFY) break;
      if (this.remember(`identify:${link.url}`)) this.state.identify.push(link);
    }
    for (const page of pages) {
      if (this.state.frontier.length >= MAX_FRONTIER) break;
      if (this.remember(page.url)) this.state.frontier.push(page);
    }
    this.store.changed();
  }

  private take(items: Discovered[], adapter: string): number {
    // What lives on a blocked source is dropped, whoever found it (a Reddit post of a YouTube video…).
    items = items.filter((item) => !this.sourceBlocked(sourceKeyOf(item)));
    const stats = this.stats(adapter);
    stats.found += items.length;
    const added = items.length ? this.ingest(items) : 0;
    stats.added += added;
    return added;
  }

  /** Runs one unit of work: the next in rotation, or a given adapter/target. */
  async runOnce(adapterId?: string, target?: string): Promise<{ adapter: string; target?: string; found: number; added: number }> {
    const lanes = this.lanes();
    if (!lanes.length) return { adapter: 'none', found: 0, added: 0 };
    const lane = adapterId ?? lanes[(this.state.cursors._lane = ((this.state.cursors._lane ?? -1) + 1) % lanes.length)];
    const stats = this.stats(lane);
    stats.runs++;
    stats.lastRun = new Date().toISOString();
    this.store.changed();
    let found = 0;
    let added = 0;
    let unit: string | undefined = target;
    try {
      if (lane === 'web') {
        const web = this.config().adapters.web;
        const fresh = web.seeds.find((seed) => !this.seen.has(seed) && this.pageAllowed(seed));
        const next = target
          ? { url: target, depth: 0, seed: target }
          : fresh
            ? { url: fresh, depth: 0, seed: fresh }
            : this.state.frontier.shift();
        if (!next) return { adapter: lane, found: 0, added: 0 };
        this.remember(next.url);
        unit = next.url;
        const result = await crawlPage(this.ctx, web, next.url, next.depth, next.seed);
        this.queueLinks(result.identify, (result.links ?? []).map((link) => ({ url: link.url, depth: link.depth ?? next.depth + 1, seed: next.seed })));
        found = result.items.length;
        added = this.take(result.items, lane);
      } else if (lane === 'identify') {
        const next = target ? { url: target } : this.state.identify.shift();
        if (!next) return { adapter: lane, found: 0, added: 0 };
        unit = next.url;
        const item = await identifyLink(this.ctx, next.url, next as { title?: string });
        found = item ? 1 : 0;
        added = item ? this.take([item], lane) : 0;
      } else {
        const adapter = PLATFORM_ADAPTERS.find((candidate) => candidate.id === lane);
        if (!adapter?.discover || !adapter.targets) return { adapter: lane, found: 0, added: 0 };
        const config = this.adapterConfig(adapter.id);
        const targets = adapter.targets(config, this.queries());
        if (!targets.length) return { adapter: lane, found: 0, added: 0 };
        unit = target ?? targets[(this.state.cursors[lane] = ((this.state.cursors[lane] ?? -1) + 1) % targets.length)];
        const result = await adapter.discover(this.contextFor(adapter, 'crawl'), config, unit);
        found = result.items.length;
        added = this.take(result.items, lane);
        if (result.links?.length) this.queueLinks(result.links.map((link) => ({ url: link.url })), []);
      }
    } catch (error) {
      // A spent budget is not a failure: that adapter rests until tomorrow.
      if (error instanceof BudgetUsed) return { adapter: lane, target: unit, found: 0, added: 0 };
      if (error instanceof RobotsDisallowed || error instanceof SiteBlocked) stats.blocked++;
      else stats.errors++;
      stats.lastError = `${unit ?? ''}: ${this.explain(error)}`.slice(0, 300);
      throw error;
    } finally {
      this.store.changed();
    }
    return { adapter: lane, target: unit, found, added };
  }

  /**
   * Searches the platforms for a client's query, waiting at most `searchTimeoutMs`.
   * Results that arrive later are still kept for the next searches.
   */
  async search(query: string): Promise<number> {
    const config = this.config();
    const key = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    if (!config.enabled || !config.searchPlatforms || key.length < 2) return 0;
    const entry = (this.state.searches[key] ??= { count: 0, last: 0 });
    entry.count++;
    entry.last = Date.now();
    const keys = Object.keys(this.state.searches);
    if (keys.length > 500) {
      for (const old of keys.sort((a, b) => this.state.searches[a].last - this.state.searches[b].last).slice(0, keys.length - 500)) {
        delete this.state.searches[old];
      }
    }
    this.store.changed();
    if ((this.searchCache.get(key) ?? 0) > Date.now()) return 0;
    const running = this.searching.get(key);
    const all =
      running ??
      (async () => {
        const text = key.replace(/^[#@]/, '');
        const results = await Promise.all(
          this.enabledAdapters()
            // Official APIs are searched while today's budget has room.
            .filter((adapter) => adapter.search && (!adapter.api || adapter.api.optional || this.budgetLeft(adapter.id, 'search')))
            .map(async (adapter) => {
              const stats = this.stats(adapter.id);
              try {
                const items = await adapter.search!(this.contextFor(adapter, 'search'), this.adapterConfig(adapter.id), text);
                return this.take(items, adapter.id);
              } catch (error) {
                if (error instanceof BudgetUsed) return 0;
                if (error instanceof RobotsDisallowed || error instanceof SiteBlocked) stats.blocked++;
                else stats.errors++;
                stats.lastError = `search "${text}": ${this.explain(error)}`.slice(0, 300);
                return 0;
              }
            })
        );
        this.searchCache.set(key, Date.now() + config.searchCacheMinutes * 60_000);
        if (this.searchCache.size > 1000) this.searchCache.delete(this.searchCache.keys().next().value!);
        return results.reduce((sum, count) => sum + count, 0);
      })().finally(() => this.searching.delete(key));
    if (!running) this.searching.set(key, all);
    const timeout = new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(0), config.searchTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([all, timeout]);
  }

  /** An error, with a hint when an API refused the credentials. */
  private explain(error: unknown): string {
    const message = (error as Error).message;
    if (error instanceof FetchFailed && (error.status === 401 || error.status === 403)) return `${message} (check the API key)`;
    if (error instanceof FetchFailed && error.status === 429) return `${message} (rate limited; paused)`;
    return message;
  }

  addSeed(url: string): void {
    const web = this.config().adapters.web;
    if (!web.seeds.includes(url)) web.seeds.push(url);
  }

  status() {
    const config = this.config();
    const adapters = config.adapters as unknown as Record<string, { enabled?: boolean }>;
    const describe = (adapter: Adapter) => {
      const settings = this.adapterConfig(adapter.id);
      const usage = this.usage(adapter.id);
      return {
        id: adapter.id,
        label: adapter.label,
        description: adapter.description,
        enabled: adapters[adapter.id]?.enabled !== false,
        blocked: this.sourceBlocked(adapter.id),
        targets: adapter.targets ? adapter.targets(settings, this.queries()).length : 0,
        search: Boolean(adapter.search),
        stats: this.stats(adapter.id),
        api: adapter.api
          ? {
              ...adapter.api,
              configured: this.configured(adapter),
              dailyLimit: Number(settings.dailyLimit ?? adapter.api.defaultDailyLimit),
              searchShare: Number(settings.searchShare ?? 0.5),
              usedToday: { crawl: usage.crawl, search: usage.search },
              pausedUntil: usage.pausedUntil && usage.pausedUntil > Date.now() ? new Date(usage.pausedUntil).toISOString() : undefined,
            }
          : undefined,
      };
    };
    return {
      enabled: config.enabled,
      userAgent: config.userAgent,
      autoList: config.autoList,
      searchPlatforms: config.searchPlatforms,
      blockedSources: config.blockedSources,
      sites: config.sites,
      adapters: [
        ...PLATFORM_ADAPTERS.map(describe),
        {
          id: 'web',
          label: 'Web pages',
          description: 'Seed sites: video and photo pages, and links to platforms found on them.',
          enabled: config.adapters.web.enabled,
          blocked: this.sourceBlocked('web'),
          targets: config.adapters.web.seeds.length,
          search: false,
          stats: this.stats('web'),
          api: undefined,
        },
        {
          id: 'identify',
          label: 'Platform links',
          description: 'Links to YouTube, Vimeo, TikTok… found while crawling, identified through oEmbed.',
          enabled: true,
          blocked: false,
          targets: this.state.identify.length,
          search: false,
          stats: this.stats('identify'),
          api: undefined,
        },
      ],
      queues: { frontier: this.state.frontier.length, identify: this.state.identify.length, seen: this.seen.size },
      queries: this.queries(),
      recentSearches: Object.entries(this.state.searches)
        .sort((a, b) => b[1].last - a[1].last)
        .slice(0, 20)
        .map(([query, entry]) => ({ query, count: entry.count, last: new Date(entry.last).toISOString() })),
      hosts: [...this.fetcher.hosts.entries()]
        .sort((a, b) => b[1].requests - a[1].requests)
        .slice(0, 30)
        .map(([host, stats]) => ({ host, ...stats })),
    };
  }
}

export type { AdapterId };
