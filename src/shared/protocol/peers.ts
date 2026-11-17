// Peering between search algorithm nodes: metadata by id or link, discoveries, and
// full-catalog pushes. Browser-safe.
import type { CommentBlock } from '../comments.js';
import type { CreatorKind, Format, Rating } from '../taxonomy.js';
import type { ContentMedia, ContentOrigin, CreatorAccount, CreatorInfo, TagNote } from './content.js';

// ---------------------------------------------------------------------------
// Peering between search algorithm nodes: metadata by id or link, and discoveries.

/** Metadata about one content, as nodes share it with their peers. */
export interface PeerEntry {
  id: string;
  contentId?: string;
  link?: string;
  sources: string[];
  status: 'listed' | 'blocked' | 'pending';
  title: string;
  description?: string;
  format: Format;
  rating: Rating;
  topics: string[];
  language?: string;
  durationSeconds?: number;
  creator?: CreatorInfo;
  thumbnail?: string;
  pageUrl?: string;
  origin?: ContentOrigin;
  publishedAt: string;
  platformStats?: Record<string, number>;
  providers?: string[];
}

/** What a node asks a peer for: content matching some criteria. */
export interface PeerDiscoverCriteria {
  /** Only content of this source (youtube, reddit…). */
  platform?: string;
  /** Only content that has a content id, a link, or both. */
  has?: 'any' | 'cid' | 'link' | 'both';
  /** Only content whose platform numbers (views, likes, comments…) are in these ranges. */
  metrics?: { key: string; min?: number; max?: number }[];
  /** Content filters: formats, a rating ceiling and topics. */
  filters?: { formats?: Format[]; maxRating?: Rating; topics?: string[] };
  /** How the peer picks from what matches: its newest, its most popular, or at random. */
  algorithm?: 'new' | 'popular' | 'random';
  limit?: number;
}

// ---------------------------------------------------------------------------
// Full-catalog pushes between search algorithm nodes (manual content sync): one node
// ships its whole catalog to a peer in bounded batches — content entries with their
// metadata, topics, creators and groups, and the comment chains of content pages.
// The push driver (POST /v1/admin/peers/push) sends one batch at a time and reports
// per-category progress; the receiving side is POST /v1/peers/import.

/** A content entry as a node ships it in a full-catalog push: what the registry keeps
 *  per content, listing decisions and topic filing included. Votes are per account and
 *  stay local, and so do thumbnail images (only a remote thumbnail URL travels). */
export interface PeerCatalogEntry {
  id: string;
  contentId?: string;
  link?: string;
  sources?: string[];
  status: 'listed' | 'blocked' | 'pending';
  /** Why the entry is blocked, when it is. */
  reason?: string;
  title: string;
  description?: string;
  format: Format;
  rating: Rating;
  /** The topic names the entry is filed under. */
  topics?: string[];
  /** The exact topic ids it is filed under (each matches a topic record). */
  topicIds?: string[];
  language?: string;
  durationSeconds?: number;
  /** The images of a list-of-images content, in order. */
  gallery?: ContentMedia[];
  creatorId?: string;
  providers?: string[];
  publishedAt: string;
  pageUrl?: string;
  /** Remote thumbnail of discovered content. */
  thumbnailUrl?: string;
  media?: ContentMedia;
  /** Platform popularity numbers the node kept (views, likes, comments…). */
  platformStats?: Record<string, number>;
  notes?: TagNote[];
  origin?: ContentOrigin;
}

/** A topic as a node ships it in a full-catalog push. */
export interface PeerTopicRecord {
  /** The topic's id when the sending node keeps one; new topics are keyed by name. */
  id?: string;
  name: string;
  description?: string;
  icon?: string;
  status?: 'listed' | 'blocked';
}

/** A creator — or a group (kind `group`, with its members) — as a node ships it.
 *  Proof keys are deliberately absent: they are trust anchors and never travel with a
 *  catalog (the operator or the creator's own proof brings them here). */
export interface PeerCreatorRecord {
  id: string;
  name: string;
  kind: CreatorKind;
  description?: string;
  links?: string[];
  accounts?: CreatorAccount[];
  icon?: string;
  /** Groups only: the creator ids that are members. */
  members?: string[];
  status?: 'listed' | 'blocked';
}

/** One content page's comment chain as a node ships it: the full block history, with
 *  comment data only where it is verifiable (signed by the commenter's key). */
export interface PeerCommentChain {
  /** The page's root: its cid, or its first link when it has no cid. */
  content: string;
  blocks: CommentBlock[];
}

/** One bounded batch of a full-catalog push. */
export interface PeerImportBatch {
  entries?: PeerCatalogEntry[];
  topics?: PeerTopicRecord[];
  /** Creator records, groups included or not. */
  creators?: PeerCreatorRecord[];
  /** Groups as their own list: creator records of kind `group`, with their members. */
  groups?: PeerCreatorRecord[];
  comments?: PeerCommentChain[];
}

export interface PeerImportCount {
  accepted: number;
  skipped: number;
}

/** What a node reports back for one imported batch. */
export interface PeerImportReport {
  entries: PeerImportCount;
  topics: PeerImportCount;
  creators: PeerImportCount;
  groups: PeerImportCount;
  /** Comment chains: a page's chain is imported whole or not at all. */
  comments: PeerImportCount;
  /** The first few reasons items were skipped. */
  errors: string[];
}

/** The categories a full-catalog push moves, in the order it syncs them. */
export const PEER_PUSH_CATEGORIES = ['topics', 'creators', 'entries', 'comments'] as const;
export type PeerPushCategory = (typeof PEER_PUSH_CATEGORIES)[number];

/** One call of the admin push driver: one bounded batch to one node, and how far it got. */
export interface PeerPushResult {
  ref: string;
  /** null for a totals-only probe (a call without a category). */
  category: PeerPushCategory | null;
  /** How many items a full sync moves, per category. */
  totals: Record<PeerPushCategory, number>;
  /** How many items this call sent. */
  sent: number;
  /** The cursor to pass for the next batch of this category; null when it is done (or
   *  when the push failed — then retry with the cursor that was passed in). */
  cursor: string | null;
  done: boolean;
  /** What the receiving node reported for the batch. */
  report?: PeerImportReport;
  /** When the push did not reach the node (unreachable, not a peer…): what went wrong. */
  error?: string;
  /** Comment chains left out because one chain does not fit in a batch (comments only). */
  oversized?: number;
}
