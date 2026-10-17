// Types of the client daemon's local API (GUI ⇄ daemon). Browser-safe: no Node imports.
import type { NodeType } from './noderef.js';
import type { Manifest } from './content.js';
import type { ContentItem, CreatorInfo, Invoice, LedgerEntry, NodeInfo, Preferences, StorageAssignment, AccountView } from './protocol.js';
import type { Embed, ExternalSource } from './sources.js';
import type { CreatorKind, Format, Rating } from './taxonomy.js';

export type AuthMode = 'identity' | 'pseudonym' | 'anonymous';

/** One bloom filter of content the user has seen, as the settings hold it. */
export interface BloomFilterSettings {
  /** Keep and use the filter at all. */
  enabled: boolean;
  /** Number of bits: 1, 10, 100, … 100,000,000 (powers of ten). */
  bits: number;
  /** How many items the filter is made for (its design capacity; sets the hash count). */
  expected: number;
}

/** Content previews the user has seen on screen (separate from content actually selected). */
export interface PreviewBloomSettings extends BloomFilterSettings {
  /** Completely hide previewed content again, or only push it down among other previews. */
  mode: 'hide' | 'demote';
}

/**
 * The seen-content filter the client sends to search algorithm nodes, who then stop
 * suggesting anything that collides with it. More bits make the filter more precise —
 * and tell the node more about what the user has seen.
 */
export interface NodeBloomSettings extends BloomFilterSettings {
  /** Send the filter inside search requests when it is small enough for the node. */
  inline: boolean;
}

/** What the GUI shows of one filter. */
export interface BloomFilterStatus {
  enabled: boolean;
  bits: number;
  /** How many items the filter is made for. */
  expected: number;
  /** The optimal number of hash functions for this size and capacity. */
  hashes: number;
  /** Bytes of the bit array (ceil(bits/8)). */
  bytes: number;
  /** How many keys were added (of the `expected` the filter is made for). */
  added: number;
}

/** The state of all three seen-content filters (GET /api/bloom). */
export interface BloomStatus {
  selected: BloomFilterStatus;
  preview: BloomFilterStatus & { mode: 'hide' | 'demote' };
  node: BloomFilterStatus & { inline: boolean };
}

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

/** How a page shows its content. */
export const PAGE_LAYOUTS = ['grid', 'list', 'shorts', 'stream', 'masonry'] as const;
export type PageLayout = (typeof PAGE_LAYOUTS)[number];

export const PAGE_LAYOUT_LABELS: Record<PageLayout, string> = {
  grid: 'Grid of cards',
  list: 'List',
  shorts: 'Vertical swipe (one at a time, plays automatically)',
  stream: 'Vertical feed (one column, endless)',
  masonry: 'Masonry wall',
};

/** Where a page gets its content. */
export const PAGE_SOURCES = ['feed', 'search', 'subscriptions'] as const;
export type PageSource = (typeof PAGE_SOURCES)[number];

/** Pieces of metadata a page can show for each item, in the order chosen. */
export const METADATA_FIELDS = [
  'title',
  'creator',
  'platform',
  'likes',
  'dislikes',
  'views',
  'published',
  'duration',
  'format',
  'rating',
  'tags',
  'topics',
  'via',
  'description',
] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

export const METADATA_LABELS: Record<MetadataField, string> = {
  title: 'Title',
  creator: 'Creator name',
  platform: 'Platform',
  likes: 'Like count',
  dislikes: 'Dislike count',
  views: 'Views on the platform',
  published: 'When it was published',
  duration: 'Duration',
  format: 'Format',
  rating: 'Age rating',
  tags: 'Tags',
  topics: 'Topics',
  via: 'Algorithm node',
  description: 'Description',
};

export const PAGE_ICONS = [
  'home',
  'film',
  'smartphone',
  'image',
  'music',
  'podcast',
  'gamepad',
  'book',
  'newspaper',
  'flask',
  'graduation',
  'heart',
  'star',
  'flame',
  'compass',
  'search',
  'users',
  'sparkles',
  'tv',
  'radio',
] as const;
export type PageIcon = (typeof PAGE_ICONS)[number];

export type PagePreset = 'videos' | 'shorts' | 'images';

export interface PageFilters {
  /** Only these formats (empty = all). */
  formats: Format[];
  /** Highest age rating on this page; never above the rating limit in the preferences. */
  maxRating?: Rating;
  /** Topics to favour, or (with onlyTopics) to require. */
  topics: string[];
  onlyTopics: boolean;
  creatorKinds: CreatorKind[];
  /** Search pages: how results are ordered. */
  sort?: 'relevance' | 'new' | 'top';
}

/** A page of the client: a preset (home, videos, shorts, images) or one the user made. */
export interface PageConfig {
  id: string;
  title: string;
  icon: PageIcon;
  /** Set on the built-in pages (they can be changed and reset, but not deleted). */
  preset?: PagePreset;
  layout: PageLayout;
  source: PageSource;
  /** For search pages: the query (#tags, @creators, words). */
  query?: string;
  filters: PageFilters;
  /** Show the image preview (thumbnail) of each item. */
  thumbnail: boolean;
  /** Metadata shown with each item, in order. */
  fields: MetadataField[];
  options: {
    /** Play videos as they come into view (vertical swipe). */
    autoplay: boolean;
    /** Start muted (browsers only autoplay muted media). */
    muted: boolean;
    /** Columns of grid and masonry layouts (0 = as many as fit). */
    columns: number;
    size: 'small' | 'medium' | 'large';
  };
  /** Show the page in the left panel. */
  sidebar: boolean;
}

export interface Settings {
  /** Version of the settings format, for one-time changes of defaults (see normalizeSettings). */
  revision?: number;
  /** The pages of the client, in the order of the left panel. "home" is the start page. */
  pages: PageConfig[];
  /** Where shared links point: a hosted copy of the web client. */
  shareBaseUrl: string;
  preferences: Preferences;
  /** blend: mix every enabled algorithm node by priority; primary: only the first that answers. */
  feedMode: 'blend' | 'primary';
  /** What to do with content no algorithm node has reviewed. */
  unknownContent: 'warn' | 'hide' | 'allow';
  /**
   * Disable every external content embed (platform players and platform media files).
   * Only content hosted on the network (its cid) and its metadata show then, with a
   * placeholder standing in for the picture or player.
   */
  blockExternalEmbeds: boolean;
  /** Account mode for newly added nodes. */
  defaultAuth: AuthMode;
  autoplay: boolean;
  /**
   * How long the GUI waits before loading more items when you reach the end of a list:
   * a little friction, so scrolling fast does not spend credits on content nobody looks at.
   */
  loadPauseMs: number;
  cacheMiB: number;
  ipfsGateway: string;
  profile: { name: string; kind: CreatorKind };
  storageService: StorageServiceSettings;
  theme: 'system' | 'dark' | 'light';
  /** Tor, for the desktop app and `vibeshare client` (in a browser, use Tor Browser). */
  tor: TorSettings;
  /** Content you have selected (opened): a local bloom filter of what you have already seen. */
  selectedBloom: BloomFilterSettings;
  /** Content previews you have seen on screen, without selecting them. */
  previewBloom: PreviewBloomSettings;
  /** The seen-content filter sent to search algorithm nodes (they stop suggesting what collides). */
  nodeBloom: NodeBloomSettings;
}

export interface TorSettings {
  /**
   * off: never (onion nodes cannot be reached); onion: only nodes at .onion addresses go
   * through Tor; all: every request to nodes goes through Tor (onion addresses preferred).
   */
  mode: 'off' | 'onion' | 'all';
  /** Tor's SOCKS address, e.g. 127.0.0.1:9050; empty = find it (9050, then Tor Browser's 9150). */
  proxy: string;
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

/** A profile of this client, as the GUI lists them. */
export interface ProfileSummary {
  id: string;
  name: string;
  /** public: anyone using this client can switch to it; protected: username + password. */
  access: 'public' | 'protected';
  username?: string;
  /** Hidden profiles appear only while active, and then only as "Hidden profile". */
  hidden?: boolean;
  active: boolean;
}

export interface ClientState {
  version: string;
  identity: { id: string };
  nodes: NodeEntry[];
  settings: Settings;
  subscriptions: Subscription[];
  /** The profiles of this client and the one that is active. */
  profiles: ProfileSummary[];
  activeProfile: string;
  /** True while the active hidden profile is still sealed (it opens with its password). */
  locked: boolean;
}

/** A content item from an algorithm node, with where it came from. */
export interface FeedItem extends ContentItem {
  via: string;
  viaName: string;
  /** Local URL of the thumbnail (proxied through the daemon). */
  thumbnailUrl?: string;
  /** True when a bloom filter says the user has seen this content before. */
  seen?: boolean;
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
  /** True when the bloom filters guess the user has watched this content before. */
  seen?: boolean;
  /** External sources to embed when no provider has the content. */
  embeds: (Embed & { source: ExternalSource })[];
  /** True when the user disabled every external embed (placeholders show instead). */
  embedsDisabled?: boolean;
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
  /**
   * The exact manifest to publish, from `POST /api/publish/preview`: the content id is
   * then known and shown before anything is uploaded. Missing: it is built during the
   * upload (with `createdAt`, when given, so the id can still be predicted).
   */
  manifest?: Manifest;
  createdAt?: string;
}

/** The content id an upload will have, computed by the client before publishing. */
export interface PublishPreview {
  /** The content id (vs1…) of the manifest. */
  cid: string;
  /** The full id with the fallback sources. */
  id: string;
  manifest: Manifest;
  size: number;
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
