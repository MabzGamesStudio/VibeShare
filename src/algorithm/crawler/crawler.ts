import { log } from '../../shared/log.js';
import { JsonFile } from '../../shared/store.js';
import { TOPICS, type Rating } from '../../shared/taxonomy.js';
import { flickr, openverse, wikimedia, type FlickrConfig, type OpenverseConfig, type WikimediaConfig } from './adapters/images.js';
import { bluesky, lemmy, mastodon, type BlueskyConfig, type LemmyConfig, type MastodonConfig } from './adapters/social.js';
import { archive, dailymotion, peertube, youtube, type ArchiveConfig, type DailymotionConfig, type PeerTubeConfig, type YouTubeConfig } from './adapters/video.js';
import { crawlPage, webDefaults, type WebConfig } from './adapters/web.js';
import { PoliteFetcher, RobotsDisallowed } from './fetcher.js';
import { identifyLink } from './oembed.js';
import type { Adapter, CrawlContext, Discovered } from './types.js';

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
  };
}

type AdapterId = keyof CrawlerConfig['adapters'];

const PLATFORM_ADAPTERS = [youtube, peertube, dailymotion, archive, wikimedia, openverse, flickr, mastodon, bluesky, lemmy] as unknown as Adapter[];

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

interface CrawlerState {
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

  constructor(
    private readonly config: () => CrawlerConfig,
    statePath: string | null,
    private readonly ingest: Ingest
  ) {
    this.fetcher = new PoliteFetcher({
      userAgent: config().userAgent,
      defaultDelayMs: () => this.config().hostDelayMs,
      timeoutMs: () => this.config().timeoutMs,
      allowPrivate: () => this.config().allowPrivateAddresses,
    });
    this.ctx = { fetcher: this.fetcher };
    this.store = new JsonFile<CrawlerState>(
      statePath,
      () => ({ cursors: {}, frontier: [], identify: [], seen: [], searches: {}, stats: {} }),
      5000
    );
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

  private enabledAdapters(): Adapter[] {
    const adapters = this.config().adapters as unknown as Record<string, { enabled?: boolean }>;
    return PLATFORM_ADAPTERS.filter((adapter) => adapters[adapter.id]?.enabled !== false);
  }

  private adapterConfig(id: string): Record<string, unknown> {
    return (this.config().adapters as unknown as Record<string, Record<string, unknown>>)[id] ?? {};
  }

  /** The kinds of work available right now, in rotation order. */
  private lanes(): string[] {
    const lanes = this.enabledAdapters().map((adapter) => adapter.id);
    const web = this.config().adapters.web;
    if (web.enabled && (this.state.frontier.length || web.seeds.some((seed) => !this.seen.has(seed)))) lanes.push('web');
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
        const fresh = web.seeds.find((seed) => !this.seen.has(seed));
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
        const result = await adapter.discover(this.ctx, config, unit);
        found = result.items.length;
        added = this.take(result.items, lane);
        if (result.links?.length) this.queueLinks(result.links.map((link) => ({ url: link.url })), []);
      }
    } catch (error) {
      if (error instanceof RobotsDisallowed) stats.blocked++;
      else stats.errors++;
      stats.lastError = `${unit ?? ''}: ${(error as Error).message}`.slice(0, 300);
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
            .filter((adapter) => adapter.search)
            .map(async (adapter) => {
              const stats = this.stats(adapter.id);
              try {
                const items = await adapter.search!(this.ctx, this.adapterConfig(adapter.id), text);
                return this.take(items, adapter.id);
              } catch (error) {
                if (error instanceof RobotsDisallowed) stats.blocked++;
                else stats.errors++;
                stats.lastError = `search "${text}": ${(error as Error).message}`.slice(0, 300);
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

  addSeed(url: string): void {
    const web = this.config().adapters.web;
    if (!web.seeds.includes(url)) web.seeds.push(url);
  }

  status() {
    const config = this.config();
    const adapters = config.adapters as unknown as Record<string, { enabled?: boolean }>;
    const describe = (adapter: Adapter) => ({
      id: adapter.id,
      label: adapter.label,
      description: adapter.description,
      enabled: adapters[adapter.id]?.enabled !== false,
      targets: adapter.targets ? adapter.targets(this.adapterConfig(adapter.id), this.queries()).length : 0,
      search: Boolean(adapter.search),
      stats: this.stats(adapter.id),
    });
    return {
      enabled: config.enabled,
      userAgent: config.userAgent,
      autoList: config.autoList,
      searchPlatforms: config.searchPlatforms,
      adapters: [
        ...PLATFORM_ADAPTERS.map(describe),
        {
          id: 'web',
          label: 'Web pages',
          description: 'Seed sites: video and photo pages, and links to platforms found on them.',
          enabled: config.adapters.web.enabled,
          targets: config.adapters.web.seeds.length,
          search: false,
          stats: this.stats('web'),
        },
        {
          id: 'identify',
          label: 'Platform links',
          description: 'Links to YouTube, Vimeo, TikTok… found while crawling, identified through oEmbed.',
          enabled: true,
          targets: this.state.identify.length,
          search: false,
          stats: this.stats('identify'),
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
