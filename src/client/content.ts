// Content pages and the user's own data: looking content, creators, groups and topics up
// on the algorithm nodes, the comment chain of a page, the suggestions a user makes
// (groups, topics, creator accounts, related content), their subscriptions, and the
// local records — history, search history, toast messages and saved cids. One
// collaborator of ClientCore; browser-safe.
import type {
  CommentsResponse,
  CommentPostRequest,
  ContentView,
  CreatorView,
  GroupView,
  LibraryItem,
  NodeEntry,
  SavedState,
  SearchHistoryItem,
  Subscription,
  ToastMessage,
  TopicView,
} from '../shared/clientapi.js';
import { badRequest, notFound } from '../shared/errors.js';
import { log } from '../shared/node/log.js';
import { parseNodeRef } from '../shared/noderef.js';
import { RemoteError } from '../shared/remote.js';
import type { CreatorKind } from '../shared/taxonomy.js';
import type {
  AccountLinkProposal,
  AccountLinkResponse,
  ContentItem,
  CreatorContentResponse,
  CreatorContentSuggestion,
  CreatorIconResponse,
  CreatorIconSuggestion,
  CreatorInfo,
  GroupInfo,
  GroupSuggestion,
  GroupSuggestionRequest,
  GroupSuggestionResponse,
  LookupResult,
  TopicCreateRequest,
  TopicCreateResponse,
  TopicInfo,
  TopicSuggestion,
  TopicSuggestionRequest,
  TopicSuggestionResponse,
} from '../shared/protocol.js';
import { claimSigningPayload } from '../shared/protocol.js';
import { commentRemovePayload, commentSigningPayload } from '../shared/comments.js';
import { signData } from '../shared/crypto.js';
import { baseId, embedFor, parseContentId, parseSource, platformOf, withSources } from '../shared/sources.js';
import { FetchError } from './fetcher.js';
import { SCOPES_OF_EVENT } from './bloom.js';
import { emptySavedState } from './model.js';
import { askJson, errorText } from './nodes.js';
import type { ClientCore } from './core.js';

/** Remembers one search — only while the user keeps a search history (and it is not paused). */
export function rememberSearch(core: ClientCore, query: string): void {
  const text = String(query ?? '').trim().slice(0, 200);
  if (!text || !core.settings.searchHistory || core.settings.pauseHistory) return;
  const items = core.searchHistoryItems().filter((item) => item.query !== text);
  items.unshift({ query: text, at: new Date().toISOString() });
  core.store.data.data.searchHistory = items.slice(0, 200);
  core.store.changed();
}

/** Content pages, comments and the user's own records, for one client. */
export class Content {
  constructor(private readonly core: ClientCore) {}

  async content(id: string): Promise<ContentView> {
    const parsed = parseContentId(id);
    if (!parsed) throw badRequest('Not a content id');
    this.core.traces.trace('basic', 'core.lookup', 'content lookup', { message: parsed.base });
    const view: ContentView = {
      id: parsed.full,
      base: parsed.base,
      native: parsed.native,
      status: 'unknown',
      embeds: [],
      suggestedProviders: [],
      providerErrors: [],
    };
    for (const node of this.core.nodes.active('algorithm')) {
      const price = this.core.nodes.algorithmPrice(node, 'lookup');
      if (!this.core.nodes.affordable(node, price)) continue;
      try {
        const result = await askJson<LookupResult>(this.core, 
          node,
          `/v1/content/${encodeURIComponent(parsed.full)}`,
          undefined,
          price > 0,
          8000
        );
        if (result.status === 'unknown') continue;
        view.status = result.status;
        view.decidedBy = { id: node.id, name: node.name };
        if (result.status === 'listed') view.item = this.core.feedItem(node, result);
        else view.reason = result.reason;
        break;
      } catch (error) {
        log.debug(`Lookup on ${node.name}: ${errorText(error)}`);
      }
    }
    const extra = view.item ? (parseContentId(view.item.id)?.sources ?? []) : [];
    view.id = withSources(parsed.full, extra);
    const sources = parseContentId(view.id)?.sources ?? [];
    const known = new Set(this.core.nodes.list('provider').map((node) => node.id));
    view.suggestedProviders = (view.item?.providers ?? []).filter((ref) => {
      const parsedRef = parseNodeRef(ref);
      return parsedRef && !(parsedRef.id && known.has(parsedRef.id));
    });
    if (parsed.native) {
      try {
        const hit = await this.core.fetcher.manifest(parsed.base);
        const manifest = hit.manifest;
        view.manifest = {
          name: manifest.name,
          mime: manifest.mime,
          size: manifest.size,
          chunks: manifest.chunks.length,
          chunkSize: manifest.chunkSize,
          createdAt: manifest.createdAt,
          creator: manifest.creator ? { id: manifest.creator.id, name: manifest.creator.name, kind: manifest.creator.kind } : undefined,
          meta: manifest.meta as Record<string, unknown> | undefined,
          vvsh: manifest.vvsh,
        };
        view.provider = {
          id: hit.provider.id,
          name: hit.provider.name,
          perMiB: this.core.nodes.providerPrice(hit.provider),
          estimate: this.core.fetcher.estimate(manifest, hit.provider),
        };
        view.streamUrl = this.core.options.streamUrl(parsed.base, false);
        view.downloadUrl = this.core.options.streamUrl(parsed.base, true);
        if (!view.item && manifest.sources) {
          view.id = withSources(view.id, manifest.sources.map(parseSource).filter((source) => source !== null));
        }
      } catch (error) {
        if (error instanceof FetchError) view.providerErrors = error.attempts;
        else view.providerErrors = [{ node: '', name: 'Client', error: errorText(error) }];
      }
    }
    const all = parseContentId(view.id)?.sources ?? sources;
    view.embeds = all.map((source) => ({
      ...embedFor(source, { ipfsGateway: this.core.settings.ipfsGateway, parentHost: this.core.options.embedHost() }),
      source,
    }));
    // Media the platform serves directly (an image, an mp4) beats an embedded player.
    const media = view.item?.media;
    if (media && all[0] && /^https?:\/\//.test(media.url)) {
      view.embeds.unshift({ kind: media.type, src: media.url, page: view.item?.pageUrl ?? view.embeds[0]?.page ?? media.url, label: platformOf(view.id).name, source: all[0] });
    }
    // The user disabled every external embed: only cid content and its metadata show,
    // with a placeholder standing in for the platform's picture or player.
    if (this.core.settings.blockExternalEmbeds) {
      view.embeds = [];
      view.embedsDisabled = true;
    }
    // Whether this content was watched before is the selected filter's guess (the filter
    // of what the user opened). A preview is not a watch: content only seen on screen shows
    // no "*watched" on its first open — from the second open on it does.
    const identity = { id: view.id, contentId: view.item?.contentId, link: view.item?.link };
    if (this.core.blooms.sees('selected', identity)) view.seen = true;
    this.core.traces.trace('basic', 'core.lookup', `content lookup → ${view.status}`, {
      data: { native: view.native, embeds: view.embeds.length, providerErrors: view.providerErrors.length, seen: Boolean(view.seen) },
    });
    return view;
  }

  async creator(id: string): Promise<CreatorView> {
    for (const node of this.core.nodes.active('algorithm')) {
      try {
        const result = await this.core.nodes
          .client(node)
          .json<{ creator: CreatorInfo; items: ContentItem[] }>(`/v1/creators/${encodeURIComponent(id)}`, { auth: false });
        return { creator: result.creator, items: result.items.map((item) => this.core.feedItem(node, item)), via: node.id };
      } catch (error) {
        if (!(error instanceof RemoteError && error.status === 404)) log.debug(`Creator on ${node.name}: ${errorText(error)}`);
      }
    }
    // A group is a creator of kind `group` with its own page: a link to /creator/<group id>
    // (an old bookmark, a related account) still opens it, members and content included.
    for (const node of this.core.nodes.active('algorithm')) {
      try {
        const result = await this.core.nodes
          .client(node)
          .json<{ group: CreatorInfo; members: CreatorInfo[]; items: ContentItem[] }>(`/v1/groups/${encodeURIComponent(id)}`, { auth: false });
        return { creator: result.group, items: result.items.map((item) => this.core.feedItem(node, item)), via: node.id };
      } catch (error) {
        if (!(error instanceof RemoteError && error.status === 404)) log.debug(`Group on ${node.name}: ${errorText(error)}`);
      }
    }
    const subscription = this.core.store.data.data.subscriptions.find((s) => s.id === id);
    const subKind = subscription?.kind === 'topic' ? 'unknown' : (subscription?.kind ?? 'unknown');
    return { creator: { id, name: subscription?.name ?? id.slice(0, 16), kind: subKind }, items: [] };
  }

  /**
   * A group page: the group, its member creators (for the carousel) and every member's
   * content in one list. A group is a creator everywhere else, so subscribing to one is
   * the same as subscribing to a creator.
   */
  async group(id: string): Promise<GroupView> {
    for (const node of this.core.nodes.active('algorithm')) {
      try {
        const result = await this.core.nodes.client(node).json<{ group: GroupInfo; members: CreatorInfo[]; items: ContentItem[] }>(
          `/v1/groups/${encodeURIComponent(id)}`,
          { auth: false }
        );
        return {
          group: result.group,
          members: result.members ?? [],
          items: result.items.map((item) => this.core.feedItem(node, item)),
          via: node.id,
        };
      } catch (error) {
        if (!(error instanceof RemoteError && error.status === 404)) log.debug(`Group on ${node.name}: ${errorText(error)}`);
      }
    }
    const subscription = this.core.store.data.data.subscriptions.find((s) => s.id === id);
    if (!subscription) throw notFound('No algorithm node knows this group');
    return { group: { id, name: subscription.name, kind: 'group', members: [] }, members: [], items: [] };
  }

  /** A topic page: the topic and every content filed under its exact topic id. */
  async topic(id: string): Promise<TopicView> {
    for (const node of this.core.nodes.active('algorithm')) {
      try {
        const result = await this.core.nodes
          .client(node)
          .json<{ topic: TopicInfo; items: ContentItem[] }>(`/v1/topics/${encodeURIComponent(id)}`, { auth: false });
        return { topic: result.topic, items: result.items.map((item) => this.core.feedItem(node, item)), via: node.id };
      } catch (error) {
        if (!(error instanceof RemoteError && error.status === 404)) log.debug(`Topic on ${node.name}: ${errorText(error)}`);
      }
    }
    const subscription = this.core.store.data.data.subscriptions.find((s) => s.id === id);
    if (!subscription) throw notFound('No algorithm node knows this topic');
    return { topic: { id, name: subscription.name, icon: subscription.icon }, items: [] };
  }

  /** Topics matching a name or id, across the enabled algorithm nodes (Explore). */
  async searchTopics(query: string): Promise<{ topics: TopicInfo[] }> {
    const q = String(query ?? '').trim().slice(0, 100);
    const found = new Map<string, TopicInfo>();
    for (const node of this.core.nodes.active('algorithm')) {
      try {
        const result = await this.core.nodes.client(node).json<{ topics: TopicInfo[] }>(`/v1/topics?q=${encodeURIComponent(q)}`, {
          auth: false,
          timeoutMs: 8000,
        });
        for (const topic of result.topics ?? []) if (!found.has(topic.id)) found.set(topic.id, topic);
      } catch (error) {
        log.debug(`Topics on ${node.name}: ${errorText(error)}`);
      }
      if (found.size >= 24) break;
    }
    return { topics: [...found.values()].slice(0, 24) };
  }

  /** Groups matching a name or id (a group is a creator of kind `group`). */
  async searchGroups(query: string): Promise<{ groups: CreatorInfo[] }> {
    const { creators } = await this.searchCreators(String(query ?? ''), 'group');
    return { groups: creators.filter((creator) => creator.kind === 'group') };
  }

  /** A client brings a topic: the node keeps it under the hash of the name. */
  createTopic(node: NodeEntry, body: TopicCreateRequest): Promise<TopicCreateResponse> {
    if (!String(body.name ?? '').trim()) throw badRequest('A topic needs a name');
    return this.core.nodes.client(node).json<TopicCreateResponse>('/v1/topics', { body: { name: body.name, description: body.description } });
  }

  /** Suggesting changes to a group: members to add or drop, a name, a description, links, an icon. */
  suggestGroup(node: NodeEntry, group: string, body: GroupSuggestionRequest): Promise<GroupSuggestionResponse> {
    return this.core.nodes.client(node).json<GroupSuggestionResponse>(`/v1/groups/${encodeURIComponent(group)}/suggestion`, { body });
  }

  /** Suggesting what a topic's description or icon should say. */
  suggestTopic(node: NodeEntry, topic: string, body: TopicSuggestionRequest): Promise<TopicSuggestionResponse> {
    return this.core.nodes.client(node).json<TopicSuggestionResponse>(`/v1/topics/${encodeURIComponent(topic)}/suggestion`, { body });
  }

  /** The group changes the user asked for on a node, with their status. */
  myGroupSuggestions(node: NodeEntry): Promise<{ suggestions: GroupSuggestion[] }> {
    return this.core.nodes.client(node).json<{ suggestions: GroupSuggestion[] }>('/v1/group-suggestions/mine');
  }

  /** The topic suggestions the user made on a node, with their status. */
  myTopicSuggestions(node: NodeEntry): Promise<{ suggestions: TopicSuggestion[] }> {
    return this.core.nodes.client(node).json<{ suggestions: TopicSuggestion[] }>('/v1/topic-suggestions/mine');
  }

  /** Creators matching a name or id, across the enabled algorithm nodes (Explore). */
  async searchCreators(query: string, kind?: CreatorKind | 'group'): Promise<{ creators: CreatorInfo[] }> {
    const q = String(query ?? '').trim().slice(0, 100);
    const found = new Map<string, CreatorInfo>();
    for (const node of this.core.nodes.active('algorithm')) {
      try {
        const suffix = kind ? `&kind=${encodeURIComponent(kind)}` : '';
        const result = await this.core.nodes.client(node).json<{ creators: CreatorInfo[] }>(`/v1/creators?q=${encodeURIComponent(q)}${suffix}`, {
          auth: false,
          timeoutMs: 8000,
        });
        for (const creator of result.creators ?? []) if (!found.has(creator.id)) found.set(creator.id, creator);
      } catch (error) {
        log.debug(`Creators on ${node.name}: ${errorText(error)}`);
      }
      if (found.size >= 24) break;
    }
    return { creators: [...found.values()].slice(0, 24) };
  }

  // -------------------------------------------------------------------------
  // Comments: one hash-chained log per content page, hosted by the first enabled
  // algorithm node. The user's key signs every comment, so only they may edit or remove
  // it; anonymous ones carry no key and can never be changed.

  private commentNode(): NodeEntry | undefined {
    return this.core.nodes.active('algorithm')[0];
  }

  /**
   * The comment chain of a content page, with the viewer's own votes and key. The client
   * suggests an order and how far the reader has scrolled; the node decides the order and
   * sends all the block headers, with the comment data of the first loaded comments only.
   */
  async comments(id: string, options: { order?: string; offset?: number; limit?: number } = {}): Promise<CommentsResponse> {
    const node = this.commentNode();
    if (!node) throw new Error('No algorithm node is enabled');
    const query = new URLSearchParams();
    if (options.order) query.set('order', options.order);
    if (options.offset) query.set('offset', String(Math.max(0, Math.trunc(options.offset))));
    if (options.limit) query.set('limit', String(Math.max(1, Math.trunc(options.limit))));
    const suffix = query.toString();
    const data = await this.core.nodes.client(node).json<Omit<CommentsResponse, 'you'>>(
      `/v1/comments/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ''}`,
      { timeoutMs: 8000 }
    );
    return { ...data, you: this.core.store.identity.id };
  }

  /** Writes a comment, a reply, or an edit of one's own (signed by the user's key). */
  async comment(id: string, body: CommentPostRequest): Promise<unknown> {
    const node = this.commentNode();
    if (!node) throw new Error('No algorithm node is enabled');
    const identity = this.core.store.identity;
    // A first level comment replies to the page's root: its cid, or its first link. The
    // text is signed exactly as it is sent, so the chain hashes the same bytes.
    const replyFrom = !body.replyFrom || body.replyFrom === '0' ? baseId(id) : body.replyFrom;
    const signed = body.anonymous
      ? {}
      : { key: identity.id, sig: signData(identity, commentSigningPayload({ key: identity.id, replyFrom, text: body.text })) };
    return this.core.nodes.client(node).json(`/v1/comments/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: { ...body, replyFrom, ...signed },
    });
  }

  /** Votes on a comment: 1 like, -1 dislike, 0 takes the vote back. */
  async voteComment(id: string, comment: string, vote: 1 | -1 | 0): Promise<unknown> {
    const node = this.commentNode();
    if (!node) throw new Error('No algorithm node is enabled');
    return this.core.nodes.client(node).json(`/v1/comments/${encodeURIComponent(id)}/${encodeURIComponent(comment)}/vote`, {
      method: 'POST',
      body: { vote },
    });
  }

  /** Asks for one's own comment to be removed (the node keeps its block header). */
  async removeComment(id: string, comment: string): Promise<unknown> {
    const node = this.commentNode();
    if (!node) throw new Error('No algorithm node is enabled');
    const identity = this.core.store.identity;
    return this.core.nodes.client(node).json(`/v1/comments/${encodeURIComponent(id)}/${encodeURIComponent(comment)}/remove`, {
      method: 'POST',
      body: { key: identity.id, sig: signData(identity, commentRemovePayload(comment)) },
    });
  }

  /**
   * Links a creator's accounts on other platforms (YouTube, TikTok, Twitter…) on a node.
   * Signed with the user's key when they hold the creator's, the accounts are linked at
   * once; unsigned, they must be external links to the creator and the node's operator
   * decides whether to link them (its account limit applies either way).
   */
  async linkCreatorAccounts(
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
    const creator = String(body.creator ?? '').trim();
    if (!creator) throw badRequest('creator is required');
    let proof: { key: string; ts: number; sig: string } | undefined;
    if (body.sign !== false) {
      const ts = Date.now();
      proof = { key: this.core.store.identity.id, ts, sig: signData(this.core.store.identity, claimSigningPayload(node.id, creator, ts)) };
    }
    return this.core.nodes.client(node).json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: { creator, accounts: body.accounts ?? [], name: body.name, kind: body.kind, proof, symmetric: body.symmetric },
    });
  }

  /** The account links the user proposed without the creator's key, with their status. */
  myAccountLinks(node: NodeEntry): Promise<{ proposals: AccountLinkProposal[] }> {
    return this.core.nodes.client(node).json<{ proposals: AccountLinkProposal[] }>('/v1/account-links/mine');
  }

  /** Content the user suggests as related to a creator, with an optional message. */
  suggestCreatorContent(
    node: NodeEntry,
    creator: string,
    body: { id?: string; message?: string; title?: string; platform?: string; metrics?: Record<string, number> }
  ): Promise<CreatorContentResponse> {
    if (!String(body.id ?? '').trim()) throw badRequest('id is required');
    return this.core.nodes.client(node).json<CreatorContentResponse>(`/v1/creators/${encodeURIComponent(creator)}/suggestions`, {
      body: { id: body.id, message: body.message, title: body.title, platform: body.platform, metrics: body.metrics },
    });
  }

  /** An icon the user suggests for a creator (a small image, as a data: URL). */
  suggestCreatorIcon(node: NodeEntry, creator: string, icon: string): Promise<CreatorIconResponse> {
    return this.core.nodes.client(node).json<CreatorIconResponse>(`/v1/creators/${encodeURIComponent(creator)}/icon-suggestion`, {
      body: { icon },
    });
  }

  /** The icons the user suggested for creators, with their status. */
  myIconSuggestions(node: NodeEntry): Promise<{ suggestions: CreatorIconSuggestion[] }> {
    return this.core.nodes.client(node).json<{ suggestions: CreatorIconSuggestion[] }>('/v1/creator-icons/mine');
  }

  /** The user's own creator-content suggestions on a node, with their status. */
  myCreatorSuggestions(node: NodeEntry): Promise<{ suggestions: CreatorContentSuggestion[] }> {
    return this.core.nodes.client(node).json<{ suggestions: CreatorContentSuggestion[] }>('/v1/creator-suggestions/mine');
  }
  subscribe(body: { id?: string; name?: string; kind?: string; icon?: string }) {
    if (!body.id) throw badRequest('id is required');
    const list = this.core.store.data.data.subscriptions;
    if (!list.some((s) => s.id === body.id)) {
      list.push({
        id: body.id,
        name: String(body.name ?? body.id).slice(0, 120),
        // A creator kind — a group subscribes like a creator — or `topic` for a topic.
        kind: (body.kind as Subscription['kind']) || undefined,
        icon: body.icon ? String(body.icon) : undefined,
        addedAt: new Date().toISOString(),
      });
      this.core.store.changed();
    }
    return { subscriptions: list };
  }

  unsubscribe(id: string) {
    this.core.store.data.data.subscriptions = this.core.store.data.data.subscriptions.filter((s) => s.id !== id);
    this.core.store.changed();
    return { subscriptions: this.core.store.data.data.subscriptions };
  }

  remember(body: { id?: string; title?: string; contentId?: string; link?: string }) {
    if (!body.id) throw badRequest('id is required');
    // History paused: what the user views now leaves no trace in the history or the
    // bloom filters — both stand still until the pause is lifted.
    if (this.core.settings.pauseHistory) return { ok: true, paused: true };
    // Watching is written to the local history log only when the user turned that on.
    if (this.core.settings.watchHistory) {
      const history = this.core.store.data.data.history.filter((h) => h.id !== body.id && this.keptInHistory(h.at));
      history.unshift({ id: body.id, title: String(body.title ?? body.id).slice(0, 300), at: new Date().toISOString() });
      this.core.store.data.data.history = history.slice(0, 200);
    }
    // Selected content: its cid and each link go into the bloom filters that remember
    // what the user has seen (locally, and the copy sent to search algorithm nodes).
    this.core.blooms.mark({ id: body.id, contentId: body.contentId, link: body.link }, SCOPES_OF_EVENT.selected);
    this.core.store.changed();
    return { ok: true };
  }

  forgetHistory() {
    this.core.store.data.data.history = [];
    this.core.store.changed();
    return { ok: true };
  }

  /** The queries the user searched for, most recent first (the search bar suggests from these). */
  searchHistoryItems(): SearchHistoryItem[] {
    this.core.store.data.data.searchHistory ??= [];
    return this.core.store.data.data.searchHistory.filter((item) => this.keptInHistory(item.at));
  }
  /** Whether a history entry is still inside the clearing window the user set (0 = forever). */
  private keptInHistory(at: string): boolean {
    const days = this.core.settings.historyClearDays;
    if (!days) return true;
    return Date.now() - Date.parse(at) < days * 86_400_000;
  }
  /** Clears the search history — all of it, or just the entries of one query. */
  clearSearchHistory(query?: string): { items: SearchHistoryItem[] } {
    const data = this.core.store.data.data;
    data.searchHistory = query ? (data.searchHistory ?? []).filter((item) => item.query !== query) : [];
    this.core.store.changed();
    return { items: data.searchHistory };
  }

  // -------------------------------------------------------------------------
  // Toast messages: the same log as the nodes' consoles keep, on the client —
  // kept only when the user turns that on (off by default).

  /** The saved toast messages, newest first, matching the words searched for. */
  toastsItems(query?: string): { items: ToastMessage[]; saved: boolean } {
    const saved = this.core.settings.toastHistory;
    const needle = (query ?? '').trim().toLowerCase();
    const items = (this.core.store.data.data.toasts ?? [])
      .filter((item) => this.keptInHistory(item.at))
      .filter((item) => !needle || item.text.toLowerCase().includes(needle));
    return { items, saved };
  }

  /** Remembers one toast message — only while the user keeps them (and history is not paused). */
  rememberToast(body: { text?: string; kind?: string; at?: string }): { items: ToastMessage[]; saved: boolean } {
    const text = String(body.text ?? '').trim().slice(0, 500);
    if (text && this.core.settings.toastHistory && !this.core.settings.pauseHistory) {
      const kind: ToastMessage['kind'] = body.kind === 'error' || body.kind === 'success' ? body.kind : 'info';
      const items = (this.core.store.data.data.toasts ?? []).filter((item) => this.keptInHistory(item.at));
      items.unshift({ id: String(Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), at: body.at ?? new Date().toISOString(), text, kind });
      this.core.store.data.data.toasts = items.slice(0, 200);
      this.core.store.changed();
    }
    return this.toastsItems();
  }

  /** Drops saved toast messages — all of them, or just the one with this id. */
  forgetToasts(id?: string): { items: ToastMessage[]; saved: boolean } {
    const data = this.core.store.data.data;
    data.toasts = id ? (data.toasts ?? []).filter((item) => item.id !== id) : [];
    this.core.store.changed();
    return this.toastsItems();
  }

  // -------------------------------------------------------------------------
  // Saved cids: the user saves any cid and sorts it into their own collections
  // (one saved cid may sit in several collections at once).

  /** The saved cids and their collections (the saved screen). */
  savedState(): SavedState {
    const data = this.core.store.data.data;
    data.saved ??= emptySavedState();
    data.saved.collections ??= [];
    data.saved.items ??= [];
    return data.saved;
  }

  /**
   * Resolves collection names-or-ids to ids, making the named ones as needed —
   * saving into a collection that does not exist yet simply creates it.
   */
  private collectionsFor(entries: unknown, saved: SavedState): string[] {
    const ids: string[] = [];
    for (const entry of Array.isArray(entries) ? entries.slice(0, 32) : []) {
      const text = String(entry ?? '').trim().slice(0, 60);
      if (!text) continue;
      const found = saved.collections.find((c) => c.id === text || c.name.toLowerCase() === text.toLowerCase());
      const collection = found ?? { id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: text, addedAt: new Date().toISOString() };
      if (!found) saved.collections.push(collection);
      if (!ids.includes(collection.id)) ids.push(collection.id);
    }
    return ids;
  }

  /** Saves a cid into the saved list, assigning it to the given collections. */
  saveCid(body: { id?: string; title?: string; collections?: unknown }): SavedState {
    const id = String(body.id ?? '').trim().slice(0, 4096);
    if (!id) throw badRequest('id is required');
    const saved = this.savedState();
    const title = String(body.title ?? '').trim().slice(0, 300) || id;
    const existing = saved.items.find((item) => item.id === id);
    if (existing) {
      existing.title = title;
      if (body.collections !== undefined) existing.collections = this.collectionsFor(body.collections, saved);
    } else {
      saved.items.unshift({ id, title, addedAt: new Date().toISOString(), collections: this.collectionsFor(body.collections, saved) });
    }
    this.core.store.changed();
    return saved;
  }

  /** Assigns a saved cid to different cid collections (or takes it out of some). */
  assignSavedCid(id: string, body: { title?: string; collections?: unknown }): SavedState {
    const saved = this.savedState();
    const item = saved.items.find((entry) => entry.id === id);
    if (!item) throw notFound('No such saved cid');
    if (body.title !== undefined) item.title = String(body.title ?? '').trim().slice(0, 300) || item.title;
    if (body.collections !== undefined) item.collections = this.collectionsFor(body.collections, saved);
    this.core.store.changed();
    return saved;
  }

  /** Takes a cid out of the saved list; it leaves every collection with it. */
  unsaveCid(id: string): SavedState {
    const saved = this.savedState();
    saved.items = saved.items.filter((item) => item.id !== id);
    this.core.store.changed();
    return saved;
  }

  /** Makes a cid collection of the user's own (saving into a name makes it too). */
  addCidCollection(body: { name?: string }): SavedState {
    const saved = this.savedState();
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw badRequest('A collection name is required');
    if (saved.collections.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw badRequest('There is already a collection with that name');
    saved.collections.push({ id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, addedAt: new Date().toISOString() });
    this.core.store.changed();
    return saved;
  }

  /** Renames one of the user's cid collections. */
  renameCidCollection(id: string, body: { name?: string }): SavedState {
    const saved = this.savedState();
    const collection = saved.collections.find((c) => c.id === id);
    if (!collection) throw notFound('No such collection');
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw badRequest('A collection name is required');
    if (saved.collections.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
      throw badRequest('There is already a collection with that name');
    }
    collection.name = name;
    this.core.store.changed();
    return saved;
  }

  /** Removes a collection; the cids saved in it stay saved (they just leave it). */
  removeCidCollection(id: string): SavedState {
    const saved = this.savedState();
    saved.collections = saved.collections.filter((c) => c.id !== id);
    for (const item of saved.items) item.collections = item.collections.filter((c) => c !== id);
    this.core.store.changed();
    return saved;
  }

  /**
   * "Delete locally": drops the cached chunks of one content — its manifest lists them
   * — and forgets the manifest. Chunks only ever enter the cache behind a manifest, so
   * a content that cannot be resolved has nothing cached under it either way.
   */
  async dropCachedContent(id: string): Promise<{ dropped: number }> {
    const base = parseContentId(id)?.base ?? id;
    let dropped = 0;
    try {
      const { manifest } = await this.core.fetcher.manifest(base);
      const cache = this.core.cache as typeof this.core.cache & { drop?: (ids: string[]) => number };
      dropped = cache.drop?.(manifest.chunks.map((chunk) => chunk.id)) ?? 0;
    } catch {
      // Nothing resolved (and nothing cached): the local record still goes.
    }
    this.core.fetcher.forget(base);
    return { dropped };
  }

  /** Removes one item from the published library this device keeps. */
  removePublished(id: string): { published: LibraryItem[] } {
    const data = this.core.store.data.data;
    data.library = data.library.filter((item) => item.id !== id);
    this.core.store.changed();
    return { published: data.library };
  }

  /**
   * Asks the chosen nodes to remove or hide one content. Every node decides for itself
   * and the request goes out on this user's account on each — so the answer says per
   * node whether the request was sent, and never fails as a whole.
   */
  async requestRemoval(input: { nodeIds: string[]; id: string; message?: string }): Promise<{ results: { node: string; name: string; ok: boolean; error?: string }[] }> {
    const results = await Promise.all(
      input.nodeIds.map(async (nodeId): Promise<{ node: string; name: string; ok: boolean; error?: string }> => {
        const node = this.core.nodes.get(nodeId);
        if (!node) return { node: nodeId, name: nodeId.slice(0, 12), ok: false, error: 'Unknown node' };
        try {
          await this.core.nodes.client(node).json('/v1/removals', { method: 'POST', body: { id: input.id, message: input.message || undefined } });
          return { node: node.id, name: node.name, ok: true };
        } catch (error) {
          return { node: node.id, name: node.name, ok: false, error: errorText(error) };
        }
      })
    );
    return { results };
  }
}
