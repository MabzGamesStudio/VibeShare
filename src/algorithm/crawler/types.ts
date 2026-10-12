import type { ContentMedia } from '../../shared/protocol.js';
import { TOPICS, type CreatorKind, type Format, type Rating } from '../../shared/taxonomy.js';
import type { ApiRequest, Fetched, PoliteFetcher } from './fetcher.js';

/** A piece of content found on another platform. */
export interface Discovered {
  /** Content id (`yt:…`, `peertube:host/id`, `url:…`). */
  id: string;
  title: string;
  description?: string;
  format: Format;
  /** From the platform's own flags (nsfw, sensitive, mature); otherwise the node's default applies. */
  rating?: Rating;
  tags?: string[];
  topics?: string[];
  language?: string;
  durationSeconds?: number;
  publishedAt?: string;
  creator?: { id: string; name: string; kind?: CreatorKind; url?: string };
  thumbnailUrl?: string;
  media?: ContentMedia;
  pageUrl?: string;
  stats?: { views?: number; likes?: number };
  /** Which adapter found it. */
  adapter: string;
}

export interface CrawlContext {
  fetcher: PoliteFetcher;
  /**
   * A call to the adapter's official API with the operator's credentials, counted against
   * its daily budget (`units`: what the call costs, 1 by default). Throws BudgetUsed when
   * today's budget for this kind of work (crawling or client searches) is spent.
   */
  api(url: string, request?: ApiRequest & { units?: number }): Promise<Fetched>;
  /** An OAuth app token (client credentials), fetched once and kept until it expires. */
  token(get: () => Promise<{ token: string; expiresIn?: number }>): Promise<string>;
}

/** An official API that needs the operator's own key: where to get one, what it needs. */
export interface ApiInfo {
  /** Where the operator registers an app / gets a key. */
  signupUrl: string;
  credentials: { key: string; label: string; secret?: boolean }[];
  /** Limits and terms worth knowing. */
  note: string;
  /** Requests (or quota units) per day used by default. */
  defaultDailyLimit: number;
  /** The adapter also works without credentials (keys only add more). */
  optional?: boolean;
}

/** Budget settings every API adapter has, next to its credentials. */
export interface ApiBudget {
  /** Requests (or quota units) to use per day, across crawling and client searches. */
  dailyLimit: number;
  /** Share of the daily budget kept for client searches (0–1); crawling uses the rest. */
  searchShare: number;
}

/** Thrown by `ctx.api` when the day's budget is spent. */
export class BudgetUsed extends Error {
  constructor(readonly adapter: string) {
    super(`${adapter}: today's API budget is used up`);
  }
}

export interface AdapterResult {
  items: Discovered[];
  /** Links worth looking at later (platform links to identify, pages to crawl). */
  links?: { url: string; depth?: number }[];
}

/**
 * A source of content: a platform API, a feed, or the web. `targets` lists units of
 * discovery work (an instance, a tag, a channel…); the crawler cycles through them.
 */
export interface Adapter<C = Record<string, unknown>> {
  id: string;
  label: string;
  /** What this adapter finds, shown to operators. */
  description: string;
  defaults: C & { enabled: boolean };
  /** Present for adapters that use an official API with the operator's key. */
  api?: ApiInfo;
  targets?(config: C, queries: string[]): string[];
  discover?(ctx: CrawlContext, config: C, target: string): Promise<AdapterResult>;
  search?(ctx: CrawlContext, config: C, query: string): Promise<Discovered[]>;
}

/** Vertical media is short-form video; everything else keeps its format. */
export function videoFormat(width?: number, height?: number, aspect?: number): Format {
  const ratio = aspect ?? (width && height ? width / height : undefined);
  return ratio !== undefined && ratio > 0 && ratio < 0.95 ? 'short-video' : 'video';
}

const TOPIC_WORDS: Record<string, string[]> = {
  science: ['science', 'physics', 'chemistry', 'biology', 'astronomy', 'space', 'nasa', 'experiment', 'research', 'scientist'],
  learning: ['tutorial', 'lesson', 'learn', 'course', 'lecture', 'explained', 'how to', 'howto', 'education', 'guide'],
  technology: ['technology', 'tech', 'programming', 'software', 'computer', 'linux', 'coding', 'developer', 'ai', 'gadget'],
  gaming: ['game', 'gaming', 'gameplay', 'playthrough', 'minecraft', 'speedrun', 'esports', 'nintendo', 'playstation', 'xbox'],
  music: ['music', 'song', 'album', 'concert', 'guitar', 'piano', 'cover', 'remix', 'beats', 'lofi', 'jazz', 'band'],
  art: ['art', 'painting', 'drawing', 'illustration', 'sculpture', 'artist', 'sketch', 'artwork', 'digitalart'],
  news: ['news', 'breaking', 'report', 'headlines', 'election'],
  comedy: ['comedy', 'funny', 'humor', 'humour', 'meme', 'standup', 'prank'],
  sports: ['sport', 'football', 'soccer', 'basketball', 'tennis', 'cycling', 'running', 'olympics', 'nba', 'fifa'],
  health: ['health', 'fitness', 'workout', 'yoga', 'nutrition', 'medicine', 'mental health'],
  cooking: ['cooking', 'recipe', 'food', 'baking', 'chef', 'kitchen'],
  travel: ['travel', 'trip', 'journey', 'tourism', 'city tour', 'vacation', 'hiking'],
  nature: ['nature', 'wildlife', 'animal', 'birds', 'forest', 'ocean', 'landscape', 'flower', 'mountain', 'sunset'],
  history: ['history', 'historical', 'ancient', 'war', 'medieval', 'archive'],
  politics: ['politics', 'government', 'policy', 'parliament', 'congress'],
  business: ['business', 'startup', 'finance', 'economy', 'marketing', 'investing'],
  film: ['film', 'movie', 'cinema', 'trailer', 'short film', 'animation', 'documentary'],
  kids: ['kids', 'children', 'cartoon', 'nursery'],
  diy: ['diy', 'craft', 'woodworking', 'repair', 'build', 'maker'],
  lifestyle: ['lifestyle', 'vlog', 'fashion', 'beauty', 'home'],
};

const TOPIC_PATTERNS = TOPICS.map((topic) => ({
  topic,
  pattern: new RegExp(
    `(^|[^\\p{L}\\p{N}])(${(TOPIC_WORDS[topic] ?? [topic]).map((word) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})s?([^\\p{L}\\p{N}]|$)`,
    'iu'
  ),
}));

/** Topics a title, description and tags point to (the node's default topics). */
export function inferTopics(text: string, tags: string[] = []): string[] {
  const haystack = `${text} ${tags.join(' ')}`.replace(/[#_-]/g, ' ');
  return TOPIC_PATTERNS.filter(({ pattern }) => pattern.test(haystack))
    .map(({ topic }) => topic)
    .slice(0, 3);
}

export function shorten(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).trim()}…`;
}

export function toIso(value: string | number | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
