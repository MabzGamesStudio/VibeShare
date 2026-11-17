import type { Server } from 'node:http';
import { join } from 'node:path';
import { serveStatic, hasGui } from '../shared/node/assets.js';
import { apiVersionHeaders } from '../shared/api-version.js';
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
} from '../shared/node/http.js';
import { fromBase64url } from '../shared/encoding.js';
import { log } from '../shared/node/log.js';
import type { Transport } from '../shared/remote.js';
import { isOnionUrl, torFetch, TorRouter } from '../shared/node/tor.js';
import { parseContentId } from '../shared/sources.js';
import { ensureDir } from '../shared/node/store.js';
import { TRACE_LEVELS, normalizeTraceSettings, type TraceLevel } from '../shared/tracing.js';
import { TraceStore, tracingRoutes } from '../shared/node/tracing-node.js';
import { clientRoutes } from './api.js';
import { ChunkCache } from './cache.js';
import { ClientCore } from './core.js';
import { FetchError, type Fetcher } from './fetcher.js';
import type { NodeManager } from './nodes.js';
import type { Publisher } from './publisher.js';
import { StorageWorker } from './service.js';
import { ClientStore } from './state.js';
import { FileUploads } from './uploads.js';
import { ffmpegAvailable, transcodeVvshWebm } from '../provider/transcode.js';

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
  /** The daemon's local trace log (off by default; see Settings → Logging). */
  readonly traces: TraceStore;
  private router = new Router();
  private server: Server | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private thumbs = new Map<string, { type: string; data: Buffer }>();
  /**
   * The `x-vs-trace` header of the request being dispatched: the guard is the only hook
   * that sees the request before createHttpServer asks for its trace id, and the two run
   * synchronously back to back for routed requests — so this one-slot handoff carries
   * the GUI's user-action trace id into the request timeline without touching the
   * shared server code.
   */
  private pendingTrace: string | undefined;
  /** Routes requests to nodes through Tor as the settings say. */
  readonly tor: TorRouter;
  port = 0;

  constructor(private readonly options: ClientOptions) {
    const dir = options.dataDir ? ensureDir(options.dataDir) : null;
    this.token = options.token ?? randomToken(24);
    this.store = new ClientStore(dir);
    // One trace log per daemon: settings come from the client settings and are saved
    // through the same file everything else is (traces.jsonl sits beside client.json).
    this.traces = new TraceStore('client', dir, () => this.settings.tracing, (settings) => {
      this.store.data.data.settings.tracing = normalizeTraceSettings(settings);
      this.store.changed();
    });
    this.cache = new ChunkCache(dir ? join(dir, 'cache') : null, () => this.settings.cacheMiB * MiB);
    this.uploads = new FileUploads(dir);
    this.tor = new TorRouter(() => this.settings.tor);
    this.core = new ClientCore({
      store: this.store,
      cache: this.cache,
      uploads: this.uploads,
      traces: this.traces,
      thumbnailUrl: (node, key) => `/api/thumb/${node.id}/${key}?t=${this.token}`,
      streamUrl: (base, download) => `/stream/${base}?${download ? 'download=1&' : ''}t=${this.token}`,
      embedHost: () => (this.loopbackOnly() ? 'localhost' : this.host),
      onSettings: (previous, next) => this.settingsChanged(previous, next),
      beforeRemoveNode: async (id, release) => {
        if (release) await this.worker.releaseAll(id);
      },
      transport: (target) => this.transportFor(target),
      transcodeVvsh: transcodeVvshWebm,
      encoderInfo: async () =>
        (await ffmpegAvailable())
          ? { backend: 'ffmpeg' }
          : {
              backend: 'mediarecorder',
              warning: 'FFmpeg with VP9 and Opus encoders is not available. Using the slower, realtime MediaRecorder fallback in the browser.',
            },
    });
    this.nodes = this.core.nodes;
    this.fetcher = this.core.fetcher;
    this.publisher = this.core.publisher;
    this.worker = new StorageWorker(this.store, this.nodes, dir, options.serviceIntervalMs, this.traces);
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
    // An empty header is not a token: fall through to ?t= and the cookie, so a page that
    // holds no token of its own is still authorized by the cookie this daemon set.
    if (typeof header === 'string' && header) return header;
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
    // A GUI user action passes its trace id along so the API calls it makes join the
    // same timeline (see pendingTrace for why this is the place to read it).
    const header = ctx.req.headers['x-vs-trace'];
    this.pendingTrace = typeof header === 'string' && header.trim() ? header.trim().slice(0, 100) : undefined;
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
      await this.worker.sync({ announce: true });
      return this.worker.status();
    });
    // "Test my copy": hash-check the data kept for one job (or all) against its chunk ids.
    r.post('/api/services/verify', async (ctx) => {
      const body = await readJson<{ providerId?: string; assignmentId?: string }>(ctx.req);
      return { reports: await this.worker.verify(body.providerId, body.assignmentId) };
    });
    // Giving one job back: the client stops storing it and the provider frees its slot.
    r.post('/api/services/release', async (ctx) => {
      const body = await readJson<{ providerId?: string; assignmentId?: string }>(ctx.req);
      const released = body.providerId && body.assignmentId ? await this.worker.release(body.providerId, body.assignmentId) : false;
      if (!released) return { ok: false as const, error: 'That job is not stored here any more' };
      return { ok: true as const, status: await this.worker.status() };
    });
    // Reachability checks behind the provider-jobs wizard: the daemon asks the address, so
    // the browser never depends on the host sending CORS headers.
    r.get('/api/probe', async (ctx) => {
      const target = new URL(String(ctx.req.url ?? '/'), 'http://127.0.0.1').searchParams.get('url') ?? '';
      const started = Date.now();
      const fail = (why: string) => ({ ok: false as const, status: 0, bytes: 0, type: '', error: why, ms: Date.now() - started });
      if (!/^https?:\/\//.test(target)) return fail('The address must start with http:// or https://');
      try {
        let response = await fetch(target, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
        // Some hosts refuse HEAD: ask for one byte instead and read the length they send.
        if (response.status === 405 || response.status === 501) {
          response = await fetch(target, { headers: { range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
        }
        return {
          ok: response.ok || response.status === 206,
          status: response.status,
          bytes: Number(response.headers.get('content-length') ?? 0),
          type: response.headers.get('content-type') ?? '',
          ms: Date.now() - started,
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    });

    // The local trace log (off by default): the same API as the node consoles' tracing
    // tabs, behind the same /api token guard as everything else here.
    tracingRoutes(this.router, this.traces, '/api/tracing', (ctx) => this.guard(ctx));
    // One event from the GUI (a user action or change), kept in the timeline whose id it
    // carries — so browser-side actions show up beside the API calls they caused.
    r.post('/api/tracing/events', async (ctx) => {
      const body = await readJson<{
        level?: string;
        component?: string;
        action?: string;
        message?: string;
        data?: unknown;
        error?: string;
        traceId?: string;
        initiator?: { kind?: string; label?: string };
      }>(ctx.req);
      const level = (TRACE_LEVELS as readonly string[]).includes(String(body.level)) ? (body.level as TraceLevel) : 'detail';
      const label = String(body.initiator?.label ?? '').slice(0, 120);
      this.traces.recorder.event(level, String(body.component ?? 'gui').slice(0, 80), String(body.action ?? '').slice(0, 200), {
        message: body.message === undefined ? undefined : String(body.message).slice(0, 500),
        data: body.data,
        error: body.error === undefined ? undefined : String(body.error).slice(0, 500),
        traceId: body.traceId ? String(body.traceId).slice(0, 100) : undefined,
        initiator: label ? { kind: body.initiator?.kind === 'api' ? 'api' : 'user-action', label } : undefined,
      });
      return { ok: true };
    });

    // Streaming and downloads (Range requests from <video>, <audio>, <img>, downloads)
    r.get('/stream/:id', async (ctx) => {
      // A .vvsh stream as byte ranges: the browser's own seeking drives it, and only the
      // chunks that hold the asked-for bytes are fetched from the provider.
      if (ctx.params.id.startsWith('vvsh.')) {
        const spec = JSON.parse(new TextDecoder().decode(fromBase64url(ctx.params.id.slice(5)))) as {
          n: string;
          r: string;
          c: number;
          q: string;
          d: number;
        };
        const total = spec.d;
        const match = /bytes=(\d*)-(\d*)/.exec(String(ctx.req.headers.range ?? ''));
        const start = match && match[1] ? Number(match[1]) : 0;
        // A range answer is capped: an open-ended `bytes=0-` probe must never turn into
        // one giant response. The browser asks for the next part when it wants it, so the
        // video arrives in pieces and only the chunks those pieces fall in are fetched.
        const HARD_CAP = 2 * 1024 * 1024;
        const requestedEnd = match && match[2] ? Math.min(Number(match[2]) + 1, total) : total;
        const end = Math.min(requestedEnd, start + HARD_CAP);
        const bytes = await this.core.vvshRange(
          this.nodes.require(spec.n),
          { root: spec.r, chunkCount: spec.c },
          spec.q,
          total,
          start,
          end
        );
        const headers: Record<string, string> = {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'content-length': String(bytes.length),
          'cache-control': 'private, max-age=3600',
        };
        const status = match ? 206 : 200;
        if (match) headers['content-range'] = `bytes ${start}-${start + bytes.length - 1}/${total}`;
        ctx.res.writeHead(status, headers).end(Buffer.from(bytes));
        return;
      }
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
      try {
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
      } catch (error) {
        // A part stopped mid-stream (it could not be fetched again and verified): end here
        // — content that does not match the expected cid is never sent on.
        log.debug(`Stream of ${ctx.params.id} stopped early: ${(error as Error).message}`);
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
      // Every reply is stamped with the local API's contract version, so the GUI can
      // check what it is talking to before anything else fails.
      responseHeaders: apiVersionHeaders(),
      guard: (ctx) => this.guard(ctx),
      // Local tracing (off by default): one timeline per API request, joined by the
      // user action that made it when the GUI sends `x-vs-trace` (see pendingTrace).
      // The tracing endpoints record the events they are given themselves and are
      // skipped here, so recording an action never spawns a second timeline of its own.
      trace: {
        request: (label) => {
          const parent = this.pendingTrace;
          this.pendingTrace = undefined;
          if (/\/api\/tracing\//.test(label)) return '';
          return this.traces.recorder.start({ kind: 'api', label }, parent);
        },
        done: (traceId, info) =>
          this.traces.trace('dependency', 'api', 'request ok', {
            traceId,
            data: this.traces.summarize({ url: info.path, method: info.method, status: info.status, ms: info.ms }),
          }),
        failed: (traceId, info, error) =>
          this.traces.trace('error', 'api', 'request failed', {
            traceId,
            data: this.traces.summarize({ url: info.path, method: info.method, status: info.status, ms: info.ms }),
            error: (error as Error).message,
          }),
      },
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
    this.core.stopBloomJob();
    this.worker.stop();
    if (this.server) await closeServer(this.server);
    this.server = null;
    this.store.flush();
  }
}
