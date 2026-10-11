import type { Server } from 'node:http';
import { join } from 'node:path';
import { serveStatic, hasGui } from '../shared/assets.js';
import type {
  ClientState,
  ContentView,
  CreatorView,
  ExternalPublishRequest,
  FeedItem,
  FeedResponse,
  NodeEntry,
  PublishRequest,
  Settings,
} from '../shared/clientapi.js';
import { randomToken, safeEqual } from '../shared/crypto.js';
import { MiB } from '../shared/content.js';
import {
  badRequest,
  closeServer,
  createHttpServer,
  forbidden,
  HttpError,
  listen,
  notFound,
  readJson,
  RemoteError,
  Router,
  sendJson,
  type Ctx,
} from '../shared/http.js';
import { log } from '../shared/log.js';
import { parseNodeRef } from '../shared/noderef.js';
import {
  SOFTWARE,
  type ContentItem,
  type CreatorInfo,
  type Invoice,
  type LookupResult,
  type Page,
  type Preferences,
} from '../shared/protocol.js';
import { embedFor, formatSource, parseContentId, parseSource, sourceFromUrl, withSources } from '../shared/sources.js';
import { ensureDir } from '../shared/store.js';
import { ChunkCache } from './cache.js';
import { FetchError, Fetcher } from './fetcher.js';
import { errorText, NodeManager } from './nodes.js';
import { Publisher } from './publisher.js';
import { StorageWorker } from './service.js';
import { ClientStore, formatSeed, parseSeed } from './state.js';

export interface ClientOptions {
  /** Where identity, settings, cache and service data live; null keeps everything in memory (tests). */
  dataDir: string | null;
  host?: string;
  port?: number;
  guiDir?: string | null;
  /** Access token of the local API (random by default). */
  token?: string;
  serviceIntervalMs?: number;
  refreshIntervalMs?: number;
}

type Kind = 'feed' | 'search' | 'latest';

function encodeCursor(value: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(text: string | undefined): Record<string, string | null> | null {
  if (!text) return null;
  try {
    return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Record<string, string | null>;
  } catch {
    return null;
  }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * The client node: a local daemon that owns the user's keys, nodes, credits and
 * cache, and serves the GUI. The GUI (browser or desktop window) talks only to this
 * daemon; the daemon talks to provider and algorithm nodes.
 */
export class ClientNode {
  readonly store: ClientStore;
  readonly nodes: NodeManager;
  readonly cache: ChunkCache;
  readonly fetcher: Fetcher;
  readonly publisher: Publisher;
  readonly worker: StorageWorker;
  readonly token: string;
  private router = new Router();
  private server: Server | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private thumbs = new Map<string, { type: string; data: Buffer }>();
  port = 0;

  constructor(private readonly options: ClientOptions) {
    const dir = options.dataDir ? ensureDir(options.dataDir) : null;
    this.store = new ClientStore(dir);
    this.nodes = new NodeManager(this.store);
    this.cache = new ChunkCache(dir ? join(dir, 'cache') : null, () => this.settings.cacheMiB * MiB);
    this.fetcher = new Fetcher(this.nodes, this.cache);
    this.publisher = new Publisher(this.store, this.nodes, dir);
    this.worker = new StorageWorker(this.store, this.nodes, dir, options.serviceIntervalMs);
    this.token = options.token ?? randomToken(24);
    this.routes();
  }

  get settings(): Settings {
    return this.store.data.data.settings;
  }

  get host(): string {
    return this.options.host ?? '127.0.0.1';
  }

  url(): string {
    const host = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
    return `http://${host}:${this.port}`;
  }

  /** URL that opens the GUI with access (needed when the daemon listens beyond localhost). */
  guiUrl(): string {
    return `${this.url()}/?t=${this.token}`;
  }

  private loopbackOnly(): boolean {
    return ['127.0.0.1', 'localhost', '::1'].includes(this.host);
  }

  // -------------------------------------------------------------------------
  // Access control: only the GUI served by this daemon may use the API.

  private tokenOf(ctx: Ctx): string {
    const header = ctx.req.headers['x-vs-token'];
    if (typeof header === 'string') return header;
    const query = ctx.query.get('t');
    if (query) return query;
    const cookie = (ctx.req.headers.cookie ?? '').match(/(?:^|;\s*)vs_token=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : '';
  }

  private authorized(ctx: Ctx): boolean {
    const token = this.tokenOf(ctx);
    return Boolean(token) && safeEqual(token, this.token);
  }

  private guard(ctx: Ctx): void {
    // Stops DNS rebinding: a web page cannot reach the daemon under another host name.
    if (this.loopbackOnly() && !LOOPBACK.test(ctx.req.headers.host ?? '')) throw forbidden('Unexpected Host header');
    const path = ctx.url.pathname;
    if ((path.startsWith('/api/') || path.startsWith('/stream/')) && !this.authorized(ctx)) {
      throw forbidden('Missing or wrong local access token');
    }
  }

  // -------------------------------------------------------------------------

  state(): ClientState {
    return {
      version: SOFTWARE,
      identity: { id: this.store.identity.id },
      nodes: this.nodes.list(),
      settings: this.settings,
      subscriptions: this.store.data.data.subscriptions,
    };
  }

  private feedItem(node: NodeEntry, item: ContentItem): FeedItem {
    const key = item.thumbnail?.split('/').pop();
    return {
      ...item,
      via: node.id,
      viaName: node.name,
      thumbnailUrl: key ? `/api/thumb/${node.id}/${key}?t=${this.token}` : undefined,
    };
  }

  private algorithmsFor(kind: Kind): NodeEntry[] {
    const priceKind = kind === 'search' ? 'search' : 'feed';
    return this.nodes.active('algorithm').filter((node) => this.nodes.affordable(node, this.nodes.algorithmPrice(node, priceKind)));
  }

  /**
   * Asks the algorithm nodes for a page. "blend" mixes every enabled node by priority
   * (round robin, without duplicates); "primary" uses the first node that answers.
   */
  async collect(kind: Kind, body: Record<string, unknown>, cursor?: string): Promise<FeedResponse> {
    const nodes = this.algorithmsFor(kind);
    const errors: FeedResponse['errors'] = [];
    if (!nodes.length) return { items: [], errors: [{ node: '', name: 'Client', error: 'No algorithm node is enabled' }] };
    const cursors = decodeCursor(cursor) ?? {};
    const path = kind === 'feed' ? '/v1/feed' : kind === 'search' ? '/v1/search' : '/v1/creators/latest';
    const priceKind = kind === 'search' ? 'search' : 'feed';
    const ask = async (node: NodeEntry, limit: number): Promise<Page<ContentItem>> => {
      const price = this.nodes.algorithmPrice(node, priceKind);
      const page = await this.nodes.client(node).json<Page<ContentItem>>(path, {
        body: { ...body, limit, cursor: cursors[node.id] ?? undefined },
        auth: price > 0,
      });
      if (price > 0) void this.nodes.refreshBalance(node);
      return page;
    };

    if (this.settings.feedMode === 'primary') {
      const started = Object.keys(cursors);
      const candidates = started.length ? nodes.filter((node) => started.includes(node.id)) : nodes;
      for (const node of candidates) {
        try {
          const page = await ask(node, 24);
          return {
            items: page.items.map((item) => this.feedItem(node, item)),
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
        if (!item) continue;
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
        const result = await this.nodes
          .client(node)
          .json<LookupResult>(`/v1/content/${encodeURIComponent(parsed.full)}`, { auth: price > 0, timeoutMs: 8000 });
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
        view.streamUrl = `/stream/${parsed.base}?t=${this.token}`;
        view.downloadUrl = `/stream/${parsed.base}?download=1&t=${this.token}`;
        if (!view.item && manifest.sources) {
          view.id = withSources(view.id, manifest.sources.map(parseSource).filter((source) => source !== null));
        }
      } catch (error) {
        if (error instanceof FetchError) view.providerErrors = error.attempts;
        else view.providerErrors = [{ node: '', name: 'Client', error: errorText(error) }];
      }
    }
    const host = this.loopbackOnly() ? 'localhost' : this.host;
    view.embeds = (parseContentId(view.id)?.sources ?? sources).map((source) => ({
      ...embedFor(source, { ipfsGateway: this.settings.ipfsGateway, parentHost: host }),
      source,
    }));
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

  private updateSettings(patch: Partial<Settings>): Settings {
    const current = this.settings;
    const wasEnabled = current.storageService.enabled;
    const next: Settings = {
      ...current,
      ...patch,
      preferences: { ...current.preferences, ...(patch.preferences ?? {}) },
      profile: { ...current.profile, ...(patch.profile ?? {}) },
      storageService: { ...current.storageService, ...(patch.storageService ?? {}) },
    };
    if (!['blend', 'primary'].includes(next.feedMode)) throw badRequest('feedMode is blend or primary');
    if (!['warn', 'hide', 'allow'].includes(next.unknownContent)) throw badRequest('unknownContent is warn, hide or allow');
    next.cacheMiB = Math.max(16, Number(next.cacheMiB) || 1024);
    next.storageService.quotaGiB = Math.max(0, Number(next.storageService.quotaGiB) || 0);
    this.store.data.data.settings = next;
    this.store.changed();
    if (next.storageService.enabled && !wasEnabled) this.worker.start();
    if (!next.storageService.enabled && wasEnabled) this.worker.stop();
    if (next.storageService.enabled) void this.worker.sync();
    return next;
  }

  // -------------------------------------------------------------------------

  private routes(): void {
    const r = this.router;
    const node = (ctx: Ctx) => this.nodes.require(ctx.params.id);

    r.get('/api/state', () => this.state());

    // Nodes: add by pasting references, remove, reorder, enable/disable, account mode, price limit.
    r.post('/api/nodes', async (ctx) => {
      const body = await readJson<{ text?: string }>(ctx.req);
      if (!body.text?.trim()) throw badRequest('Paste one or more node references');
      return this.nodes.add(body.text);
    });
    r.get('/api/nodes/export', (ctx) => ({ text: this.nodes.exportRefs((ctx.query.get('type') as 'provider') ?? undefined) }));
    r.patch('/api/nodes/:id', async (ctx) => {
      const body = await readJson<Partial<NodeEntry>>(ctx.req);
      const updated = this.nodes.update(ctx.params.id, body);
      if (body.auth) void this.nodes.refreshBalance(updated);
      return updated;
    });
    r.delete('/api/nodes/:id', async (ctx) => {
      if (ctx.query.get('release') === '1') await this.worker.releaseAll(ctx.params.id);
      this.nodes.remove(ctx.params.id);
      return { ok: true };
    });
    r.post('/api/nodes/order', async (ctx) => {
      const body = await readJson<{ type?: 'provider' | 'algorithm'; ids?: string[] }>(ctx.req);
      if (body.type !== 'provider' && body.type !== 'algorithm') throw badRequest('type is provider or algorithm');
      this.nodes.reorder(body.type, (body.ids ?? []).map(String));
      return { nodes: this.nodes.list() };
    });
    r.post('/api/nodes/:id/refresh', async (ctx) => this.nodes.refresh(node(ctx)));
    r.post('/api/nodes/refresh', async () => {
      await this.nodes.refreshAll();
      return { nodes: this.nodes.list() };
    });
    r.get('/api/nodes/:id/account', async (ctx) => {
      const entry = node(ctx);
      const result = await this.nodes.client(entry).json<{ account: { balance: number; id: string } }>('/v1/account');
      this.nodes.setBalance(entry.id, result.account.balance);
      return result;
    });
    r.get('/api/nodes/:id/payments', async (ctx) => this.nodes.client(node(ctx)).json('/v1/payments', { auth: false }));
    r.post('/api/nodes/:id/invoices', async (ctx) => {
      const body = await readJson<{ method?: string; credits?: number }>(ctx.req);
      return this.nodes.client(node(ctx)).json<Invoice>(`/v1/payments/${encodeURIComponent(String(body.method))}/invoices`, {
        body: { credits: body.credits },
      });
    });
    r.get('/api/nodes/:id/invoices/:invoice', async (ctx) =>
      this.nodes.client(node(ctx)).json<Invoice>(`/v1/payments/invoices/${encodeURIComponent(ctx.params.invoice)}`)
    );
    r.post('/api/nodes/:id/claim', async (ctx) => {
      const entry = node(ctx);
      const body = await readJson<Record<string, unknown> & { method?: string }>(ctx.req);
      const { method, ...rest } = body;
      const result = await this.nodes.client(entry).json<{ balance: number }>(`/v1/payments/${encodeURIComponent(String(method))}/claim`, {
        body: rest,
        timeoutMs: 30000,
      });
      this.nodes.setBalance(entry.id, result.balance);
      return result;
    });

    // Discovery
    r.post('/api/feed', async (ctx) => {
      const body = await readJson<{ cursor?: string; seed?: string; formats?: Preferences['formats'] }>(ctx.req);
      const preferences = body.formats?.length ? { ...this.settings.preferences, formats: body.formats } : this.settings.preferences;
      return this.collect('feed', { preferences, seed: body.seed }, body.cursor);
    });
    r.post('/api/search', async (ctx) => {
      const body = await readJson<{ query?: string; filters?: Preferences & { creator?: string }; sort?: string; cursor?: string }>(ctx.req);
      const filters = { ...this.settings.preferences, ...Object.fromEntries(Object.entries(body.filters ?? {}).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) };
      return this.collect('search', { query: String(body.query ?? ''), filters, sort: body.sort }, body.cursor);
    });
    r.post('/api/subscriptions/feed', async (ctx) => {
      const body = await readJson<{ cursor?: string }>(ctx.req);
      const creators = this.store.data.data.subscriptions.map((s) => s.id);
      if (!creators.length) return { items: [], errors: [] } satisfies FeedResponse;
      return this.collect('latest', { creators, preferences: this.settings.preferences }, body.cursor);
    });
    r.get('/api/content/:id', (ctx) => this.content(ctx.params.id));
    r.get('/api/creators/:id', (ctx) => this.creator(ctx.params.id));
    r.get('/api/thumb/:id/:key', async (ctx) => {
      const cacheKey = `${ctx.params.id}/${ctx.params.key}`;
      let thumb = this.thumbs.get(cacheKey);
      if (!thumb) {
        const entry = node(ctx);
        const response = await this.nodes.client(entry).fetch(`/v1/thumbnails/${encodeURIComponent(ctx.params.key)}`, { auth: false });
        const type = response.headers.get('content-type') ?? '';
        const safeType = ['image/jpeg', 'image/png', 'image/webp'].find((allowed) => type.startsWith(allowed)) ?? 'application/octet-stream';
        thumb = { type: safeType, data: Buffer.from(await response.arrayBuffer()) };
        this.thumbs.set(cacheKey, thumb);
        if (this.thumbs.size > 500) this.thumbs.delete(this.thumbs.keys().next().value!);
      }
      ctx.res.writeHead(200, {
        'content-type': thumb.type,
        'content-length': thumb.data.length,
        'cache-control': 'private, max-age=86400',
        'content-security-policy': "sandbox; default-src 'none'",
        'x-content-type-options': 'nosniff',
      });
      ctx.res.end(thumb.data);
    });
    r.get('/api/source', (ctx) => {
      const source = sourceFromUrl(ctx.query.get('url') ?? '');
      if (!source) throw badRequest('Not a link this client understands');
      return { source, id: formatSource(source), embed: embedFor(source, { ipfsGateway: this.settings.ipfsGateway }) };
    });

    // Contributions to algorithm nodes (they pay credits for these)
    r.post('/api/vote', async (ctx) => {
      const body = await readJson<{ nodeId?: string; id?: string; vote?: number }>(ctx.req);
      const entry = this.nodes.require(String(body.nodeId));
      const result = await this.nodes.client(entry).json<{ credited: number }>('/v1/votes', { body: { id: body.id, vote: body.vote } });
      if (result.credited) void this.nodes.refreshBalance(entry);
      return result;
    });
    r.get('/api/vote/:id', async (ctx) => {
      const entry = node(ctx);
      return this.nodes.client(entry).json(`/v1/votes/${encodeURIComponent(ctx.query.get('content') ?? '')}`);
    });
    r.post('/api/suggest', async (ctx) => {
      const body = await readJson<{ nodeId?: string; id?: string; kind?: string; value?: string; reason?: string; timestamp?: number }>(ctx.req);
      const entry = this.nodes.require(String(body.nodeId));
      const { nodeId: _node, ...rest } = body;
      const result = await this.nodes.client(entry).json<{ status: string }>('/v1/suggestions', { body: rest });
      void this.nodes.refreshBalance(entry);
      return result;
    });
    r.get('/api/contributions', async () => {
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
    });

    // Subscriptions
    r.get('/api/subscriptions', () => ({ subscriptions: this.store.data.data.subscriptions }));
    r.post('/api/subscriptions', async (ctx) => {
      const body = await readJson<{ id?: string; name?: string; kind?: string }>(ctx.req);
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
    });
    r.delete('/api/subscriptions/:id', (ctx) => {
      this.store.data.data.subscriptions = this.store.data.data.subscriptions.filter((s) => s.id !== ctx.params.id);
      this.store.changed();
      return { subscriptions: this.store.data.data.subscriptions };
    });

    // Publishing
    r.post('/api/upload', (ctx) => this.publisher.receive(ctx.req));
    r.post('/api/publish', async (ctx) => this.publisher.publish(await readJson<PublishRequest>(ctx.req, 2 * MiB)));
    r.post('/api/publish/external', async (ctx) => this.publisher.publishExternal(await readJson<ExternalPublishRequest>(ctx.req, 2 * MiB)));
    r.get('/api/jobs', () => ({ jobs: [...this.publisher.jobs.values()].reverse() }));
    r.get('/api/jobs/:id', (ctx) => {
      const job = this.publisher.jobs.get(ctx.params.id);
      if (!job) throw notFound('No such job');
      return job;
    });

    // Library and history
    r.get('/api/library', () => ({ published: this.store.data.data.library, history: this.store.data.data.history }));
    r.post('/api/history', async (ctx) => {
      const body = await readJson<{ id?: string; title?: string }>(ctx.req);
      if (!body.id) throw badRequest('id is required');
      const history = this.store.data.data.history.filter((h) => h.id !== body.id);
      history.unshift({ id: body.id, title: String(body.title ?? body.id).slice(0, 300), at: new Date().toISOString() });
      this.store.data.data.history = history.slice(0, 200);
      this.store.changed();
      return { ok: true };
    });
    r.delete('/api/history', () => {
      this.store.data.data.history = [];
      this.store.changed();
      return { ok: true };
    });

    // Settings, identity, services, cache
    r.patch('/api/settings', async (ctx) => this.updateSettings(await readJson<Partial<Settings>>(ctx.req)));
    r.get('/api/identity/export', () => ({ seed: formatSeed(this.store.identity.seed), id: this.store.identity.id }));
    r.post('/api/identity/import', async (ctx) => {
      const body = await readJson<{ seed?: string }>(ctx.req);
      let seed: Buffer;
      try {
        seed = parseSeed(String(body.seed ?? ''));
      } catch (error) {
        throw badRequest((error as Error).message);
      }
      this.store.replaceIdentity(seed);
      this.nodes.resetSessions();
      void Promise.all(this.nodes.list().map((entry) => this.nodes.refreshBalance(entry)));
      return { id: this.store.identity.id };
    });
    r.get('/api/services', () => this.worker.status());
    r.post('/api/services/sync', async () => {
      await this.worker.sync();
      return this.worker.status();
    });
    r.get('/api/cache', () => ({ ...this.cache.usage(), limit: this.settings.cacheMiB * MiB }));
    r.delete('/api/cache', async () => {
      await this.cache.clear();
      return this.cache.usage();
    });

    // Streaming and downloads (Range requests from <video>, <audio>, <img>, downloads)
    r.get('/stream/:id', async (ctx) => {
      const parsed = parseContentId(ctx.params.id);
      if (!parsed?.native) throw badRequest('Only native content (vs1…) can be streamed from providers');
      try {
        await this.fetcher.stream(parsed.base, ctx.res, ctx.req.headers.range, ctx.query.get('download') === '1');
      } catch (error) {
        if (error instanceof FetchError) {
          throw new HttpError(502, 'unavailable', error.message, { attempts: error.attempts });
        }
        throw error;
      }
    });
  }

  private servePage(ctx: Ctx): boolean {
    const dir = this.options.guiDir ?? null;
    const path = ctx.url.pathname === '/' ? 'index.html' : ctx.url.pathname.slice(1);
    const allowed = this.loopbackOnly() || this.authorized(ctx);
    const inject = (html: string) =>
      html.replace('</head>', `<meta name="vs-token" content="${allowed ? this.token : ''}"></head>`);
    if (ctx.query.get('t') && this.authorized(ctx)) {
      ctx.res.setHeader('set-cookie', `vs_token=${this.token}; Path=/; HttpOnly; SameSite=Strict`);
    }
    if (path.startsWith('assets/') || path.includes('.')) {
      if (serveStatic(ctx, dir, path, inject)) return true;
      if (path.startsWith('assets/')) return false;
    }
    if (hasGui(dir) && serveStatic(ctx, dir, 'index.html', inject)) return true;
    sendJson(ctx.res, 200, {
      name: 'VibeShare client',
      message: 'The GUI is not built. Run `npm run build:gui`, or use the API under /api with the x-vs-token header.',
    });
    return true;
  }

  async start(): Promise<void> {
    this.server = createHttpServer({
      router: this.router,
      name: 'client',
      guard: (ctx) => this.guard(ctx),
      fallback: (ctx) => (ctx.req.method === 'GET' || ctx.req.method === 'HEAD' ? this.servePage(ctx) : false),
    });
    this.server.requestTimeout = 0;
    this.port = await listen(this.server, this.options.port ?? 7700, this.host);
    log.info(`Client node on ${this.url()}`);
    void this.nodes.refreshAll();
    this.refreshTimer = setInterval(() => void this.nodes.refreshAll(), this.options.refreshIntervalMs ?? 120_000);
    this.refreshTimer.unref();
    if (this.settings.storageService.enabled) this.worker.start();
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.worker.stop();
    if (this.server) await closeServer(this.server);
    this.server = null;
    this.store.flush();
  }
}
