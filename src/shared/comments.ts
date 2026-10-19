// Comments on content pages: a hash-chained log the clients verify themselves.
// Every comment is one block: the block's header hashes the previous block's header (if
// any) and the hash of the comment data. The data (text, id, commenter verification, time
// and reply-from) is what the node may keep back; the headers it always sends, so the
// chain stays verifiable. Browser-safe: no Node imports.
import { sha256hex, verifySignature } from './crypto.js';

/** How much of the posting time the commenter wants written down. */
export type CommentTimePrecision = 'datetime' | 'date' | 'year' | 'none';

export const COMMENT_TIME_PRECISIONS: CommentTimePrecision[] = ['datetime', 'date', 'year', 'none'];

/** The hashed content of one comment block. */
export interface CommentData {
  /** Comment id: a uuid the node made up (or an existing one, when this block edits it). */
  id: string;
  text: string;
  /** The commenter's key id and signature; absent when the comment is anonymous. */
  key?: string;
  sig?: string;
  /** When it was posted, as precisely as the commenter allowed ('' = not written down). */
  time: string;
  /** '0' for a top level comment, otherwise the id of the comment it is a reply from. */
  replyFrom: string;
}

/** One block of a comment section's chain. */
export interface CommentBlock {
  /** Header hash of the previous block ('' for the first block). */
  prev: string;
  /** sha256 of the canonical comment data. */
  dataHash: string;
  /** sha256 of (prev + dataHash + id): this block's header hash. */
  hash: string;
  /** The comment id, in the header: an edit reuses the id, and it stays when data goes. */
  id: string;
  /** The comment data; absent when the node keeps only the header (removed or hidden). */
  data?: CommentData;
}

/** What one comment resolves to after the whole chain is verified. */
export interface CommentEntry {
  id: string;
  text: string;
  time: string;
  /** The comment it is a reply from; a first level comment replies to the page's root. */
  replyFrom: string;
  key?: string;
  anonymous: boolean;
  edited: boolean;
  likes: number;
  dislikes: number;
  /** The asking account's own vote. */
  mine: 1 | -1 | 0;
  /** Earlier versions of the text, oldest first (edit history, kept by the chain). */
  history: { text: string; time: string }[];
}

/** A block whose data the node keeps back: the comment existed and was removed. */
export interface RemovedEntry {
  removed: true;
  id: string;
}

export type ChainEntry = CommentEntry | RemovedEntry;

export interface CommentVotes {
  likes: number;
  dislikes: number;
  mine?: 1 | -1 | 0;
}

/** What a commenter signs (the fields they know before the node fills in id and time). */
export function commentSigningPayload(data: { key?: string; replyFrom: string; text: string }): string {
  return ['vibeshare-comment', data.key ?? '', data.replyFrom, data.text].join('\n');
}

/** What a commenter signs to ask for their comment to be removed. */
export function commentRemovePayload(id: string): string {
  return `vibeshare-comment-remove\n${id}`;
}

/** The canonical shape of the comment data, hashed into the block header. */
function canonicalComment(data: CommentData): string {
  return JSON.stringify([data.id, data.text, data.key ?? '', data.sig ?? '', data.time, data.replyFrom]);
}

export function commentDataHash(data: CommentData): string {
  return sha256hex(canonicalComment(data));
}

/** A block's header hash: the previous header, the data hash and the comment id. */
export function blockHash(prev: string, dataHash: string, id: string): string {
  return sha256hex(prev + dataHash + id);
}

/**
 * The node makes up comment ids deterministically: the hash of the page's root (its cid,
 * or its first link when it has no cid) and where the comment's block sits in the chain.
 * An edit reuses the id of the comment it edits.
 */
export function commentIdAt(root: string, index: number): string {
  return sha256hex(`${root}\n${index}`);
}

/**
 * Verifies a whole comment chain and resolves it into the comments it holds. The chain is
 * all or nothing: anything that does not verify — a broken header link, changed data, a
 * signature that does not check out, an edit by another key — comes back as an error and
 * no comments are shown. Blocks without data are the comments the node keeps back.
 */
export function checkCommentChain(
  blocks: CommentBlock[],
  votes: Record<string, CommentVotes> = {}
): { entries: ChainEntry[]; errors: string[] } {
  const errors: string[] = [];
  const entries: ChainEntry[] = [];
  const byId = new Map<string, CommentEntry>();
  let prev = '';
  for (const [index, block] of blocks.entries()) {
    if (block.prev !== prev) errors.push(`Block ${index + 1} does not link to the one before it`);
    if (block.hash !== blockHash(block.prev, block.dataHash, block.id)) errors.push(`Block ${index + 1} header hash does not match its contents`);
    prev = block.hash;
    const data = block.data;
    if (!data) {
      entries.push({ removed: true, id: block.id });
      continue;
    }
    if (data.id !== block.id) errors.push(`The data of block ${index + 1} is not about the comment its header names`);
    if (commentDataHash(data) !== block.dataHash) {
      errors.push(`The data of block ${index + 1} does not match its hash`);
      continue;
    }
    if (data.key && !verifySignature(data.key, commentSigningPayload(data), data.sig ?? '')) {
      errors.push(`The signature on comment ${data.id} does not verify`);
      continue;
    }
    const vote = votes[data.id] ?? { likes: 0, dislikes: 0 };
    const known = byId.get(data.id);
    if (!known) {
      const entry: CommentEntry = {
        id: data.id,
        text: data.text,
        time: data.time,
        replyFrom: data.replyFrom,
        key: data.key,
        anonymous: !data.key,
        edited: false,
        likes: vote.likes,
        dislikes: vote.dislikes,
        mine: vote.mine ?? 0,
        history: [],
      };
      byId.set(data.id, entry);
      entries.push(entry);
    } else {
      // A later block with the same id edits the comment; only the same exact key may.
      if (known.key !== data.key || !data.key) {
        errors.push(`Comment ${data.id} was edited by a different key`);
        continue;
      }
      known.history.push({ text: known.text, time: known.time });
      known.text = data.text;
      known.time = known.time || data.time;
      known.edited = true;
    }
  }
  return { entries, errors };
}
