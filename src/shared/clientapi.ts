// Types of the client daemon's local API (GUI ⇄ daemon). Browser-safe: no Node imports.
import type { NodeType } from './noderef.js';
import type { Manifest } from './content.js';
import type { CommentBlock, CommentVotes } from './comments.js';
import type { ContentItem, CreatorInfo, Invoice, LedgerEntry, NodeInfo, Preferences, StorageAssignment, AccountView } from './protocol.js';
import type { Embed, ExternalSource } from './sources.js';
import type { VvshFile } from './vvsh.js';
import type { CreatorKind, Format, Rating } from './taxonomy.js';

export type AuthMode = 'identity' | 'pseudonym' | 'anonymous';

/** The whole comment chain of a content page, and the viewer's own key. */
export interface CommentsResponse {
  /** The page's root (its cid, or its first link): what first level comments reply to. */
  root: string;
  /** Every block of the chain; data is absent where the node keeps a comment back. */
  blocks: CommentBlock[];
  votes: Record<string, CommentVotes>;
  /** Whether the section sends comment data at all (false: the block headers only). */
  shown: boolean;
  /** The viewer's key id, to tell their own comments apart. */
  you: string;
}

/** Writing a comment: a new one, a reply, or an edit of one of one's own. */
export interface CommentPostRequest {
  text: string;
  replyFrom?: string;
  editOf?: string;
  anonymous?: boolean;
  timePrecision?: 'datetime' | 'date' | 'year' | 'none';
}

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
export interface PreviewBloomSettings extends BloomFilterSettings {}

/**
 * The seen-content filter carried inside search and explore requests — just there, never
 * stored anywhere: it travels with every call, so it is kept small. The node stops
 * suggesting anything that collides with it. More bits make the filter more precise —
 * and tell the node more about what the user has seen.
 */
export interface SearchBloomSettings extends BloomFilterSettings {}

/**
 * The account's much larger seen-content filter. It never travels inside search requests:
 * the settings button (or the resubmission job) sends it to the search nodes, which keep
 * it long term and apply it while searching.
 */
export interface AccountBloomSettings extends BloomFilterSettings {
  /** How often the job resubmits it, in hours (0 = only by hand). */
  resubmitHours: number;
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

/** The state of all four seen-content filters (GET /api/bloom). */
export interface BloomStatus {
  selected: BloomFilterStatus;
  preview: BloomFilterStatus;
  /** The filter carried inside search and explore requests. */
  search: BloomFilterStatus;
  /** The account's filter kept on search nodes, with its resubmission job. */
  account: BloomFilterStatus & { resubmitHours: number };
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
  /** Request and display content preview images. Off keeps selected media playback available. */
  showContentPreviews: boolean;
  /** Account mode for newly added nodes. */
  defaultAuth: AuthMode;
  autoplay: boolean;
  /**
   * How long the GUI waits before loading more items when you reach the end of a list:
   * a little friction, so scrolling fast does not spend credits on content nobody looks at.
   */
  loadPauseMs: number;
  cacheMiB: number;
  /** How far ahead a .vvsh video keeps fetching chunks while it plays, in seconds. */
  vvshPrefetchSeconds: number;
  /** How far the arrow keys skip through a video, in seconds. */
  vvshSkipSeconds: number;
  /** What the player starts on: `auto`, `highest` or `lowest`. */
  vvshDefaultQuality: string;
  /** How wide the scrubbing preview popup shows, in pixels (the images themselves are
   *  captured and stored by the publisher — their size and quality are in the file). */
  vvshScrubWidth: number;
  /** How history lists read: `pages` (Previous/Next) or `lazy` (more as you scroll). */
  historyMode: 'pages' | 'lazy';
  /** Keep debug logs of what the app asks of the nodes (Settings → Logs). Off by default. */
  debugLogs: boolean;
  ipfsGateway: string;
  profile: { name: string; kind: CreatorKind };
  storageService: StorageServiceSettings;
  theme: 'system' | 'dark' | 'light';
  /** Tor, for the desktop app and `vibeshare client` (in a browser, use Tor Browser). */
  tor: TorSettings;
  /**
   * Pause recording what the user views: content search history and every bloom filter
   * (selected, previewed, and the copy sent to search nodes) stand still until it is off.
   */
  pauseHistory: boolean;
  /** Whether what the user searches for is kept as a search history at all. */
  searchHistory: boolean;
  /** Whether the search bar shows matching past searches under the search box. */
  searchSuggestions: boolean;
  /** Content you have selected (opened): a local bloom filter of what you have already seen. */
  selectedBloom: BloomFilterSettings;
  /** Content previews you have seen on screen, without selecting them. */
  previewBloom: PreviewBloomSettings;
  /** The seen-content filter carried inside search and explore requests (kept small). */
  searchBloom: SearchBloomSettings;
  /** The account's much larger filter kept on search nodes, resubmitted by the job. */
  accountBloom: AccountBloomSettings;
  /**
   * What the bloom filters do with content the user has seen, in feeds and in search
   * results: `hide` eliminates it completely, `rank` only alters its ranking (it is
   * pushed down among the results instead of being removed).
   */
  seenContentMode: 'hide' | 'rank';
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

/** One search the user ran, kept for the search bar to suggest (when they want it). */
export interface SearchHistoryItem {
  query: string;
  at: string;
}

/** A collection of saved cids the user made (one saved cid may sit in several). */
export interface CidCollection {
  id: string;
  name: string;
  addedAt: string;
}

/** A cid the user saved, assigned to any number of their cid collections. */
export interface SavedCid {
  id: string;
  title: string;
  addedAt: string;
  /** Ids of the cid collections this saved cid is assigned to. */
  collections: string[];
}

/** Saved cids and their collections, as the saved screen shows them. */
export interface SavedState {
  collections: CidCollection[];
  items: SavedCid[];
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
  /** A .vvsh verifiable video stream: its metadata and tree root (the chunks hang off it). */
  vvsh?: VvshFile;
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
