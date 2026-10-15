// Wire types of the VibeShare protocol (HTTP + JSON). Browser-safe: no Node imports.
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

export interface CreatorInfo {
  id: string;
  name: string;
  kind: CreatorKind;
  description?: string;
  /** Public keys (vk1…) that sign this creator's manifests. */
  keys?: string[];
  links?: string[];
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

export type ContentOrigin = 'operator' | 'submission' | 'crawler' | 'report';

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
}

export type SearchSort = 'relevance' | 'new' | 'top';

export interface SearchRequest {
  query: string;
  filters?: Preferences & { creator?: string; platform?: string };
  sort?: SearchSort;
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
  total?: number;
}

export const SUGGESTION_KINDS = ['tag', 'topic', 'format', 'rating', 'creator', 'published', 'report', 'source', 'duplicate'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

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
