// Wire types of the VibeShare protocol (HTTP + JSON). Browser-safe: no Node imports.
import type { BloomFilterData } from './bloom.js';
import type { NodeType } from './noderef.js';
import type { CreatorKind, Format, Rating } from './taxonomy.js';

export const PROTOCOL_VERSION = 1;
export const SOFTWARE = 'vibeshare/0.1.0';

// ---------------------------------------------------------------------------
// Node info: GET /v1/info returns { info, sig }, signed by the node's key.

export type PaymentType = 'voucher' | 'evm' | 'bitcoin' | 'solana' | 'lightning' | 'checkout' | 'manual';

export interface PaymentMethodInfo {
  id: string;
  type: PaymentType;
  label: string;
  description?: string;
  /** Human readable rate, e.g. { credits: 1000, per: '1 USDC' }. */
  rate?: { credits: number; per: string };
  minCredits?: number;
  maxCredits?: number;
  /** Network / currency details for crypto methods. */
  network?: string;
  currency?: string;
}

export interface SignupInfo {
  /** Credits a new account starts with. */
  grant: number;
  /** Leading zero bits of proof of work required to open an account (0 = none). */
  powBits: number;
  /** Whether accounts without a key (bearer token only) are allowed. */
  anonymous: boolean;
}

export interface NodeInfoBase {
  v: 1;
  type: NodeType;
  id: string;
  name: string;
  description: string;
  software: string;
  time: string;
  /** The URL the operator publishes the node under. */
  url?: string;
  /** The node's Tor onion address (http://….onion), when it publishes one. */
  onion?: string;
  contact?: string;
  terms?: string;
  signup: SignupInfo;
  payments: PaymentMethodInfo[];
  /** Other nodes this operator recommends (node references). */
  peers: string[];
}

export interface ProviderPricing {
  /** Credits per manifest request. */
  manifest: number;
  /** Credits per MiB of chunk data. */
  perMiB: number;
  /** MiB each account may download per day before paying. */
  freeMiBPerDay: number;
  /** Share (0–1) of what downloads cost that goes to the uploader's account on this node. */
  creatorShare: number;
  upload: {
    /** open: anyone with an account; paid: priced per MiB; closed: operator only. */
    mode: 'open' | 'paid' | 'closed';
    perMiB: number;
    maxBytes: number;
  };
}

export interface ProviderInfo extends NodeInfoBase {
  type: 'provider';
  pricing: ProviderPricing;
  rewards: ProviderRewards;
  services: { storage: { enabled: boolean; openJobs: number } };
  stats: { contents: number; bytes: number };
}

export interface AlgorithmPricing {
  feed: number;
  search: number;
  lookup: number;
  /** Credits to submit content for review. */
  submission: number;
}

/** One price for keeping a user's seen-content bloom filter on this node. */
export interface BloomStorageTier {
  id: string;
  label?: string;
  /** The biggest filter (in bits) this tier stores. */
  maxBits: number;
  /** How long the filter is kept for that price. */
  durationSeconds: number;
  /** Credits the user pays to store the filter for that long. */
  price: number;
}

/** Seen-content bloom filters on an algorithm node (stored copies and request filters). */
export interface BloomServiceInfo {
  /** The biggest filter (in bits) that may travel inside a request. */
  inlineMaxBits: number;
  /** The biggest account filter (in bits) this node keeps long term. */
  accountMaxBits: number;
  storage: { tiers: BloomStorageTier[] };
}

/** What a client sends to keep its seen-content filter on a node: a storage tier and the filter. */
export interface BloomStorageRequest {
  tier: string;
  filter: BloomFilterData;
}

/** The calling user's stored filter on a node (when one is kept), and the tiers on offer. */
export interface BloomStorageState {
  filter?: BloomFilterData;
  expiresAt?: string;
  tiers: BloomStorageTier[];
}

/**
 * The account's own long-term filter on a node: kept until it is dropped (no expiry),
 * refreshed at any time by hand or by the client's resubmission job. The node applies it
 * while searching, so the client does not have to send it along with every request.
 */
export interface AccountFilterState {
  filter?: BloomFilterData;
  /** When the client last submitted it. */
  updatedAt?: string;
  /** The largest filter this node keeps for an account (bits). */
  maxBits: number;
}

export interface AlgorithmRewards {
  /** Credits for the first vote on a piece of content. */
  vote: number;
  voteDailyCap: number;
  /** Credits when a suggested tag/rating/topic is accepted. */
  acceptedSuggestion: number;
  /** Credits for reporting a content id or link the node did not have. */
  report: number;
  reportDailyCap: number;
  /** Only key-based accounts earn rewards. */
  requireIdentity: boolean;
  /** Accept a suggestion automatically once this many accounts made it (0 = only by hand). */
  autoAcceptAgreement: number;
}

export interface ProviderRewards {
  /** Credits for reporting a content id the node did not have. */
  report: number;
  reportDailyCap: number;
  /** Credits for a suggestion of missing data (sources, duplicates) the node did not have. */
  suggestion: number;
  suggestionDailyCap: number;
}

export interface AlgorithmInfo extends NodeInfoBase {
  type: 'algorithm';
  pricing: AlgorithmPricing;
  rewards: AlgorithmRewards;
  ranking: { strategy: string; description: string };
  taxonomy: { topics: string[] };
  stats: { listed: number; blocked: number; creators: number; discovered?: number };
  /** Whether the node finds content on other platforms by itself, and where. */
  discovery?: { crawling: boolean; searchesPlatforms: boolean; platforms: string[] };
  /** Seen-content bloom filters this node accepts (it then stops suggesting what collides). */
  bloom?: BloomServiceInfo;
  /** How many accounts a creator may link together here (YouTube, TikTok, Twitter…). */
  maxCreatorAccounts?: number;
}

export type NodeInfo = ProviderInfo | AlgorithmInfo;

export interface SignedInfo {
  info: NodeInfo;
  sig: string;
}

export function infoSigningPayload(canonicalInfo: string): string {
  return 'vibeshare-info\n' + canonicalInfo;
}

export function sessionSigningPayload(nodeId: string, ts: number): string {
  return `vibeshare-session\n${nodeId}\n${ts}`;
}

export function powInput(nodeId: string, subject: string, ts: number): string {
  return `vibeshare-pow\n${nodeId}\n${subject}\n${ts}`;
}

// ---------------------------------------------------------------------------
// Accounts and credits (each node keeps its own, independent ledger)

export interface SessionResponse {
  token: string;
  accountId: string;
  expiresAt?: string;
  balance: number;
}

export interface AccountView {
  id: string;
  kind: 'anonymous' | 'key';
  balance: number;
  earned: number;
  spent: number;
  createdAt: string;
}

export interface LedgerEntry {
  at: string;
  amount: number;
  balance: number;
  reason: string;
  ref?: string;
}

export interface Invoice {
  id: string;
  method: string;
  credits: number;
  status: 'open' | 'paid' | 'expired' | 'pending-review' | 'rejected';
  createdAt: string;
  expiresAt?: string;
  pay: {
    address?: string;
    amount?: string;
    currency?: string;
    /** e.g. ethereum:, bitcoin:, solana: or lightning: URI for wallets. */
    uri?: string;
    checkoutUrl?: string;
    instructions?: string;
  };
}

// ---------------------------------------------------------------------------
// Provider storage service: client nodes store data for a provider and earn credits.

export interface StorageRewards {
  /** Paid when the assignment is accepted and the data downloaded. */
  upfront: number;
  /** Paid each time the provider retrieves a chunk from the client. */
  perRetrieval: number;
  /** Paid for each passed proof-of-storage challenge. */
  perChallenge: number;
  /** Paid at the end of the term if enough challenges were passed. */
  completion: number;
}

export interface StorageOffer {
  id: string;
  cid?: string;
  title?: string;
  chunks: number;
  bytes: number;
  durationSeconds: number;
  rewards: StorageRewards;
  slots: number;
  requireIdentity: boolean;
}

export type AssignmentStatus = 'downloading' | 'active' | 'completed' | 'failed' | 'released';

export interface StorageAssignment {
  id: string;
  jobId: string;
  chunkIds: string[];
  bytes: number;
  status: AssignmentStatus;
  acceptedAt: string;
  expiresAt: string;
  challenges: { passed: number; failed: number };
  retrievals: number;
  earned: number;
}

export interface StorageTask {
  id: string;
  type: 'retrieve' | 'challenge';
  assignmentId: string;
  chunkId: string;
  /** For challenges: answer with sha256hex(nonce + chunk bytes). */
  nonce?: string;
  deadline: string;
}

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
  status: 'listed';
  title: string;
  description?: string;
  format: Format;
  rating: Rating;
  topics: string[];
  tags: string[];
  language?: string;
  durationSeconds?: number;
  creator?: CreatorInfo;
  /**
   * The thumbnail: a path on the algorithm node (/v1/thumbnails/<key>) for thumbnails it
   * stores, or an absolute https URL for content discovered on other platforms.
   */
  thumbnail?: string;
  /** Directly displayable media of external content (an image, an mp4…), when the platform offers it. */
  media?: ContentMedia;
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
  blockedTags?: string[];
  blockedCreators?: string[];
  /** Only creators of these kinds (empty = all). */
  creatorKinds?: CreatorKind[];
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
}

export interface Page<T> {
  items: T[];
  cursor?: string;
  total?: number;
}

export const SUGGESTION_KINDS = ['tag', 'topic', 'format', 'rating', 'creator', 'published', 'report', 'source', 'duplicate'] as const;
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
  value: string;
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
  tags: string[];
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
  /** Content filters: formats, a rating ceiling, topics and tags. */
  filters?: { formats?: Format[]; maxRating?: Rating; topics?: string[]; tags?: string[] };
  /** How the peer picks from what matches: its newest, its most popular, or at random. */
  algorithm?: 'new' | 'popular' | 'random';
  limit?: number;
}

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
}

/** A place a client can fetch a cid from, offered when this node does not hold the bytes. */
export interface ContentLink {
  cid: string;
  url: string;
}

export interface SubmissionRequest {
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

export interface ApiErrorBody {
  error: { code: string; message: string };
}
