import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from '../shared/crypto.js';
import { badRequest } from '../shared/node/http.js';
import type { ContentItem, ContentMedia, ContentOrigin, CreatorInfo, LookupResult, Preferences, SearchSort, TagNote } from '../shared/protocol.js';
import type { Discovered } from './crawler/types.js';
import { baseId, formatSource, isNativeId, parseContentId, parseSource, sourceFromUrl } from '../shared/sources.js';
import { JsonFile } from '../shared/node/store.js';
import type { TraceStore } from '../shared/node/tracing-node.js';
import {
  CREATOR_KINDS,
  FORMATS,
  normalizeTag,
  RATINGS,
  ratingAllowed,
  topicIdOf,
  type CreatorKind,
  type Format,
  type Rating,
} from '../shared/taxonomy.js';
import { wilson, quality, seededRandom } from './ranking.js';
import { formatsCovering } from './support.js';
import { matchesLanguages } from '../shared/language.js';
import { ageRatingSystem, legacyRatingOf, parseAgeRating, UNKNOWN_AGE_RATING } from '../shared/age-rating.js';

/** What the node knows about one content. Every entry has a content id, a link, or both — they are separate. */
export interface Entry {
  /** Base id (`vs1…`, `yt:…`). */
  id: string;
  /**
   * The VibeShare content id (`vs1…`), when the content is published on VibeShare.
   * Separate from the link: an entry has a content id, a link, or both.
   */
  contentId?: string;
  /**
   * Where the content lives outside VibeShare — a link (an https URL or a platform
   * source like `yt:…`). Separate from the content id.
   */
  link?: string;
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
  /** The topic records this entry is filed under (each is an exact topic id). */
  topicIds?: string[];
  language?: string;
  durationSeconds?: number;
  /** The images of a list-of-images content, in order. */
  gallery?: ContentMedia[];
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
  /** Platform popularity numbers the node kept (views, likes, comments… from claims). */
  platformStats?: Record<string, number>;
  /** Free-form content data: short string pairs the operator or publisher set. */
  data?: Record<string, string>;
}

export interface CreatorRecord extends CreatorInfo {
  status: 'listed' | 'blocked';
  addedAt: string;
}

/** A topic as the node keeps it: a hash id, a name, and what users/operators added. */
export interface TopicRecord {
  /** `tp1…`: the hash of the name — never the name itself. */
  id: string;
  name: string;
  description?: string;
  icon?: string;
  status: 'listed' | 'blocked';
  addedAt: string;
}

interface RegistryData {
  entries: Record<string, Entry>;
  creators: Record<string, CreatorRecord>;
  topics?: Record<string, TopicRecord>;
}

/**
 * The id of a topic: a hash of its name (`tp1…`). Topics are never keyed by their name,
 * so renaming one, or two nodes agreeing on a name, never collides with content data.
 * (The function itself lives in shared/taxonomy.ts, where clients use it too.)
 */
export { topicIdOf };

export type EntryInput = Partial<Omit<Entry, 'id' | 'likes' | 'dislikes' | 'addedAt' | 'updatedAt'>> & {
  id?: string;
  /** Legacy input alias: platform tags, folded into topics (tags are redundant of topics). */
  tags?: string[];
};

/** The free-form content data of an entry: short string pairs, bounded in count. */
export function cleanData(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 200) break;
    const name = String(key).trim().slice(0, 80);
    if (!name) continue;
    out[name] = String(raw ?? '').slice(0, 1000);
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanList(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeTag(String(item))).filter(Boolean))].slice(0, max);
}

/** The stored form of a content link: `yt:…`, `url:…`, or an https link mapped to its platform. */
export function normalizeLink(link: string): string {
  const text = String(link).trim();
  const source = parseSource(text) ?? sourceFromUrl(text);
  if (source) return formatSource(source);
  if (/^https?:\/\//.test(text) && text.length <= 2048 && !/\s/.test(text)) return `url:${encodeURIComponent(text).replace(/~/g, '%7E')}`;
  throw badRequest(`Not a link: ${text.slice(0, 80)}`);
}

/** The content id and the link of a pasted id/link, in the forms entries use. */
export function identityOf(input: { id?: string; contentId?: string; link?: string }): { key: string; contentId?: string; link?: string } {
  const parsed = input.id ? parseContentId(input.id) : null;
  const contentId = input.contentId ?? (parsed?.native ? parsed.base : undefined);
  if (contentId !== undefined && !isNativeId(contentId)) throw badRequest(`Not a content id: ${contentId}`);
  // The link the content lives at: its own source for external ids, the first fallback
  // source of a combined id, and a pasted id that is no content id taken as the link.
  const fromId = parsed ? (!parsed.native ? parsed.base : parsed.sources[0] ? formatSource(parsed.sources[0]) : undefined) : input.id;
  const rawLink = input.link ?? fromId;
  const link = rawLink ? normalizeLink(rawLink) : undefined;
  const key = parsed?.base ?? contentId ?? link;
  if (!key) throw badRequest('Content needs a content id or a link');
  return { key, contentId, link };
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
/**
 * Whether the entry's age rating sits at or under every configured per-system maximum.
 * The systems order their categories mild → strict, so "under the maximum" is an earlier
 * spot in that order. A rating a maximum does not name — another system, or none at all
 * (unknown) — passes: unknown stays allowed, exactly as it always has.
 */
function ageRatingWithinMaxima(maxima: { system: string; category: string }[] | undefined, topics: readonly string[]): boolean {
  const rating = parseAgeRating(topics);
  if (!rating || rating.category === UNKNOWN_AGE_RATING) return true;
  for (const max of maxima ?? []) {
    if (max.system.trim().toLowerCase() !== rating.system) continue;
    const categories = ageRatingSystem(max.system)?.categories ?? [];
    const entryAt = categories.findIndex((entry) => categoryMatches(entry, rating.category));
    const maxAt = categories.findIndex((entry) => categoryMatches(entry, max.category));
    if (entryAt >= 0 && maxAt >= 0) {
      // Later in the system's order means stricter: past the maximum is hidden.
      if (entryAt > maxAt) return false;
    } else if (
      // No category order to compare (a free-text rating): the legacy buckets decide.
      RATINGS.indexOf(legacyRatingOf(rating)) > RATINGS.indexOf(legacyRatingOf({ system: max.system, category: max.category }))
    ) {
      return false;
    }
  }
  return true;
}

/** Whether a category of a system is the one named (its slug or its label). */
function categoryMatches(category: { slug: string; label: string }, value: string): boolean {
  const wanted = String(value ?? '').trim().toLowerCase();
  return Boolean(wanted) && (category.slug === wanted || category.label.toLowerCase() === wanted);
}

export class Registry {
  private store: JsonFile<RegistryData>;
  private thumbs = new Map<string, Buffer>();

  constructor(
    path: string | null,
    private readonly thumbDir: string | null,
    /** The node's trace log, when it keeps one. Per-record decisions go to it at detail level. */
    private readonly traces?: TraceStore
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

  /**
   * Finds the entry a content id or link belongs to: by its id, its content id, its
   * link, or a fallback source carried with one of them.
   */
  findByRef(ref: string): Entry | undefined {
    const direct = this.get(ref);
    if (direct) return direct;
    const wanted = new Set<string>();
    try {
      const { key, contentId, link } = identityOf({ id: ref });
      for (const value of [key, contentId, link]) if (value) wanted.add(value);
    } catch {
      wanted.add(ref);
    }
    return this.all().find(
      (entry) =>
        wanted.has(entry.id) ||
        (entry.contentId !== undefined && wanted.has(entry.contentId)) ||
        (entry.link !== undefined && wanted.has(entry.link)) ||
        entry.sources.some((source) => wanted.has(source))
    );
  }

  all(): Entry[] {
    return Object.values(this.store.data.entries);
  }

  creator(id: string | undefined): CreatorRecord | undefined {
    return id ? this.store.data.creators[id] : undefined;
  }

  // -------------------------------------------------------------------------
  // Groups: a creator of kind `group` whose members are other content creators.
  // Membership is binary; there is no linking between creators.

  /** Every group (listed ones only unless asked for more). */
  groups(includeBlocked = false): CreatorRecord[] {
    return Object.values(this.store.data.creators).filter(
      (creator) => creator.kind === 'group' && (includeBlocked || creator.status !== 'blocked')
    );
  }

  /** The creators that are members of a group (ids only); empty for anything else. */
  members(id: string | undefined): string[] {
    const creator = this.creator(id);
    return creator?.kind === 'group' ? [...(creator.members ?? [])] : [];
  }

  /** The groups a creator is a member of, with their names (blocked groups left out). */
  groupsOf(creatorId: string | undefined): { id: string; name: string }[] {
    if (!creatorId) return [];
    return this.groups()
      .filter((group) => (group.members ?? []).includes(creatorId))
      .map((group) => ({ id: group.id, name: group.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Adds and removes members of a group. Only creators the node knows become members. */
  setMembers(groupId: string, add: string[] = [], remove: string[] = []): CreatorRecord {
    const group = this.creator(groupId);
    if (!group) throw badRequest(`Unknown group ${groupId}`);
    const drop = new Set(remove);
    const members = (group.members ?? []).filter((id) => !drop.has(id));
    for (const id of add) {
      if (!this.creator(id)) throw badRequest(`Unknown creator ${id}`);
      if (!members.includes(id)) members.push(id);
    }
    const updated = this.upsertCreator({ id: group.id, name: group.name, kind: 'group', members: members.slice(0, 500) });
    this.traces?.trace('detail', 'algorithm.registry', 'function:setMembers', {
      message: `${group.id.slice(0, 24)} · ${updated.members?.length ?? 0} members`,
      data: { group: group.id.slice(0, 32), added: add.length, removed: remove.length, total: updated.members?.length ?? 0 },
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Topics: a category of content, kept under a hash id (never under its name).

  topic(id: string | undefined): TopicRecord | undefined {
    return id ? this.store.data.topics?.[id] : undefined;
  }

  /** Every topic, listed ones only unless asked for more. */
  topics(includeBlocked = false): TopicRecord[] {
    return Object.values(this.store.data.topics ?? {}).filter((topic) => includeBlocked || topic.status === 'listed');
  }

  /**
   * Stores a topic. A new name gets the id its hash produces, so the same name never
   * doubles; passing an existing id edits that topic (its name may then be changed).
   */
  upsertTopic(input: { id?: string; name: string; description?: string; icon?: string; status?: 'listed' | 'blocked' }): { topic: TopicRecord; created: boolean } {
    const name = String(input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('A topic needs a name');
    const existing = input.id ? this.store.data.topics?.[input.id] : this.store.data.topics?.[topicIdOf(name)];
    if (input.id && !existing) throw badRequest(`Unknown topic ${input.id}`);
    const topic: TopicRecord = {
      id: existing?.id ?? topicIdOf(name),
      // A topic brought by name keeps the name it was first stored with, so "Deep Sea"
      // and "deep sea" never rename each other; only an edit that carries the id renames.
      name: existing && !input.id ? existing.name : name,
      description: (input.description ?? existing?.description)?.slice(0, 2000) || undefined,
      icon: (input.icon !== undefined ? input.icon : existing?.icon) || undefined,
      status: input.status ?? existing?.status ?? 'listed',
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    (this.store.data.topics ??= {})[topic.id] = topic;
    this.changed();
    this.traces?.trace('detail', 'algorithm.registry', 'function:upsertTopic', {
      message: `${topic.id.slice(0, 16)} · ${existing ? 'edited' : 'created'} · ${topic.status}`,
      data: { id: topic.id.slice(0, 32), name: topic.name.slice(0, 40), created: !existing, status: topic.status },
    });
    return { topic, created: !existing };
  }

  /** The topic ids of a list of topic names, storing the topics that are new. */
  topicIdsFor(names: string[], create = true): string[] {
    const ids: string[] = [];
    for (const name of cleanList(names)) {
      const id = topicIdOf(name);
      if (!this.store.data.topics?.[id]) {
        if (!create) continue;
        this.upsertTopic({ name });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** How many listed contents are filed under a topic id. */
  countTopic(id: string): number {
    return this.all().filter((entry) => entry.status === 'listed' && entry.topicIds?.includes(id)).length;
  }

  /** Lists or blocks content, keeping votes and creation time of an existing entry. */
  upsert(input: EntryInput): Entry {
    const { key, contentId, link } = identityOf(input);
    const parsed = input.id ? parseContentId(input.id) : null;
    const existing = this.store.data.entries[key];
    const now = new Date().toISOString();
    if (input.format !== undefined && !FORMATS.includes(input.format)) throw badRequest(`Unknown format ${input.format}`);
    if (input.rating !== undefined && !RATINGS.includes(input.rating)) throw badRequest(`Unknown rating ${input.rating}`);
    const sources = [
      ...new Set([
        ...(existing?.sources ?? []),
        ...(parsed?.sources.map(formatSource) ?? []),
        ...(input.sources ?? []),
        ...(parsed && !parsed.native && parsed.base !== key ? [parsed.base] : []),
      ]),
    ].filter((source) => source !== key);
    const entry: Entry = {
      id: key,
      contentId: contentId ?? existing?.contentId,
      link: link ?? existing?.link,
      sources,
      status: input.status ?? existing?.status ?? 'listed',
      reason: input.reason ?? existing?.reason,
      title: (input.title ?? existing?.title ?? key).slice(0, 300),
      // An empty description or creator clears it (a missing one keeps what is there).
      description: ((input.description ?? existing?.description)?.slice(0, 5000) || undefined),
      format: input.format ?? existing?.format ?? 'other',
      rating: input.rating ?? existing?.rating ?? 'all',
      // A provided topic list replaces the old one (an empty list clears it); tags fold in.
      topics: input.topics !== undefined || input.tags !== undefined ? cleanList([...(input.topics ?? []), ...(input.tags ?? [])], 64) : (existing?.topics ?? []),
      topicIds: input.topics !== undefined || input.tags !== undefined ? this.topicIdsFor(cleanList([...(input.topics ?? []), ...(input.tags ?? [])], 64)) : existing?.topicIds,
      language: input.language ?? existing?.language,
      durationSeconds: input.durationSeconds ?? existing?.durationSeconds,
      gallery: input.gallery ?? existing?.gallery,
      creatorId: (input.creatorId ?? existing?.creatorId) || undefined,
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
      platformStats: input.platformStats ?? existing?.platformStats,
      // A provided data map replaces the old one (an empty one clears it).
      data: input.data !== undefined ? cleanData(input.data) : existing?.data,
    };
    if (entry.status !== 'blocked') delete entry.reason;
    this.store.data.entries[entry.id] = entry;
    this.changed();
    // One listing decision per content id (a new entry, or one whose status moved).
    if (!existing || existing.status !== entry.status) {
      this.traces?.trace('detail', 'algorithm.registry', 'function:upsert', {
        message: `${entry.id.slice(0, 24)} · ${entry.status}${existing ? ` (was ${existing.status})` : ''}`,
        data: { id: entry.id.slice(0, 32), status: entry.status, created: !existing, reason: entry.reason?.slice(0, 80) },
      });
    }
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
    this.traces?.trace('detail', 'algorithm.registry', 'function:remove', {
      message: `${key.slice(0, 24)} · unknown again`,
      data: { id: key.slice(0, 32), status: 'unknown' },
    });
    return true;
  }

  /**
   * Stores a creator. Callers that bring new proof keys only add to the keys on file;
   * the operator's console saves the whole record and may replace them (`replaceKeys`).
   */
  upsertCreator(input: Partial<CreatorRecord> & { id: string }, options?: { replaceKeys?: boolean }): CreatorRecord {
    if (!input.id || input.id.length > 128) throw badRequest('A creator needs an id');
    const existing = this.store.data.creators[input.id];
    const kind = (input.kind ?? existing?.kind ?? 'unknown') as CreatorKind;
    if (!CREATOR_KINDS.includes(kind)) throw badRequest(`Unknown creator kind ${kind}`);
    const record: CreatorRecord = {
      id: input.id,
      name: (input.name ?? existing?.name ?? input.id).slice(0, 120),
      kind,
      description: (input.description ?? existing?.description)?.slice(0, 2000) || undefined,
      keys: [...new Set(options?.replaceKeys ? (input.keys ?? existing?.keys ?? []) : [...(existing?.keys ?? []), ...(input.keys ?? [])])],
      links: input.links ?? existing?.links,
      accounts: input.accounts ?? existing?.accounts,
      icon: (input.icon !== undefined ? input.icon : existing?.icon) || undefined,
      // Only groups have members; other creators keep none.
      members: kind === 'group' ? [...new Set((input.members ?? existing?.members ?? []).filter(Boolean))].slice(0, 500) : undefined,
      status: input.status ?? existing?.status ?? 'listed',
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    this.store.data.creators[record.id] = record;
    this.changed();
    this.traces?.trace('detail', 'algorithm.registry', 'function:upsertCreator', {
      message: `${record.id.slice(0, 24)} · ${record.kind} · ${record.status}`,
      data: { id: record.id.slice(0, 48), kind: record.kind, created: !existing, status: record.status, members: record.members?.length },
    });
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
    this.traces?.trace('detail', 'algorithm.registry', 'function:setThumbnail', {
      message: `${baseId(id).slice(0, 24)} · ${bytes.length} bytes`,
      data: { id: baseId(id).slice(0, 32), bytes: bytes.length, known: Boolean(entry) },
    });
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
    const contentId = entry.contentId ?? (isNativeId(entry.id) ? entry.id : undefined);
    const link = entry.link ?? (isNativeId(entry.id) ? entry.sources[0] : entry.id);
    const groups = this.groupsOf(entry.creatorId);
    return {
      id: [entry.id, ...entry.sources].join('~'),
      status: 'listed',
      contentId,
      link,
      title: entry.title,
      description: entry.description,
      format: entry.format,
      rating: entry.rating,
      topics: entry.topics,
      topicIds: entry.topicIds?.length ? entry.topicIds : undefined,
      language: entry.language,
      durationSeconds: entry.durationSeconds,
      gallery: entry.gallery,
      creator: creator
        ? { id: creator.id, name: creator.name, kind: creator.kind, description: creator.description, keys: creator.keys, links: creator.links, icon: creator.icon }
        : entry.creatorId
          ? { id: entry.creatorId, name: entry.creatorId.slice(0, 12), kind: 'unknown' }
          : undefined,
      groups: groups.length ? groups : undefined,
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
      data: entry.data && Object.keys(entry.data).length ? entry.data : undefined,
    };
  }

  lookup(id: string): LookupResult {
    const entry = this.get(id);
    const creatorBlocked = entry && entry.status !== 'pending' && entry.status !== 'blocked' && this.creator(entry.creatorId)?.status === 'blocked';
    const result: LookupResult =
      !entry || entry.status === 'pending'
        ? { id, status: 'unknown' }
        : entry.status === 'blocked'
          ? { id, status: 'blocked', reason: entry.reason }
          : creatorBlocked
            ? { id, status: 'blocked', reason: 'the creator is blocked' }
            : this.view(entry);
    // The listing decision of one content id, with the reason when there is one.
    this.traces?.trace('detail', 'algorithm.registry', 'function:lookup', {
      message: `${id.slice(0, 24)} · ${result.status}`,
      data: {
        id: id.slice(0, 32),
        status: result.status,
        reason: result.status === 'blocked' ? result.reason?.slice(0, 80) : undefined,
      },
    });
    return result;
  }

  /** Listed entries that pass the viewer's preferences and the node's own rating ceiling. */
  visible(preferences: Preferences, nodeMaxRating: Rating): Entry[] {
    const limit = RATINGS[Math.min(RATINGS.indexOf(preferences.maxRating ?? nodeMaxRating), RATINGS.indexOf(nodeMaxRating))];
    const formats = preferences.formats?.length ? new Set(formatsCovering(preferences.formats)) : null;
    const topics = preferences.onlyTopics && preferences.topics?.length ? new Set(preferences.topics) : null;
    const blockedTopics = preferences.blockedTopics?.length ? new Set(preferences.blockedTopics) : null;
    const blockedCreators = new Set(preferences.blockedCreators ?? []);
    const kinds = preferences.creatorKinds?.length ? new Set(preferences.creatorKinds) : null;
    const languages = preferences.languages?.length ? preferences.languages : null;
    // A language list is a hard filter only when the slider says "only show" (or the
    // preference predates the slider): weaker levels are ranking hints, not exclusions.
    const languageFilter = preferences.languageLevel && preferences.languageLevel !== 'only' ? null : languages;
    // Formats the reader excluded outright (the tri-state list) are never shown.
    const blockedFormats = preferences.blockedFormats?.length ? new Set(formatsCovering(preferences.blockedFormats)) : null;
    // A blocked group blocks everyone in it, not only the group's own page; a whitelisted
    // creator or group keeps that creator, and every member of that group.
    const blockedMembers = new Set<string>();
    const allowedMembers = new Set<string>();
    const allowed = preferences.onlyCreators && preferences.creatorIds?.length ? new Set(preferences.creatorIds) : null;
    for (const group of this.groups(true)) {
      if (group.status === 'blocked' || blockedCreators.has(group.id)) for (const member of group.members ?? []) blockedMembers.add(member);
      if (allowed?.has(group.id)) for (const member of group.members ?? []) allowedMembers.add(member);
    }
    return this.all().filter((entry) => {
      if (entry.status !== 'listed') return false;
      if (!ratingAllowed(entry.rating, limit)) return false;
      if (!ageRatingWithinMaxima(preferences.ageRatingMaxima, [...(entry.topics ?? []), ...(entry.topicIds ?? [])])) return false;
      if (formats && !formats.has(entry.format)) return false;
      if (blockedFormats && blockedFormats.has(entry.format)) return false;
      // Topics match by name or by topic id: a page filter may carry either.
      if (topics && !entry.topics.some((topic) => topics.has(topic)) && !(entry.topicIds ?? []).some((id) => topics.has(id))) return false;
      if (
        blockedTopics &&
        (entry.topics.some((topic) => blockedTopics.has(topic)) || (entry.topicIds ?? []).some((id) => blockedTopics.has(id)))
      )
        return false;
      if (entry.creatorId && blockedCreators.has(entry.creatorId)) return false;
      if (entry.creatorId && blockedMembers.has(entry.creatorId)) return false;
      if (allowed && !(entry.creatorId && (allowed.has(entry.creatorId) || allowedMembers.has(entry.creatorId)))) return false;
      const creator = this.creator(entry.creatorId);
      if (creator?.status === 'blocked') return false;
      if (kinds && !kinds.has(creator?.kind ?? 'unknown')) return false;
      if (languageFilter && !matchesLanguages(entry, languageFilter)) return false;
      return true;
    });
  }

  /**
   * Full-text search over title, topics, creator and description.
   * `#topic` (or `topic:science`) and `@creator` narrow the results; `format:video` filters.
   * A seed makes the order reproducible: it drives the little discovery term that breaks
   * near-ties, so the same seed (and the same trace id) answers the same exact results.
   */
  search(entries: Entry[], query: string, sort: SearchSort, seed = ''): { entry: Entry; score: number }[] {
    const tokens = words(query);
    const creators = tokens.filter((t) => t.startsWith('@')).map((t) => t.slice(1));
    const formats = formatsCovering(tokens.filter((t) => t.startsWith('format:')).map((t) => t.slice(7)) as Format[]);
    const topicFilters = [
      ...tokens.filter((t) => t.startsWith('#')).map((t) => normalizeTag(t.slice(1))),
      ...tokens.filter((t) => t.startsWith('topic:')).map((t) => normalizeTag(t.slice(6))),
    ];
    const terms = tokens.filter((t) => !/^[#@]|^(format|topic):/.test(t));
    const results: { entry: Entry; score: number }[] = [];
    for (const entry of entries) {
      if (formats.length && !formats.includes(entry.format)) continue;
      const topics = entry.topics.map((topic) => normalizeTag(topic));
      if (topicFilters.length && !topicFilters.every((topic) => topics.includes(topic))) continue;
      const creator = this.creator(entry.creatorId);
      const creatorText = `${creator?.name ?? ''} ${entry.creatorId ?? ''}`.toLowerCase();
      if (creators.length && !creators.every((name) => creatorText.includes(name))) continue;
      let score = creators.length + formats.length + topicFilters.length > 0 ? 1 : 0;
      let matched = 0;
      if (terms.length) {
        const title = words(entry.title);
        const description = (entry.description ?? '').toLowerCase();
        for (const term of terms) {
          let termScore = 0;
          if (title.includes(term)) termScore += 4;
          else if (title.some((word) => word.startsWith(term))) termScore += 2.5;
          if (creatorText.includes(term)) termScore += 2;
          if (entry.topics.some((topic) => topic === term || topic.startsWith(term))) termScore += 2;
          if (description.includes(term)) termScore += 1;
          if (entry.format === term) termScore += 1;
          if (termScore > 0) matched++;
          score += termScore;
        }
        if (matched < Math.ceil(terms.length / 2)) continue;
        score *= matched / terms.length;
      }
      if (score <= 0 && terms.length) continue;
      // The seed's discovery term only breaks near-ties: the same seed always answers the
      // same order, and without one the search stays purely about the match.
      const discovery = seed ? seededRandom(seed, entry.id) * 0.25 : 0;
      results.push({ entry, score: score + quality(entry) * 0.5 + discovery });
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
    // What came of one discovered item, per content id.
    const decision = (result: 'added' | 'known' | 'invalid', status?: string): void => {
      this.traces?.trace('detail', 'algorithm.registry', 'function:upsertDiscovered', {
        message: `${item.id.slice(0, 24)} · ${result}${status ? ` · ${status}` : ''}`,
        data: { id: item.id.slice(0, 32), decision: result, status, adapter: item.adapter },
      });
    };
    if (!parsed || !item.title) {
      decision('invalid');
      return 'invalid';
    }
    const now = new Date().toISOString();
    const existing = this.store.data.entries[parsed.base];
    if (existing) {
      if (existing.origin === 'crawler') {
        existing.thumbnailUrl = item.thumbnailUrl ?? existing.thumbnailUrl;
        existing.media = item.media ?? existing.media;
        existing.pageUrl = item.pageUrl ?? existing.pageUrl;
        if (item.stats) existing.platformStats = { ...existing.platformStats, ...(item.stats as Record<string, number>) };
        if (item.rating === 'nsfw') existing.rating = 'nsfw';
      } else {
        existing.thumbnailUrl ??= item.thumbnailUrl;
        existing.media ??= item.media;
        existing.pageUrl ??= item.pageUrl;
      }
      this.changed();
      decision('known', existing.status);
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
      contentId: parsed.native ? parsed.base : undefined,
      link: parsed.native ? (parsed.sources[0] ? formatSource(parsed.sources[0]) : undefined) : parsed.base,
      sources: parsed.sources.map(formatSource).filter((source) => source !== parsed.base),
      status: policy.autoList ? 'listed' : 'pending',
      title: item.title.slice(0, 300),
      description: item.description?.slice(0, 5000),
      format: FORMATS.includes(item.format) ? item.format : 'other',
      rating: item.rating ?? policy.defaultRating,
      // Crawler finds are filed under their topics (raw platform tags fold in too), so a
      // topic page lists them.
      topics: cleanList([...(item.topics ?? []), ...(item.tags ?? [])], 32),
      topicIds: this.topicIdsFor(cleanList([...(item.topics ?? []), ...(item.tags ?? [])], 32)),
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
      platformStats: item.stats as Record<string, number> | undefined,
    };
    this.changed();
    decision('added', this.store.data.entries[parsed.base].status);
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
    if (removable.length) {
      this.changed();
      this.traces?.trace('basic', 'algorithm.registry', 'function:prune', {
        message: `${removable.length} crawler entries dropped`,
        data: { dropped: removable.length, kept: this.all().length, max },
      });
    }
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
