// Comments on content pages and the operator's censored words: the hash-chained
// log itself, how comments are served and kept back, and the fuzzy matching that
// keeps censored words — and close evasions of them — out of sight.

import type { AlgorithmNode } from '../node.js';
import { type Account } from '../../node/ledger.js';
import { isKeyId, verifySignature } from '../../shared/crypto.js';
import { buildManifestFromBuffer, contentIdOf } from '../../shared/content.js';
import { type CommentBlock, type CommentData, type CommentOrder, type CommentTimePrecision, blockHash, commentDataHash, commentIdAt, commentOrderOf, commentRemovePayload, commentSigningPayload } from '../../shared/comments.js';
import { type Ctx, badRequest, forbidden, notFound, readJson } from '../../shared/node/http.js';
import { log } from '../../shared/node/log.js';
import { NodeClient } from '../../shared/nodeclient.js';
import { type CensoredSet, type CensoredWordsChange, type CensoredWordsPage } from '../../shared/protocol.js';
import { baseId } from '../../shared/sources.js';
import { offsetOf } from '../support.js';

/** The two word sets, kept sorted so the console's pages never skip an entry. */
export interface CensorshipData {
  /** Words whose presence — or a close variant of one — hides a comment. */
  words: string[];
  /** Words that only count when they sit within one word of a censored one. */
  adjacent: string[];
  /** Lookalike spellings kept for matching only, generated from `words` — never listed. */
  variants?: string[];
}
/** Leet-speak and lookalike characters folded to the letters they stand for. */
export const LEET: Record<string, string> = { '@': 'a', '+': 't', '0': 'o', '1': 'i', '!': 'i', '$': 's', '3': 'e', '4': 'a', '5': 's', '7': 't', '|': 'i' };
export function leetFold(text: string): string {
  let out = '';
  for (const raw of text.toLowerCase()) out += LEET[raw] ?? raw;
  return out;
}
/** One word as the censor filter sees it: "@R+" reads as "art", and so does "arrrt". */
export function normalizeCensorWord(word: string): string {
  return leetFold(word)
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/(.)\1+/gu, '$1');
}
/** The words of a comment as the censor filter sees them, in order. */
export function censorTokens(text: string): string[] {
  return leetFold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.replace(/(.)\1+/gu, '$1'))
    .filter(Boolean);
}
/** The lookalike characters one letter of a word is spelled with (leet-speak, digits).
 *  'l' and 'i' share '1' — exactly the ambiguity the stored spellings keep around. */
const LOOKALIKES: Record<string, string[]> = {
  a: ['@', '4'],
  b: ['8'],
  e: ['3'],
  g: ['9'],
  i: ['1', '!', '|'],
  l: ['1', '|'],
  o: ['0'],
  s: ['5', '$'],
  t: ['+', '7'],
};
/** Cap on the lookalikes kept per word: singles and pairs only, never every combination. */
const MAX_VARIANTS = 64;

/**
 * The common lookalike spellings of one censored word — generated when the operator adds
 * the word, stored for matching, and never shown in their list. Deterministic and
 * bounded: every one- and two-character substitution (the pairs catch evasions like
 * "8i9" for "big", which fold to no single spelling), then case and zero-width tricks,
 * capped per word.
 */
export function censorVariants(raw: string): string[] {
  const word = String(raw ?? '').trim().toLowerCase();
  if (!word || !/^[\p{L}\p{N}]+$/u.test(word)) return [];
  const letters = [...word];
  const options = letters.map((letter) => [letter, ...(LOOKALIKES[letter] ?? [])]);
  const out: string[] = [];
  const seen = new Set<string>([word]);
  const emit = (spelling: string) => {
    if (out.length >= MAX_VARIANTS || seen.has(spelling)) return;
    seen.add(spelling);
    out.push(spelling);
  };
  // One-character substitutions first…
  for (let i = 0; i < letters.length; i++) {
    for (const letter of options[i]) {
      if (letter !== letters[i]) emit(letters.map((c, at) => (at === i ? letter : c)).join(''));
    }
  }
  // …then pairs, in a fixed order and still bounded by the cap.
  for (let i = 0; i < letters.length && out.length < MAX_VARIANTS; i++) {
    for (let j = i + 1; j < letters.length && out.length < MAX_VARIANTS; j++) {
      for (const a of options[i]) {
        for (const b of options[j]) {
          if (a === letters[i] && b === letters[j]) continue;
          emit(letters.map((c, at) => (at === i ? a : at === j ? b : c)).join(''));
        }
      }
    }
  }
  // Case and zero-width tricks last.
  emit(word[0].toUpperCase() + word.slice(1));
  emit(letters.map((letter, index) => (index % 2 ? letter.toUpperCase() : letter)).join(''));
  emit(word.toUpperCase());
  emit(letters.join('\u200b'));
  return out;
}

/** Regenerates the stored lookalikes of the words set — after every change to it. */
export function rebuildCensorVariants(node: AlgorithmNode): void {
  node.censorship.data.variants = [...new Set(node.censorship.data.words.flatMap(censorVariants))];
}

/** Levenshtein distance with an early exit past `max` (words here are short). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}
/**
 * Whether a word counts as the censored one: exactly after normalization ("@R+" is
 * "art"), plus one or two small edits around longer words. Short words match exactly
 * only, so a three-letter censored word never pulls in its innocent neighbours.
 */
export function isCensoredVariant(word: string, censored: string): boolean {
  const a = normalizeCensorWord(word);
  const b = normalizeCensorWord(censored);
  if (!a || !b) return false;
  if (a === b) return true;
  const limit = b.length <= 3 ? 0 : b.length <= 7 ? 1 : 2;
  return editDistance(a, b, limit) <= limit;
}
/** The word set an admin route names; anything else is a bad request. */
export function censoredSetOf(value: string): CensoredSet {
  if (value === 'words' || value === 'adjacent') return value;
  throw badRequest('set is words or adjacent');
}
/** One content page's comment chain, kept here. */
export interface CommentSection {
  /** The whole block chain, in order. */
  blocks: CommentBlock[];
  /** Whose account voted how, per comment id. */
  votes: Record<string, Record<string, 1 | -1>>;
  /** Comment ids whose data the node keeps back (the author asked, or the operator hid it). */
  hidden: string[];
  /** Whether this section sends comment data at all (false: the headers only). */
  shown: boolean;
  /** When the data lives on a content provider instead: the content id that holds it. */
  remote?: string;
}
export interface CommentsData {
  sections: Record<string, CommentSection>;
  /** When each account last added a block, for the rate limit. */
  recent: Record<string, number[]>;
}
export interface CommentPostBody {
  text?: string;
  replyFrom?: string;
  editOf?: string;
  anonymous?: boolean;
  timePrecision?: CommentTimePrecision;
  key?: string;
  sig?: string;
}
export function censoredSet(node: AlgorithmNode, set: CensoredSet): string[] {
  return set === 'words' ? node.censorship.data.words : node.censorship.data.adjacent;
}
/** Word sets are kept sorted (case-insensitively) so paging never skips an entry. */
export function sortCensored(node: AlgorithmNode, list: string[]): void {
  list.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}
/**
 * Whether a comment's text is kept back, and for which reason. Words close to a
 * censored one count as it (leet-speak, padded letters, a typo, an inserted letter).
 * Adjacent words are the second set, with deliberately simple semantics: their entries
 * only count when one sits next to (within one word of) a censored word.
 */
export function censoredIn(node: AlgorithmNode, text: string): 'censored' | 'adjacent' | null {
  const { words, adjacent, variants } = node.censorship.data;
  if (!words.length && !adjacent.length) return null;
  const tokens = censorTokens(text);
  const hits = (token: string, list: string[]) => list.some((entry) => isCensoredVariant(token, entry));
  // The operator's words together with their stored lookalike spellings ("8i9" for
  // "big"): those live for matching only and never show in the list.
  const forms = variants?.length ? [...words, ...variants] : words;
  if (tokens.some((token) => hits(token, forms))) return 'censored';
  for (let i = 0; i < tokens.length; i++) {
    if (!hits(tokens[i], adjacent)) continue;
    const neighbours = [tokens[i - 1], tokens[i + 1]].filter((token): token is string => Boolean(token));
    if (neighbours.some((token) => hits(token, words))) return 'adjacent';
  }
  return null;
}
/** One page of a word set, by offset. */
export function censoredPage(node: AlgorithmNode, set: CensoredSet, cursor: string | undefined, limit: number): CensoredWordsPage {
  const list = censoredSet(node, set);
  const offset = offsetOf(cursor);
  return {
    set,
    items: list.slice(offset, offset + limit),
    cursor: offset + limit < list.length ? String(offset + limit) : undefined,
    total: list.length,
  };
}
/** Whether two entries are the same word to the filter (any spelling or casing). */
function sameCensorWord(a: string, b: string): boolean {
  const na = normalizeCensorWord(a);
  const nb = normalizeCensorWord(b);
  return na ? na === nb : a.toLowerCase() === b.toLowerCase();
}

/** Adds a word to a set. A word already there, in any spelling, is a friendly no-op. */
export function addCensoredWord(node: AlgorithmNode, set: CensoredSet, raw: string): CensoredWordsChange {
  const word = String(raw ?? '').trim().slice(0, 64);
  if (!word) throw badRequest('A word is required');
  const list = censoredSet(node, set);
  if (list.some((entry) => sameCensorWord(entry, word))) {
    return { set, changed: false, total: list.length, note: `"${word}" is already on the list.` };
  }
  list.push(word);
  sortCensored(node, list);
  node.censorship.changed();
  rebuildCensorVariants(node);
  return { set, changed: true, total: list.length };
}

/**
 * Adds one word or a whole list at once — commas and new lines both separate the
 * entries. They are trimmed, normalised for comparison and deduped ("@r+" and "art" are
 * one word), and each is stored exactly as the operator typed it.
 */
export function addCensoredWords(node: AlgorithmNode, set: CensoredSet, raw: string): CensoredWordsChange {
  const entries = String(raw ?? '')
    .split(/[,\n]/)
    .map((entry) => entry.trim().slice(0, 64))
    .filter(Boolean);
  const seen = new Set<string>();
  const words = entries.filter((entry) => {
    const key = normalizeCensorWord(entry) || entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!words.length) throw badRequest('A word is required');
  if (words.length === 1) return addCensoredWord(node, set, words[0]);
  const before = censoredSet(node, set).length;
  for (const word of words) addCensoredWord(node, set, word);
  const added = censoredSet(node, set).length - before;
  return {
    set,
    changed: added > 0,
    total: censoredSet(node, set).length,
    note: added ? `Added ${added} word${added === 1 ? '' : 's'}.` : 'Every word on that list is already there.',
  };
}
/** Renames one entry of a set, keeping the set free of repeats. */
export function renameCensoredWord(node: AlgorithmNode, set: CensoredSet, rawFrom: string, rawTo: string): CensoredWordsChange {
  const from = String(rawFrom ?? '').trim();
  const to = String(rawTo ?? '').trim().slice(0, 64);
  if (!to) throw badRequest('A word is required');
  const list = censoredSet(node, set);
  const at = list.findIndex((entry) => entry.toLowerCase() === from.toLowerCase());
  if (at < 0) return { set, changed: false, total: list.length, note: 'That word is not on the list.' };
  if (list.some((entry, index) => index !== at && sameCensorWord(entry, to))) {
    return { set, changed: false, total: list.length, note: `"${to}" is already on the list.` };
  }
  list[at] = to;
  sortCensored(node, list);
  node.censorship.changed();
  rebuildCensorVariants(node);
  return { set, changed: true, total: list.length };
}
/** Drops one entry of a set. */
export function deleteCensoredWord(node: AlgorithmNode, set: CensoredSet, rawWord: string): CensoredWordsChange {
  const word = String(rawWord ?? '').trim();
  const list = censoredSet(node, set);
  const at = list.findIndex((entry) => entry.toLowerCase() === word.toLowerCase());
  if (at < 0) return { set, changed: false, total: list.length };
  list.splice(at, 1);
  node.censorship.changed();
  rebuildCensorVariants(node);
  return { set, changed: true, total: list.length };
}
export function commentSection(node: AlgorithmNode, id: string): { key: string; section: CommentSection } {
  const key = baseId(id);
  const sections = node.comments.data.sections;
  if (!sections[key]) sections[key] = { blocks: [], votes: {}, hidden: [], shown: true };
  return { key, section: sections[key] };
}
/** A content page's comment section, if one is kept yet: reading never stores anything. */
export function findCommentSection(node: AlgorithmNode, id: string): { key: string; section?: CommentSection } {
  const key = baseId(id);
  return { key, section: node.comments.data.sections[key] };
}
/** How much of the posting time is written down: exactly what the commenter allows. */
export function commentTime(node: AlgorithmNode, precision: CommentTimePrecision | undefined): string {
  const now = new Date();
  if (precision === 'date') return now.toISOString().slice(0, 10);
  if (precision === 'year') return String(now.getUTCFullYear());
  if (precision === 'none') return '';
  return now.toISOString();
}
/** The precision of a written time, so an edit keeps what the comment already chose. */
export function precisionOf(node: AlgorithmNode, time: string): CommentTimePrecision {
  if (time.length >= 20) return 'datetime';
  if (time.length >= 8) return 'date';
  if (time.length >= 4) return 'year';
  return 'none';
}
export function appendCommentBlock(node: AlgorithmNode, section: CommentSection, data: CommentData): CommentBlock {
  const prev = section.blocks.at(-1)?.hash ?? '';
  const dataHash = commentDataHash(data);
  const block: CommentBlock = { prev, dataHash, hash: blockHash(prev, dataHash, data.id), id: data.id, data };
  section.blocks.push(block);
  return block;
}
/** The comment data this node holds, or reads back from the content provider. */
export async function commentDataOf(node: AlgorithmNode, section: CommentSection): Promise<(CommentData | null)[]> {
  if (!section.remote) return section.blocks.map((block) => block.data ?? null);
  return fetchCommentData(node, section.remote);
}
/**
 * The chain as clients get it: every header, and the comment data of the comments the
 * node sends. `load` picks which comment data goes out (the ranked first screen and
 * what scrolled in after it); headers of comments whose data waits its turn are marked
 * `pending`, headers of comments kept back stay plain (clients show those removed).
 */
export function servedComments(node: AlgorithmNode, section: CommentSection, data: (CommentData | null)[], load: Set<string> | null): CommentBlock[] {
  const hidden = new Set(section.hidden);
  return section.blocks.map((block, index) => {
    const comment = data[index];
    // Operator-hidden and censored comments are both kept back: the header stays in
    // the chain, the data never goes out.
    const kept = Boolean(comment && (hidden.has(comment.id) || censoredIn(node, comment.text)));
    const sending = Boolean(section.shown && comment && !kept && (!load || load.has(comment.id)));
    return sending
      ? { ...block, data: comment as CommentData }
      : {
          prev: block.prev,
          dataHash: block.dataHash,
          hash: block.hash,
          id: block.id,
          ...(section.shown && comment && !kept && load ? { pending: true } : {}),
        };
  });
}
/**
 * The comment ids in the order the node wants them shown. The order is the node's own
 * decision — a client only suggests one — and it is what the first screen of comment
 * data and every later scroll load follow.
 */
export function rankComments(node: AlgorithmNode, section: CommentSection, data: (CommentData | null)[], order: CommentOrder): string[] {
  if (!section.shown) return [];
  const hidden = new Set(section.hidden);
  const votes = commentVotes(node, section, undefined);
  const latest = new Map<string, CommentData>();
  for (const comment of data) if (comment && !hidden.has(comment.id) && !censoredIn(node, comment.text)) latest.set(comment.id, comment);
  const score = (id: string) => {
    const vote = votes[id] ?? { likes: 0, dislikes: 0 };
    return { likes: vote.likes, dislikes: vote.dislikes, at: Date.parse(latest.get(id)!.time) || 0 };
  };
  const comparators: Record<CommentOrder, (a: string, b: string) => number> = {
    'most-liked': (a, b) => score(b).likes - score(a).likes || score(b).at - score(a).at,
    'most-disliked': (a, b) => score(b).dislikes - score(a).dislikes || score(b).at - score(a).at,
    newest: (a, b) => score(b).at - score(a).at,
    oldest: (a, b) => score(a).at - score(b).at,
    relevant: (a, b) => score(b).likes - score(b).dislikes - (score(a).likes - score(a).dislikes) || score(b).at - score(a).at,
  };
  return [...latest.keys()].sort(comparators[order] ?? comparators.relevant);
}
/** Where the votes on each comment stand, including the asking account's own. */
export function commentVotes(node: AlgorithmNode, section: CommentSection,
  account: string | undefined): Record<string, { likes: number; dislikes: number; mine?: 1 | -1 | 0 }> {
  const out: Record<string, { likes: number; dislikes: number; mine?: 1 | -1 | 0 }> = {};
  for (const [id, votes] of Object.entries(section.votes)) {
    let likes = 0;
    let dislikes = 0;
    for (const vote of Object.values(votes)) {
      if (vote === 1) likes++;
      else dislikes++;
    }
    out[id] = account && votes[account] ? { likes, dislikes, mine: votes[account] } : { likes, dislikes };
  }
  return out;
}
/** The rate limit: how many blocks one account may add per hour. */
export function noteCommentBlock(node: AlgorithmNode, account: string): void {
  const limit = node.config.comments.maxPerHour;
  const recent = node.comments.data.recent;
  const times = (recent[account] ?? []).filter((at) => Date.now() - at < 3600_000);
  if (limit > 0 && times.length >= limit) throw badRequest(`At most ${limit} comments per hour`);
  times.push(Date.now());
  recent[account] = times;
}
export async function saveComments(node: AlgorithmNode, section: CommentSection): Promise<void> {
  node.comments.changed();
  if (node.config.comments.storage === 'provider') await offloadComments(node, section);
}
/** Appends a comment (or an edit of one) to a content page's chain. */
export async function postComment(node: AlgorithmNode, contentId: string, account: Account, body: CommentPostBody): Promise<CommentBlock> {
  // The text is signed and hashed exactly as it comes: only its presence is checked, so
  // a signature never covers other bytes than the chain ends up hashing.
  const text = String(body.text ?? '');
  const maxLength = node.config.comments.maxLength;
  if (!text.trim()) throw badRequest('A comment needs text');
  if (text.length > maxLength) throw badRequest(`A comment is at most ${maxLength} characters`);
  // The censored words are checked as the comment lands (posts and edits alike), and
  // again every time comments are read — so a word added later hides older comments too.
  if (censoredIn(node, text)) throw badRequest('This comment carries a word this node does not allow');
  const { key: root, section } = commentSection(node, contentId);
  const data = await commentDataOf(node, section);
  noteCommentBlock(node, account.id);

  if (body.editOf) {
    // A block may carry an existing comment's id only to edit it, and only the same
    // exact commenter may: the same key, proven again on the new text.
    const original = data.filter((comment) => comment?.id === body.editOf).at(-1);
    if (!original) throw notFound('No such comment');
    if (!original.key || body.anonymous) throw forbidden('Anonymous comments cannot be edited');
    const replyFrom = original.replyFrom;
    if (
      body.key !== original.key ||
      !body.sig ||
      !verifySignature(original.key, commentSigningPayload({ key: original.key, replyFrom, text }), body.sig)
    ) {
      throw forbidden("Only the comment's own key may edit it");
    }
    const block = appendCommentBlock(node, section, {
      id: original.id,
      text,
      key: original.key,
      sig: body.sig,
      time: commentTime(node, body.timePrecision ?? precisionOf(node, original.time)),
      replyFrom,
    });
    await saveComments(node, section);
    return block;
  }

  // A first level comment replies to the page's root: its cid, or its first link when
  // the page has no cid. The node makes up the id from what the comment attaches to,
  // the commenter's key (nothing, when the comment is anonymous), the hash of the text
  // and the most recent block header ('0' when the comment starts the chain).
  const replyFrom = !body.replyFrom || body.replyFrom === '0' ? root : String(body.replyFrom);
  if (replyFrom !== root && !data.some((comment) => comment?.id === replyFrom)) throw badRequest('A comment replies to one that exists');
  const id = commentIdAt(replyFrom, section.blocks.at(-1)?.hash ?? '', text, body.anonymous ? undefined : body.key);
  if (body.anonymous) {
    // Anonymous comments carry no key: they can never be edited or removed later.
    const block = appendCommentBlock(node, section, { id, text, time: commentTime(node, body.timePrecision), replyFrom });
    await saveComments(node, section);
    return block;
  }
  if (!body.key || !isKeyId(body.key) || !body.sig || !verifySignature(body.key, commentSigningPayload({ key: body.key, replyFrom, text }), body.sig)) {
    throw forbidden("A comment needs a signature by its commenter's key");
  }
  const block = appendCommentBlock(node, section, {
    id,
    text,
    key: body.key,
    sig: body.sig,
    time: commentTime(node, body.timePrecision),
    replyFrom,
  });
  await saveComments(node, section);
  return block;
}
/** The author asking for their comment to go: the data goes, the headers stay. */
export async function removeComment(node: AlgorithmNode, contentId: string, commentId: string, body: { key?: string; sig?: string }): Promise<void> {
  const { section } = findCommentSection(node, contentId);
  if (!section) throw notFound('No such comment');
  const data = await commentDataOf(node, section);
  const original = data.filter((comment) => comment?.id === commentId).at(-1);
  if (!original) throw notFound('No such comment');
  if (!original.key) throw forbidden('Anonymous comments cannot be removed');
  if (body.key !== original.key || !body.sig || !verifySignature(original.key, commentRemovePayload(commentId), body.sig)) {
    throw forbidden("Only the comment's own key may remove it");
  }
  if (!section.hidden.includes(commentId)) section.hidden.push(commentId);
  await saveComments(node, section);
}
export function voteComment(node: AlgorithmNode, contentId: string, commentId: string, account: Account, vote: number): void {
  const { section } = findCommentSection(node, contentId);
  if (!section) throw notFound('No such comment');
  const votes = (section.votes[commentId] ??= {});
  if (vote === 1 || vote === -1) votes[account.id] = vote;
  else delete votes[account.id];
  if (!Object.keys(votes).length) delete section.votes[commentId];
  node.comments.changed();
}
/** Everything the operator's console shows about one comment section. */
export async function adminComments(node: AlgorithmNode, id: string): Promise<Record<string, unknown>> {
  const { key, section } = findCommentSection(node, id);
  if (!section) return { content: key, shown: true, blocks: 0, votes: {}, comments: [] };
  const data = await commentDataOf(node, section);
  const hidden = new Set(section.hidden);
  const votes = commentVotes(node, section, undefined);
  const latest = new Map<string, CommentData>();
  for (const comment of data) if (comment) latest.set(comment.id, comment);
  return {
    content: key,
    shown: section.shown,
    blocks: section.blocks.length,
    votes,
    comments: [...latest.values()].map((comment) => ({
      ...comment,
      hidden: hidden.has(comment.id),
      likes: votes[comment.id]?.likes ?? 0,
      dislikes: votes[comment.id]?.dislikes ?? 0,
    })),
  };
}
/** Flushes all comment data the node keeps for one content page: blocks, votes and hides. */
export function flushComments(node: AlgorithmNode, id: string): boolean {
  const { key } = findCommentSection(node, id);
  const existed = Boolean(node.comments.data.sections[key]);
  if (existed) {
    delete node.comments.data.sections[key];
    node.comments.changed();
  }
  return existed;
}
/** The content provider client that keeps comment data when storage is 'provider'. */
export function commentProviderClient(node: AlgorithmNode, url: string): NodeClient {
  return new NodeClient({
    url: url.replace(/\/$/, ''),
    expectedType: 'provider',
    auth: 'identity',
    identity: node.identity,
    transport: () => node.transport(url),
  });
}
/** Sends a section's comment data to the content provider and keeps only headers here. */
export async function offloadComments(node: AlgorithmNode, section: CommentSection): Promise<void> {
  const provider = node.config.comments.provider;
  if (!provider?.url) return;
  try {
    const client = commentProviderClient(node, provider.url);
    const payload = section.blocks.map((block) => block.data ?? null);
    const chunks = new Map<string, Buffer>();
    const manifest = await buildManifestFromBuffer(
      Buffer.from(JSON.stringify(payload)),
      { name: 'comments.json', mime: 'application/json' },
      (id, chunk) => {
        chunks.set(id, chunk);
      }
    );
    const cid = contentIdOf(manifest);
    const offloadStarted = Date.now();
    const started = await client.json<{ missing: string[] }>('/v1/uploads', { method: 'POST', body: { manifest } });
    for (const chunkId of started.missing) {
      const chunk = chunks.get(chunkId);
      if (chunk) await client.fetch(`/v1/uploads/${cid}/chunks/${chunkId}`, { method: 'PUT', body: chunk });
    }
    await client.json(`/v1/uploads/${cid}/commit`, { method: 'POST', body: {} });
    section.remote = cid;
    for (const block of section.blocks) delete block.data;
    node.traces.trace('dependency', 'algorithm.comments', 'function:offloadComments', {
      message: `provider kept ${cid.slice(0, 24)}`,
      data: node.traces.summarize({ cid: cid.slice(0, 32), url: `${client.url}/v1/uploads/${cid}/commit`, method: 'POST', ms: Date.now() - offloadStarted, blocks: section.blocks.length }),
    });
  } catch (error) {
    // The data stays here while the provider cannot take it.
    log.debug(`Comment data upload: ${(error as Error).message}`);
    node.traces.trace('error', 'algorithm.comments', 'function:offloadComments', {
      message: `${section.blocks.length} blocks kept here`,
      error: (error as Error).message,
    });
  }
}
export async function fetchCommentData(node: AlgorithmNode, remote: string): Promise<(CommentData | null)[]> {
  const provider = node.config.comments.provider;
  if (!provider?.url) return [];
  const client = commentProviderClient(node, provider.url);
  const fetchStarted = Date.now();
  const manifest = await client.json<{ chunks: { id: string }[] }>(`/v1/content/${remote}`);
  const parts: Buffer[] = [];
  for (const chunk of manifest.chunks) {
    const response = await client.fetch(`/v1/chunks/${chunk.id}?cid=${remote}`);
    parts.push(Buffer.from(await response.arrayBuffer()));
  }
  const data = JSON.parse(Buffer.concat(parts).toString()) as (CommentData | null)[];
  node.traces.trace('dependency', 'algorithm.comments', 'function:fetchCommentData', {
    message: `${remote.slice(0, 24)} · ${manifest.chunks.length} chunks`,
    data: node.traces.summarize({ cid: remote.slice(0, 32), url: `${client.url}/v1/content/${remote}`, method: 'GET', ms: Date.now() - fetchStarted, chunks: manifest.chunks.length, comments: data.length }),
  });
  return data;
}
/**
 * A page's chain as it travels in a push: every header, and comment data only where
 * it is verifiable — the comment carries its commenter's key and signature and the
 * section actually sends its data. Anonymous comment data never travels (nothing
 * proves it), and neither does hidden data: those comments go as headers only, which
 * is exactly how clients already take them.
 */
export function commentSyncBlocks(node: AlgorithmNode, section: CommentSection, data: (CommentData | null)[]): CommentBlock[] {
  return section.blocks.map((block, index) => {
    const comment = data[index];
    // Censored comment data travels no further than hidden data does.
    const keep = Boolean(section.shown && comment?.key && comment.sig && !section.hidden.includes(comment.id) && !censoredIn(node, comment.text));
    return keep ? { ...block, data: comment as CommentData } : { prev: block.prev, dataHash: block.dataHash, hash: block.hash, id: block.id };
  });
}
export function registerCommentsRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
    router.get('/v1/comments/:id', async (ctx) => {
      const account = node.auth.account(ctx);
      // Reading a page never stores anything: a page without comments sends an empty chain.
      const { key: root, section } = findCommentSection(node, ctx.params.id);
      const order = commentOrderOf(ctx.query.get('order'));
      const offset = Math.max(0, Math.trunc(Number(ctx.query.get('offset') ?? 0)) || 0);
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(ctx.query.get('limit') ?? 20)) || 20));
      const data = section ? await commentDataOf(node, section) : [];
      const rank = section ? rankComments(node, section, data, order) : [];
      const loaded = Math.min(offset + limit, rank.length);
      return {
        root,
        blocks: section ? servedComments(node, section, data, new Set(rank.slice(0, loaded))) : [],
        votes: section ? commentVotes(node, section, account?.id) : {},
        shown: section?.shown ?? true,
        order,
        rank,
        total: rank.length,
        loaded,
      };
    });

    router.post('/v1/comments/:id', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<CommentPostBody>(ctx.req);
      const block = await postComment(node, ctx.params.id, account, body);
      const { section } = findCommentSection(node, ctx.params.id);
      // Post or edit, with the account and how big the chain stands now.
      node.traces.trace('basic', 'algorithm.comments', body.editOf ? 'function:editComment' : 'function:postComment', {
        message: `${account.id.slice(0, 12)} · ${block.id.slice(0, 16)} · ${section?.blocks.length ?? 0} blocks`,
        data: {
          content: baseId(ctx.params.id).slice(0, 32),
          comment: block.id.slice(0, 24),
          account: account.id.slice(0, 16),
          edit: Boolean(body.editOf),
          anonymous: Boolean(body.anonymous),
          blocks: section?.blocks.length ?? 0,
        },
      });
      return { block };
    });

    router.post('/v1/comments/:id/:comment/vote', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<{ vote?: number }>(ctx.req);
      voteComment(node, ctx.params.id, ctx.params.comment, account, Number(body.vote ?? 0));
      const { section } = commentSection(node, ctx.params.id);
      return { votes: commentVotes(node, section, account.id) };
    });

    router.post('/v1/comments/:id/:comment/remove', async (ctx) => {
      const account = node.auth.require(ctx);
      await removeComment(node, ctx.params.id, ctx.params.comment, await readJson<{ key?: string; sig?: string }>(ctx.req));
      const { section } = findCommentSection(node, ctx.params.id);
      // The data goes, the header stays: how many of each are left.
      node.traces.trace('basic', 'algorithm.comments', 'function:removeComment', {
        message: `${account.id.slice(0, 12)} · ${ctx.params.comment.slice(0, 16)} · ${section?.hidden.length ?? 0} hidden`,
        data: {
          content: baseId(ctx.params.id).slice(0, 32),
          comment: ctx.params.comment.slice(0, 24),
          account: account.id.slice(0, 16),
          hidden: section?.hidden.length ?? 0,
          blocks: section?.blocks.length ?? 0,
        },
      });
      return { removed: true };
    });

    router.get('/v1/admin/comments', (ctx) => {
      admin(ctx);
      return {
        sections: Object.entries(node.comments.data.sections)
          .filter(([, section]) => section.blocks.length > 0)
          .map(([content, section]) => ({
            content,
            blocks: section.blocks.length,
            hidden: section.hidden.length,
            shown: section.shown,
          })),
      };
    });
    router.get('/v1/admin/comments/:id', async (ctx) => {
      admin(ctx);
      return adminComments(node, ctx.params.id);
    });
    // Flushing a page's comment data: every block, vote and hiding goes, the page starts over.
    router.delete('/v1/admin/comments/:id', (ctx) => {
      admin(ctx);
      const flushed = flushComments(node, ctx.params.id);
      node.traces.trace('basic', 'algorithm.admin', 'function:flushComments', {
        message: `${ctx.params.id.slice(0, 24)} · ${flushed ? 'flushed' : 'no comments'}`,
        data: { content: baseId(ctx.params.id).slice(0, 32), flushed },
      });
      return { flushed };
    });
    router.put('/v1/admin/comments/:id', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ shown?: boolean }>(ctx.req);
      const { section } = findCommentSection(node, ctx.params.id);
      if (!section) throw notFound('No comment section on this page');
      section.shown = body.shown !== false;
      node.comments.changed();
      node.traces.trace('basic', 'algorithm.admin', 'function:setCommentsShown', {
        message: `${ctx.params.id.slice(0, 24)} · data ${section.shown ? 'shown' : 'withheld'}`,
        data: { content: baseId(ctx.params.id).slice(0, 32), shown: section.shown, blocks: section.blocks.length },
      });
      return adminComments(node, ctx.params.id);
    });
    router.post('/v1/admin/comments/:id/:comment/:action', async (ctx) => {
      admin(ctx);
      if (ctx.params.action !== 'hide' && ctx.params.action !== 'show') throw badRequest('hide or show');
      const { section } = findCommentSection(node, ctx.params.id);
      if (!section) throw notFound('No comment section on this page');
      const at = section.hidden.indexOf(ctx.params.comment);
      if (ctx.params.action === 'hide' && at < 0) section.hidden.push(ctx.params.comment);
      if (ctx.params.action === 'show' && at >= 0) section.hidden.splice(at, 1);
      node.comments.changed();
      node.traces.trace('basic', 'algorithm.admin', 'function:setCommentHidden', {
        message: `${ctx.params.comment.slice(0, 16)} · ${ctx.params.action}`,
        data: {
          content: baseId(ctx.params.id).slice(0, 32),
          comment: ctx.params.comment.slice(0, 24),
          hidden: ctx.params.action === 'hide',
          hiddenCount: section.hidden.length,
        },
      });
      return adminComments(node, ctx.params.id);
    });

    // The censored words of this node, edited from the comments page: two sets, listed
    // one page at a time, and kept free of repeats (adding one already there is a no-op).
    router.get('/v1/admin/censored/:set', (ctx) => {
      admin(ctx);
      return censoredPage(node, censoredSetOf(ctx.params.set), ctx.query.get('cursor') ?? undefined, node.listLimit(ctx.query.get('limit')));
    });
    router.post('/v1/admin/censored/:set', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ word?: string }>(ctx.req);
      // One word or a whole list: commas and new lines both separate the entries.
      return addCensoredWords(node, censoredSetOf(ctx.params.set), String(body.word ?? ''));
    });
    router.put('/v1/admin/censored/:set', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ from?: string; to?: string }>(ctx.req);
      return renameCensoredWord(node, censoredSetOf(ctx.params.set), String(body.from ?? ''), String(body.to ?? ''));
    });
    router.delete('/v1/admin/censored/:set/:word', (ctx) => {
      admin(ctx);
      return deleteCensoredWord(node, censoredSetOf(ctx.params.set), decodeURIComponent(ctx.params.word));
    });

}

