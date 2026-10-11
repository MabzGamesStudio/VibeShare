import { isAbsolute } from 'node:path';
import { BaseNode, type BaseConfig, type NodeOptions } from '../commerce/node.js';
import type { Account } from '../commerce/ledger.js';
import { buildManifestFromFile, contentIdOf, mimeFromName, MiB, validateManifest, type Manifest } from '../shared/content.js';
import {
  badRequest,
  forbidden,
  HttpError,
  notFound,
  readBody,
  readJson,
  unauthorized,
  type Ctx,
} from '../shared/http.js';
import { log } from '../shared/log.js';
import { NodeClient } from '../shared/nodeclient.js';
import { parseNodeRef } from '../shared/noderef.js';
import type { ProviderInfo, ProviderPricing, StorageRewards } from '../shared/protocol.js';
import { isChunkId, isNativeId } from '../shared/sources.js';
import { JsonFile } from '../shared/store.js';
import { RemoteError } from '../shared/http.js';
import { StorageService, type StorageServiceConfig } from './service.js';
import { ContentStore } from './store.js';
import {
  HttpBackend,
  IpfsBackend,
  LocalBackend,
  MemoryBackend,
  ProviderBackend,
  S3Backend,
  WebDavBackend,
  type BackendConfig,
  type BlobBackend,
} from './storage/backends.js';
import { basename } from 'node:path';

export interface ProviderConfig extends BaseConfig {
  pricing: ProviderPricing & {
    /** Per-content price per MiB, by content id (e.g. premium or free content). */
    overrides: Record<string, number>;
  };
  storage: {
    backends: BackendConfig[];
    /** How many writable backends each chunk is written to. */
    replication: number;
    /** Memory cache for hot chunks, in MiB. */
    cacheMiB: number;
    /** Copy chunks read from read-only backends or peers into writable backends. */
    cacheFetched: boolean;
    /** Ask client nodes of the storage service for chunks no backend has. */
    usePeers: boolean;
  };
  /** Publish the list of hosted content at /v1/catalog (lets algorithm nodes discover it). */
  catalog: boolean;
  storageService: StorageServiceConfig;
}

export function providerDefaults(): ProviderConfig {
  return {
    name: 'VibeShare provider',
    description: 'A VibeShare content provider node.',
    host: '0.0.0.0',
    port: 7701,
    trustProxy: false,
    signup: { grant: 500, powBits: 0, anonymous: true, perIpPerHour: 30 },
    payments: [{ id: 'voucher', type: 'voucher' }],
    peers: [],
    pricing: {
      manifest: 0,
      perMiB: 1,
      freeMiBPerDay: 100,
      creatorShare: 0.2,
      upload: { mode: 'open', perMiB: 0, maxBytes: 4 * 1024 * MiB },
      overrides: {},
    },
    storage: {
      backends: [{ id: 'local', type: 'local', path: 'blobs' }],
      replication: 1,
      cacheMiB: 128,
      cacheFetched: true,
      usePeers: true,
    },
    catalog: true,
    storageService: {
      enabled: true,
      challengeIntervalSeconds: 900,
      minPassRatio: 0.8,
      offlineGraceSeconds: 120,
      taskTimeoutSeconds: 30,
      auto: {
        enabled: false,
        replicas: 2,
        durationDays: 30,
        rewards: { upfront: 5, perRetrieval: 1, perChallenge: 1, completion: 20 },
        requireIdentity: false,
      },
    },
  };
}

interface PendingUpload {
  manifest: Manifest;
  uploader: string;
  createdAt: number;
}

const UPLOAD_TTL_MS = 24 * 3600_000;

export class ProviderNode extends BaseNode<ProviderConfig> {
  readonly store: ContentStore;
  readonly service: StorageService;
  private uploads: JsonFile<{ uploads: Record<string, PendingUpload> }>;
  private backendCache: { key: string; list: BlobBackend[] } = { key: '', list: [] };
  private gcTimer: NodeJS.Timeout;

  constructor(options: NodeOptions<ProviderConfig>) {
    super('provider', providerDefaults(), options);
    this.uploads = new JsonFile(this.path('uploads.json'), () => ({ uploads: {} }));
    this.service = new StorageService(
      this.path('storage-service.json'),
      this.ledger,
      () => this.config.storageService,
      (id, options) => this.store.getChunk(id, options)
    );
    this.store = new ContentStore({
      indexPath: this.path('content-index.json'),
      backends: () => this.backends(),
      priorities: () => Object.fromEntries(this.config.storage.backends.map((b) => [b.id, b.priority ?? 10])),
      replication: () => this.config.storage.replication,
      cacheBytes: this.config.storage.cacheMiB * MiB,
      peerFallback: (id) => (this.config.storage.usePeers ? this.service.retrieve(id) : Promise.resolve(null)),
      cacheFetched: () => this.config.storage.cacheFetched,
    });
    this.gcTimer = setInterval(() => void this.collectGarbage(), 15 * 60_000);
    this.gcTimer.unref();
  }

  backends(): BlobBackend[] {
    const configs = this.config.storage.backends;
    const key = JSON.stringify(configs);
    if (key === this.backendCache.key) return this.backendCache.list;
    const list: BlobBackend[] = [];
    for (const config of configs) {
      try {
        list.push(this.createBackend(config));
      } catch (error) {
        log.error(`Storage backend ${config.id}: ${(error as Error).message}`);
      }
    }
    this.backendCache = { key, list };
    return list;
  }

  private createBackend(config: BackendConfig): BlobBackend {
    switch (config.type) {
      case 'memory':
        return new MemoryBackend(config.id, config);
      case 'local':
        if (!this.options.dataDir && !isAbsolute(config.path)) return new MemoryBackend(config.id, config);
        return new LocalBackend(config.id, config, this.options.dataDir);
      case 's3':
        return new S3Backend(config.id, config);
      case 'webdav':
        return new WebDavBackend(config.id, config);
      case 'ipfs':
        return new IpfsBackend(config.id, config);
      case 'http':
        return new HttpBackend(config.id, config);
      case 'provider': {
        const ref = parseNodeRef(config.ref);
        if (!ref) throw new Error(`Bad node reference ${config.ref}`);
        const client = new NodeClient({ url: ref.url, expectedId: ref.id, expectedType: 'provider', auth: 'identity', identity: this.identity });
        return new ProviderBackend(
          config.id,
          async (key) => {
            try {
              const path = key.startsWith('m-') ? `/v1/content/${key.slice(2)}` : `/v1/chunks/${key}`;
              const response = await client.fetch(path, { timeoutMs: 30000 });
              return Buffer.from(await response.arrayBuffer());
            } catch (error) {
              if (error instanceof RemoteError && error.status === 404) return null;
              throw error;
            }
          },
          async () => {
            try {
              const info = await client.fetchInfo();
              const account = await client.json<{ account: { balance: number } }>('/v1/account');
              return { ok: true, detail: `${info.name} (balance ${account.account.balance})` };
            } catch (error) {
              return { ok: false, detail: (error as Error).message };
            }
          }
        );
      }
    }
  }

  protected extraInfo(): Partial<ProviderInfo> {
    const { overrides: _overrides, ...pricing } = this.config.pricing;
    const stats = this.store.stats();
    return {
      type: 'provider',
      pricing,
      services: { storage: { enabled: this.config.storageService.enabled, openJobs: this.service.openJobCount() } },
      stats: { contents: stats.contents, bytes: stats.bytes },
    };
  }

  protected validateConfig(config: ProviderConfig): void {
    const ids = new Set<string>();
    for (const backend of config.storage.backends) {
      if (!backend.id || ids.has(backend.id)) throw badRequest('Storage backends need unique ids');
      ids.add(backend.id);
    }
    if (config.pricing.creatorShare < 0 || config.pricing.creatorShare > 1) throw badRequest('creatorShare is between 0 and 1');
  }

  // -------------------------------------------------------------------------
  // Pricing

  private perMiB(cid?: string): number {
    const pricing = this.config.pricing;
    if (cid && cid in pricing.overrides) return pricing.overrides[cid];
    return pricing.perMiB;
  }

  chunkPrice(size: number, cid?: string): number {
    return Math.ceil((size * this.perMiB(cid)) / MiB);
  }

  /** Charges an account for `bytes` of `cid`, using its free daily allowance first. */
  private charge(account: Account | undefined, bytes: number, cid: string | undefined, reason: string): { charged: number; balance?: number } {
    const price = this.chunkPrice(bytes, cid);
    if (price <= 0) return { charged: 0, balance: account?.balance };
    if (!account) throw unauthorized('An account is needed to download from this node');
    const allowance = this.config.pricing.freeMiBPerDay * MiB;
    const used = this.ledger.daily(account, 'freeBytes');
    if (used + bytes <= allowance) {
      this.ledger.addDaily(account, 'freeBytes', bytes);
      return { charged: 0, balance: account.balance };
    }
    this.ledger.debit(account.id, price, reason, cid);
    const content = cid ? this.store.getContent(cid) : undefined;
    const share = Math.floor(price * this.config.pricing.creatorShare);
    if (content && share > 0 && content.uploader !== 'operator' && content.uploader !== account.id && this.ledger.get(content.uploader)) {
      this.ledger.credit(content.uploader, share, 'creator share', cid);
    }
    return { charged: price, balance: this.ledger.get(account.id)?.balance };
  }

  // -------------------------------------------------------------------------
  // Routes

  private uploaderFor(ctx: Ctx): string {
    if (ctx.req.headers['x-admin-token']) {
      this.requireAdmin(ctx);
      return 'operator';
    }
    const account = this.auth.require(ctx);
    if (this.config.pricing.upload.mode === 'closed') throw forbidden('This node does not accept uploads');
    return account.id;
  }

  private pendingUpload(ctx: Ctx, cid: string): PendingUpload {
    const upload = this.uploads.data.uploads[cid];
    if (!upload || Date.now() - upload.createdAt > UPLOAD_TTL_MS) throw notFound('No pending upload for this content');
    if (upload.uploader !== this.uploaderFor(ctx)) throw forbidden('This upload belongs to another account');
    return upload;
  }

  private async getManifest(cid: string): Promise<Manifest | undefined> {
    const manifest = this.store.getManifest(cid);
    if (manifest || !isNativeId(cid)) return manifest;
    const recovered = await this.store.recoverManifest(cid);
    if (recovered) this.store.adopt(recovered, 'operator');
    return recovered;
  }

  protected registerRoutes(): void {
    const router = this.router;

    router.get('/v1/content/:cid', async (ctx) => {
      const cid = ctx.params.cid;
      const manifest = await this.getManifest(cid);
      if (!manifest) throw notFound('This node does not have the content');
      if (ctx.req.method === 'HEAD') {
        ctx.res.writeHead(200, { 'content-type': 'application/json' }).end();
        return;
      }
      const price = this.config.pricing.manifest;
      if (price > 0) {
        const account = this.auth.require(ctx);
        this.ledger.debit(account.id, price, 'manifest', cid);
      }
      return manifest;
    });

    router.post('/v1/has', async (ctx) => {
      const body = await readJson<{ ids?: string[] }>(ctx.req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
      return { has: Object.fromEntries(ids.map((id) => [id, Boolean(this.store.getContent(String(id)))])) };
    });

    router.get('/v1/quote/:cid', (ctx) => {
      const cid = ctx.params.cid;
      const content = this.store.getContent(cid);
      if (!content) throw notFound('This node does not have the content');
      const account = this.auth.account(ctx);
      const freeLeft = account
        ? Math.max(0, this.config.pricing.freeMiBPerDay * MiB - this.ledger.daily(account, 'freeBytes'))
        : this.config.pricing.freeMiBPerDay * MiB;
      return {
        cid,
        size: content.size,
        perMiB: this.perMiB(cid),
        manifest: this.config.pricing.manifest,
        total: this.config.pricing.manifest + this.chunkPrice(content.size, cid),
        freeBytesLeft: freeLeft,
        balance: account?.balance,
      };
    });

    router.get('/v1/chunks/:id', async (ctx) => {
      const id = ctx.params.id;
      if (!isChunkId(id)) throw badRequest('Not a chunk id');
      const cid = ctx.query.get('cid') ?? undefined;
      const record = this.store.chunkRecord(id);
      if (!record) throw notFound('This node does not have the chunk');
      const account = this.auth.account(ctx);
      // Check the price before reading, so an account without credits costs no backend traffic.
      const price = this.chunkPrice(record.size, cid);
      if (price > 0 && !account) throw unauthorized('An account is needed to download from this node');
      const data = await this.store.getChunk(id);
      if (!data) throw new HttpError(503, 'unavailable', 'The chunk is stored but no backend can read it right now');
      if (ctx.req.method === 'HEAD') {
        ctx.res.writeHead(200, { 'content-length': data.length, 'x-vs-price': String(price) }).end();
        return;
      }
      const { charged, balance } = this.charge(account, data.length, cid, 'download');
      if (cid) {
        const manifest = this.store.getManifest(cid);
        this.store.recordServed(cid, data.length, charged, manifest?.chunks[0]?.id === id);
      }
      ctx.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'x-vs-charged': String(charged),
        ...(balance !== undefined ? { 'x-vs-balance': String(balance) } : {}),
      });
      ctx.res.end(data);
    });

    // Uploads: announce the manifest, send the chunks the node is missing, then commit.
    router.post('/v1/uploads', async (ctx) => {
      const uploader = this.uploaderFor(ctx);
      const body = await readJson<{ manifest?: unknown }>(ctx.req, 64 * MiB);
      const manifest = validateManifest(body.manifest);
      const upload = this.config.pricing.upload;
      if (uploader !== 'operator' && manifest.size > upload.maxBytes) {
        throw new HttpError(413, 'too_large', `This node accepts uploads up to ${Math.floor(upload.maxBytes / MiB)} MiB`);
      }
      const cid = contentIdOf(manifest);
      const cost = uploader === 'operator' || upload.mode !== 'paid' ? 0 : Math.ceil((manifest.size / MiB) * upload.perMiB);
      if (this.store.getContent(cid)) return { cid, status: 'ready', missing: [], cost: 0 };
      if (cost > 0 && (this.ledger.get(uploader)?.balance ?? 0) < cost) {
        throw new HttpError(402, 'payment_required', `Uploading costs ${cost} credits`, { price: cost });
      }
      this.uploads.data.uploads[cid] = { manifest, uploader, createdAt: Date.now() };
      this.uploads.changed();
      const missing = [...new Set(manifest.chunks.map((chunk) => chunk.id))].filter((id) => !this.store.hasChunk(id));
      return { cid, status: 'pending', missing, cost };
    });

    router.put('/v1/uploads/:cid/chunks/:chunkId', async (ctx) => {
      const upload = this.pendingUpload(ctx, ctx.params.cid);
      const chunkId = ctx.params.chunkId;
      if (!upload.manifest.chunks.some((chunk) => chunk.id === chunkId)) throw badRequest('The chunk is not part of this upload');
      const data = await readBody(ctx.req, upload.manifest.chunkSize);
      try {
        await this.store.putChunk(chunkId, data);
      } catch (error) {
        throw badRequest((error as Error).message);
      }
      return { ok: true };
    });

    router.post('/v1/uploads/:cid/commit', async (ctx) => {
      const cid = ctx.params.cid;
      if (this.store.getContent(cid)) return { cid, status: 'ready' };
      const upload = this.pendingUpload(ctx, cid);
      const missing = upload.manifest.chunks.filter((chunk) => !this.store.hasChunk(chunk.id)).map((chunk) => chunk.id);
      if (missing.length) throw new HttpError(409, 'incomplete', `${missing.length} chunks are still missing`, { missing });
      const settings = this.config.pricing.upload;
      if (upload.uploader !== 'operator' && settings.mode === 'paid') {
        const cost = Math.ceil((upload.manifest.size / MiB) * settings.perMiB);
        if (cost > 0) this.ledger.debit(upload.uploader, cost, 'upload', cid);
      }
      await this.store.addContent(upload.manifest, upload.uploader);
      delete this.uploads.data.uploads[cid];
      this.uploads.changed();
      this.autoJob(cid, upload.manifest);
      log.info(`Stored ${upload.manifest.name} (${cid.slice(0, 16)}…, ${(upload.manifest.size / MiB).toFixed(1)} MiB)`);
      return { cid, status: 'ready' };
    });

    router.get('/v1/catalog', (ctx) => {
      if (!this.config.catalog) throw forbidden('This node does not publish its catalog');
      const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0));
      const limit = Math.min(200, Math.max(1, Number(ctx.query.get('limit') ?? 50)));
      const items = this.store.list(offset, limit).map((record) => {
        const manifest = this.store.getManifest(record.cid);
        return {
          cid: record.cid,
          name: record.name,
          mime: record.mime,
          size: record.size,
          createdAt: record.createdAt,
          meta: manifest?.meta,
          creator: manifest?.creator ? { id: manifest.creator.id, name: manifest.creator.name, kind: manifest.creator.kind } : undefined,
          sources: manifest?.sources,
        };
      });
      return { items, next: items.length === limit ? offset + limit : undefined };
    });

    this.serviceRoutes();
    this.adminRoutes();
  }

  private autoJob(cid: string, manifest: Manifest): void {
    const auto = this.config.storageService.auto;
    if (!this.config.storageService.enabled || !auto.enabled) return;
    this.service.createJob({
      cid,
      title: manifest.meta?.title ?? manifest.name,
      chunks: manifest.chunks,
      replicas: auto.replicas,
      durationSeconds: auto.durationDays * 86400,
      rewards: auto.rewards,
      requireIdentity: auto.requireIdentity,
    });
  }

  private serviceRoutes(): void {
    const router = this.router;
    const base = '/v1/services/storage';
    router.get(`${base}/offers`, (ctx) => ({ offers: this.service.offers(this.auth.require(ctx)) }));
    router.post(`${base}/offers/:jobId/accept`, (ctx) => this.service.accept(this.auth.require(ctx), ctx.params.jobId));
    router.get(`${base}/assignments`, (ctx) => ({ assignments: this.service.mine(this.auth.require(ctx)) }));
    router.get(`${base}/assignments/:id/chunks/:chunkId`, async (ctx) => {
      const data = await this.service.assignmentChunk(this.auth.require(ctx), ctx.params.id, ctx.params.chunkId);
      ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
    });
    router.post(`${base}/assignments/:id/ready`, (ctx) => this.service.ready(this.auth.require(ctx), ctx.params.id));
    router.post(`${base}/assignments/:id/release`, (ctx) => this.service.release(this.auth.require(ctx), ctx.params.id));
    router.get(`${base}/tasks`, async (ctx) => {
      const account = this.auth.require(ctx);
      const wait = Math.max(0, Math.min(30, Number(ctx.query.get('wait') ?? 0)));
      return { tasks: await this.service.poll(account, wait) };
    });
    router.post(`${base}/tasks/:id`, async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readBody(ctx.req, 9 * MiB);
      const result = await this.service.answer(account, ctx.params.id, body);
      return { ...result, balance: this.ledger.get(account.id)?.balance };
    });
  }

  private adminRoutes(): void {
    const router = this.router;
    router.get('/v1/admin/content', (ctx) => {
      this.requireAdmin(ctx);
      const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0));
      const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') ?? 100)));
      return { items: this.store.list(offset, limit), stats: this.store.stats() };
    });
    router.delete('/v1/admin/content/:cid', async (ctx) => {
      this.requireAdmin(ctx);
      if (!(await this.store.deleteContent(ctx.params.cid))) throw notFound('No such content');
      return { ok: true };
    });
    router.post('/v1/admin/content/import', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ path?: string; name?: string; mime?: string; meta?: Manifest['meta']; sources?: string[] }>(ctx.req);
      if (!body.path) throw badRequest('path is required');
      return this.importFile(body.path, body);
    });
    router.post('/v1/admin/content/:cid/price', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ perMiB?: number | null }>(ctx.req);
      const overrides = { ...this.configFile.data.pricing.overrides };
      if (body.perMiB === null || body.perMiB === undefined) delete overrides[ctx.params.cid];
      else overrides[ctx.params.cid] = Math.max(0, Number(body.perMiB));
      this.configFile.data.pricing.overrides = overrides;
      this.configFile.changed();
      return { overrides };
    });
    router.get('/v1/admin/storage/backends', async (ctx) => {
      this.requireAdmin(ctx);
      const priorities = Object.fromEntries(this.config.storage.backends.map((b) => [b.id, b.priority ?? 10]));
      const backends = await Promise.all(
        this.backends().map(async (backend) => ({
          id: backend.id,
          type: backend.type,
          writable: backend.writable,
          priority: priorities[backend.id] ?? 10,
          status: await backend.check(),
        }))
      );
      return { backends, replication: this.config.storage.replication };
    });
    router.get('/v1/admin/storage/jobs', (ctx) => {
      this.requireAdmin(ctx);
      return { jobs: this.service.jobs(), stats: this.service.stats() };
    });
    router.post('/v1/admin/storage/jobs', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{
        cid?: string;
        replicas?: number;
        durationDays?: number;
        rewards?: Partial<StorageRewards>;
        requireIdentity?: boolean;
        openUntil?: string;
      }>(ctx.req);
      const manifest = body.cid ? this.store.getManifest(body.cid) : undefined;
      if (!manifest) throw notFound('No such content on this node');
      return this.service.createJob({
        cid: body.cid,
        title: manifest.meta?.title ?? manifest.name,
        chunks: manifest.chunks,
        replicas: body.replicas,
        durationSeconds: body.durationDays ? body.durationDays * 86400 : undefined,
        rewards: body.rewards,
        requireIdentity: body.requireIdentity,
        openUntil: body.openUntil,
      });
    });
    router.post('/v1/admin/storage/jobs/:id/close', (ctx) => {
      this.requireAdmin(ctx);
      this.service.closeJob(ctx.params.id);
      return { ok: true };
    });
    router.get('/v1/admin/storage/assignments', (ctx) => {
      this.requireAdmin(ctx);
      return { assignments: this.service.assignmentsForAdmin().slice(0, 500) };
    });
  }

  /** Adds a file from this machine's disk as operator content. */
  async importFile(
    path: string,
    options: { name?: string; mime?: string; meta?: Manifest['meta']; sources?: string[] } = {}
  ): Promise<{ cid: string; manifest: Manifest }> {
    const name = options.name ?? basename(path);
    const manifest = await buildManifestFromFile(
      path,
      { name, mime: options.mime ?? mimeFromName(name), meta: options.meta, sources: options.sources },
      (id, data) => this.store.putChunk(id, data)
    );
    validateManifest(manifest);
    const record = await this.store.addContent(manifest, 'operator');
    this.autoJob(record.cid, manifest);
    return { cid: record.cid, manifest };
  }

  /** Adds content from memory (used by the demo and tests). */
  async importBuffer(data: Buffer, options: { name: string; mime?: string; meta?: Manifest['meta']; sources?: string[] }) {
    const { buildManifestFromBuffer } = await import('../shared/content.js');
    const manifest = await buildManifestFromBuffer(
      data,
      { name: options.name, mime: options.mime ?? mimeFromName(options.name), meta: options.meta, sources: options.sources },
      (id, chunk) => this.store.putChunk(id, chunk)
    );
    const record = await this.store.addContent(manifest, 'operator');
    this.autoJob(record.cid, manifest);
    return { cid: record.cid, manifest };
  }

  private async collectGarbage(): Promise<void> {
    const keep = this.service.pinnedChunks();
    for (const [cid, upload] of Object.entries(this.uploads.data.uploads)) {
      if (Date.now() - upload.createdAt > UPLOAD_TTL_MS) {
        delete this.uploads.data.uploads[cid];
        this.uploads.changed();
      } else for (const chunk of upload.manifest.chunks) keep.add(chunk.id);
    }
    const removed = await this.store.collectGarbage(keep, UPLOAD_TTL_MS);
    if (removed) log.info(`Removed ${removed} chunks of abandoned uploads`);
  }

  protected adminStatus(): Record<string, unknown> {
    return { content: this.store.stats(), storageService: this.service.stats() };
  }

  async stop(): Promise<void> {
    clearInterval(this.gcTimer);
    this.service.stop();
    await super.stop();
  }

  flush(): void {
    super.flush();
    this.store.flush();
    this.uploads.flush();
    this.service.flush();
  }
}
