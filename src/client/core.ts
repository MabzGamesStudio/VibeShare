// The client's logic: nodes, feeds, content, credits, publishing and the user's data.
// The desktop/command-line daemon and the web client (in a service worker) both run
// it; they only differ in where data is kept and how requests arrive. Browser-safe.
import type {
  ClientState,
  ContentView,
  CreatorView,
  FeedItem,
  FeedResponse,
  NodeEntry,
  PageFilters,
  PageSource,
  ProfileSummary,
  Settings,
} from '../shared/clientapi.js';
import { applySettingsPatch, defaultSettings, normalizeSettings, pagePreferences } from '../shared/clientdefaults.js';
import { base64url, fromBase64url } from '../shared/encoding.js';
import { badRequest, notFound } from '../shared/errors.js';
import { log } from '../shared/log.js';
import { parseNodeRef } from '../shared/noderef.js';
import { matchesLanguages } from '../shared/language.js';
import {
  decodeProfileSeed,
  encodeProfileSeed,
  hashProfilePassword,
  newProfileSeed,
  randomProfileSalt,
  verifyProfilePassword,
  type ProfileAccess,
} from '../shared/profiles.js';
import { SOFTWARE, type ClaimResponse, type ContentItem, type CreatorInfo, type LookupResult, type Page, type Preferences } from '../shared/protocol.js';
import { RemoteError, type Transport } from '../shared/remote.js';
import { embedFor, parseContentId, parseSource, platformOf, withSources } from '../shared/sources.js';
import { FetchError, Fetcher } from './fetcher.js';
import type { ChunkStore, ClientStoreLike, ProfileRecord, UploadStore } from './model.js';
import { errorText, NodeManager } from './nodes.js';
import { Publisher } from './publisher.js';

export type FeedKind = 'feed' | 'search' | 'latest';

export function encodeCursor(value: Record<string, string | null>): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursor(text: string | undefined): Record<string, string | null> | null {
  if (!text) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(text))) as Record<string, string | null>;
  } catch {
    return null;
  }
}

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
}

export class ClientCore {
  readonly store: ClientStoreLike;
  readonly nodes: NodeManager;
  readonly fetcher: Fetcher;
  readonly publisher: Publisher;
  readonly cache: ChunkStore;

  constructor(readonly options: ClientCoreOptions) {
    this.store = options.store;
    this.cache = options.cache;
    this.nodes = new NodeManager(this.store, options.transport);
    this.fetcher = new Fetcher(this.nodes, this.cache);
    this.publisher = new Publisher(this.store, this.nodes, options.uploads);
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
      profiles: this.profileSummaries(),
      activeProfile: this.store.data.data.activeProfile ?? 'main',
    };
  }

  feedItem(node: NodeEntry, item: ContentItem): FeedItem {
    // Thumbnails the algorithm node stores come through the client; those of discovered content are on the platform.
    const remote = item.thumbnail && /^https?:\/\//.test(item.thumbnail) ? item.thumbnail : undefined;
    const key = !remote ? item.thumbnail?.split('/').pop() : undefined;
    return {
      ...item,
      via: node.id,
      viaName: node.name,
      thumbnailUrl: remote ?? (key ? this.options.thumbnailUrl(node, key) : undefined),
    };
  }

  private algorithmsFor(kind: FeedKind): NodeEntry[] {
    const priceKind = kind === 'search' ? 'search' : 'feed';
    return this.nodes.active('algorithm').filter((node) => this.nodes.affordable(node, this.nodes.algorithmPrice(node, priceKind)));
  }

  /**
   * Asks the algorithm nodes for a page. "blend" mixes every enabled node by priority
   * (round robin, without duplicates); "primary" uses the first node that answers.
   */
  async collect(kind: FeedKind, body: Record<string, unknown>, cursor?: string): Promise<FeedResponse> {
    const nodes = this.algorithmsFor(kind);
    const errors: FeedResponse['errors'] = [];
    if (!nodes.length) return { items: [], errors: [{ node: '', name: 'Client', error: 'No algorithm node is enabled' }] };
    const cursors = decodeCursor(cursor) ?? {};
    const path = kind === 'feed' ? '/v1/feed' : kind === 'search' ? '/v1/search' : '/v1/creators/latest';
    const priceKind = kind === 'search' ? 'search' : 'feed';
    // Nodes filter by language too; this covers nodes that do not, and content they pass on.
    const languages = ((body.preferences ?? body.filters) as Preferences | undefined)?.languages ?? this.settings.preferences.languages;
    const wanted = (item: ContentItem) => matchesLanguages(item, languages);
    const ask = async (node: NodeEntry, limit: number): Promise<Page<ContentItem>> => {
      const price = this.nodes.algorithmPrice(node, priceKind);
      // (Paid answers carry the new balance; nothing else is asked.)
      return this.askJson<Page<ContentItem>>(node, path, { ...body, limit, cursor: cursors[node.id] ?? undefined }, price > 0);
    };

    if (this.settings.feedMode === 'primary') {
      const started = Object.keys(cursors);
      const candidates = started.length ? nodes.filter((node) => started.includes(node.id)) : nodes;
      for (const node of candidates) {
        try {
          const page = await ask(node, 24);
          return {
            items: page.items.filter(wanted).map((item) => this.feedItem(node, item)),
            cursor: page.cursor ? encodeCursor({ [node.id]: page.cursor }) : undefined,
            errors,
          };
        } catch (error) {
          errors.push({ node: node.id, name: node.name, error: errorText(error) });
        }
      }
      return { items: [], errors };
    }

    const live = nodes.filter((node) => !(node.id in cursors) || cursors[node.id] !== null);
    const per = Math.max(8, Math.ceil(24 / Math.max(1, live.length)));
    const pages = await Promise.all(
      live.map(async (node) => {
        try {
          return { node, page: await ask(node, per) };
        } catch (error) {
          errors.push({ node: node.id, name: node.name, error: errorText(error) });
          return { node, page: null };
        }
      })
    );
    const seen = new Set<string>();
    const items: FeedItem[] = [];
    const longest = Math.max(0, ...pages.map(({ page }) => page?.items.length ?? 0));
    for (let i = 0; i < longest; i++) {
      for (const { node, page } of pages) {
        const item = page?.items[i];
        if (!item || !wanted(item)) continue;
        const base = item.id.split('~')[0];
        if (seen.has(base)) continue;
        seen.add(base);
        items.push(this.feedItem(node, item));
      }
    }
    const next: Record<string, string | null> = { ...cursors };
    for (const { node, page } of pages) next[node.id] = page ? (page.cursor ?? null) : (cursors[node.id] ?? null);
    const more = Object.values(next).some((value) => value !== null);
    return { items, cursor: more ? encodeCursor(next) : undefined, errors };
  }

  /** One endpoint for every page: its source, query and filters, within the user's preferences. */
  browse(body: { source?: PageSource; query?: string; filters?: Partial<PageFilters>; sort?: string; cursor?: string; seed?: string }): Promise<FeedResponse> {
    const preferences = pagePreferences(this.settings.preferences, body.filters);
    if (body.source === 'search') {
      const sort = body.sort ?? body.filters?.sort;
      return this.collect('search', { query: String(body.query ?? ''), filters: preferences, sort }, body.cursor);
    }
    if (body.source === 'subscriptions') {
      const creators = this.store.data.data.subscriptions.map((s) => s.id);
      if (!creators.length) return Promise.resolve({ items: [], errors: [] });
      return this.collect('latest', { creators, preferences }, body.cursor);
    }
    return this.collect('feed', { preferences, seed: body.seed }, body.cursor);
  }

  async content(id: string): Promise<ContentView> {
    const parsed = parseContentId(id);
    if (!parsed) throw badRequest('Not a content id');
    const view: ContentView = {
      id: parsed.full,
      base: parsed.base,
      native: parsed.native,
      status: 'unknown',
      embeds: [],
      suggestedProviders: [],
      providerErrors: [],
    };
    for (const node of this.nodes.active('algorithm')) {
      const price = this.nodes.algorithmPrice(node, 'lookup');
      if (!this.nodes.affordable(node, price)) continue;
      try {
        const result = await this.askJson<LookupResult>(
          node,
          `/v1/content/${encodeURIComponent(parsed.full)}`,
          undefined,
          price > 0,
          8000
        );
        if (result.status === 'unknown') continue;
        view.status = result.status;
        view.decidedBy = { id: node.id, name: node.name };
        if (result.status === 'listed') view.item = this.feedItem(node, result);
        else view.reason = result.reason;
        break;
      } catch (error) {
        log.debug(`Lookup on ${node.name}: ${errorText(error)}`);
      }
    }
    const extra = view.item ? (parseContentId(view.item.id)?.sources ?? []) : [];
    view.id = withSources(parsed.full, extra);
    const sources = parseContentId(view.id)?.sources ?? [];
    const known = new Set(this.nodes.list('provider').map((node) => node.id));
    view.suggestedProviders = (view.item?.providers ?? []).filter((ref) => {
      const parsedRef = parseNodeRef(ref);
      return parsedRef && !(parsedRef.id && known.has(parsedRef.id));
    });
    if (parsed.native) {
      try {
        const hit = await this.fetcher.manifest(parsed.base);
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
        };
        view.provider = {
          id: hit.provider.id,
          name: hit.provider.name,
          perMiB: this.nodes.providerPrice(hit.provider),
          estimate: this.fetcher.estimate(manifest, hit.provider),
        };
        view.streamUrl = this.options.streamUrl(parsed.base, false);
        view.downloadUrl = this.options.streamUrl(parsed.base, true);
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
      ...embedFor(source, { ipfsGateway: this.settings.ipfsGateway, parentHost: this.options.embedHost() }),
      source,
    }));
    // Media the platform serves directly (an image, an mp4) beats an embedded player.
    const media = view.item?.media;
    if (media && all[0] && /^https?:\/\//.test(media.url)) {
      view.embeds.unshift({ kind: media.type, src: media.url, page: view.item?.pageUrl ?? view.embeds[0]?.page ?? media.url, label: platformOf(view.id).name, source: all[0] });
    }
    return view;
  }

  async creator(id: string): Promise<CreatorView> {
    for (const node of this.nodes.active('algorithm')) {
      try {
        const result = await this.nodes
          .client(node)
          .json<{ creator: CreatorInfo; items: ContentItem[] }>(`/v1/creators/${encodeURIComponent(id)}`, { auth: false });
        return { creator: result.creator, items: result.items.map((item) => this.feedItem(node, item)), via: node.id };
      } catch (error) {
        if (!(error instanceof RemoteError && error.status === 404)) log.debug(`Creator on ${node.name}: ${errorText(error)}`);
      }
    }
    const subscription = this.store.data.data.subscriptions.find((s) => s.id === id);
    return { creator: { id, name: subscription?.name ?? id.slice(0, 16), kind: subscription?.kind ?? 'unknown' }, items: [] };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const current = this.settings;
    let next: Settings;
    try {
      next = applySettingsPatch(current, patch);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    this.store.data.data.settings = next;
    this.store.changed();
    this.options.onSettings?.(current, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Profiles: several users of one client, each with their own nodes, settings,
  // history and client id (key). Public profiles open for anyone; others need
  // their username and password.

  /** Makes sure the current data has a profile record (the implicit single profile). */
  private ensureProfiles(): void {
    const data = this.store.data.data;
    data.profiles ??= [];
    data.activeProfile ??= 'main';
    if (data.profiles.length) return;
    data.profiles.push({
      id: data.activeProfile || 'main',
      name: this.settings.profile.name || 'Main',
      access: { mode: 'public' },
      identitySeed: encodeProfileSeed(this.store.identity.seed),
      nodes: data.nodes,
      settings: data.settings,
      subscriptions: data.subscriptions,
      library: data.library,
      history: data.history,
    });
  }

  /** Saves the live data and client id into the active profile's slot. */
  private snapshotProfile(): void {
    const data = this.store.data.data;
    this.ensureProfiles();
    const record = data.profiles.find((profile) => profile.id === data.activeProfile);
    if (!record) return;
    record.nodes = data.nodes;
    record.settings = data.settings;
    record.subscriptions = data.subscriptions;
    record.library = data.library;
    record.history = data.history;
    record.identitySeed = encodeProfileSeed(this.store.identity.seed);
  }

  profileSummaries(): ProfileSummary[] {
    const data = this.store.data.data;
    if (!data.profiles?.length) {
      return [{ id: data.activeProfile || 'main', name: this.settings.profile.name || 'Main', access: 'public', active: true }];
    }
    return data.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      access: profile.access.mode === 'password' ? 'protected' : 'public',
      username: profile.access.mode === 'password' ? profile.access.username : undefined,
      active: profile.id === data.activeProfile,
    }));
  }

  /** Creates a fresh profile (default settings, no nodes, its own client id). */
  async createProfile(body: { name?: string; username?: string; password?: string }): Promise<ProfileSummary[]> {
    const data = this.store.data.data;
    this.snapshotProfile();
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw badRequest('A profile name is required');
    if (data.profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      throw badRequest('There is already a profile with that name');
    }
    const password = String(body.password ?? '');
    let access: ProfileAccess = { mode: 'public' };
    if (password) {
      const username = String(body.username ?? '').trim().slice(0, 60);
      if (!username) throw badRequest('A username is needed with a password');
      const salt = randomProfileSalt();
      access = { mode: 'password', username, salt, hash: await hashProfilePassword(password, salt, username) };
    }
    data.profiles.push({
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      access,
      identitySeed: encodeProfileSeed(newProfileSeed()),
      nodes: [],
      settings: defaultSettings(),
      subscriptions: [],
      library: [],
      history: [],
    });
    this.store.changed();
    return this.profileSummaries();
  }

  /** Switches to another profile: its data, its client id, its node accounts. */
  async switchProfile(body: { id?: string; username?: string; password?: string }): Promise<ClientState> {
    const data = this.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === String(body.id ?? ''));
    if (!target) throw notFound('No such profile');
    if (target.id !== data.activeProfile) {
      if (target.access.mode === 'password') {
        const ok = await verifyProfilePassword(target.access, String(body.username ?? ''), String(body.password ?? ''));
        if (!ok) throw badRequest('Wrong username or password for this profile');
      }
      this.snapshotProfile();
      const previousSettings = data.settings;
      data.nodes = target.nodes;
      data.settings = normalizeSettings(target.settings);
      data.subscriptions = target.subscriptions;
      data.library = target.library;
      data.history = target.history;
      data.activeProfile = target.id;
      this.store.replaceIdentity(decodeProfileSeed(target.identitySeed));
      this.nodes.resetSessions();
      this.store.changed();
      this.options.onSettings?.(previousSettings, data.settings);
      void Promise.all(this.nodes.list().map((entry) => this.nodes.refreshBalance(entry)));
    }
    return this.state();
  }

  /** Renames a profile and changes or clears its username/password protection. */
  async updateProfile(body: { id?: string; name?: string; username?: string; password?: string; makePublic?: boolean }): Promise<ProfileSummary[]> {
    const data = this.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === String(body.id ?? ''));
    if (!target) throw notFound('No such profile');
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 60);
      if (!name) throw badRequest('A profile name is required');
      target.name = name;
    }
    if (body.makePublic) target.access = { mode: 'public' };
    if (body.password) {
      const username = String(body.username ?? (target.access.mode === 'password' ? target.access.username : '')).trim().slice(0, 60);
      if (!username) throw badRequest('A username is needed with a password');
      const salt = randomProfileSalt();
      target.access = { mode: 'password', username, salt, hash: await hashProfilePassword(String(body.password), salt, username) };
    }
    this.store.changed();
    return this.profileSummaries();
  }

  deleteProfile(id: string): ProfileSummary[] {
    const data = this.store.data.data;
    this.ensureProfiles();
    if (id === data.activeProfile) throw badRequest('Switch to another profile before deleting this one');
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((profile) => profile.id !== id);
    if (data.profiles.length === before) throw notFound('No such profile');
    this.store.changed();
    return this.profileSummaries();
  }

  async removeNode(id: string, release: boolean): Promise<void> {
    await this.options.beforeRemoveNode?.(id, release);
    this.nodes.remove(id);
  }

  /**
   * Asks a node on the account only when it charges for the answer. When the node says
   * "this node charges …" to an anonymous request, its cached price was stale: the
   * question is asked again with the account and the node's info is refreshed in the
   * background, so the next question carries the account right away.
   */
  private async askJson<T>(node: NodeEntry, path: string, body: unknown, auth: boolean, timeoutMs?: number): Promise<T> {
    const client = this.nodes.client(node);
    try {
      return await client.json<T>(path, { body, auth, timeoutMs });
    } catch (error) {
      if (auth || !(error instanceof RemoteError) || error.status !== 401) throw error;
      void this.nodes.refresh(node);
      return await client.json<T>(path, { body, auth: true, timeoutMs });
    }
  }

  /**
   * Reports a content id or link the client played from outside the network to every
   * node that rewards such reports (algorithm nodes and content providers). Nodes that
   * already had the content keep it and pay nothing.
   */
  async report(id: string): Promise<{ nodes: { node: string; name: string; known?: boolean; credited?: number; error?: string }[] }> {
    const results = await Promise.all(
      [...this.nodes.active('algorithm'), ...this.nodes.active('provider')].map(async (entry) => {
        try {
          const result = await this.nodes.client(entry).json<{ known: boolean; credited: number }>('/v1/reports', { body: { id } });
          return { node: entry.id, name: entry.name, ...result };
        } catch (error) {
          return { node: entry.id, name: entry.name, error: errorText(error) };
        }
      })
    );
    return { nodes: results };
  }

  /**
   * Reports platform popularity numbers (views, likes, comments, subscribers…) the
   * client saw for the content to every algorithm node; each pays for the numbers it
   * did not already have, times its per-source credit multipliers.
   */
  async claim(
    id: string,
    metrics: Record<string, number>,
    source?: string,
    publishedAt?: string
  ): Promise<{ nodes: { node: string; name: string; newInfo?: boolean; credited?: number; multiplier?: number; updated?: string[]; error?: string }[] }> {
    const results = await Promise.all(
      this.nodes.active('algorithm').map(async (entry) => {
        try {
          const result = await this.nodes.client(entry).json<ClaimResponse>('/v1/claims', { body: { id, metrics, source, publishedAt } });
          return { node: entry.id, name: entry.name, ...result };
        } catch (error) {
          return { node: entry.id, name: entry.name, error: errorText(error) };
        }
      })
    );
    return { nodes: results };
  }

  async contributions() {
    const results = await Promise.all(
      this.nodes.list('algorithm').map(async (entry) => {
        try {
          const client = this.nodes.client(entry);
          const [suggestions, submissions] = await Promise.all([
            client.json<{ suggestions: unknown[] }>('/v1/suggestions/mine'),
            client.json<{ submissions: unknown[] }>('/v1/submissions/mine'),
          ]);
          return { node: entry.id, name: entry.name, ...suggestions, ...submissions };
        } catch (error) {
          return { node: entry.id, name: entry.name, suggestions: [], submissions: [], error: errorText(error) };
        }
      })
    );
    return { nodes: results };
  }

  subscribe(body: { id?: string; name?: string; kind?: string }) {
    if (!body.id) throw badRequest('id is required');
    const list = this.store.data.data.subscriptions;
    if (!list.some((s) => s.id === body.id)) {
      list.push({
        id: body.id,
        name: String(body.name ?? body.id).slice(0, 120),
        kind: body.kind as Settings['profile']['kind'],
        addedAt: new Date().toISOString(),
      });
      this.store.changed();
    }
    return { subscriptions: list };
  }

  unsubscribe(id: string) {
    this.store.data.data.subscriptions = this.store.data.data.subscriptions.filter((s) => s.id !== id);
    this.store.changed();
    return { subscriptions: this.store.data.data.subscriptions };
  }

  remember(body: { id?: string; title?: string }) {
    if (!body.id) throw badRequest('id is required');
    const history = this.store.data.data.history.filter((h) => h.id !== body.id);
    history.unshift({ id: body.id, title: String(body.title ?? body.id).slice(0, 300), at: new Date().toISOString() });
    this.store.data.data.history = history.slice(0, 200);
    this.store.changed();
    return { ok: true };
  }

  forgetHistory() {
    this.store.data.data.history = [];
    this.store.changed();
    return { ok: true };
  }

  /** Replaces the identity (restoring a backup); sessions are re-opened with the new keys. */
  restoreIdentity(seed: Buffer): { id: string } {
    this.store.replaceIdentity(seed);
    this.nodes.resetSessions();
    void Promise.all(this.nodes.list().map((entry) => this.nodes.refreshBalance(entry)));
    return { id: this.store.identity.id };
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
