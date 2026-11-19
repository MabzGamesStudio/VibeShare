// Downloadable content copies (URL jobs), submissions, censored word lists and the
// shared error body. Browser-safe.
import type { CreatorKind, Format, Rating } from '../taxonomy.js';

// ---------------------------------------------------------------------------
// Downloadable content copies: a client hands a provider a download link (and its cid)
// and is paid each time the provider pulls content from it. A link is a single content
// URL, or a base URL at which any cid can be queried.

/** What a client submits: one content download URL with its cid, or a base URL. */
export interface ContentUrlSubmission {
  /** A single content id this URL serves; its bytes must hash to exactly this. */
  cid?: string;
  /** The direct download URL for that one cid. */
  url?: string;
  /** Or a base URL: `<baseUrl>/<cid>` serves any cid at the client's endpoint. */
  baseUrl?: string;
}

export interface ContentUrlRecord {
  id: string;
  account: string;
  cid?: string;
  url?: string;
  baseUrl?: string;
  status: 'pending' | 'accepted' | 'rejected';
  downloads: number;
  earned: number;
  createdAt: string;
  /** How many times in a row this endpoint failed to serve — working ones are tried first. */
  fails?: number;
  /** When the last successful check ran (endpoints that just worked move to the top). */
  lastOkAt?: number;
  /** What the latest check of this endpoint found — kept across reloads, shown on the rows. */
  lastOutcome?: 'success' | 'failed' | 'not tested';
  /**
   * For a base URL: the content ids it has actually served. A base URL is one address for
   * every content, so success is kept per content id — a copy of one content saying
   * nothing about another.
   */
  okCids?: string[];
}

/** A place a client can fetch a cid from, offered when this node does not hold the bytes. */
export interface ContentLink {
  cid: string;
  url: string;
}

export interface SubmissionRequest {
  /** Free-form content data to keep on the entry once the submission is accepted. */
  data?: Record<string, string>;
  id: string;
  title: string;
  /** Where the content lives outside VibeShare (a link or a platform source), when there is no content id. */
  link?: string;
  description?: string;
  format?: Format;
  rating?: Rating;
  topics?: string[];
  tags?: string[];
  language?: string;
  durationSeconds?: number;
  /** The images of a list-of-images content (their content ids or links), in order. */
  gallery?: string[];
  creator?: { id?: string; name?: string; kind?: CreatorKind };
  /** data: URL of a small image (≤ 200 kB). */
  thumbnail?: string;
  providers?: string[];
  publishedAt?: string;
  /** Proves the submitter holds the creator key: signs claimSigningPayload(nodeId, baseId, ts). */
  creatorProof?: { key: string; ts: number; sig: string };
}

export function claimSigningPayload(nodeId: string, contentBaseId: string, ts: number): string {
  return `vibeshare-claim\n${nodeId}\n${contentBaseId}\n${ts}`;
}

/**
 * The two word sets an algorithm node's operator keeps on the comments page: `words`
 * (a comment containing one — or a close, evasive variant of one — is hidden) and
 * `adjacent` (entries that only count when they sit next to a censored word).
 */
export type CensoredSet = 'words' | 'adjacent';

/** One page of a censored word set. */
export interface CensoredWordsPage {
  set: CensoredSet;
  items: string[];
  /** The offset of the next page, when the list has more. */
  cursor?: string;
  total: number;
}

/** What adding, renaming or deleting a word came to (a repeat add is a friendly no-op). */
export interface CensoredWordsChange {
  set: CensoredSet;
  /** False when nothing changed (a repeat word, or one that is not on the list). */
  changed: boolean;
  total: number;
  /** A friendly explanation when nothing changed. */
  note?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Content removal requests. A creator asking for their own content gets it deleted
// at once; anyone else's ask is queued for the operator's review.

/** What a client sends to POST /v1/removals: the content to remove and why. */
export interface RemovalRequestInput {
  /** A content id (`vs1…`) or a link id the node knows. */
  id: string;
  /** The requester's reason, shown to the operator reviewing the request. */
  message?: string;
}

/** One queued removal request, waiting for the operator. */
export interface RemovalRequest {
  /** The request's own id (what the admin's approve/reject name). */
  id: string;
  /** The content the request is about, in the node's own id form. */
  cid: string;
  /** The account that asked. */
  account: string;
  message?: string;
  at: string;
  status: 'pending';
}

/** What POST /v1/removals answered: a creator's own content is deleted at once. */
export type RemovalOutcome = { deleted: true } | { queued: true; request: RemovalRequest };

/** One row of the admin's delete review: the request plus what the node knows of the content. */
export interface RemovalRequestView extends RemovalRequest {
  title?: string;
  creator?: string;
}
