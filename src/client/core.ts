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
  PublishPreview,
  PublishRequest,
  Settings,
} from '../shared/clientapi.js';
import type { BloomStatus } from '../shared/clientapi.js';
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
  profileSealKey,
  randomProfileSalt,
  sealProfile,
  unsealProfile,
  verifyProfilePassword,
  type ProfileAccess,
  type SealKey,
} from '../shared/profiles.js';
import { SOFTWARE, type AlgorithmInfo, type BloomStorageState, type ClaimResponse, type ContentItem, type CreatorInfo, type LookupResult, type Page, type Preferences } from '../shared/protocol.js';
import { bytesMatchCid } from '../shared/content.js';
import { RemoteError, type Transport } from '../shared/remote.js';
import { BLOOM_INLINE_MAX_BYTES, type BloomFilterData } from '../shared/bloom.js';
import { embedFor, parseContentId, parseSource, platformOf, withSources } from '../shared/sources.js';
import { FetchError, Fetcher } from './fetcher.js';
import { BloomBook, SCOPES_OF_EVENT, type BloomScope } from './bloom.js';
import type { ChunkStore, ClientStoreLike, ProfilePayload, ProfileRecord, UploadStore } from './model.js';
import { prepareClientSave } from './model.js';
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
  readonly uploads: UploadStore;
  /** The bloom filters of content the user has seen (selected, previewed, sent to nodes). */
  readonly blooms: BloomBook;

  constructor(readonly options: ClientCoreOptions) {
    this.store = options.store;
    this.cache = options.cache;
    this.uploads = options.uploads;
    this.nodes = new NodeManager(this.store, options.transport);
    this.fetcher = new Fetcher(this.nodes, this.cache);
    this.publisher = new Publisher(this.store, this.nodes, options.uploads);
    this.blooms = new BloomBook(this.store);
    // Hidden profiles are encrypted at rest: what is written out is the sealed form.
    this.store.data.prepare = prepareClientSave;
    const storeChanged = this.store.changed.bind(this.store);
    this.store.changed = () => {
      storeChanged();
      this.scheduleSeal();
    };
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
      locked: this.isLocked(),
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
   * The seen-content filter carried inside a request to an algorithm node: only when the
   * user sends one at all, and only while it is small enough for that node to accept.
   */
  private bloomPayload(node: NodeEntry): { bloom?: BloomFilterData } {
    const settings = this.settings.nodeBloom;
    if (!settings.enabled || !settings.inline) return {};
    const limit = (node.info as AlgorithmInfo | undefined)?.bloom?.inlineMaxBits ?? BLOOM_INLINE_MAX_BYTES * 8;
    const payload = this.blooms.payload('node', limit);
    return payload ? { bloom: payload } : {};
  }

  /**
   * The local seen-content filters applied to a page: content the user has selected is
   * never suggested again; previewed content is hidden again or only pushed down among
   * the other previews, as the user chose. Colliding items are marked `seen`.
   */
  private applySeenFilters(items: FeedItem[]): FeedItem[] {
    const shown: FeedItem[] = [];
    const demoted: FeedItem[] = [];
    for (const item of items) {
      const identity = { id: item.id, contentId: item.contentId, link: item.link };
      const seenSelected = this.blooms.sees('selected', identity);
      const seenPreview = this.blooms.sees('preview', identity);
      if (seenSelected) continue;
      const marked = seenPreview ? { ...item, seen: true } : item;
      if (seenPreview && this.settings.previewBloom.mode === 'hide') continue;
      if (seenPreview && this.settings.previewBloom.mode === 'demote') demoted.push(marked);
      else shown.push(marked);
    }
    return [...shown, ...demoted];
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
      // (Paid answers carry the new balance; nothing else is asked — except when the node
      // keeps the user's seen-content filter, which it only applies to the account.)
      const identify = price > 0 || this.settings.nodeBloom.enabled;
      return this.askJson<Page<ContentItem>>(
        node,
        path,
        { ...body, ...this.bloomPayload(node), limit, cursor: cursors[node.id] ?? undefined },
        identify
      );
    };

    if (this.settings.feedMode === 'primary') {
      const started = Object.keys(cursors);
      const candidates = started.length ? nodes.filter((node) => started.includes(node.id)) : nodes;
      for (const node of candidates) {
        try {
          const page = await ask(node, 24);
          return {
            items: this.applySeenFilters(page.items.filter(wanted).map((item) => this.feedItem(node, item))),
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
    return { items: this.applySeenFilters(items), cursor: more ? encodeCursor(next) : undefined, errors };
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
    // The user disabled every external embed: only cid content and its metadata show,
    // with a placeholder standing in for the platform's picture or player.
    if (this.settings.blockExternalEmbeds) {
      view.embeds = [];
      view.embedsDisabled = true;
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
      blooms: data.blooms ?? {},
    });
  }

  /** Saves the live data and client id into the active profile's slot. */
  private async snapshotProfile(): Promise<void> {
    const data = this.store.data.data;
    this.ensureProfiles();
    const record = data.profiles.find((profile) => profile.id === data.activeProfile);
    if (!record) return;
    const payload: ProfilePayload = {
      name: record.name,
      identitySeed: encodeProfileSeed(this.store.identity.seed),
      nodes: data.nodes,
      settings: data.settings,
      subscriptions: data.subscriptions,
      library: data.library,
      history: data.history,
      blooms: data.blooms ?? {},
    };
    if (record.hidden) {
      // A hidden profile is only ever stored sealed; the plaintext fields are emptied.
      const key = this.sealKeys.get(record.id);
      if (key) record.sealed = await sealProfile(payload, key);
      record.name = '';
      record.identitySeed = '';
      record.nodes = [];
      record.settings = defaultSettings();
      record.subscriptions = [];
      record.library = [];
      record.history = [];
      record.blooms = {};
      void this.store.hideIdentity?.();
    } else {
      record.identitySeed = payload.identitySeed;
      record.nodes = payload.nodes;
      record.settings = payload.settings;
      record.subscriptions = payload.subscriptions;
      record.library = payload.library;
      record.history = payload.history;
      record.blooms = payload.blooms;
    }
  }

  /** The payload of a profile: from its fields, or from its sealed blob when hidden. */
  private payloadOf(record: ProfileRecord): ProfilePayload {
    return {
      name: record.name,
      identitySeed: record.identitySeed,
      nodes: record.nodes,
      settings: record.settings,
      subscriptions: record.subscriptions,
      library: record.library,
      history: record.history,
      blooms: record.blooms ?? {},
    };
  }

  /** Loads a profile's payload into the live fields and takes its client id. */
  private loadProfile(record: ProfileRecord, payload: ProfilePayload, previousSettings: Settings): void {
    const data = this.store.data.data;
    record.name = payload.name;
    record.identitySeed = payload.identitySeed;
    record.nodes = payload.nodes;
    record.settings = payload.settings;
    record.subscriptions = payload.subscriptions;
    record.library = payload.library;
    record.history = payload.history;
    record.blooms = payload.blooms ?? {};
    data.nodes = payload.nodes;
    data.settings = normalizeSettings(payload.settings);
    data.subscriptions = payload.subscriptions;
    data.library = payload.library;
    data.history = payload.history;
    data.blooms = payload.blooms ?? {};
    data.activeProfile = record.id;
    this.blooms.reloaded();
    this.store.replaceIdentity(decodeProfileSeed(payload.identitySeed));
    this.store.changed();
    this.options.onSettings?.(previousSettings, data.settings);
    void Promise.all(this.nodes.list().map((entry) => this.nodes.refreshBalance(entry)));
  }

  /** Keys of hidden profiles opened in this session (kept in memory only). */
  private sealKeys = new Map<string, SealKey>();
  private sealTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keeps the sealed blob of an active hidden profile current on every change. */
  private scheduleSeal(): void {
    const data = this.store.data.data;
    const record = data.profiles?.find((profile) => profile.id === data.activeProfile && profile.hidden);
    if (!record || !this.sealKeys.has(record.id) || this.sealTimer) return;
    this.sealTimer = setTimeout(() => {
      this.sealTimer = null;
      void this.sealActive(record).catch((error) => log.debug(`Could not seal the hidden profile: ${errorText(error)}`));
    }, 25);
  }

  private async sealActive(record: ProfileRecord): Promise<void> {
    const key = this.sealKeys.get(record.id);
    if (!key) return;
    const data = this.store.data.data;
    record.sealed = await sealProfile(
      {
        name: record.name,
        identitySeed: encodeProfileSeed(this.store.identity.seed),
        nodes: data.nodes,
        settings: data.settings,
        subscriptions: data.subscriptions,
        library: data.library,
        history: data.history,
        blooms: data.blooms ?? {},
      },
      key
    );
    void this.store.hideIdentity?.();
  }

  /** True while a hidden profile is active but still sealed (locked). */
  private isLocked(): boolean {
    const data = this.store.data.data;
    const record = (data.profiles ?? []).find((profile) => profile.id === data.activeProfile && profile.hidden);
    return Boolean(record && (record.sealed || record.hidden) && !this.sealKeys.has(record.id));
  }

  profileSummaries(): ProfileSummary[] {
    const data = this.store.data.data;
    const profiles = data.profiles ?? [];
    if (!profiles.length) {
      return [{ id: data.activeProfile || 'main', name: this.settings.profile.name || 'Main', access: 'public', active: true }];
    }
    const out: ProfileSummary[] = [];
    for (const profile of profiles) {
      const active = profile.id === data.activeProfile;
      if (profile.hidden) {
        // Hidden profiles do not appear in the list at all. When one is active the
        // client shows only that it is inside one, never its name.
        if (active) out.push({ id: profile.id, name: 'Hidden profile', access: 'protected', hidden: true, active: true });
        continue;
      }
      out.push({
        id: profile.id,
        name: profile.name,
        access: profile.access.mode === 'password' ? 'protected' : 'public',
        username: profile.access.mode === 'password' ? profile.access.username : undefined,
        active,
      });
    }
    return out;
  }

  /** Creates a fresh profile (default settings, no nodes, its own client id). */
  async createProfile(body: { name?: string; username?: string; password?: string; hidden?: boolean }): Promise<ProfileSummary[]> {
    const data = this.store.data.data;
    await this.snapshotProfile();
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw badRequest('A profile name is required');
    const hidden = Boolean(body.hidden);
    const username = String(body.username ?? '').trim().slice(0, 60);
    const password = String(body.password ?? '');
    if (hidden && (!username || !password)) throw badRequest('A hidden profile needs a username and a password');
    if (!hidden && data.profiles.some((profile) => !profile.hidden && profile.name.toLowerCase() === name.toLowerCase())) {
      throw badRequest('There is already a profile with that name');
    }
    let access: ProfileAccess = { mode: 'public' };
    if (password) {
      if (!username) throw badRequest('A username is needed with a password');
      const salt = randomProfileSalt();
      access = { mode: 'password', username, salt, hash: await hashProfilePassword(password, salt, username) };
    }
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: ProfilePayload = {
      name,
      identitySeed: encodeProfileSeed(newProfileSeed()),
      nodes: [],
      settings: defaultSettings(),
      subscriptions: [],
      library: [],
      history: [],
      blooms: {},
    };
    if (hidden) {
      // A hidden profile is created sealed: its name, client id and data are encrypted
      // with a key derived from the password, and it never appears in the profile list.
      const keySalt = randomProfileSalt();
      const key = await profileSealKey(password, keySalt);
      (access as { keySalt?: string }).keySalt = keySalt;
      data.profiles.push({
        id,
        name: '',
        access,
        hidden: true,
        sealed: await sealProfile(payload, key),
        identitySeed: '',
        nodes: [],
        settings: defaultSettings(),
        subscriptions: [],
        library: [],
        history: [],
        blooms: {},
      });
    } else {
      data.profiles.push({ ...payload, id, name, access });
    }
    this.store.changed();
    return this.profileSummaries();
  }

  /** Switches to another profile: its data, its client id, its node accounts. */
  async switchProfile(body: { id?: string; username?: string; password?: string }): Promise<ClientState> {
    const data = this.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === String(body.id ?? ''));
    if (!target) throw notFound('No such profile');
    // A hidden profile that is active but still sealed is opened in place.
    if (target.id !== data.activeProfile || (target.hidden && !this.sealKeys.has(target.id))) {
      const password = String(body.password ?? '');
      if (target.access.mode === 'password') {
        const ok = await verifyProfilePassword(target.access, String(body.username ?? ''), password);
        if (!ok) throw badRequest('Wrong username or password for this profile');
      }
      let payload: ProfilePayload;
      if (target.hidden) {
        // A hidden profile opens only with its username and password: the key derived
        // from the password decrypts its data (nothing else can read it).
        if (target.access.mode !== 'password' || !target.sealed) throw badRequest('This hidden profile cannot be opened');
        const key = await profileSealKey(password, target.access.keySalt ?? target.access.salt);
        try {
          payload = await unsealProfile<ProfilePayload>(target.sealed, key);
        } catch {
          throw badRequest('Wrong username or password for this profile');
        }
        await this.snapshotProfile();
        this.sealKeys.set(target.id, key);
      } else {
        await this.snapshotProfile();
        payload = this.payloadOf(target);
      }
      for (const id of [...this.sealKeys.keys()]) if (id !== target.id) this.sealKeys.delete(id);
      this.loadProfile(target, payload, data.settings);
    }
    return this.state();
  }

  /** Opens a hidden profile: the only way in is its username and password. */
  async unlockHidden(body: { username?: string; password?: string }): Promise<ClientState> {
    const data = this.store.data.data;
    const username = String(body.username ?? '');
    const target = (data.profiles ?? []).find(
      (profile) => profile.hidden && profile.access.mode === 'password' && profile.access.username === username
    );
    if (!target) throw badRequest('Wrong username or password for a hidden profile');
    return this.switchProfile({ id: target.id, username, password: String(body.password ?? '') });
  }

  /** Renames a profile and changes or clears its username/password protection. */
  async updateProfile(body: { id?: string; name?: string; username?: string; password?: string; makePublic?: boolean }): Promise<ProfileSummary[]> {
    const data = this.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === String(body.id ?? ''));
    if (!target) throw notFound('No such profile');
    if (target.hidden) throw badRequest('A hidden profile is managed only through its unlock dialog');
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

  /** Deletes a profile, but only with its username and password (typed confirmation for a public profile). */
  async deleteProfile(id: string, credentials: { username?: string; password?: string }): Promise<ProfileSummary[]> {
    const data = this.store.data.data;
    this.ensureProfiles();
    const target = data.profiles.find((profile) => profile.id === id);
    if (!target) throw notFound('No such profile');
    const username = String(credentials.username ?? '');
    const password = String(credentials.password ?? '');
    if (!username || !password) throw badRequest('Enter the profile username and password to delete it');
    if (target.access.mode === 'password') {
      // A protected (or hidden) profile is deleted only with its own username and password.
      const ok = await verifyProfilePassword(target.access, username, password);
      if (!ok) throw badRequest('Wrong username or password for this profile');
    } else if (username !== target.name) {
      // A public profile has no password of its own: its name is typed as the username
      // and the password field confirms the intent to delete.
      throw badRequest('Type the profile name as the username to confirm deletion');
    }
    if (id === data.activeProfile) {
      // Deleting the active profile (an anonymous account is deleted this way): switch to
      // another one first. When it is the only profile, wipe it and start clean instead of
      // leaving the client with none.
      const other = data.profiles.find((profile) => profile.id !== id && !profile.hidden);
      if (other) {
        this.loadProfile(other, this.payloadOf(other), data.settings);
      } else {
        const previousSettings = data.settings;
        const freshSettings = defaultSettings();
        const fresh: ProfilePayload = {
          name: freshSettings.profile.name || 'Main',
          identitySeed: encodeProfileSeed(newProfileSeed()),
          nodes: [],
          settings: freshSettings,
          subscriptions: [],
          library: [],
          history: [],
          blooms: {},
        };
        // The fresh start is an ordinary public profile (drop any hidden/locked state).
        target.hidden = undefined;
        target.access = { mode: 'public' };
        target.sealed = undefined;
        this.sealKeys.delete(target.id);
        this.loadProfile(target, fresh, previousSettings);
        return this.profileSummaries();
      }
    }
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((profile) => profile.id !== id);
    if (data.profiles.length === before) throw notFound('No such profile');
    this.sealKeys.delete(id);
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

  /** The content id an upload will have, computed on this client before publishing. */
  async previewPublish(request: PublishRequest): Promise<PublishPreview> {
    return this.publisher.preview(request);
  }

  /**
   * Pulls the data behind a URL into this client as a file to publish, e.g. when
   * suggesting missing content: the content id is then computed here and the bytes are
   * uploaded from this device.
   */
  async uploadFromUrl(rawUrl: string): Promise<{ fileId: string; size: number; name: string; mime: string }> {
    let url: URL;
    try {
      url = new URL(String(rawUrl ?? ''));
    } catch {
      throw badRequest('Not a URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('Only http(s) URLs can be pulled');
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw badRequest(`The URL answered ${response.status}`);
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream';
    const name = (decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '') || 'file').slice(0, 255);
    const stream = response.body;
    const stored = stream && this.uploads.putStream
      ? await this.uploads.putStream(stream)
      : await this.uploads.put(new Uint8Array(await response.arrayBuffer()));
    return { ...stored, name, mime };
  }

  /**
   * Fetches content from a link a provider offered (a provider sends a link instead of
   * the bytes when it does not hold them). The data is accepted only when the bytes hash
   * to the requested cid exactly.
   */
  async fetchContentLink(url: string, cid: string): Promise<{ ok: boolean; size: number }> {
    let data: Uint8Array;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return { ok: false, size: 0 };
      data = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { ok: false, size: 0 };
    }
    if (!bytesMatchCid(data, cid)) return { ok: false, size: 0 }; // only accept an exact cid match
    return { ok: true, size: data.length };
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

  remember(body: { id?: string; title?: string; contentId?: string; link?: string }) {
    if (!body.id) throw badRequest('id is required');
    const history = this.store.data.data.history.filter((h) => h.id !== body.id);
    history.unshift({ id: body.id, title: String(body.title ?? body.id).slice(0, 300), at: new Date().toISOString() });
    this.store.data.data.history = history.slice(0, 200);
    // Selected content: its cid and each link go into the bloom filters that remember
    // what the user has seen (locally, and the copy sent to search algorithm nodes).
    this.blooms.mark({ id: body.id, contentId: body.contentId, link: body.link }, SCOPES_OF_EVENT.selected);
    this.store.changed();
    return { ok: true };
  }

  forgetHistory() {
    this.store.data.data.history = [];
    this.store.changed();
    return { ok: true };
  }

  /**
   * A preview that came on screen: recorded by the preview filter (and the copy sent to
   * search nodes) as content the user has seen without selecting it.
   */
  markPreviewed(body: { id?: string; contentId?: string; link?: string }): { added: number } {
    if (!body.id) throw badRequest('id is required');
    return { added: this.blooms.mark({ id: body.id, contentId: body.contentId, link: body.link }, SCOPES_OF_EVENT.preview) };
  }

  /** The state of the three seen-content filters (what the settings screen shows). */
  bloomStatus(): BloomStatus {
    return this.blooms.status();
  }

  /** Forgets one filter; the user is warned about this before it is called. */
  resetBloom(scope: string): BloomStatus {
    if (scope !== 'selected' && scope !== 'preview' && scope !== 'node') throw badRequest('scope is selected, preview or node');
    this.blooms.reset(scope);
    return this.blooms.status();
  }

  /** The storage a search node offers for seen-content filters, and the user's own there. */
  bloomOffers(node: NodeEntry): Promise<BloomStorageState> {
    return this.nodes.client(node).json<BloomStorageState>('/v1/bloom');
  }

  /** Pays a search node (its own price and duration) to keep the user's filter a while. */
  async buyBloomStorage(node: NodeEntry, tier: string): Promise<BloomStorageState> {
    if (!tier) throw badRequest('tier is required');
    const filter = this.blooms.filter('node').toJSON();
    const state = await this.nodes.client(node).json<BloomStorageState>('/v1/bloom', { method: 'PUT', body: { tier, filter } });
    void this.nodes.refreshBalance(node);
    return state;
  }

  /** Stops the search node from keeping the user's filter (it is deleted there). */
  async dropBloomStorage(node: NodeEntry): Promise<BloomStorageState> {
    const state = await this.nodes.client(node).json<BloomStorageState>('/v1/bloom', { method: 'DELETE' });
    void this.nodes.refreshBalance(node);
    return state;
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
