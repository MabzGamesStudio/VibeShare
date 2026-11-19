// Wire types of the VibeShare protocol (HTTP + JSON). Browser-safe: no Node imports.
import type { BloomFilterData } from '../bloom.js';
import type { NodeType } from '../noderef.js';
import type { CreatorKind, Format, Rating, SuggestLevel } from '../taxonomy.js';

// ---------------------------------------------------------------------------
// Node info: GET /v1/info returns { info, sig }, signed by the node's key.

export type PaymentType = 'voucher' | 'evm' | 'bitcoin' | 'monero' | 'solana' | 'lightning' | 'checkout' | 'manual';

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
  /** The payer has to supply proof of the transfer (a transaction id or payment hash). */
  needsProof?: boolean;
  /** The operator confirms the transfer by hand instead of the node checking it. */
  review?: boolean;
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
  /** The current protocol version, for readers that predate `protocol` (was `1` in v1). */
  v: number;
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
  /** What this node's local tracing keeps (whether it is on and for how long).
   *  Deprecated in favour of `features.tracing` — read `features` first, fall back here. */
  tracing?: { enabled: boolean; expirationHours: number };
  /** The protocol versions this node speaks (v2+). Absent on v1 nodes: they speak their `v`. */
  protocol?: { min: number; max: number };
  /** What this node supports beyond the base protocol (v2+). Unknown keys MUST be ignored. */
  features?: Record<string, boolean | number | string | string[]>;
  /**
   * Credits transfers this node accepts: accounts holding at least `minSenderBalance`
   * credits may send them to another account. 0 turns the gate off.
   */
  transfers?: { minSenderBalance: number };
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
  /** Deprecated in favour of `features['storage-service']` / `features['storage-open-jobs']` —
   *  read `features` first, fall back here. */
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
  /** Whether the node finds content on other platforms by itself, and where.
   *  Deprecated in favour of the `features.discovery*` keys — read `features` first, fall back here. */
  discovery?: { crawling: boolean; searchesPlatforms: boolean; platforms: string[] };
  /** Seen-content bloom filters this node accepts (it then stops suggesting what collides).
   *  Deprecated in favour of the `features.bloom*` keys — read `features` first, fall back here. */
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
