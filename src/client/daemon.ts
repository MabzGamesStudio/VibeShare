import type { Server } from 'node:http';
import { join } from 'node:path';
import { serveStatic, hasGui } from '../shared/assets.js';
import type { NodeEntry, Settings } from '../shared/clientapi.js';
import { randomToken, safeEqual } from '../shared/crypto.js';
import { MiB } from '../shared/content.js';
import {
  badRequest,
  closeServer,
  createHttpServer,
  forbidden,
  HttpError,
  listen,
  readJson,
  Router,
  sendJson,
  type Ctx,
} from '../shared/http.js';
import { log } from '../shared/log.js';
import type { Transport } from '../shared/remote.js';
import { isOnionUrl, torFetch, TorRouter } from '../shared/tor.js';
import { parseContentId } from '../shared/sources.js';
import { ensureDir } from '../shared/store.js';
import { clientRoutes } from './api.js';
import { ChunkCache } from './cache.js';
import { ClientCore } from './core.js';
import { FetchError, type Fetcher } from './fetcher.js';
import type { NodeManager } from './nodes.js';
import type { Publisher } from './publisher.js';
import { StorageWorker } from './service.js';
import { ClientStore } from './state.js';
import { FileUploads } from './uploads.js';

export interface ClientOptions {
  /** Where identity, settings, cache and service data live; null keeps everything in memory (tests). */
  dataDir: string | null;
  host?: string;
  port?: number;
  guiDir?: string | null;
  /** Access token of the local API (random by default). */
  token?: string;
  serviceIntervalMs?: number;
  /**
   * Check every node this often. Off by default: node status and balances come from the
   * requests the user makes anyway, so an idle client costs nodes and credits nothing.
   */
  refreshIntervalMs?: number;
  /** Called with the settings at start and after every change (the desktop app follows the Tor setting). */
  onSettings?: (settings: Settings) => void;
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * The client node: a local daemon that owns the user's keys, nodes, credits and
 * cache, and serves the GUI. The GUI (browser or desktop window) talks only to this
 * daemon; the daemon talks to provider and algorithm nodes. Its logic is ClientCore,
 * which the web client runs in the browser too.
 */
export class ClientNode {
  readonly store: ClientStore;
  readonly core: ClientCore;
  readonly nodes: NodeManager;
  readonly cache: ChunkCache;
  readonly fetcher: Fetcher;
  readonly publisher: Publisher;
  readonly uploads: FileUploads;
  readonly worker: StorageWorker;
  readonly token: string;
  private router = new Router();
  private server: Server | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private thumbs = new Map<string, { type: string; data: Buffer }>();
  /** Routes requests to nodes through Tor as the settings say. */
  readonly tor: TorRouter;
  port = 0;

  constructor(private readonly options: ClientOptions) {
    const dir = options.dataDir ? ensureDir(options.dataDir) : null;
    this.token = options.token ?? randomToken(24);
    this.store = new ClientStore(dir);
    this.cache = new ChunkCache(dir ? join(dir, 'cache') : null, () => this.settings.cacheMiB * MiB);
    this.uploads = new FileUploads(dir);
    this.tor = new TorRouter(() => this.settings.tor);
    this.core = new ClientCore({
      store: this.store,
      cache: this.cache,
      uploads: this.uploads,
      thumbnailUrl: (node, key) => `/api/thumb/${node.id}/${key}?t=${this.token}`,
      streamUrl: (base, download) => `/stream/${base}?${download ? 'download=1&' : ''}t=${this.token}`,
      embedHost: () => (this.loopbackOnly() ? 'localhost' : this.host),
      onSettings: (previous, next) => this.settingsChanged(previous, next),
      beforeRemoveNode: async (id, release) => {
        if (release) await this.worker.releaseAll(id);
      },
      transport: (target) => this.transportFor(target),
    });
    this.nodes = this.core.nodes;
    this.fetcher = this.core.fetcher;
    this.publisher = this.core.publisher;
    this.worker = new StorageWorker(this.store, this.nodes, dir, options.serviceIntervalMs);
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

  /**
   * Tor for .onion nodes (unless Tor is off), and for every node in "all" mode — then
   * through the node's own onion address when it publishes one, so traffic never leaves Tor.
   */
  private transportFor(target: { url: string; onion?: string }): Transport | undefined {
    const { mode } = this.settings.tor;
    const onion = mode === 'all' && target.onion && isOnionUrl(target.onion) && !isOnionUrl(target.url) ? target.onion.replace(/\/+$/, '') : null;
    const url = onion ?? target.url;
    if (!isOnionUrl(url) && !this.tor.routes(url)) return undefined;
    if (!onion) return { fetch: this.tor.fetch, timeoutFactor: 4 };
    const base = target.url.replace(/\/+$/, '');
    const viaOnion = ((input: string | URL | Request, init?: RequestInit) => {
      const href = input instanceof Request ? input.url : String(input);
      return this.tor.fetch(href.startsWith(base) ? onion + href.slice(base.length) : href, init);
    }) as typeof fetch;
    return { fetch: viaOnion, timeoutFactor: 4 };
  }

  /** Whether Tor can be reached, and whether traffic really leaves through it. */
  async checkTor(): Promise<{ ok: boolean; proxy?: string; isTor?: boolean; ip?: string; error?: string }> {
    let proxy: string | undefined;
    try {
      const address = await this.tor.proxy.address();
      proxy = `${address.host}:${address.port}`;
      const check = torFetch({ proxy: address, isolation: () => 'vibeshare:check' });
      const response = await check('https://check.torproject.org/api/ip', { signal: AbortSignal.timeout(45_000) });
      const answer = (await response.json()) as { IsTor?: boolean; IP?: string };
      return { ok: Boolean(answer.IsTor), proxy, isTor: Boolean(answer.IsTor), ip: answer.IP };
    } catch (error) {
      return { ok: false, proxy, error: (error as Error).message };
    }
  }

  private settingsChanged(previous: Settings, next: Settings): void {
    this.options.onSettings?.(next);
    const wasEnabled = previous.storageService.enabled;
    if (next.storageService.enabled && !wasEnabled) this.worker.start();
    if (!next.storageService.enabled && wasEnabled) this.worker.stop();
    if (next.storageService.enabled) void this.worker.sync();
  }

  // -------------------------------------------------------------------------

  private routes(): void {
    const r = this.router;
    for (const route of clientRoutes(this.core)) {
      r.on(route.method, route.path, (ctx) =>
        route.handler({ params: ctx.params, query: ctx.query, json: (limit) => readJson(ctx.req, limit) })
      );
    }

    // What only the daemon does: files on disk, proxied thumbnails, the storage service.
    r.post('/api/upload', (ctx) => this.uploads.receive(ctx.req));
    r.get('/api/thumb/:id/:key', async (ctx) => {
      const cacheKey = `${ctx.params.id}/${ctx.params.key}`;
      let thumb = this.thumbs.get(cacheKey);
      if (!thumb) {
        const entry = this.nodes.require(ctx.params.id);
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
    // Live updates for the GUI: node status and credits as they change (Server-Sent Events).
    // Local only: nothing is asked of the nodes for it.
    r.get('/api/events', (ctx) => {
      ctx.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (nodes: NodeEntry[]) => ctx.res.write(`event: nodes\ndata: ${JSON.stringify(nodes)}\n\n`);
      send(this.nodes.list());
      const stop = this.nodes.subscribe(send);
      const keepAlive = setInterval(() => ctx.res.write(': keep-alive\n\n'), 25_000);
      ctx.req.on('close', () => {
        stop();
        clearInterval(keepAlive);
      });
    });
    r.post('/api/tor/check', () => this.checkTor());
    r.get('/api/services', () => this.worker.status());
    r.post('/api/services/sync', async () => {
      await this.worker.sync();
      return this.worker.status();
    });

    // Streaming and downloads (Range requests from <video>, <audio>, <img>, downloads)
    r.get('/stream/:id', async (ctx) => {
      const parsed = parseContentId(ctx.params.id);
      if (!parsed?.native) throw badRequest('Only native content (vs1…) can be streamed from providers');
      let answer;
      try {
        answer = await this.fetcher.open(parsed.base, ctx.req.headers.range, ctx.query.get('download') === '1');
      } catch (error) {
        if (error instanceof FetchError) {
          throw new HttpError(502, 'unavailable', error.message, { attempts: error.attempts });
        }
        throw error;
      }
      const { res } = ctx;
      res.writeHead(answer.status, answer.headers);
      if (!answer.body || ctx.req.method === 'HEAD') {
        await answer.body?.return(undefined);
        res.end();
        return;
      }
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      for await (const piece of answer.body) {
        if (closed) break;
        if (!res.write(piece)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.on('drain', done);
            res.on('close', done);
          });
        }
      }
      res.end();
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
    if (this.options.refreshIntervalMs) {
      this.refreshTimer = setInterval(() => void this.nodes.refreshAll(), this.options.refreshIntervalMs);
      this.refreshTimer.unref();
    }
    if (this.settings.storageService.enabled) this.worker.start();
    this.options.onSettings?.(this.settings);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.worker.stop();
    if (this.server) await closeServer(this.server);
    this.server = null;
    this.store.flush();
  }
}
