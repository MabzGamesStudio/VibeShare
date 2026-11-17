// The client's coordinator: nodes, feeds, content, credits, publishing and the user's
// data meet here. Each seam lives in its own module (feeds.ts, content.ts, credits.ts,
// publish.ts, profile.ts) and this class owns the shared collaborators and delegates to
// them — the public surface of ClientCore is what the daemon, the route table (api.ts)
// and the web client use, unchanged. The desktop/command-line daemon and the web client
// (in a service worker) both run it; they only differ in where data is kept and how
// requests arrive. Browser-safe.
import type {
  BloomStatus,
  CommentPostRequest,
  CommentsResponse,
  ContentView,
  CreatorView,
  FeedItem,
  FeedResponse,
  GroupView,
  NodeEntry,
  PageFilters,
  PageSource,
  ProfileSummary,
  PublishPreview,
  PublishRequest,
  SavedState,
  SearchHistoryItem,
  Settings,
  ToastMessage,
  TopicView,
} from '../shared/clientapi.js';
import type {
  AccountFilterState,
  AccountLinkProposal,
  AccountLinkResponse,
  BloomStorageState,
  ContentItem,
  CreatorContentResponse,
  CreatorContentSuggestion,
  CreatorIconResponse,
  CreatorIconSuggestion,
  CreatorInfo,
  GroupSuggestion,
  GroupSuggestionRequest,
  GroupSuggestionResponse,
  TopicCreateRequest,
  TopicCreateResponse,
  TopicInfo,
  TopicSuggestion,
  TopicSuggestionRequest,
  TopicSuggestionResponse,
} from '../shared/protocol.js';
import type { ClientState } from '../shared/clientapi.js';
import type { CreatorKind } from '../shared/taxonomy.js';
import { SOFTWARE } from '../shared/protocol.js';
import type { Manifest, ManifestMeta } from '../shared/content.js';
import type { VvshBuildConfig } from '../shared/vvsh-encode.js';
import type { VvshConvertQuote, VvshFile, VvshFrameStats } from '../shared/vvsh.js';
import type { Transport } from '../shared/remote.js';
import { parseNodeRef } from '../shared/noderef.js';
import { Fetcher } from './fetcher.js';
import { BloomBook } from './bloom.js';
import type { ChunkStore, ClientStoreLike, UploadStore } from './model.js';
import { prepareClientSave } from './model.js';
import { NodeManager } from './nodes.js';
import { Publisher } from './publisher.js';
import { NO_TRACES, type TraceLog } from './trace.js';
import { Content } from './content.js';
import { Credits } from './credits.js';
import { Feeds, type FeedKind } from './feeds.js';
import { Profiles } from './profile.js';
import { Publishing } from './publish.js';

export { encodeCursor, decodeCursor, type FeedKind } from './feeds.js';

export interface ClientCoreOptions {
  store: ClientStoreLike;
  cache: ChunkStore;
  uploads: UploadStore;
  /** URL the GUI loads a thumbnail kept on an algorithm node from. */
  thumbnailUrl: (node: NodeEntry, key: string) => string;
  /** URL the GUI streams (or downloads) native content from. */
  streamUrl: (base: string, download: boolean) => string;
  /** Host name of the page that embeds players (Twitch needs it). */
  embedHost: () => string;
  /** Called after settings change (the daemon starts and stops its storage service). */
  onSettings?: (previous: Settings, next: Settings) => void;
  /** Called before a node is removed (the daemon can release data it stores for it). */
  beforeRemoveNode?: (id: string, release: boolean) => Promise<void>;
  /** The software name and version the GUI shows. */
  version?: string;
  /** How requests to a node are sent (the daemon routes them through Tor); plain fetch when undefined. */
  transport?: (target: { url: string; onion?: string }) => Transport | undefined;
  /** Native encoder supplied by the daemon; the static browser uses its local fallback. */
  transcodeVvsh?: (
    source: Uint8Array,
    config: VvshBuildConfig,
    totalSeconds: number,
    onProgress?: (rendition: number, chunk: number, fraction: number) => void
  ) => Promise<Record<string, Uint8Array[]>>;
  /** Whether local publishing has a usable native FFmpeg backend. */
  encoderInfo?: () => Promise<{ backend: 'ffmpeg' | 'mediarecorder'; warning?: string }>;
  /** The daemon's trace log; a no-op in the browser build (tracing is a daemon feature). */
  traces?: TraceLog;
}

export class ClientCore {
  readonly store: ClientStoreLike;
  readonly nodes: NodeManager;
  readonly fetcher: Fetcher;
  readonly publisher: Publisher;
  readonly cache: ChunkStore;
  readonly uploads: UploadStore;
  /** The bloom filters of content the user has seen (selected, previewed, sent to nodes). */
  readonly blooms: BloomBook;
  /** The daemon's trace log (a no-op without one). */
  readonly traces: TraceLog;

  /** The seams of the client's logic, one module each (see the imports above). */
  private readonly feeds: Feeds;
  private readonly contents: Content;
  private readonly credits: Credits;
  private readonly publishing: Publishing;
  private readonly profiles: Profiles;

  constructor(readonly options: ClientCoreOptions) {
    this.store = options.store;
    this.cache = options.cache;
    this.uploads = options.uploads;
    this.traces = options.traces ?? NO_TRACES;
    this.nodes = new NodeManager(this.store, options.transport, this.traces);
    this.fetcher = new Fetcher(this.nodes, this.cache, this.traces);
    this.publisher = new Publisher(this.store, this.nodes, options.uploads, this.traces);
    this.blooms = new BloomBook(this.store, this.traces);
    this.feeds = new Feeds(this);
    this.contents = new Content(this);
    this.credits = new Credits(this);
    this.publishing = new Publishing(this);
    this.profiles = new Profiles(this);
    // Hidden profiles are encrypted at rest: what is written out is the sealed form.
    this.store.data.prepare = prepareClientSave;
    const storeChanged = this.store.changed.bind(this.store);
    this.store.changed = () => {
      storeChanged();
      this.profiles.scheduleSeal();
    };
    // The account filter's resubmission job (a no-op while the setting is off).
    this.feeds.scheduleBloomJob();
  }

  get settings(): Settings {
    return this.store.data.data.settings;
  }

  state(): ClientState {
    return {
      version: this.options.version ?? SOFTWARE,
      identity: { id: this.store.identity.id },
      nodes: this.nodes.list(),
      settings: this.settings,
      subscriptions: this.store.data.data.subscriptions,
      profiles: this.profiles.profileSummaries(),
      activeProfile: this.store.data.data.activeProfile ?? 'main',
      locked: this.profiles.isLocked(),
    };
  }

  feedItem(node: NodeEntry, item: ContentItem): FeedItem {
    return this.feeds.feedItem(node, item);
  }

  /**
   * Asks the algorithm nodes for a page. "blend" mixes every enabled node by priority
   * (round robin, without duplicates); "primary" uses the first node that answers.
   */
  collect(kind: FeedKind, body: Record<string, unknown>, cursor?: string): Promise<FeedResponse> {
    return this.feeds.collect(kind, body, cursor);
  }

  /** One endpoint for every page: its source, query and filters, within the user's preferences. */
  browse(body: { source?: PageSource; query?: string; filters?: Partial<PageFilters>; sort?: string; cursor?: string; seed?: string }): Promise<FeedResponse> {
    return this.feeds.browse(body);
  }

  content(id: string): Promise<ContentView> {
    return this.contents.content(id);
  }

  creator(id: string): Promise<CreatorView> {
    return this.contents.creator(id);
  }

  /**
   * A group page: the group, its member creators (for the carousel) and every member's
   * content in one list. A group is a creator everywhere else, so subscribing to one is
   * the same as subscribing to a creator.
   */
  group(id: string): Promise<GroupView> {
    return this.contents.group(id);
  }

  /** A topic page: the topic and every content filed under its exact topic id. */
  topic(id: string): Promise<TopicView> {
    return this.contents.topic(id);
  }

  /** Topics matching a name or id, across the enabled algorithm nodes (Explore). */
  searchTopics(query: string): Promise<{ topics: TopicInfo[] }> {
    return this.contents.searchTopics(query);
  }

  /** Groups matching a name or id (a group is a creator of kind `group`). */
  searchGroups(query: string): Promise<{ groups: CreatorInfo[] }> {
    return this.contents.searchGroups(query);
  }

  /** A client brings a topic: the node keeps it under the hash of the name. */
  createTopic(node: NodeEntry, body: TopicCreateRequest): Promise<TopicCreateResponse> {
    return this.contents.createTopic(node, body);
  }

  /** Suggesting changes to a group: members to add or drop, a name, a description, links, an icon. */
  suggestGroup(node: NodeEntry, group: string, body: GroupSuggestionRequest): Promise<GroupSuggestionResponse> {
    return this.contents.suggestGroup(node, group, body);
  }

  /** Suggesting what a topic's description or icon should say. */
  suggestTopic(node: NodeEntry, topic: string, body: TopicSuggestionRequest): Promise<TopicSuggestionResponse> {
    return this.contents.suggestTopic(node, topic, body);
  }

  /** The group changes the user asked for on a node, with their status. */
  myGroupSuggestions(node: NodeEntry): Promise<{ suggestions: GroupSuggestion[] }> {
    return this.contents.myGroupSuggestions(node);
  }

  /** The topic suggestions the user made on a node, with their status. */
  myTopicSuggestions(node: NodeEntry): Promise<{ suggestions: TopicSuggestion[] }> {
    return this.contents.myTopicSuggestions(node);
  }

  /** Creators matching a name or id, across the enabled algorithm nodes (Explore). */
  searchCreators(query: string, kind?: CreatorKind | 'group'): Promise<{ creators: CreatorInfo[] }> {
    return this.contents.searchCreators(query, kind);
  }

  /**
   * The comment chain of a content page, with the viewer's own votes and key. The client
   * suggests an order and how far the reader has scrolled; the node decides the order and
   * sends all the block headers, with the comment data of the first loaded comments only.
   */
  comments(id: string, options: { order?: string; offset?: number; limit?: number } = {}): Promise<CommentsResponse> {
    return this.contents.comments(id, options);
  }

  /** Writes a comment, a reply, or an edit of one's own (signed by the user's key). */
  comment(id: string, body: CommentPostRequest): Promise<unknown> {
    return this.contents.comment(id, body);
  }

  /** Votes on a comment: 1 like, -1 dislike, 0 takes the vote back. */
  voteComment(id: string, comment: string, vote: 1 | -1 | 0): Promise<unknown> {
    return this.contents.voteComment(id, comment, vote);
  }

  /** Asks for one's own comment to be removed (the node keeps its block header). */
  removeComment(id: string, comment: string): Promise<unknown> {
    return this.contents.removeComment(id, comment);
  }

  /**
   * Links a creator's accounts on other platforms (YouTube, TikTok, Twitter…) on a node.
   * Signed with the user's key when they hold the creator's, the accounts are linked at
   * once; unsigned, they must be external links to the creator and the node's operator
   * decides whether to link them (its account limit applies either way).
   */
  linkCreatorAccounts(
    node: NodeEntry,
    body: {
      creator?: string;
      accounts?: { platform: string; handle: string; url?: string; creator?: string; subscribers?: number }[];
      name?: string;
      kind?: string;
      /** Send the user's signature (only useful — and only allowed — for one's own creator). */
      sign?: boolean;
      /** Links go both ways by default; `false` makes them one way. */
      symmetric?: boolean;
    }
  ): Promise<AccountLinkResponse> {
    return this.contents.linkCreatorAccounts(node, body);
  }

  /** The account links the user proposed without the creator's key, with their status. */
  myAccountLinks(node: NodeEntry): Promise<{ proposals: AccountLinkProposal[] }> {
    return this.contents.myAccountLinks(node);
  }

  /** Content the user suggests as related to a creator, with an optional message. */
  suggestCreatorContent(
    node: NodeEntry,
    creator: string,
    body: { id?: string; message?: string; title?: string; platform?: string; metrics?: Record<string, number> }
  ): Promise<CreatorContentResponse> {
    return this.contents.suggestCreatorContent(node, creator, body);
  }

  /** An icon the user suggests for a creator (a small image, as a data: URL). */
  suggestCreatorIcon(node: NodeEntry, creator: string, icon: string): Promise<CreatorIconResponse> {
    return this.contents.suggestCreatorIcon(node, creator, icon);
  }

  /** The icons the user suggested for creators, with their status. */
  myIconSuggestions(node: NodeEntry): Promise<{ suggestions: CreatorIconSuggestion[] }> {
    return this.contents.myIconSuggestions(node);
  }

  /** The user's own creator-content suggestions on a node, with their status. */
  myCreatorSuggestions(node: NodeEntry): Promise<{ suggestions: CreatorContentSuggestion[] }> {
    return this.contents.myCreatorSuggestions(node);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    return this.profiles.updateSettings(patch);
  }

  profileSummaries(): ProfileSummary[] {
    return this.profiles.profileSummaries();
  }

  /** Creates a fresh profile (default settings, no nodes, its own client id). */
  createProfile(body: { name?: string; username?: string; password?: string; hidden?: boolean }): Promise<ProfileSummary[]> {
    return this.profiles.createProfile(body);
  }

  /** Switches to another profile: its data, its client id, its node accounts. */
  switchProfile(body: { id?: string; username?: string; password?: string }): Promise<ClientState> {
    return this.profiles.switchProfile(body);
  }

  /** Opens a hidden profile: the only way in is its username and password. */
  unlockHidden(body: { username?: string; password?: string }): Promise<ClientState> {
    return this.profiles.unlockHidden(body);
  }

  /** Renames a profile and changes or clears its username/password protection. */
  updateProfile(body: { id?: string; name?: string; username?: string; password?: string; makePublic?: boolean }): Promise<ProfileSummary[]> {
    return this.profiles.updateProfile(body);
  }

  /** Deletes a profile, but only with its username and password (typed confirmation for a public profile). */
  deleteProfile(id: string, credentials: { username?: string; password?: string }): Promise<ProfileSummary[]> {
    return this.profiles.deleteProfile(id, credentials);
  }

  async removeNode(id: string, release: boolean): Promise<void> {
    await this.options.beforeRemoveNode?.(id, release);
    this.nodes.remove(id);
  }

  /**
   * Reports a content id or link the client played from outside the network to every
   * node that rewards such reports (algorithm nodes and content providers). Nodes that
   * already had the content keep it and pay nothing.
   */
  report(id: string): Promise<{ nodes: { node: string; name: string; known?: boolean; credited?: number; error?: string }[] }> {
    return this.credits.report(id);
  }

  /**
   * Reports platform popularity numbers (views, likes, comments, subscribers…) the
   * client saw for the content to every algorithm node; each pays for the numbers it
   * did not already have, times its per-source credit multipliers.
   */
  claim(
    id: string,
    metrics: Record<string, number>,
    source?: string,
    publishedAt?: string
  ): Promise<{ nodes: { node: string; name: string; newInfo?: boolean; credited?: number; multiplier?: number; updated?: string[]; error?: string }[] }> {
    return this.credits.claim(id, metrics, source, publishedAt);
  }

  contributions() {
    return this.credits.contributions();
  }

  /** The content id an upload will have, computed on this client before publishing. */
  previewPublish(request: PublishRequest): Promise<PublishPreview> {
    return this.publishing.previewPublish(request);
  }

  /**
   * Pulls the data behind a URL into this client as a file to publish, e.g. when
   * suggesting missing content: the content id is then computed here and the bytes are
   * uploaded from this device.
   */
  uploadFromUrl(rawUrl: string): Promise<{ fileId: string; size: number; name: string; mime: string }> {
    return this.publishing.uploadFromUrl(rawUrl);
  }

  /**
   * Fetches content from a link a provider offered (a provider sends a link instead of
   * the bytes when it does not hold them), or from a URL job's host. The retrieved
   * content is accepted only on an exact match: bytes that hash to the cid (a
   * downloadable copy), or — for a native content id, which names its manifest — a file
   * whose size and every chunk hash to that manifest (the same check a provider runs).
   * Otherwise the answer says the downloaded content from the node/link does not match
   * the expected cid.
   */
  fetchContentLink(url: string, cid: string): Promise<{ ok: boolean; size: number; error?: string }> {
    return this.publishing.fetchContentLink(url, cid);
  }

  subscribe(body: { id?: string; name?: string; kind?: string; icon?: string }) {
    return this.contents.subscribe(body);
  }

  unsubscribe(id: string) {
    return this.contents.unsubscribe(id);
  }

  remember(body: { id?: string; title?: string; contentId?: string; link?: string }) {
    return this.contents.remember(body);
  }

  forgetHistory() {
    return this.contents.forgetHistory();
  }

  /** The queries the user searched for, most recent first (the search bar suggests from these). */
  searchHistoryItems(): SearchHistoryItem[] {
    return this.contents.searchHistoryItems();
  }

  /** Clears the search history — all of it, or just the entries of one query. */
  clearSearchHistory(query?: string): { items: SearchHistoryItem[] } {
    return this.contents.clearSearchHistory(query);
  }

  /** The saved toast messages, newest first, matching the words searched for. */
  toastsItems(query?: string): { items: ToastMessage[]; saved: boolean } {
    return this.contents.toastsItems(query);
  }

  /** Remembers one toast message — only while the user keeps them (and history is not paused). */
  rememberToast(body: { text?: string; kind?: string; at?: string }): { items: ToastMessage[]; saved: boolean } {
    return this.contents.rememberToast(body);
  }

  /** Drops saved toast messages — all of them, or just the one with this id. */
  forgetToasts(id?: string): { items: ToastMessage[]; saved: boolean } {
    return this.contents.forgetToasts(id);
  }

  /** The saved cids and their collections (the saved screen). */
  savedState(): SavedState {
    return this.contents.savedState();
  }

  /** Saves a cid into the saved list, assigning it to the given collections. */
  saveCid(body: { id?: string; title?: string; collections?: unknown }): SavedState {
    return this.contents.saveCid(body);
  }

  /** Assigns a saved cid to different cid collections (or takes it out of some). */
  assignSavedCid(id: string, body: { title?: string; collections?: unknown }): SavedState {
    return this.contents.assignSavedCid(id, body);
  }

  /** Takes a cid out of the saved list; it leaves every collection with it. */
  unsaveCid(id: string): SavedState {
    return this.contents.unsaveCid(id);
  }

  /** Makes a cid collection of the user's own (saving into a name makes it too). */
  addCidCollection(body: { name?: string }): SavedState {
    return this.contents.addCidCollection(body);
  }

  /** Renames one of the user's cid collections. */
  renameCidCollection(id: string, body: { name?: string }): SavedState {
    return this.contents.renameCidCollection(id, body);
  }

  /** Removes a collection; the cids saved in it stay saved (they just leave it). */
  removeCidCollection(id: string): SavedState {
    return this.contents.removeCidCollection(id);
  }

  /**
   * A preview that came on screen: recorded by the preview filter (and the copy sent to
   * search nodes) as content the user has seen without selecting it.
   */
  markPreviewed(body: { id?: string; contentId?: string; link?: string }): { added: number } {
    return this.feeds.markPreviewed(body);
  }

  /** The state of the four seen-content filters (what the settings screen shows). */
  bloomStatus(): BloomStatus {
    return this.feeds.bloomStatus();
  }

  /** Forgets one filter; the user is warned about this before it is called. */
  resetBloom(scope: string): BloomStatus {
    return this.feeds.resetBloom(scope);
  }

  /** The storage a search node offers for seen-content filters, and the user's own there. */
  bloomOffers(node: NodeEntry): Promise<BloomStorageState> {
    return this.feeds.bloomOffers(node);
  }

  /** Pays a search node (its own price and duration) to keep a copy of the search filter a while. */
  buyBloomStorage(node: NodeEntry, tier: string): Promise<BloomStorageState> {
    return this.feeds.buyBloomStorage(node, tier);
  }

  /** Stops the search node from keeping the user's filter (it is deleted there). */
  dropBloomStorage(node: NodeEntry): Promise<BloomStorageState> {
    return this.feeds.dropBloomStorage(node);
  }

  /** The account filter one search node keeps for the user, and how big it may be. */
  accountFilterState(node: NodeEntry): Promise<AccountFilterState> {
    return this.feeds.accountFilterState(node);
  }

  /** Sends this user's account filter to one search node (it replaces what is kept there). */
  submitAccountFilter(node: NodeEntry): Promise<AccountFilterState> {
    return this.feeds.submitAccountFilter(node);
  }

  /** Stops one search node from keeping the account filter. */
  dropAccountFilter(node: NodeEntry): Promise<AccountFilterState> {
    return this.feeds.dropAccountFilter(node);
  }

  /**
   * The button: submits the account filter to every enabled search node at once. Each
   * node answers (or fails) on its own; the summary says which is which.
   */
  submitAccountFilters(): Promise<{ node: string; name: string; ok: boolean; error?: string; updatedAt?: string }[]> {
    return this.feeds.submitAccountFilters();
  }

  /**
   * Runs the resubmission job on its schedule: right away whenever it is switched on or
   * its interval changes, then every `resubmitHours` hours. `resubmitHours: 0` switches
   * the job off — the settings button still submits at any time.
   */
  scheduleBloomJob(): void {
    this.feeds.scheduleBloomJob();
  }

  /** Stops the resubmission job (its filter stays on the nodes until it is dropped there). */
  stopBloomJob(): void {
    this.feeds.stopBloomJob();
  }

  /**
   * Builds one video's .vvsh stream and publishes it: every record and payload is uploaded
   * the moment it exists, so a long video is never held twice in memory, then the signed
   * manifest (the metadata and root alone) is committed.
   */
  publishVvshStream(
    node: NodeEntry,
    source: Uint8Array,
    options: {
      name: string;
      totalSeconds: number;
      config?: VvshBuildConfig;
      meta?: ManifestMeta;
      sourceMime?: string;
      previews?: string[];
      /** Opt in to the daemon's configured native encoder (legacy API calls stay lossless). */
      encoder?: 'ffmpeg';
      /** External copies the manifest falls back to (raw links; normalized here). */
      sources?: string[];
      /** The algorithm nodes to put the content id in front of; every active one when omitted. */
      algorithms?: string[];
      /** Sign as the creator — off publishes without a creator identity. */
      sign?: boolean;
      /** A small image (data: URL) the algorithm nodes show with the listing. */
      thumbnail?: string;
      /** One stamp across providers keeps the content id the same everywhere. */
      createdAt?: string;
    }
  ): Promise<{ cid: string; manifest: Manifest; objects: number; listed: number }> {
    return this.publishing.publishVvshStream(node, source, options);
  }

  /** The backend local publishing will use, including the warning the GUI must show. */
  encoderInfo(): Promise<{ backend: 'ffmpeg' | 'mediarecorder'; warning?: string }> {
    return this.publishing.encoderInfo();
  }

  /** What one provider asks to calculate a .vvsh from just the video. */
  quoteVvshConvert(
    node: NodeEntry,
    options: { bytes: number; totalSeconds: number; config?: VvshBuildConfig }
  ): Promise<{ quote: VvshConvertQuote }> {
    return this.publishing.quoteVvshConvert(node, options);
  }

  /**
   * Lets a provider calculate the .vvsh stream from just the video, sent in pieces so a
   * long one never overflows anything: the quote first, then the pieces, then the work
   * (charged before it runs), then the signed manifest is committed there.
   */
  convertVvshOn(
    node: NodeEntry,
    options: {
      data: Uint8Array;
      name: string;
      totalSeconds: number;
      config?: VvshBuildConfig;
      meta?: ManifestMeta;
      sourceMime?: string;
      previews?: string[];
      /** How far the provider's own processing is, 0–100, from each polled state. */
      onProgress?: (percent: number) => void;
      /** External copies the manifest falls back to (raw links; normalized here). */
      sources?: string[];
      /** The algorithm nodes to put the content id in front of; every active one when omitted. */
      algorithms?: string[];
      /** Sign as the creator — off publishes without a creator identity. */
      sign?: boolean;
      /** A small image (data: URL) the algorithm nodes show with the listing. */
      thumbnail?: string;
      /** One stamp across providers keeps the content id the same everywhere. */
      createdAt?: string;
    }
  ): Promise<{ cid: string; quote: VvshConvertQuote; manifest: Manifest; listed: number; warnings: string[] }> {
    return this.publishing.convertVvshOn(node, options);
  }

  /** One object (a tree record or a payload) given its hash, checked against that hash. */
  vvshObject(node: NodeEntry, hash: string): Promise<Uint8Array> {
    return this.publishing.vvshObject(node, hash);
  }

  /** Uploads one already-built .vvsh object (a record or a payload) to a provider. */
  storeVvshObject(node: NodeEntry, hash: string, data: Uint8Array): Promise<void> {
    return this.publishing.storeVvshObject(node, hash, data);
  }

  /** Commits an already-uploaded .vvsh stream (its objects are on the node) and lists it. */
  commitVvshStream(
    node: NodeEntry,
    manifest: Manifest,
    options: { algorithms?: string[]; sign?: boolean; thumbnail?: string; sources?: string[] } = {}
  ): Promise<{ cid: string; listed: number }> {
    return this.publishing.commitVvshStream(node, manifest, options);
  }

  /**
   * One verified chunk of one bitrate at one time. The request is just where to look —
   * the tree root (or a branch the caller already verified), the chunk index and the
   * encoding — and the walk down (single path, every step checked against its parent)
   * fetches only the records it needs, answering with the path it took and the leaf.
   */
  vvshChunk(
    node: NodeEntry,
    ref: { root: string; chunkCount: number; from?: { hash: string; depth: number } },
    index: number,
    rendition: string
  ): Promise<{ data: Uint8Array; frames: VvshFrameStats; path: string[]; pathDepth: number }> {
    return this.publishing.vvshChunk(node, ref, index, rendition);
  }

  /** A byte range of one decoded stream by node id — what the /stream/vvsh routes call. */
  vvshStreamRange(spec: { n: string; r: string; c: number; q: string; d: number }, start: number, end: number): Promise<Uint8Array> {
    return this.publishing.vvshStreamRange(spec, start, end);
  }

  /** Every chunk of one bitrate, reassembled into the full video file to save. */
  exportVvsh(node: NodeEntry, file: VvshFile, rendition: string): Promise<Uint8Array> {
    return this.publishing.exportVvsh(node, file, rendition);
  }

  /**
   * One byte range of one bitrate's decoded stream — exactly the chunks that hold it and
   * nothing else. With the rendition's `decodedBytes` the chunk boundaries are known
   * arithmetic (`floor(i · bytes / chunks)` — the same cut the build made), so a seek to
   * any part of the video fetches only the chunk or two it lands on.
   */
  vvshRange(
    node: NodeEntry,
    ref: { root: string; chunkCount: number; from?: { hash: string; depth: number } },
    rendition: string,
    decodedBytes: number,
    start: number,
    end: number
  ): Promise<Uint8Array> {
    return this.publishing.vvshRange(node, ref, rendition, decodedBytes, start, end);
  }

  /** Replaces the identity (restoring a backup); sessions are re-opened with the new keys. */
  restoreIdentity(seed: Uint8Array): { id: string } {
    return this.profiles.restoreIdentity(seed);
  }

  /**
   * Adds the nodes a hosted client comes with, the first time it runs. Nodes that do
   * not answer yet are added anyway (when their reference names their key) and checked
   * again later.
   */
  async addDefaultNodes(refs: string[]): Promise<void> {
    const text = refs.join('\n');
    if (!text.trim()) return;
    const result = await this.nodes.add(text);
    for (const failed of result.errors) {
      const ref = parseNodeRef(failed.ref);
      if (!ref?.id || !ref.type || this.nodes.get(ref.id)) continue;
      this.store.data.data.nodes.push({
        id: ref.id,
        type: ref.type,
        url: ref.url,
        name: new URL(ref.url).host,
        enabled: true,
        auth: this.settings.defaultAuth,
        addedAt: new Date().toISOString(),
        status: { online: false, checkedAt: new Date().toISOString(), error: failed.error },
        ref: failed.ref,
      });
      this.store.changed();
    }
  }
}
