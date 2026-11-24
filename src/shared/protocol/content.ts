// Algorithm-node content: creators, groups, topics, content items, feeds and search,
// suggestions, reports and claims. Browser-safe.
import type { BloomFilterData } from '../bloom.js';
import type { CommentBlock } from '../comments.js';
import type { CreatorKind, Format, Rating, SuggestLevel } from '../taxonomy.js';

// ---------------------------------------------------------------------------
// Algorithm node: metadata, feeds, search

/** One of a creator's linked accounts on another platform (YouTube, TikTok, Twitter…). */
export interface CreatorAccount {
  /** The platform, as a source scheme (`yt`, `tiktok`, `x`…) or a host. */
  platform: string;
  /** The handle or user name on that platform. */
  handle: string;
  /** A direct link to the account, when known. */
  url?: string;
  /**
   * The VibeShare creator this account is related to (a creator id like `name:…`/`vk1…`,
   * or a link id like `yt:abcdef`). Related creators with a page here belong in the
   * creator page's carousel; accounts without one are just outside-platform links.
   */
  creator?: string;
  /** How many subscribers (or followers) the account has, when known. */
  subscribers?: number;
  /**
   * The related creator's own name and icon, filled in by the node when it already knows
   * that creator: its info is what shows then, not the submitted handle or subscriber
   * count.
   */
  name?: string;
  icon?: string;
}

export interface CreatorInfo {
  id: string;
  name: string;
  kind: CreatorKind;
  description?: string;
  /** Public keys (vk1…) that sign this creator's manifests. */
  keys?: string[];
  links?: string[];
  /** The creator's accounts on other platforms, linked together (capped by the node). */
  accounts?: CreatorAccount[];
  /** The creator's icon: a data: URL of a small image (≤ 200 kB). */
  icon?: string;
  /**
   * Groups only (kind `group`): the content creators that are members. Membership is
   * binary — a creator is in the group or not — with no linking between creators.
   */
  members?: string[];
}

/**
 * A group page's view: the group, its member creators (resolved) and every member's
 * content in one list. A group behaves like a creator everywhere else: it is searched,
 * subscribed to and shown the same way.
 */
export interface GroupInfo extends CreatorInfo {
  kind: 'group';
  members: string[];
  memberCreators?: CreatorInfo[];
}

/** A topic: a category of content. Its id is a hash, never its name. */
export interface TopicInfo {
  id: string;
  name: string;
  description?: string;
  /** A data: URL of a small image (≤ 200 kB), suggested by users or set by the operator. */
  icon?: string;
  /** How many listed contents carry this topic id. */
  items?: number;
}

/** A client creating a topic (or asking for one the node does not have yet). */
export interface TopicCreateRequest {
  name: string;
  description?: string;
}

export interface TopicCreateResponse {
  topic: TopicInfo;
  /** True when the topic did not exist before (the client brought the name). */
  newInfo: boolean;
  credited: number;
}

/** A client's suggestion of a change to a group: members, name, description, links, icon. */
export interface GroupSuggestionRequest {
  /** Creator ids to add to the group. */
  add?: string[];
  /** Creator ids to remove from the group. */
  remove?: string[];
  name?: string;
  description?: string;
  links?: string[];
  /** A data: URL of a small image (≤ 200 kB). */
  icon?: string;
  reason?: string;
}

/** A suggested group change, as the node keeps it for the operator. */
export interface GroupSuggestion extends GroupSuggestionRequest {
  id: string;
  groupId: string;
  groupName?: string;
  accountId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  credited?: number;
}

export interface GroupSuggestionResponse {
  suggestion: GroupSuggestion;
  newInfo: boolean;
  credited: number;
}

/** A client's suggestion of a topic description or icon. */
export interface TopicSuggestionRequest {
  description?: string;
  /** A data: URL of a small image (≤ 200 kB). */
  icon?: string;
  reason?: string;
}

export interface TopicSuggestion extends TopicSuggestionRequest {
  id: string;
  topicId: string;
  topicName?: string;
  accountId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  credited?: number;
}

export interface TopicSuggestionResponse {
  suggestion: TopicSuggestion;
  newInfo: boolean;
  credited: number;
}

export interface TagNote {
  kind: SuggestionKind;
  value: string;
  reason: string;
  /** Seconds into the media that show the evidence. */
  timestamp?: number;
}

export interface ContentItem {
  /** Full content id, including fallback sources (`vs1…~yt:…`). */
  id: string;
  /** Free-form content data the operator or publisher set: short string pairs. */
  data?: Record<string, string>;
  status: 'listed';
  title: string;
  description?: string;
  format: Format;
  rating: Rating;
  topics: string[];
  /** The topic ids this content is filed under (each matches a topic record exactly). */
  topicIds?: string[];
  language?: string;
  durationSeconds?: number;
  creator?: CreatorInfo;
  /** The groups the content's creator is a member of. */
  groups?: { id: string; name: string }[];
  /**
   * The thumbnail: a path on the algorithm node (/v1/thumbnails/<key>) for thumbnails it
   * stores, or an absolute https URL for content discovered on other platforms.
   */
  thumbnail?: string;
  /** Directly displayable media of external content (an image, an mp4…), when the platform offers it. */
  media?: ContentMedia;
  /** The images of a list-of-images content, in the order they are shown. */
  gallery?: ContentMedia[];
  /** The page of the content on its platform. */
  pageUrl?: string;
  /** How the algorithm node learnt about it. */
  origin?: ContentOrigin;
  publishedAt: string;
  /** VibeShare votes on this node; views/platformLikes come from the original platform when known. */
  stats: { likes: number; dislikes: number; views?: number; platformLikes?: number };
  /** Provider node references known to host the content. */
  providers?: string[];
  notes?: TagNote[];
  /** The VibeShare content id (vs1…), when the content is published on VibeShare. Kept separate from the link. */
  contentId?: string;
  /** Where the content lives outside VibeShare (a link or a platform source like `yt:…`), when it has no content id. */
  link?: string;
  /** One of the few native suggestions that leads a page even when already seen. */
  nativeSuggestion?: boolean;
  /**
   * Namespaced extension bag: arbitrary members a fork or app adds without a protocol
   * change. Receivers ignore it (and every other member they do not know), and senders
   * must not rely on it surviving a hop — nodes may drop it while copying metadata.
   */
  x?: Record<string, unknown>;
}

export type ContentOrigin = 'operator' | 'submission' | 'crawler' | 'report' | 'peer';

export interface ContentMedia {
  url: string;
  type: 'image' | 'video' | 'audio';
  width?: number;
  height?: number;
}

export type LookupResult =
  | ContentItem
  | { id: string; status: 'blocked'; reason?: string }
  | { id: string; status: 'unknown' };

export interface Preferences {
  /** Only these formats (empty = all). */
  formats?: Format[];
  /** Highest age rating to show. */
  maxRating?: Rating;
  /** Topics to favour. */
  topics?: string[];
  /** Only show the topics above. */
  onlyTopics?: boolean;
  /** Topics never to show (by name or topic id). */
  blockedTopics?: string[];
  blockedCreators?: string[];
  /** Only these creators (and group members) — a whitelist of creator ids. */
  creatorIds?: string[];
  /** Only show content by the creators/creators in groups listed above. */
  onlyCreators?: boolean;
  /** Only creators of these kinds (empty = all). */
  creatorKinds?: CreatorKind[];
  /**
   * How strongly the format, topic and creator picks below weigh in the recommendations
   * (see SuggestLevel): "only" narrows to them, "ignore" leaves them out entirely, and the
   * stops in between ask the node to favour them to that degree.
   */
  formatLevel?: SuggestLevel;
  topicLevel?: SuggestLevel;
  creatorLevel?: SuggestLevel;
  /** The picks those levels refer to (they are only required at the "only show" level). */
  preferredFormats?: Format[];
  preferredTopics?: string[];
  preferredCreators?: string[];
  /** Age-rating reasons (violence, language, …) whose content to leave out entirely. */
  disregard?: string[];
  /** Platforms (content sources like youtube) to favour or exclude, and how strongly. */
  preferredPlatforms?: string[];
  blockedPlatforms?: string[];
  platformLevel?: SuggestLevel;
  /**
   * Only these languages (codes like "en"; empty = all). Content that declares a language
   * must declare one of them; other content is kept when its title could be in one of them,
   * judged leniently by the letters it uses (see shared/language.ts).
   */
  languages?: string[];
}

export interface FeedRequest {
  preferences?: Preferences;
  cursor?: string;
  limit?: number;
  /** Keeps a randomized ranking stable across pages. */
  seed?: string;
  /**
   * A small copy of the user's seen-content bloom filter: the node leaves out anything
   * whose cid or links collide with it (see also the filters it stores for the account).
   */
  bloom?: BloomFilterData;
  /** Include preview image URLs in results (true unless explicitly false). */
  previews?: boolean;
}

export type SearchSort = 'relevance' | 'new' | 'top';

export interface SearchRequest {
  query: string;
  filters?: Preferences & { creator?: string; platform?: string };
  sort?: SearchSort;
  cursor?: string;
  limit?: number;
  /** A small seen-content bloom filter; anything that collides with it is not suggested. */
  bloom?: BloomFilterData;
  /** Include preview image URLs in results (true unless explicitly false). */
  previews?: boolean;
  /** The seed the node's non-deterministic steps draw from instead of chance. */
  seed?: string;
  /** The client's trace id: with the same one (and the same parameters) the node tries to
   *  answer with the exact same results. */
  trace?: string;
}

/**
 * A page of one collection. `cursor` is an **opaque** string: pass it back unchanged to
 * get the next page; when it is absent, the last page was reached. `total`, when
 * present, is the size of the collection the page was cut from. Ordering is stable for
 * one pagination run (the same cursor sequence walks the same order), but the catalog
 * may change between pages: items added or removed mid-pagination can shift what a
 * later page shows — resume promptly and de-duplicate by id on the client.
 */
export interface Page<T> {
  items: T[];
  cursor?: string;
  total?: number;
}

/**
 * Per-collection caps on `limit`, matching the clamps the routes enforce today. Routes
 * clamp through `pageLimit` below so the wire constant and the server agree.
 */
export const PAGE_LIMITS = {
  /** Feeds and searches on an algorithm node (POST /v1/feed, POST /v1/search). */
  feed: 100,
  search: 100,
  /** Creator listings (POST /v1/creators/latest, GET /v1/creators). */
  creators: 100,
  /** The provider catalog (GET /v1/catalog). */
  catalog: 200,
  /** Ids accepted by one lookup (POST /v1/lookup). */
  lookupIds: 200,
  /** The account's own contribution lists (e.g. GET /v1/submissions/mine). */
  mine: 200,
  /** The operator console lists (the admin API's list limit). */
  admin: 500,
} as const;

/**
 * The limit one route uses: `requested` clamped into [1, cap], falling back to the
 * caller's own default (or the cap) when it is missing or not a number.
 */
export function pageLimit(collection: keyof typeof PAGE_LIMITS, requested: unknown, fallback?: number): number {
  const cap = PAGE_LIMITS[collection];
  const want = Math.floor(Number(requested ?? fallback ?? cap));
  return Math.min(cap, Math.max(1, Number.isFinite(want) ? want : (fallback ?? cap)));
}

export const SUGGESTION_KINDS = ['topic', 'format', 'rating', 'creator', 'published', 'report', 'source', 'duplicate', 'tag', 'title', 'description', 'thumbnail', 'data', 'topics'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/**
 * A creator linking their accounts on other platforms (YouTube, TikTok, Twitter…) on a
 * node. Signing is optional: with `proof` — a signature of
 * `claimSigningPayload(nodeId, creator, ts)` with the creator's key — the accounts are
 * linked at once. Without it, anyone may propose external links to the creator (every
 * account must carry its link), and the node's operator decides whether to link them.
 * The node caps how many accounts may be linked (`maxCreatorAccounts` in its info).
 */
export interface CreatorAccountLinkRequest {
  /** The creator on this node (`name:…`, `vk1…`). New creators take their key as id. */
  creator: string;
  /** The accounts to link together (this replaces the creator's list when signed). */
  accounts: CreatorAccount[];
  /** Name and kind, used when the creator is new. */
  name?: string;
  kind?: CreatorKind;
  /** Optional proof the caller holds this creator's key (the request is then trusted). */
  proof?: { key: string; ts: number; sig: string };
  /**
   * Whether links between accounts go both ways (the default): an account pointing at
   * another creator also appears on that creator's page. `false` makes it one way.
   */
  symmetric?: boolean;
}

/** An unsigned proposal to link accounts (external links) to a creator, for review. */
export interface AccountLinkProposal {
  id: string;
  /** The creator the accounts are proposed for. */
  creatorId: string;
  creatorName?: string;
  accounts: CreatorAccount[];
  /** Name and kind, when the proposal would start the creator's record. */
  name?: string;
  kind?: CreatorKind;
  accountId: string;
  status: 'pending' | 'accepted';
  createdAt: string;
  reviewedAt?: string;
  /** Whether accepted links go both ways (the default) or only point one way. */
  symmetric?: boolean;
}

/** What linking accounts answers: done at once (signed), or kept for the operator. */
export interface AccountLinkResponse {
  /** True when the accounts were linked now (the request was signed with the creator key). */
  linked: boolean;
  creator?: CreatorInfo;
  proposal?: AccountLinkProposal;
}

/** Content a client suggests as related to a creator, with an optional message. */
export interface CreatorContentRequest {
  /** The content: a content id (`vs1…`, with sources) or a link (`yt:…`, `url:…`). */
  id: string;
  /** An optional message for the operator. */
  message?: string;
  /** The content's title, when the client knows it. */
  title?: string;
  /** The platform the content lives on (`youtube`, `tiktok`…), for the operator. */
  platform?: string;
  /** Platform numbers the client saw (views, likes, comments…), kept when accepted. */
  metrics?: Record<string, number>;
}

/** One suggested piece of content on a creator, as the node keeps it for review. */
export interface CreatorContentSuggestion {
  id: string;
  /** The creator the content is related to. */
  creatorId: string;
  /** The suggested content, in the node's own form (its key). */
  contentId: string;
  /** The reference as the client sent it (a content id or a link). */
  contentRef: string;
  message?: string;
  /** What the client knows about the content: title, platform and its numbers. */
  title?: string;
  platform?: string;
  metrics?: Record<string, number>;
  accountId: string;
  status: 'pending' | 'accepted';
  createdAt: string;
  reviewedAt?: string;
  /** Credits the suggesting client earned when it was accepted. */
  credited?: number;
}

export interface CreatorContentResponse {
  suggestion: CreatorContentSuggestion;
  /** True when this suggestion was new (the node did not already have it waiting). */
  newInfo: boolean;
  /** Credits earned (paid when the operator accepts the suggestion). */
  credited: number;
}

/** An icon a client suggests for a creator (a small image). */
export interface CreatorIconRequest {
  /** A data: URL of a small image (≤ 200 kB): png, jpeg, webp or gif. */
  icon: string;
}

/** A suggested creator icon, as the node keeps it for review. */
export interface CreatorIconSuggestion {
  id: string;
  creatorId: string;
  creatorName?: string;
  icon: string;
  accountId: string;
  status: 'pending' | 'accepted';
  createdAt: string;
  reviewedAt?: string;
  /** Credits the suggesting client earned when it was accepted. */
  credited?: number;
}

export interface CreatorIconResponse {
  suggestion: CreatorIconSuggestion;
  /** True when this suggestion was new (the node did not already have one waiting). */
  newInfo: boolean;
  /** Credits earned (paid when the operator accepts the suggestion). */
  credited: number;
}

export interface SuggestionRequest {
  id: string;
  kind: SuggestionKind;
  /**
   * The suggested value. Plain text for most kinds (an empty `title`, `description` or
   * `thumbnail` value means "clear it"); `data` carries a JSON string→string map and
   * `topics` a JSON list of the corrected topic names — each replaces what the content
   * has when the operator accepts.
   */
  value: string;
  /** Why the client thinks so — optional; a correction can speak for itself. */
  reason: string;
  timestamp?: number;
  /** For kind `source`: the platform the suggested link points at (youtube, twitch…). */
  platform?: string;
}

/**
 * A content id or link a client came across while playing content from outside the
 * network (a platform embed, a media URL…). Nodes reward reports of things they did
 * not already have.
 */
export interface ReportRequest {
  /** A content id (with sources) or a link to the content. */
  id: string;
}

export interface ReportResponse {
  /** True when the node already had the content. */
  known: boolean;
  /** Credits earned for the report (0 when the node already had it). */
  credited: number;
}

/**
 * Popularity numbers a client saw for content on its platform (views, likes, comments,
 * subscribers…), posted to an algorithm node. The node pays only for numbers it did not
 * have yet, multiplied by the source's credit multipliers and the recency factor.
 */
export interface ClaimRequest {
  /** A content id (with sources) or a link to the content. */
  id: string;
  /** The platform the numbers come from (youtube, reddit…); defaults to the id's source. */
  source?: string;
  /** The numbers the client saw, by metric key (views, likes, comments, upvotes…). */
  metrics: Record<string, number>;
  /** When the content was posted on its platform, for the recency factor. */
  publishedAt?: string;
}

export interface ClaimResponse {
  /** True when the node already knew the content. */
  known: boolean;
  /** True when at least one number was new to the node (the only case that pays). */
  newInfo: boolean;
  /** Credits earned (0 when nothing was new). */
  credited: number;
  /** The multiplier the source's rules produced (1 or more). */
  multiplier: number;
  /** The metric keys the node kept as new. */
  updated: string[];
}

/** One platform link a client suggests adding to a piece of content. */
export interface SourceSuggestion {
  /** Platform key (youtube, twitch, reddit…). */
  platform: string;
  /** The link to the content there. */
  url: string;
}

export const PROVIDER_SUGGESTION_KINDS = ['source', 'duplicate', 'missing'] as const;
export type ProviderSuggestionKind = (typeof PROVIDER_SUGGESTION_KINDS)[number];

/**
 * What a client suggests a content provider node is missing: links to the content on
 * other platforms, another content id the content is a duplicate of (helps the node
 * compress or dedupe its store), or a note that the content data itself is missing
 * (the client can upload it right after).
 */
export interface ProviderSuggestionRequest {
  /** The content id (or link) the suggestion is about. */
  id: string;
  kind: ProviderSuggestionKind;
  /** For kind `source`: the missing platform links (a cid can have several sources). */
  sources?: SourceSuggestion[];
  /** For kind `duplicate`: the id of the content this one duplicates. */
  duplicateOf?: string;
  /** Free text for the operator. */
  note?: string;
}

export interface ProviderSuggestion {
  id: string;
  contentId: string;
  kind: ProviderSuggestionKind;
  sources?: SourceSuggestion[];
  duplicateOf?: string;
  note?: string;
  accountId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
}

export interface ProviderSuggestionResponse {
  suggestion: ProviderSuggestion;
  /** True when the node did not already have this suggestion (the only case that pays). */
  newInfo: boolean;
  credited: number;
}
