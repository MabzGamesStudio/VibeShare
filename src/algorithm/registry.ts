import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from '../shared/crypto.js';
import { badRequest } from '../shared/http.js';
import type { ContentItem, ContentMedia, ContentOrigin, CreatorInfo, LookupResult, Preferences, SearchSort, TagNote } from '../shared/protocol.js';
import type { Discovered } from './crawler/types.js';
import { baseId, formatSource, parseContentId } from '../shared/sources.js';
import { JsonFile } from '../shared/store.js';
import {
  CREATOR_KINDS,
  FORMATS,
  normalizeTag,
  RATINGS,
  ratingAllowed,
  type CreatorKind,
  type Format,
  type Rating,
} from '../shared/taxonomy.js';
import { wilson, quality } from './ranking.js';

/** What the node knows about one content id. Ids it has no entry for are "unknown". */
export interface Entry {
  /** Base id (`vs1…`, `yt:…`). */
  id: string;
  /** Fallback sources appended to the id given to clients. */
  sources: string[];
  /** pending: found by the crawler, waiting for review (clients see it as unknown). */
  status: 'listed' | 'blocked' | 'pending';
  reason?: string;
  title: string;
  description?: string;
  format: Format;
  rating: Rating;
  topics: string[];
  tags: string[];
  language?: string;
  durationSeconds?: number;
  creatorId?: string;
  thumbnail?: boolean;
  providers: string[];
  publishedAt: string;
  addedAt: string;
  updatedAt: string;
  likes: number;
  dislikes: number;
  notes: TagNote[];
  /** How the entry got here. Entries without one predate the crawler (set by the operator). */
  origin?: ContentOrigin;
  /** Which crawler adapter found it. */
  adapter?: string;
  pageUrl?: string;
  /** Remote thumbnail of discovered content. */
  thumbnailUrl?: string;
  media?: ContentMedia;
  platformStats?: { views?: number; likes?: number };
}

export interface CreatorRecord extends CreatorInfo {
  status: 'listed' | 'blocked';
  addedAt: string;
}

interface RegistryData {
  entries: Record<string, Entry>;
  creators: Record<string, CreatorRecord>;
}

export type EntryInput = Partial<Omit<Entry, 'id' | 'likes' | 'dislikes' | 'addedAt' | 'updatedAt'>> & { id: string };

function cleanList(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeTag(String(item))).filter(Boolean))].slice(0, max);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}#@:+-]+/u)
    .filter(Boolean);
}

/** Metadata of an algorithm node: whitelist (listed), blacklist (blocked), creators and thumbnails. */
export class Registry {
  private store: JsonFile<RegistryData>;
  private thumbs = new Map<string, Buffer>();

  constructor(
    path: string | null,
    private readonly thumbDir: string | null
  ) {
    // Written at most every two seconds: the crawler keeps adding entries.
    this.store = new JsonFile<RegistryData>(path, () => ({ entries: {}, creators: {} }), 2000);
    if (thumbDir) mkdirSync(thumbDir, { recursive: true });
  }

  get data(): RegistryData {
    return this.store.data;
  }

  changed(): void {
    this.store.changed();
  }

  flush(): void {
    this.store.flush();
  }

  get(id: string): Entry | undefined {
    return this.store.data.entries[baseId(id)];
  }

  all(): Entry[] {
    return Object.values(this.store.data.entries);
  }

  creator(id: string | undefined): CreatorRecord | undefined {
    return id ? this.store.data.creators[id] : undefined;
  }

  /** Lists or blocks content, keeping votes and creation time of an existing entry. */
  upsert(input: EntryInput): Entry {
    const parsed = parseContentId(input.id);
    if (!parsed) throw badRequest(`Not a content id: ${input.id}`);
    const existing = this.store.data.entries[parsed.base];
    const now = new Date().toISOString();
    if (input.format !== undefined && !FORMATS.includes(input.format)) throw badRequest(`Unknown format ${input.format}`);
    if (input.rating !== undefined && !RATINGS.includes(input.rating)) throw badRequest(`Unknown rating ${input.rating}`);
    const sources = [...new Set([...(existing?.sources ?? []), ...parsed.sources.map(formatSource), ...(input.sources ?? [])])].filter(
      (source) => source !== parsed.base
    );
    const entry: Entry = {
      id: parsed.base,
      sources,
      status: input.status ?? existing?.status ?? 'listed',
      reason: input.reason ?? existing?.reason,
      title: (input.title ?? existing?.title ?? parsed.base).slice(0, 300),
      description: (input.description ?? existing?.description)?.slice(0, 5000),
      format: input.format ?? existing?.format ?? 'other',
      rating: input.rating ?? existing?.rating ?? 'all',
      topics: input.topics ? cleanList(input.topics) : (existing?.topics ?? []),
      tags: input.tags ? cleanList(input.tags, 64) : (existing?.tags ?? []),
      language: input.language ?? existing?.language,
      durationSeconds: input.durationSeconds ?? existing?.durationSeconds,
      creatorId: input.creatorId ?? existing?.creatorId,
      thumbnail: input.thumbnail ?? existing?.thumbnail,
      providers: [...new Set([...(existing?.providers ?? []), ...(input.providers ?? [])])].slice(0, 16),
      publishedAt: input.publishedAt ?? existing?.publishedAt ?? now,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
      likes: existing?.likes ?? 0,
      dislikes: existing?.dislikes ?? 0,
      notes: input.notes ?? existing?.notes ?? [],
      origin: input.origin ?? existing?.origin,
      adapter: existing?.adapter,
      pageUrl: input.pageUrl ?? existing?.pageUrl,
      thumbnailUrl: input.thumbnailUrl ?? existing?.thumbnailUrl,
      media: input.media ?? existing?.media,
      platformStats: existing?.platformStats,
    };
    if (entry.status !== 'blocked') delete entry.reason;
    this.store.data.entries[entry.id] = entry;
    this.changed();
    return entry;
  }

  block(id: string, reason?: string): Entry {
    const existing = this.get(id);
    return this.upsert({ id, status: 'blocked', reason: reason ?? 'blocked by the operator', title: existing?.title });
  }

  /** Forgets an id: it becomes "unknown" again. */
  remove(id: string): boolean {
    const key = baseId(id);
    if (!this.store.data.entries[key]) return false;
    delete this.store.data.entries[key];
    this.thumbs.delete(key);
    if (this.thumbDir) rmSync(join(this.thumbDir, this.thumbKey(key)), { force: true });
    this.changed();
    return true;
  }

  upsertCreator(input: Partial<CreatorRecord> & { id: string }): CreatorRecord {
    if (!input.id || input.id.length > 128) throw badRequest('A creator needs an id');
    const existing = this.store.data.creators[input.id];
    const kind = (input.kind ?? existing?.kind ?? 'unknown') as CreatorKind;
    if (!CREATOR_KINDS.includes(kind)) throw badRequest(`Unknown creator kind ${kind}`);
    const record: CreatorRecord = {
      id: input.id,
      name: (input.name ?? existing?.name ?? input.id).slice(0, 120),
      kind,
      description: (input.description ?? existing?.description)?.slice(0, 2000),
      keys: [...new Set([...(existing?.keys ?? []), ...(input.keys ?? [])])],
      links: input.links ?? existing?.links,
      status: input.status ?? existing?.status ?? 'listed',
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    this.store.data.creators[record.id] = record;
    this.changed();
    return record;
  }

  // -------------------------------------------------------------------------
  // Thumbnails

  thumbKey(id: string): string {
    return sha256hex(baseId(id)).slice(0, 40);
  }

  setThumbnail(id: string, dataUrl: string): void {
    const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw badRequest('The thumbnail must be a JPEG, PNG or WebP data: URL');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 200 * 1024) throw badRequest('The thumbnail must be at most 200 kB');
    const key = this.thumbKey(id);
    if (this.thumbDir) writeFileSync(join(this.thumbDir, key), bytes);
    else this.thumbs.set(key, bytes);
    const entry = this.get(id);
    if (entry) {
      entry.thumbnail = true;
      this.changed();
    }
  }

  thumbnail(key: string): Buffer | null {
    if (!/^[0-9a-f]{40}$/.test(key)) return null;
    if (this.thumbs.has(key)) return this.thumbs.get(key)!;
    if (this.thumbDir) {
      const file = join(this.thumbDir, key);
      if (existsSync(file)) return readFileSync(file);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Views for clients

  view(entry: Entry): ContentItem {
    const creator = this.creator(entry.creatorId);
    return {
      id: [entry.id, ...entry.sources].join('~'),
      status: 'listed',
      title: entry.title,
      description: entry.description,
      format: entry.format,
      rating: entry.rating,
      topics: entry.topics,
      tags: entry.tags,
      language: entry.language,
      durationSeconds: entry.durationSeconds,
      creator: creator
        ? { id: creator.id, name: creator.name, kind: creator.kind, description: creator.description, keys: creator.keys, links: creator.links }
        : entry.creatorId
          ? { id: entry.creatorId, name: entry.creatorId.slice(0, 12), kind: 'unknown' }
          : undefined,
      thumbnail: entry.thumbnail ? `/v1/thumbnails/${this.thumbKey(entry.id)}` : entry.thumbnailUrl,
      media: entry.media,
      pageUrl: entry.pageUrl,
      origin: entry.origin,
      publishedAt: entry.publishedAt,
      stats: {
        likes: entry.likes,
        dislikes: entry.dislikes,
        views: entry.platformStats?.views,
        platformLikes: entry.platformStats?.likes,
      },
      providers: entry.providers.length ? entry.providers : undefined,
      notes: entry.notes.length ? entry.notes : undefined,
    };
  }

  lookup(id: string): LookupResult {
    const entry = this.get(id);
    if (!entry || entry.status === 'pending') return { id, status: 'unknown' };
    if (entry.status === 'blocked') return { id, status: 'blocked', reason: entry.reason };
    const creator = this.creator(entry.creatorId);
    if (creator?.status === 'blocked') return { id, status: 'blocked', reason: 'the creator is blocked' };
    return this.view(entry);
  }

  /** Listed entries that pass the viewer's preferences and the node's own rating ceiling. */
  visible(preferences: Preferences, nodeMaxRating: Rating): Entry[] {
    const limit = RATINGS[Math.min(RATINGS.indexOf(preferences.maxRating ?? nodeMaxRating), RATINGS.indexOf(nodeMaxRating))];
    const formats = preferences.formats?.length ? new Set(preferences.formats) : null;
    const topics = preferences.onlyTopics && preferences.topics?.length ? new Set(preferences.topics) : null;
    const blockedTags = new Set((preferences.blockedTags ?? []).map(normalizeTag));
    const blockedCreators = new Set(preferences.blockedCreators ?? []);
    const kinds = preferences.creatorKinds?.length ? new Set(preferences.creatorKinds) : null;
    const languages = preferences.languages?.length ? new Set(preferences.languages.map((l) => l.toLowerCase())) : null;
    return this.all().filter((entry) => {
      if (entry.status !== 'listed') return false;
      if (!ratingAllowed(entry.rating, limit)) return false;
      if (formats && !formats.has(entry.format)) return false;
      if (topics && !entry.topics.some((topic) => topics.has(topic))) return false;
      if (blockedTags.size && entry.tags.some((tag) => blockedTags.has(tag))) return false;
      if (entry.creatorId && blockedCreators.has(entry.creatorId)) return false;
      const creator = this.creator(entry.creatorId);
      if (creator?.status === 'blocked') return false;
      if (kinds && !kinds.has(creator?.kind ?? 'unknown')) return false;
      if (languages && entry.language && !languages.has(entry.language.toLowerCase())) return false;
      return true;
    });
  }

  /**
   * Full-text search over title, tags, creator, topics and description.
   * `#tag` and `@creator` narrow the results; `format:video` and `topic:science` filter.
   */
  search(entries: Entry[], query: string, sort: SearchSort): { entry: Entry; score: number }[] {
    const tokens = words(query);
    const tags = tokens.filter((t) => t.startsWith('#')).map((t) => normalizeTag(t.slice(1)));
    const creators = tokens.filter((t) => t.startsWith('@')).map((t) => t.slice(1));
    const formats = tokens.filter((t) => t.startsWith('format:')).map((t) => t.slice(7));
    const topicFilters = tokens.filter((t) => t.startsWith('topic:')).map((t) => t.slice(6));
    const terms = tokens.filter((t) => !/^[#@]|^(format|topic):/.test(t));
    const results: { entry: Entry; score: number }[] = [];
    for (const entry of entries) {
      if (tags.length && !tags.every((tag) => entry.tags.includes(tag))) continue;
      if (formats.length && !formats.includes(entry.format)) continue;
      if (topicFilters.length && !topicFilters.every((topic) => entry.topics.includes(topic))) continue;
      const creator = this.creator(entry.creatorId);
      const creatorText = `${creator?.name ?? ''} ${entry.creatorId ?? ''}`.toLowerCase();
      if (creators.length && !creators.every((name) => creatorText.includes(name))) continue;
      let score = tags.length + creators.length + formats.length + topicFilters.length > 0 ? 1 : 0;
      let matched = 0;
      if (terms.length) {
        const title = words(entry.title);
        const description = (entry.description ?? '').toLowerCase();
        for (const term of terms) {
          let termScore = 0;
          if (title.includes(term)) termScore += 4;
          else if (title.some((word) => word.startsWith(term))) termScore += 2.5;
          if (entry.tags.some((tag) => tag === term || tag.startsWith(term))) termScore += 2;
          if (creatorText.includes(term)) termScore += 2;
          if (entry.topics.includes(term)) termScore += 1.5;
          if (description.includes(term)) termScore += 1;
          if (entry.format === term) termScore += 1;
          if (termScore > 0) matched++;
          score += termScore;
        }
        if (matched < Math.ceil(terms.length / 2)) continue;
        score *= matched / terms.length;
      }
      if (score <= 0 && terms.length) continue;
      results.push({ entry, score: score + quality(entry) * 0.5 });
    }
    if (sort === 'new') results.sort((a, b) => b.entry.publishedAt.localeCompare(a.entry.publishedAt));
    else if (sort === 'top') results.sort((a, b) => wilson(b.entry.likes, b.entry.dislikes) - wilson(a.entry.likes, a.entry.dislikes));
    else results.sort((a, b) => b.score - a.score || b.entry.publishedAt.localeCompare(a.entry.publishedAt));
    return results;
  }

  /**
   * Stores content the crawler found. Entries the operator set (or creators submitted)
   * are never overridden, only given a missing thumbnail or media; crawler entries are
   * refreshed. Returns whether the entry is new.
   */
  upsertDiscovered(item: Discovered, policy: { autoList: boolean; defaultRating: Rating }): 'added' | 'known' | 'invalid' {
    const parsed = parseContentId(item.id);
    if (!parsed || !item.title) return 'invalid';
    const now = new Date().toISOString();
    const existing = this.store.data.entries[parsed.base];
    if (existing) {
      if (existing.origin === 'crawler') {
        existing.thumbnailUrl = item.thumbnailUrl ?? existing.thumbnailUrl;
        existing.media = item.media ?? existing.media;
        existing.pageUrl = item.pageUrl ?? existing.pageUrl;
        if (item.stats) existing.platformStats = { ...existing.platformStats, ...item.stats };
        if (item.rating === 'nsfw') existing.rating = 'nsfw';
      } else {
        existing.thumbnailUrl ??= item.thumbnailUrl;
        existing.media ??= item.media;
        existing.pageUrl ??= item.pageUrl;
      }
      this.changed();
      return 'known';
    }
    if (item.creator && !this.store.data.creators[item.creator.id]) {
      this.store.data.creators[item.creator.id] = {
        id: item.creator.id,
        name: item.creator.name.slice(0, 120),
        kind: item.creator.kind ?? 'unknown',
        links: item.creator.url ? [item.creator.url] : undefined,
        status: 'listed',
        addedAt: now,
      };
    }
    this.store.data.entries[parsed.base] = {
      id: parsed.base,
      sources: parsed.sources.map(formatSource).filter((source) => source !== parsed.base),
      status: policy.autoList ? 'listed' : 'pending',
      title: item.title.slice(0, 300),
      description: item.description?.slice(0, 5000),
      format: FORMATS.includes(item.format) ? item.format : 'other',
      rating: item.rating ?? policy.defaultRating,
      topics: cleanList(item.topics ?? []),
      tags: cleanList(item.tags ?? [], 32),
      language: item.language,
      durationSeconds: item.durationSeconds,
      creatorId: item.creator?.id,
      providers: [],
      publishedAt: item.publishedAt ?? now,
      addedAt: now,
      updatedAt: now,
      likes: 0,
      dislikes: 0,
      notes: [],
      origin: 'crawler',
      adapter: item.adapter,
      pageUrl: item.pageUrl,
      thumbnailUrl: item.thumbnailUrl,
      media: item.media,
      platformStats: item.stats,
    };
    this.changed();
    return 'added';
  }

  /** Keeps at most `max` crawler entries, dropping the oldest ones nobody voted on. */
  prune(max: number): number {
    const crawled = this.all().filter((entry) => entry.origin === 'crawler' && entry.status !== 'blocked');
    if (crawled.length <= max) return 0;
    const removable = crawled
      .filter((entry) => entry.likes + entry.dislikes === 0)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
      .slice(0, crawled.length - max);
    for (const entry of removable) delete this.store.data.entries[entry.id];
    if (removable.length) this.changed();
    return removable.length;
  }

  stats(): { listed: number; blocked: number; creators: number; pending: number; discovered: number } {
    const entries = this.all();
    return {
      listed: entries.filter((entry) => entry.status === 'listed').length,
      blocked: entries.filter((entry) => entry.status === 'blocked').length,
      pending: entries.filter((entry) => entry.status === 'pending').length,
      discovered: entries.filter((entry) => entry.origin === 'crawler').length,
      creators: Object.keys(this.store.data.creators).length,
    };
  }
}
