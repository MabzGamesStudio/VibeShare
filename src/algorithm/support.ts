// Shared building blocks of the algorithm node: paging, the matching behind
// searches, and the cleaning of untrusted records. Pure functions only.

import { type ContentMedia, type ContentOrigin, type CreatorAccount, type Page, SUGGESTION_KINDS, type SuggestionKind, type TagNote } from '../shared/protocol.js';
import { type Format, normalizeTag } from '../shared/taxonomy.js';
import { type CreatorRecord, type TopicRecord } from './registry.js';

export function offsetOf(cursor: string | undefined): number {
  const value = Number(cursor ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
export function pageOf<T>(items: T[], cursor: string | undefined, limit: number): Page<T> {
  const offset = offsetOf(cursor);
  const slice = items.slice(offset, offset + limit);
  return { items: slice, cursor: offset + limit < items.length ? String(offset + limit) : undefined, total: items.length };
}
/**
 * The requested formats with the ones their medium covers: "image" covers image lists
 * too — an image list is images packaged in one content — so the image medium shows
 * both however the request words it.
 */
export function formatsCovering(formats: Format[]): Format[] {
  return formats.includes('image') && !formats.includes('image-list') ? [...formats, 'image-list'] : formats;
}

/** A few matching native items lead every surface. Explicitly filtered pages get a few
 *  of each requested format; an unfiltered page gets three native items overall. */
export function nativeSuggestions<T extends { id: string; format: Format }>(entries: T[], formats: Format[] = []): T[] {
  const native = entries.filter((entry) => entry.id.startsWith('vs1'));
  if (!formats.length) return native.slice(0, 3);
  const first: T[] = [];
  for (const format of formatsCovering(formats)) first.push(...native.filter((entry) => entry.format === format && !first.includes(entry)).slice(0, 3));
  return first;
}
export function slug(text: string): string {
  return normalizeTag(text).slice(0, 40) || 'creator';
}
/** The words of a search phrase or a name: lower case, any order, matched partly. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
/**
 * How well a creator matches the words of a search — null when they do not. Every word
 * must appear in the name, the id or a linked account, but the name need not match
 * exactly: the words may come in any order and match only partly. Lower is better:
 * the whole name, the name as a prefix, the starts of its words, parts of its words,
 * or only the id/accounts.
 */
export function creatorMatch(creator: CreatorRecord, phrase: string): number | null {
  const words = wordsOf(phrase);
  if (!words.length) return 0;
  const name = creator.name.toLowerCase();
  const nameWords = wordsOf(name);
  const extras = [
    creator.id.toLowerCase(),
    ...(creator.accounts ?? []).flatMap((account) => [
      account.platform.toLowerCase(),
      account.handle.toLowerCase(),
      (account.url ?? '').toLowerCase(),
    ]),
  ];
  const matched = (word: string) => name.includes(word) || extras.some((text) => text.includes(word));
  if (!words.every(matched)) return null;
  const whole = words.join(' ');
  if (name === whole) return 0;
  if (name.startsWith(whole)) return 1;
  if (words.every((word) => nameWords.some((part) => part.startsWith(word)))) return 2;
  if (words.every((word) => nameWords.some((part) => part.includes(word)))) return 3;
  return 4;
}
/** How well a topic matches a search phrase; null when it does not match at all. */
export function topicMatch(topic: TopicRecord, phrase: string): number | null {
  const text = phrase.trim().toLowerCase();
  if (!text) return 0;
  const name = topic.name.toLowerCase();
  if (name === text || topic.id === text) return 0;
  if (name.startsWith(text)) return 1;
  const words = wordsOf(text);
  const nameWords = wordsOf(name);
  if (words.every((word) => nameWords.some((part) => part.startsWith(word)))) return 2;
  if (words.every((word) => nameWords.some((part) => part.includes(word)))) return 3;
  if (name.includes(text) || topic.id.includes(text)) return 4;
  return null;
}
/** Creator ids a client suggests for a group: trimmed, deduplicated, capped. */
export function cleanIds(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter((id) => id && id.length <= 128))].slice(0, max);
}
/** Links a client suggests for a group, kept as plain https links. */
export function cleanLinks(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((item) => String(item ?? '').trim()).filter((url) => /^https?:\/\//.test(url) && url.length <= 2048 && !/\s/.test(url))),
  ].slice(0, max);
}
/** The first `max` items of a batch list; anything beyond the bound is not read. */
export function asArray<T>(value: unknown, max: number): T[] {
  return Array.isArray(value) ? (value.slice(0, max) as T[]) : [];
}
/** The hash shapes the comment chain is built from (sha256 hex, or '' for no previous). */
export function isHashHex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
export const CONTENT_ORIGINS: ContentOrigin[] = ['operator', 'submission', 'crawler', 'report', 'peer'];
/** Platform accounts of a creator as a peer ships them: typed, bounded, no node-filled fields. */
export function cleanAccounts(value: unknown, max = 16): CreatorAccount[] {
  const out: CreatorAccount[] = [];
  for (const raw of asArray(value, max)) {
    const account = (raw ?? {}) as Partial<CreatorAccount>;
    const platform = String(account.platform ?? '').trim().slice(0, 64);
    const handle = String(account.handle ?? '').trim().slice(0, 120);
    if (!platform || !handle) continue;
    out.push({
      platform,
      handle,
      url: typeof account.url === 'string' && /^https?:\/\//.test(account.url) ? account.url.slice(0, 2048) : undefined,
      creator: typeof account.creator === 'string' ? account.creator.slice(0, 128) || undefined : undefined,
      subscribers: Number.isFinite(account.subscribers) ? Math.max(0, Math.round(Number(account.subscribers))) : undefined,
    });
  }
  return out;
}
/** One media reference (a gallery image, or the entry's media), as a peer ships it. */
export function cleanMedia(value: unknown): ContentMedia | undefined {
  const media = (value ?? {}) as Partial<ContentMedia>;
  const url = String(media.url ?? '').slice(0, 2048);
  const type = String(media.type ?? '');
  if (!url || (type !== 'image' && type !== 'video' && type !== 'audio')) return undefined;
  const size = (raw: unknown) => (Number.isFinite(raw) ? Math.max(1, Math.round(Number(raw))) : undefined);
  return { url, type, width: size(media.width), height: size(media.height) };
}
/** The images of a list-of-images content, in order. */
export function cleanMediaList(value: unknown, max = 64): ContentMedia[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.slice(0, max).map(cleanMedia).filter((media): media is ContentMedia => Boolean(media));
  return out.length ? out : undefined;
}
/** Platform popularity numbers (views, likes, comments…): finite numbers only. */
export function cleanStats(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 16)) {
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    out[key.slice(0, 32)] = number;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Tag notes (accepted suggestions kept on an entry), typed and bounded. */
export function cleanNotes(value: unknown, max = 32): TagNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TagNote[] = [];
  for (const raw of value.slice(0, max)) {
    const note = (raw ?? {}) as Partial<TagNote>;
    const kind = String(note.kind ?? '') as SuggestionKind;
    const text = String(note.value ?? '').slice(0, 200);
    if (!SUGGESTION_KINDS.includes(kind) || !text) continue;
    out.push({
      kind,
      value: text,
      reason: String(note.reason ?? '').slice(0, 500),
      timestamp: Number.isFinite(note.timestamp) ? Number(note.timestamp) : undefined,
    });
  }
  return out.length ? out : undefined;
}
