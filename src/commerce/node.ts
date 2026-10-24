import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { generateIdentity, identityFromSeed, randomToken, safeEqual, signData, type Identity } from '../shared/crypto.js';
import { canonicalJson, fromBase64url, base64url } from '../shared/encoding.js';
import {
  badRequest,
  closeServer,
  createHttpServer,
  forbidden,
  listen,
  readJson,
  Router,
  type Ctx,
} from '../shared/http.js';
import { log } from '../shared/log.js';
import type { Transport } from '../shared/remote.js';
import { isOnionUrl, OnionService, TorRouter, type TorMode } from '../shared/tor.js';
import { formatNodeRef, parseNodeRef, type NodeType } from '../shared/noderef.js';
import {
  infoSigningPayload,
  PROTOCOL_VERSION,
  SOFTWARE,
  type NodeInfo,
  type NodeInfoBase,
  type SignedInfo,
} from '../shared/protocol.js';
import { ensureDir, JsonFile } from '../shared/store.js';
import { Auth, type SignupConfig } from './auth.js';
import { Ledger } from './ledger.js';
import { Moderation } from './moderation.js';
import { Payments, type PaymentConfig } from './payments.js';
import { serveStatic } from '../shared/assets.js';

export interface BaseConfig {
  name: string;
  description: string;
  /** The URL clients reach this node at (behind a proxy, a domain, …). Defaults to http://host:port. */
  publicUrl?: string;
  contact?: string;
  terms?: string;
  host: string;
  port: number;
  /** Trust X-Forwarded-For (only behind your own reverse proxy). */
  trustProxy: boolean;
  signup: SignupConfig;
  payments: PaymentConfig[];
  /** Node references this operator recommends to clients. */
  peers: string[];
  tor: NodeTorConfig;
}

/** Tor: publishing the node as an onion service, and which outgoing requests go through Tor. */
export interface NodeTorConfig {
  /** Publish the node at a .onion address, through Tor's control port. */
  onionService: boolean;
  /** Tor's control port (ControlPort in torrc). */
  controlPort: string;
  /** Its password (HashedControlPassword); empty = cookie or no authentication. */
  controlPassword: string;
  /** Port of the onion address: 80 gives http://<address>.onion/. */
  onionPort: number;
  /**
   * Outgoing requests through Tor: off; onion = only to .onion addresses (other nodes that
   * are onion services); all = every request to other nodes and, on algorithm nodes, the crawler.
   * Payment checks and storage backends always connect directly.
   */
  outbound: TorMode;
  /** Tor's SOCKS address; empty = 127.0.0.1:9050 (or Tor Browser's 9150). */
  proxy: string;
}

export const DEFAULT_NODE_TOR: NodeTorConfig = {
  onionService: false,
  controlPort: '127.0.0.1:9051',
  controlPassword: '',
  onionPort: 80,
  outbound: 'onion',
  proxy: '',
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

export interface NodeOptions<C> {
  /** Where the node keeps its key, config, ledger and data; null keeps everything in memory. */
  dataDir: string | null;
  /** Config file (default <dataDir>/config.json). */
  configPath?: string;
  /** Overrides applied on top of the config file (command line flags, tests). */
  overrides?: DeepPartial<C>;
  adminToken?: string;
  /** Directory or embedded bundle of the web GUI (for /admin). */
  guiDir?: string | null;
}

export abstract class BaseNode<C extends BaseConfig> {
  readonly identity: Identity;
  readonly adminToken: string;
  readonly router = new Router();
  readonly ledger: Ledger;
  readonly auth: Auth;
  readonly payments: Payments;
  /** Bans, suspensions and rate limits for accounts, IPs and peers — shared with peers. */
  readonly moderation: Moderation;
  protected readonly configFile: JsonFile<C>;
  private overrides: DeepPartial<C>;
  private server: Server | null = null;
  /** Outgoing requests through Tor, as tor.outbound says. */
  readonly tor: TorRouter;
  private onion: OnionService | null = null;
  private onionKey: string | undefined;
  port = 0;

  constructor(
    readonly type: NodeType,
    private readonly defaults: C,
    protected readonly options: NodeOptions<C>
  ) {
    const dir = options.dataDir;
    if (dir) ensureDir(dir);
    this.identity = this.loadIdentity();
    this.adminToken = this.loadAdminToken();
    const configPath = options.configPath ?? (dir ? join(dir, 'config.json') : null);
    this.configFile = new JsonFile<C>(configPath, () => defaults);
    this.configFile.data = deepMerge(defaults, this.configFile.data);
    if (configPath && !existsSync(configPath)) this.configFile.flush();
    this.overrides = options.overrides ?? {};
    this.ledger = new Ledger(this.path('ledger.json'), this.path('ledger-audit.jsonl'));
    this.auth = new Auth(this.ledger, () => this.identity.id, () => this.config.signup);
    this.moderation = new Moderation(this.path('moderation.json'));
    this.payments = new Payments(this.path('payments.json'), this.ledger, () => this.config.payments);
    this.tor = new TorRouter(() => ({ mode: this.config.tor.outbound, proxy: this.config.tor.proxy }));
  }

  /** How to send a request to a URL: through Tor when tor.outbound says so (undefined: directly). */
  transport(url: string): Transport | undefined {
    return this.tor.routes(url) || isOnionUrl(url) ? { fetch: this.tor.fetch, timeoutFactor: 4 } : undefined;
  }

  /** The node's onion address (http://….onion), once Tor has published it. */
  onionUrl(): string | undefined {
    const address = this.onion?.address;
    if (!address) return undefined;
    const port = this.config.tor.onionPort;
    return `http://${address}${port === 80 ? '' : `:${port}`}`;
  }

  /** Starts or stops the onion service to match the config. */
  private async applyTor(): Promise<void> {
    const tor = this.config.tor;
    if (!tor.onionService) {
      this.onion?.stop();
      this.onion = null;
      return;
    }
    if (this.onion || !this.server) return;
    const keyFile = this.path('onion-key');
    const host = this.config.host;
    this.onion = new OnionService({
      controlPort: tor.controlPort,
      password: tor.controlPassword || undefined,
      virtualPort: tor.onionPort,
      target: { host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, port: this.port },
      loadKey: () => (keyFile && existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : this.onionKey),
      saveKey: (key) => {
        this.onionKey = key;
        if (keyFile) writeFileSync(keyFile, key + '\n', { mode: 0o600 });
      },
      onReady: () => log.info(`${this.type} node published as a Tor onion service: ${this.onionUrl()}`),
    });
    try {
      await this.onion.start();
    } catch (error) {
      log.warn(`Could not publish the onion service (trying again every 30 s): ${(error as Error).message}`);
    }
  }

  /** The config file merged with command line overrides. */
  get config(): C {
    return deepMerge(this.configFile.data, this.overrides);
  }

  protected path(name: string): string | null {
    return this.options.dataDir ? join(this.options.dataDir, name) : null;
  }

  private loadIdentity(): Identity {
    const file = this.path('identity.json');
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { seed: string };
      return identityFromSeed(fromBase64url(saved.seed));
    }
    const identity = generateIdentity();
    if (file) writeFileSync(file, JSON.stringify({ seed: base64url(identity.seed), id: identity.id }), { mode: 0o600 });
    return identity;
  }

  private loadAdminToken(): string {
    if (this.options.adminToken) return this.options.adminToken;
    if (process.env.VIBESHARE_ADMIN_TOKEN) return process.env.VIBESHARE_ADMIN_TOKEN;
    const file = this.path('admin-token');
    if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
    const token = randomToken(24);
    if (file) writeFileSync(file, token + '\n', { mode: 0o600 });
    return token;
  }

  /** The address clients get (references, node info): the public URL, else the onion address, else url(). */
  sharedUrl(): string {
    const config = this.config;
    if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
    return this.onionUrl() ?? this.url();
  }

  /** Where the node answers: its public URL, or the address it listens on. */
  url(): string {
    const config = this.config;
    if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
    const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.port || config.port}`;
  }

  reference(): string {
    return formatNodeRef({ type: this.type, id: this.identity.id, url: this.sharedUrl() });
  }

  protected abstract extraInfo(): Partial<NodeInfo>;
  protected abstract registerRoutes(): void;
  /** Checked before a config patch from the admin API is saved. */
  protected validateConfig(_config: C): void {}

  info(): NodeInfo {
    const config = this.config;
    const base: NodeInfoBase = {
      v: PROTOCOL_VERSION,
      type: this.type,
      id: this.identity.id,
      name: config.name,
      description: config.description,
      software: SOFTWARE,
      time: new Date().toISOString(),
      url: this.sharedUrl(),
      onion: this.onionUrl(),
      contact: config.contact,
      terms: config.terms,
      signup: { grant: config.signup.grant, powBits: config.signup.powBits, anonymous: config.signup.anonymous },
      payments: this.payments.info(),
      peers: config.peers.filter((peer) => parseNodeRef(peer)),
    };
    return { ...base, ...this.extraInfo() } as NodeInfo;
  }

  signedInfo(): SignedInfo {
    const info = this.info();
    return { info, sig: signData(this.identity, infoSigningPayload(canonicalJson(info))) };
  }

  requireAdmin(ctx: Ctx): void {
    const header = ctx.req.headers.authorization ?? '';
    const token = String(ctx.req.headers['x-admin-token'] ?? (header.startsWith('Bearer ') ? header.slice(7) : ''));
    if (!token || !safeEqual(token.trim(), this.adminToken)) throw forbidden('Admin token required');
  }

  private baseRoutes(): void {
    const router = this.router;
    router.get('/v1/info', () => this.signedInfo());
    this.auth.routes(router);
    router.get('/v1/account', (ctx) => {
      const account = this.auth.require(ctx);
      return { account: this.ledger.view(account), history: account.recent };
    });
    this.payments.routes(router, this.auth, (ctx) => this.requireAdmin(ctx));

    router.get('/v1/admin/status', (ctx) => {
      this.requireAdmin(ctx);
      const accounts = this.ledger.all();
      return {
        reference: this.reference(),
        info: this.info(),
        accounts: accounts.length,
        credits: {
          outstanding: accounts.reduce((sum, account) => sum + account.balance, 0),
          earned: accounts.reduce((sum, account) => sum + account.earned, 0),
          spent: accounts.reduce((sum, account) => sum + account.spent, 0),
        },
        ...this.adminStatus(),
      };
    });
    router.get('/v1/admin/config', (ctx) => {
      this.requireAdmin(ctx);
      return this.configFile.data;
    });
    router.put('/v1/admin/config', async (ctx) => {
      this.requireAdmin(ctx);
      const patch = await readJson(ctx.req);
      // ?replace=1 takes the body as the whole config (missing keys fall back to defaults).
      const next = ctx.query.get('replace') === '1' ? deepMerge(this.defaults, patch) : deepMerge(this.configFile.data, patch);
      this.validateConfig(next);
      for (const method of next.payments) {
        if (!method.id || !method.type) throw badRequest('Every payment method needs an id and a type');
      }
      this.configFile.data = next;
      this.configFile.changed();
      void this.applyTor();
      return next;
    });
    router.get('/v1/admin/accounts', (ctx) => {
      this.requireAdmin(ctx);
      const q = (ctx.query.get('q') ?? '').toLowerCase();
      const accounts = this.ledger
        .all()
        .filter((account) => !q || account.id.toLowerCase().includes(q) || account.note?.toLowerCase().includes(q))
        .sort((a, b) => (b.lastSeen ?? b.createdAt).localeCompare(a.lastSeen ?? a.createdAt))
        .slice(0, 500)
        .map((account) => ({ ...this.ledger.view(account), lastSeen: account.lastSeen, note: account.note }));
      return { accounts };
    });
    router.get('/v1/admin/accounts/:id', (ctx) => {
      this.requireAdmin(ctx);
      const account = this.ledger.require(ctx.params.id);
      return { account: { ...this.ledger.view(account), note: account.note }, history: account.recent };
    });
    router.post('/v1/admin/accounts/:id/adjust', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ amount?: number; reason?: string }>(ctx.req);
      const amount = Math.trunc(Number(body.amount));
      if (!amount) throw badRequest('amount must be a non-zero number');
      const reason = body.reason?.slice(0, 200) || 'adjusted by operator';
      const account =
        amount > 0 ? this.ledger.credit(ctx.params.id, amount, reason) : this.ledger.debit(ctx.params.id, -amount, reason);
      return this.ledger.view(account);
    });
    router.post('/v1/admin/accounts/:id/note', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ note?: string }>(ctx.req);
      this.ledger.setNote(ctx.params.id, String(body.note ?? '').slice(0, 500));
      return { ok: true };
    });

    // ---- moderation: bans, suspensions and rate limits (accounts, IPs and peers)
    router.get('/v1/admin/moderation', (ctx) => {
      this.requireAdmin(ctx);
      return { entries: this.moderation.list() };
    });
    router.post('/v1/admin/moderation', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ subject?: string; target?: string; action?: string; until?: string; perMinute?: number; reason?: string }>(ctx.req);
      const entry = this.moderation.add({
        subject: body.subject as never,
        target: String(body.target ?? ''),
        action: body.action as never,
        until: body.until,
        perMinute: body.perMinute,
        reason: body.reason,
      });
      // A new ban travels: peers pick it up at once instead of at the next sync round.
      void this.syncModeration();
      return { entry };
    });
    router.delete('/v1/admin/moderation/:id', (ctx) => {
      this.requireAdmin(ctx);
      if (!this.moderation.remove(ctx.params.id)) throw notFound('No such moderation entry');
      return { ok: true };
    });
    router.post('/v1/admin/moderation/sync', async (ctx) => {
      this.requireAdmin(ctx);
      return this.syncModeration();
    });

    // ---- moderation between peers: what this node has, and what it takes in
    const peerCaller = (ctx: Ctx): string => {
      const account = this.auth.require(ctx);
      const peers = this.moderationPeers();
      if (!peers.some((ref) => parseNodeRef(ref)?.id === account.id)) throw forbidden('Not a peer of this node');
      return account.id;
    };
    router.get('/v1/peers/moderation', (ctx) => {
      peerCaller(ctx);
      return { entries: this.moderation.export() };
    });
    router.post('/v1/peers/moderation', async (ctx) => {
      const from = peerCaller(ctx);
      const body = await readJson<{ entries?: unknown[] }>(ctx.req);
      // The answer carries this node's list back: one round is a two-way exchange.
      return { accepted: this.moderation.merge(body.entries ?? [], from), entries: this.moderation.export() };
    });
  }

  /** Peers this node exchanges moderation entries with (node references). */
  protected moderationPeers(): string[] {
    return [];
  }

  /** Two-way moderation exchange with every peer: what they banned, what we banned. */
  async syncModeration(): Promise<{ peers: number; accepted: number }> {
    const { NodeClient } = await import('../shared/nodeclient.js');
    let peers = 0;
    let accepted = 0;
    for (const ref of this.moderationPeers()) {
      const parsed = parseNodeRef(ref);
      if (!parsed) continue;
      try {
        const client = new NodeClient({
          url: parsed.url,
          expectedId: parsed.id,
          expectedType: parsed.type,
          auth: 'identity',
          identity: this.identity,
          transport: () => this.transport(parsed.url),
        });
        const answer = await client.json<{ entries?: unknown[]; accepted?: number }>('/v1/peers/moderation', {
          method: 'POST',
          body: { entries: this.moderation.export() },
          timeoutMs: 15_000,
        });
        accepted += this.moderation.merge(answer.entries ?? [], parsed.id);
        peers++;
      } catch (error) {
        log.debug(`Moderation sync with ${parsed.id.slice(0, 12)}: ${(error as Error).message}`);
      }
    }
    return { peers, accepted };
  }

  protected adminStatus(): Record<string, unknown> {
    return {};
  }

  private landingPage(): string {
    const info = this.info();
    const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const reference = this.reference();
    const payments = info.payments.map((method) => `<li>${escape(method.label)}</li>`).join('') || '<li>None</li>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(info.name)}</title><style>
:root{color-scheme:light dark;--bg:#f6f7fb;--fg:#15171c;--card:#fff;--muted:#5b6170;--accent:#6b4eff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaf0;--card:#181b22;--muted:#9aa1b2}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center;padding:48px 16px}
main{max-width:720px;width:100%}.card{background:var(--card);border-radius:14px;padding:24px;margin:16px 0;box-shadow:0 1px 3px #0002}
code{display:block;word-break:break-all;padding:12px;border-radius:8px;background:var(--bg);font-size:13px}
button,a.button{margin-top:12px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
.muted{color:var(--muted)}</style></head><body><main>
<p class="muted">VibeShare ${escape(this.type === 'provider' ? 'content provider' : 'search algorithm')} node</p>
<h1>${escape(info.name)}</h1><p>${escape(info.description)}</p>
<div class="card"><strong>Node reference</strong><p class="muted">Paste it into the VibeShare client (Nodes → Add node).</p>
<code id="ref">${escape(reference)}</code><button onclick="navigator.clipboard.writeText(document.getElementById('ref').textContent)">Copy reference</button></div>
<div class="card"><strong>Credits</strong><p>New accounts get ${info.signup.grant} credits.</p><strong>Payment methods</strong><ul>${payments}</ul></div>
<p><a class="button" href="/admin">Operator dashboard</a></p></main></body></html>`;
  }

  async start(): Promise<void> {
    this.baseRoutes();
    this.registerRoutes();
    const guiDir = this.options.guiDir;
    this.server = createHttpServer({
      router: this.router,
      cors: true,
      trustProxy: this.config.trustProxy,
      name: this.type,
      // Bans, suspensions and rate limits apply to every request before routing — the
      // admin itself is never locked out (it is how bans get lifted again).
      guard: (ctx) => {
        const header = ctx.req.headers.authorization ?? '';
        const token = String(ctx.req.headers['x-admin-token'] ?? (header.startsWith('Bearer ') ? header.slice(7) : ''));
        if (token && safeEqual(token.trim(), this.adminToken)) return;
        this.moderation.enforce({ ip: ctx.ip, account: this.auth.peek(ctx)?.id });
      },
      fallback: async (ctx) => {
        if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
        if (ctx.url.pathname === '/') {
          const html = this.landingPage();
          ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
          return true;
        }
        if (ctx.url.pathname === '/admin' || ctx.url.pathname === '/favicon.svg' || ctx.url.pathname.startsWith('/assets/')) {
          const path = ctx.url.pathname === '/admin' ? 'admin.html' : ctx.url.pathname.slice(1);
          return serveStatic(ctx, guiDir ?? null, path);
        }
        return false;
      },
    });
    this.port = await listen(this.server, this.config.port, this.config.host);
    log.info(`${this.type} node "${this.config.name}" listening on ${this.config.host}:${this.port}`);
    await this.applyTor();
  }

  async stop(): Promise<void> {
    this.onion?.stop();
    this.onion = null;
    if (this.server) await closeServer(this.server);
    this.server = null;
    this.flush();
  }

  flush(): void {
    this.configFile.flush();
    this.ledger.flush();
    this.payments.flush();
  }
}
