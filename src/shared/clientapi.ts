// Types of the client daemon's local API (GUI ⇄ daemon). Browser-safe: no Node imports.
import type { NodeType } from './noderef.js';
import type { ContentItem, CreatorInfo, Invoice, LedgerEntry, NodeInfo, Preferences, StorageAssignment, AccountView } from './protocol.js';
import type { Embed, ExternalSource } from './sources.js';
import type { CreatorKind } from './taxonomy.js';

export type AuthMode = 'identity' | 'pseudonym' | 'anonymous';

export interface NodeStatus {
  online: boolean;
  latencyMs?: number;
  checkedAt?: string;
  error?: string;
}

/** A node the user added. Order in the list (per type) is the priority. */
export interface NodeEntry {
  id: string;
  type: NodeType;
  url: string;
  name: string;
  description?: string;
  enabled: boolean;
  auth: AuthMode;
  /**
   * Spending limit: providers above this price per MiB, or algorithm nodes above this
   * price per request, are skipped. Undefined = no limit.
   */
  maxPrice?: number;
  addedAt: string;
  info?: NodeInfo;
  status: NodeStatus;
  balance?: number;
  accountId?: string;
  /** The copy-pastable reference. */
  ref: string;
}

export interface StorageServiceSettings {
  enabled: boolean;
  quotaGiB: number;
  /** Node ids of providers to store data for; empty = every enabled provider. */
  providers: string[];
}

export interface Settings {
  preferences: Preferences;
  /** blend: mix every enabled algorithm node by priority; primary: only the first that answers. */
  feedMode: 'blend' | 'primary';
  /** What to do with content no algorithm node has reviewed. */
  unknownContent: 'warn' | 'hide' | 'allow';
  /** Account mode for newly added nodes. */
  defaultAuth: AuthMode;
  autoplay: boolean;
  cacheMiB: number;
  ipfsGateway: string;
  profile: { name: string; kind: CreatorKind };
  storageService: StorageServiceSettings;
  theme: 'system' | 'dark' | 'light';
}

export interface Subscription {
  id: string;
  name: string;
  kind?: CreatorKind;
  addedAt: string;
}

export interface LibraryItem {
  id: string;
  title: string;
  mime?: string;
  size?: number;
  publishedAt: string;
  providers: string[];
  algorithms: { nodeId: string; submissionId?: string; error?: string }[];
  native: boolean;
}

export interface HistoryItem {
  id: string;
  title: string;
  at: string;
}

export interface ClientState {
  version: string;
  identity: { id: string };
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
}

/** A content item from an algorithm node, with where it came from. */
export interface FeedItem extends ContentItem {
  via: string;
  viaName: string;
  /** Local URL of the thumbnail (proxied through the daemon). */
  thumbnailUrl?: string;
}

export interface FeedResponse {
  items: FeedItem[];
  cursor?: string;
  errors: { node: string; name: string; error: string }[];
}

export interface ManifestSummary {
  name: string;
  mime: string;
  size: number;
  chunks: number;
  chunkSize: number;
  createdAt: string;
  creator?: { id: string; name?: string; kind?: CreatorKind };
  meta?: Record<string, unknown>;
}

export interface ContentView {
  id: string;
  base: string;
  native: boolean;
  /** listed / blocked / unknown, as decided by the first algorithm node (in priority order) that knows it. */
  status: 'listed' | 'blocked' | 'unknown';
  decidedBy?: { id: string; name: string };
  reason?: string;
  item?: FeedItem;
  /** Where the bytes come from, when a provider has the content. */
  manifest?: ManifestSummary;
  provider?: { id: string; name: string; perMiB: number; estimate: number };
  /** Local stream URL (with access token) for native content. */
  streamUrl?: string;
  downloadUrl?: string;
  /** External sources to embed when no provider has the content. */
  embeds: (Embed & { source: ExternalSource })[];
  /** Providers named by the algorithm node that the user has not added. */
  suggestedProviders: string[];
  providerErrors: { node: string; name: string; error: string }[];
}

export interface CreatorView {
  creator: CreatorInfo;
  items: FeedItem[];
  via?: string;
}

export interface AccountResponse {
  account: AccountView;
  history: LedgerEntry[];
}

export interface JobStep {
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error' | 'skipped';
  detail?: string;
}

export interface Job {
  id: string;
  kind: 'publish' | 'external';
  title: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  steps: JobStep[];
  result?: { id: string };
  error?: string;
  startedAt: string;
}

export interface PublishRequest {
  fileId: string;
  name: string;
  mime: string;
  title: string;
  description?: string;
  format?: string;
  rating?: string;
  topics?: string[];
  tags?: string[];
  language?: string;
  durationSeconds?: number;
  /** External copies to fall back to (links or `yt:…` sources). */
  sources?: string[];
  providers: string[];
  algorithms: string[];
  thumbnail?: string;
  /** Sign as the creator (your public key) — off publishes without a creator identity. */
  sign: boolean;
}

export interface ExternalPublishRequest {
  url: string;
  title: string;
  description?: string;
  format?: string;
  rating?: string;
  topics?: string[];
  tags?: string[];
  language?: string;
  algorithms: string[];
  thumbnail?: string;
}

export interface ServiceStatus {
  enabled: boolean;
  quotaBytes: number;
  usedBytes: number;
  providers: {
    id: string;
    name: string;
    online: boolean;
    assignments: StorageAssignment[];
    earned: number;
    error?: string;
  }[];
  log: { at: string; message: string }[];
}

export interface TopUp {
  invoice: Invoice;
}
