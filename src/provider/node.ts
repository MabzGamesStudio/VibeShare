import { isAbsolute } from 'node:path';
import { BaseNode, DEFAULT_NODE_TOR, type BaseConfig, type NodeOptions } from '../commerce/node.js';
import type { Account } from '../commerce/ledger.js';
import { chunkIdOf, contentIdOf, bytesCid, bytesMatchCid, mimeFromName, MiB, validateManifest, type Manifest } from '../shared/content.js';
import { buildManifestFromFile } from '../shared/contentfile.js';
import type { ContentLink, ContentUrlRecord, ContentUrlSubmission } from '../shared/protocol.js';
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
import type {
  ProviderInfo,
  ProviderPricing,
  ProviderRewards,
  ProviderSuggestion,
  ProviderSuggestionKind,
  ProviderSuggestionRequest,
  ProviderSuggestionResponse,
  ReportRequest,
  ReportResponse,
  SourceSuggestion,
  StorageRewards,
} from '../shared/protocol.js';
import { randomId } from '../shared/crypto.js';
import { baseId, isChunkId, isNativeId } from '../shared/sources.js';
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
import { convertVvsh, defaultVvshConfig, quoteVvsh, type VvshConvertPricing } from './vvsh.js';
import type { VvshBuildConfig } from '../shared/vvsh-encode.js';
import { decodeVvshChunk, decodeVvshFrames } from '../shared/vvsh-encode.js';
import type { VvshConvertQuote, VvshHash } from '../shared/vvsh.js';
import { parseVvshNode, pathToChunk } from '../shared/vvsh.js';
import { fromBase64url } from '../shared/encoding.js';

export interface ProviderConfig extends BaseConfig {
  pricing: ProviderPricing & {
    /** Per-content price per MiB, by content id (e.g. premium or free content). */
    overrides: Record<string, number>;
  };
  /** Credits the node pays for useful information from clients. */
  rewards: ProviderRewards;
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
  /** Exchanging content bytes with other content provider nodes. */
  peering: {
    /**
     * Peer content providers. `send`: this node serves or pushes chunks to the peer.
     * `receive`: this node fetches missing chunks from the peer and accepts its pushes.
     */
    peers: { ref: string; send: boolean; receive: boolean }[];
    /** Accept chunks a peer pushes here. */
    acceptPush: boolean;
    /** Automatic syncing of content bytes (chunks) with peers. */
    sync: {
      /** Run the sync job at all (otherwise sync from the dashboard). */
      enabled: boolean;
      /** How often a sync round runs (ms). */
      intervalMs: number;
      /** Rate limit: the most chunks shared (sent to peers) per minute. */
      sendRatePerMin: number;
      /** Rate limit: the most chunks received (from peers) per minute. */
      receiveRatePerMin: number;
    };
  };
  /**
   * Downloadable content copies that clients point here: a client gives a download URL
   * (and its cid) or a base URL, this node pulls content from it, and pays the client for
   * every download whose bytes hash to the cid exactly.
   */
  contentUrls: {
    /** Accept every URL a client submits (otherwise the operator reviews each one). */
    autoAccept: boolean;
    /** How many single content URLs to accept per client. */
    maxUrlsPerClient: number;
    /** How many base URLs to accept per client. */
    maxBaseUrlsPerClient: number;
    /** Credits to pay a client each time this node pulls content from their URL. */
    creditPerDownload: number;
  };
  /** Building .vvsh verifiable video streams from uploads, priced by size, chunks and encodings. */
  vvsh: {
    convert: VvshConvertPricing;
    /** Credits per MiB of a .vvsh chunk served (streaming/download pricing). */
    chunkPerMiB: number;
    /** What a client gets when it sends no configuration of its own. */
    defaults: { chunkSeconds: number; previewSplits: number; bitrates: { id: string; label: string; height?: number; kbps: number }[] };
  };
}

export function providerDefaults(): ProviderConfig {
  return {
    name: 'VibeShare provider',
    description: 'A VibeShare content provider node.',
    host: '0.0.0.0',
    port: 7701,
    trustProxy: false,
    tor: { ...DEFAULT_NODE_TOR },
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
    rewards: { report: 1, reportDailyCap: 100, suggestion: 1, suggestionDailyCap: 50 },
    peering: { peers: [], acceptPush: true, sync: { enabled: false, intervalMs: 3_600_000, sendRatePerMin: 120, receiveRatePerMin: 120 } },
    contentUrls: { autoAccept: true, maxUrlsPerClient: 16, maxBaseUrlsPerClient: 4, creditPerDownload: 2 },
    vvsh: { convert: { perMiB: 1, perChunk: 1, perRendition: 2, perPreview: 1 }, chunkPerMiB: 1, defaults: defaultVvshConfig() },
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

/** A suggestion with the same content and the same value as an earlier one is not new. */
function suggestionSignature(suggestion: { kind: string; sources?: SourceSuggestion[]; duplicateOf?: string; note?: string }): string {
  const sources = (suggestion.sources ?? [])
    .map((source) => `${source.platform}:${source.url}`)
    .sort()
    .join('\n');
  return [suggestion.kind, sources, suggestion.duplicateOf ?? '', suggestion.note ?? ''].join('\n');
}

const UPLOAD_TTL_MS = 24 * 3600_000;

export class ProviderNode extends BaseNode<ProviderConfig> {
  readonly store: ContentStore;
  readonly service: StorageService;
  private uploads: JsonFile<{ uploads: Record<string, PendingUpload> }>;
  /** Content ids clients reported; the node learns what is out there from them. */
  private reports: JsonFile<{ ids: Record<string, { at: string; account: string }> }>;
  /** Downloadable content copies clients point here (single URLs and base URLs). */
  private contentUrls: JsonFile<{ items: Record<string, ContentUrlRecord> }>;
  /** Verified bytes pulled from those links, keyed by their cid. */
  private downloads: JsonFile<{ items: Record<string, { data: string; account: string; at: string }> }>;
  /** What clients suggest this node is missing (sources, duplicates, absent data). */
  private suggestions: JsonFile<{ items: Record<string, ProviderSuggestion & { signature: string }> }>;
  private backendCache: { key: string; list: BlobBackend[] } = { key: '', list: [] };
  private gcTimer: NodeJS.Timeout;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(options: NodeOptions<ProviderConfig>) {
    super('provider', providerDefaults(), options);
    this.uploads = new JsonFile(this.path('uploads.json'), () => ({ uploads: {} }));
    this.reports = new JsonFile(this.path('reports.json'), () => ({ ids: {} }));
    this.contentUrls = new JsonFile(this.path('content-urls.json'), () => ({ items: {} }));
    this.downloads = new JsonFile(this.path('downloads.json'), () => ({ items: {} }));
    this.suggestions = new JsonFile(this.path('suggestions.json'), () => ({ items: {} }));
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
      chunkPeers: (id) => this.fetchFromPeers(id),
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
        const client = new NodeClient({
          url: ref.url,
          expectedId: ref.id,
          expectedType: 'provider',
          auth: 'identity',
          identity: this.identity,
          transport: () => this.transport(ref.url),
        });
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
      rewards: this.config.rewards,
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

  /** Running .vvsh conversions: the video arrives piece by piece, then the work runs. */
  private vvshConverts = new Map<
    string,
    {
      account: string;
      name: string;
      input: { bytes: number; totalSeconds: number; config: VvshBuildConfig };
      declared: number;
      meta?: Manifest['meta'];
      sourceMime?: string;
      previews?: string[];
      pieces: Buffer[];
      bytes: number;
      quote: VvshConvertQuote;
      at: number;
    }
  >();

  /** One conversion job's shape: the client's configuration over this node's defaults. */
  private vvshInput(body: { bytes?: number; totalSeconds?: number; config?: VvshBuildConfig }): {
    bytes: number;
    totalSeconds: number;
    config: VvshBuildConfig;
  } {
    const defaults = this.config.vvsh.defaults;
    return {
      bytes: Math.max(0, Number(body.bytes ?? 0)),
      totalSeconds: Math.max(0, Number(body.totalSeconds ?? 0)),
      config: {
        bitrates: body.config?.bitrates?.length ? body.config.bitrates : defaults.bitrates,
        chunkSeconds: body.config?.chunkSeconds || defaults.chunkSeconds,
        previewSplits: body.config?.previewSplits ?? defaults.previewSplits,
        gop: body.config?.gop,
      },
    };
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

  /** One byte range of one encoding's decoded stream, straight from this node's objects. */
  private async vvshRange(spec: { r: string; c: number; q: string; d: number }, start: number, end: number): Promise<Uint8Array> {
    const total = Math.max(0, spec.d);
    const from = Math.max(0, Math.min(start, total));
    const to = Math.max(from, Math.min(end, total));
    if (to <= from || !total || spec.c < 1) return new Uint8Array(0);
    const read = async (hash: VvshHash): Promise<Uint8Array> => {
      const data = await this.store.getChunk(hash);
      if (!data) throw notFound('This node does not have the object');
      return data;
    };
    const first = Math.min(spec.c - 1, Math.floor((from * spec.c) / total));
    const last = Math.min(spec.c - 1, Math.floor(((to - 1) * spec.c) / total));
    // The chunks that hold the range are read together — one page of objects per chunk,
    // with the built-in path, so bytes are verified and paid for in per-chunk batches.
    const indexes: number[] = [];
    for (let index = first; index <= last; index++) indexes.push(index);
    const decodedAll = await Promise.all(
      indexes.map(async (index) => {
        const chunkStart = Math.floor((index * total) / spec.c);
        // Down the tree to this one chunk, every record checked against the hash its parent
        // named — the same walk a client does, just done here against local objects.
        let hash: VvshHash = spec.r;
        for (const side of pathToChunk(spec.c, index)) {
          const record = parseVvshNode(await read(hash), hash);
          if (!record || record.kind !== 'branch') throw notFound('This stream is not verifiable from its root here');
          hash = record[side];
        }
        const node = parseVvshNode(await read(hash), hash);
        const leaf = node && node.kind === 'chunk' ? node.renditions.find((entry) => entry.id === spec.q) : undefined;
        if (!leaf) throw notFound('This stream has no such chunk');
        const blocks = decodeVvshFrames(decodeVvshChunk(await read(leaf.hash)));
        const decoded = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
        let at = 0;
        for (const block of blocks) {
          decoded.set(block, at);
          at += block.length;
        }
        return { chunkStart, decoded };
      }),
    );
    const pieces: Uint8Array[] = [];
    for (const { chunkStart, decoded } of decodedAll) {
      const takeStart = Math.max(0, from - chunkStart);
      const takeEnd = Math.min(decoded.length, to - chunkStart);
      if (takeEnd > takeStart) pieces.push(decoded.subarray(takeStart, takeEnd));
    }
    const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }

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

  // -------------------------------------------------------------------------
  // Downloadable content copies: a client points here at a download URL (with its cid)
  // or a base URL; this node pulls content from it and pays the client for every download
  // whose bytes hash to the cid exactly.

  /** Accepted links that may serve a cid: its own URL, or a base URL to query. */
  private linksFor(cid: string): ContentLink[] {
    const out: ContentLink[] = [];
    for (const record of Object.values(this.contentUrls.data.items)) {
      if (record.status !== 'accepted') continue;
      if (record.cid && record.cid === cid && record.url) out.push({ cid, url: record.url });
      else if (record.baseUrl) out.push({ cid, url: `${record.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(cid)}` });
    }
    return out;
  }

  /**
   * Pulls one content copy from a client's link, checks that its bytes hash to the cid
   * exactly, keeps them and pays the client. True when the content was accepted.
   */
  private async pullContentUrl(record: ContentUrlRecord, cid: string, url: string): Promise<boolean> {
    let data: Buffer;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return false;
      data = Buffer.from(await response.arrayBuffer());
    } catch {
      return false;
    }
    if (!bytesMatchCid(data, cid)) return false; // the content does not match the cid
    this.downloads.data.items[cid] = { data: data.toString('base64'), account: record.account, at: new Date().toISOString() };
    record.downloads++;
    const reward = Math.max(0, Math.round(this.config.contentUrls.creditPerDownload));
    if (reward > 0) {
      this.ledger.credit(record.account, reward, 'content download', cid);
      record.earned += reward;
    }
    this.contentUrls.changed();
    this.downloads.changed();
    return true;
  }

  /** Tries every accepted link for a cid, keeping the first whose content matches. */
  private async fetchContentUrl(cid: string): Promise<boolean> {
    for (const record of Object.values(this.contentUrls.data.items)) {
      if (record.status !== 'accepted') continue;
      const url = record.cid === cid && record.url ? record.url : record.baseUrl ? `${record.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(cid)}` : undefined;
      if (!url) continue;
      if (await this.pullContentUrl(record, cid, url)) return true;
    }
    return false;
  }

  /**
   * One round of automatic syncing with peers: share chunks peers are missing and pull
   * chunks this node is missing, each up to its configured per-minute rate for the time
   * this round covers.
   */
  async syncPeers(): Promise<{ sent: number; received: number; errors: number }> {
    const sync = this.config.peering.sync;
    const minutes = Math.max(1 / 60, sync.intervalMs / 60_000);
    const sendBudget = Math.max(0, Math.round(sync.sendRatePerMin * minutes));
    const receiveBudget = Math.max(0, Math.round(sync.receiveRatePerMin * minutes));
    let sent = 0;
    let received = 0;
    let errors = 0;
    for (const record of this.store.list(0, 50)) {
      const manifest = this.store.getManifest(record.cid);
      if (!manifest) continue;
      // Share: send chunks a peer lacks, up to the send budget.
      for (const peer of this.config.peering.peers) {
        if (!peer.send || sent >= sendBudget) continue;
        try {
          const client = this.peerClient(peer);
          const answer = await client.json<{ has: Record<string, boolean> }>('/v1/peers/has', {
            body: { ids: manifest.chunks.map((chunk) => chunk.id) },
            timeoutMs: 30000,
          });
          for (const chunk of manifest.chunks) {
            if (sent >= sendBudget) break;
            if (answer.has[chunk.id]) continue;
            const data = await this.store.getChunk(chunk.id, { peers: false });
            if (!data) continue;
            await client.fetch(`/v1/peers/chunks/${chunk.id}`, { method: 'PUT', raw: data, timeoutMs: 120000 });
            sent++;
          }
        } catch {
          errors++;
        }
      }
      // Receive: pull chunks this node lacks, up to the receive budget.
      for (const chunk of manifest.chunks) {
        if (received >= receiveBudget) break;
        if (this.store.hasChunk(chunk.id)) continue;
        const data = await this.fetchFromPeers(chunk.id);
        if (data) {
          await this.store.putChunk(chunk.id, data);
          received++;
        }
      }
      if (sent >= sendBudget && received >= receiveBudget) break;
    }
    return { sent, received, errors };
  }

  /** Starts (or restarts) the automatic sync job at the configured cadence. */
  private startSync(): void {
    this.stopSync();
    const sync = this.config.peering.sync;
    if (!sync.enabled) return;
    const interval = Math.max(5_000, Math.round(sync.intervalMs) || 3_600_000);
    this.syncTimer = setInterval(() => {
      void this.syncPeers().catch(() => undefined);
    }, interval);
    this.syncTimer.unref?.();
  }

  private stopSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  // -------------------------------------------------------------------------
  // Peering: content providers exchange content bytes with their peers,
  // addressed by the hash of the bytes (a chunk id).

  /** The peer the caller is, when it is configured for this direction. */
  private requirePeer(ctx: Ctx, direction: 'send' | 'receive'): { ref: string; url: string; id: string } {
    const account = this.auth.require(ctx);
    for (const peer of this.config.peering.peers) {
      if (direction === 'send' ? !peer.send : !peer.receive) continue;
      const ref = parseNodeRef(peer.ref);
      if (ref?.id === account.id) return { ref: peer.ref, url: ref.url, id: ref.id };
    }
    throw forbidden('Not a peer of this node in that direction');
  }

  /** A client talking to one configured peer as this node. */
  private peerClient(peer: { ref: string }): NodeClient {
    const ref = parseNodeRef(peer.ref)!;
    return new NodeClient({
      url: ref.url,
      expectedId: ref.id,
      expectedType: 'provider',
      auth: 'identity',
      identity: this.identity,
      transport: () => this.transport(ref.url),
    });
  }

  /** Asks the peers set to receive from for a chunk no backend here has. */
  private async fetchFromPeers(id: string, only?: string): Promise<Buffer | null> {
    for (const peer of this.config.peering.peers) {
      if (!peer.receive || (only && peer.ref !== only)) continue;
      try {
        const response = await this.peerClient(peer).fetch(`/v1/peers/chunks/${encodeURIComponent(id)}`, { timeoutMs: 30_000 });
        const data = Buffer.from(await response.arrayBuffer());
        if (chunkIdOf(data) === id) return data;
      } catch (error) {
        log.debug(`Peer has no chunk ${id.slice(0, 12)}: ${(error as Error).message}`);
      }
    }
    return null;
  }

  /**
   * Records a client's suggestion of missing data about content. What the node already
   * had pays nothing; a new suggestion earns `rewards.suggestion` (daily capped).
   */
  suggest(account: Account, body: ProviderSuggestionRequest): ProviderSuggestionResponse {
    const kind = String(body.kind ?? '') as ProviderSuggestionKind;
    if (!(['source', 'duplicate', 'missing'] as string[]).includes(kind)) throw badRequest('kind is source, duplicate or missing');
    const contentId = String(body.id ?? '').trim();
    if (!contentId || contentId.length > 4096) throw badRequest('id is required');
    const note = String(body.note ?? '').trim().slice(0, 1000);
    let sources: SourceSuggestion[] | undefined;
    let duplicateOf: string | undefined;
    if (kind === 'source') {
      const list = Array.isArray(body.sources) ? body.sources.slice(0, 16) : [];
      sources = list.map((source) => ({
        platform: String(source?.platform ?? '').trim().toLowerCase().slice(0, 32) || 'web',
        url: String(source?.url ?? '').trim().slice(0, 2048),
      }));
      if (!sources.length) throw badRequest('At least one source link is required');
      for (const source of sources) {
        let url: URL;
        try {
          url = new URL(source.url);
        } catch {
          throw badRequest(`Not a link: ${source.url.slice(0, 80)}`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('Source links must be http(s) links');
      }
    } else if (kind === 'duplicate') {
      duplicateOf = String(body.duplicateOf ?? '').trim();
      if (!duplicateOf || duplicateOf.length > 4096) throw badRequest('duplicateOf (the other content id) is required');
    }
    const signature = suggestionSignature({ kind, sources, duplicateOf, note });
    const known = Object.values(this.suggestions.data.items).find((s) => s.contentId === contentId && s.signature === signature);
    if (known) {
      const { signature: _signature, ...suggestion } = known;
      return { suggestion, newInfo: false, credited: 0 };
    }
    const stored: ProviderSuggestion & { signature: string } = {
      id: randomId('sug-', 8),
      contentId,
      kind,
      sources,
      duplicateOf,
      note: note || undefined,
      accountId: account.id,
      status: 'pending',
      createdAt: new Date().toISOString(),
      signature,
    };
    this.suggestions.data.items[stored.id] = stored;
    this.suggestions.changed();
    let credited = 0;
    const rewards = this.config.rewards;
    if (rewards.suggestion > 0 && this.ledger.daily(account, 'suggestions') < rewards.suggestionDailyCap) {
      this.ledger.addDaily(account, 'suggestions', 1);
      this.ledger.credit(account.id, rewards.suggestion, 'suggestion', contentId);
      credited = rewards.suggestion;
    }
    const { signature: _signature, ...suggestion } = stored;
    return { suggestion, newInfo: true, credited };
  }

  protected registerRoutes(): void {
    const router = this.router;

    router.get('/v1/content/:cid', async (ctx) => {
      const cid = ctx.params.cid;
      const manifest = await this.getManifest(cid);
      if (!manifest) {
        // Feature: this node does not hold the content, but a client's link may. Send the
        // link instead so the client can fetch the bytes and check the cid itself.
        const links = this.linksFor(cid);
        if (links.length) return { missing: true, links };
        throw notFound('This node does not have the content');
      }
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

    // Downloadable content copies (feature): a client registers a download URL and its
    // cid, or a base URL. This node pulls content from it and pays the client per download
    // whose bytes hash to the cid exactly. Caps and auto-accept are the operator's.
    router.post('/v1/content-urls', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<ContentUrlSubmission>(ctx.req);
      const settings = this.config.contentUrls;
      const items = this.contentUrls.data.items;
      const mine = Object.values(items).filter((r) => r.account === account.id);
      const record: ContentUrlRecord = {
        id: randomId('cu-', 8),
        account: account.id,
        status: settings.autoAccept ? 'accepted' : 'pending',
        downloads: 0,
        earned: 0,
        createdAt: new Date().toISOString(),
      };
      const httpUrl = (value: unknown): string => {
        let parsed: URL;
        try {
          parsed = new URL(String(value));
        } catch {
          throw badRequest('url must be an http(s) URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badRequest('url must be an http(s) URL');
        return parsed.toString();
      };
      if (body.baseUrl) {
        const used = mine.filter((r) => r.baseUrl).length;
        if (used >= Math.max(0, settings.maxBaseUrlsPerClient)) {
          throw badRequest(`This node accepts at most ${settings.maxBaseUrlsPerClient} base URLs per client`);
        }
        record.baseUrl = httpUrl(body.baseUrl).replace(/\/+$/, '');
      } else if (body.cid && body.url) {
        const used = mine.filter((r) => r.url).length;
        if (used >= Math.max(0, settings.maxUrlsPerClient)) {
          throw badRequest(`This node accepts at most ${settings.maxUrlsPerClient} content URLs per client`);
        }
        if (!isNativeId(String(body.cid))) throw badRequest('cid must be a content id');
        record.cid = String(body.cid);
        record.url = httpUrl(body.url);
      } else {
        throw badRequest('Provide a cid and a url, or a baseUrl');
      }
      items[record.id] = record;
      this.contentUrls.changed();
      return { record };
    });

    router.get('/v1/content-urls/mine', (ctx) => {
      const account = this.auth.require(ctx);
      return { items: Object.values(this.contentUrls.data.items).filter((r) => r.account === account.id) };
    });

    // Pull a content copy now: download it, check the cid, keep it and pay the client.
    router.post('/v1/content-urls/fetch', async (ctx) => {
      this.auth.require(ctx);
      const body = await readJson<{ cid?: string }>(ctx.req);
      const cid = String(body.cid ?? '').trim();
      if (!cid) throw badRequest('cid is required');
      const fetched = await this.fetchContentUrl(cid);
      return { fetched, downloaded: Boolean(this.downloads.data.items[cid]) };
    });

    router.get('/v1/downloads/:cid', (ctx) => {
      const item = this.downloads.data.items[ctx.params.cid];
      if (!item) throw notFound('No downloaded copy of this content');
      const data = Buffer.from(item.data, 'base64');
      ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length) });
      if (ctx.req.method === 'HEAD') return ctx.res.end();
      return ctx.res.end(data);
    });

    // Operator review of the URLs clients submitted (needed when auto-accept is off).
    router.get('/v1/admin/content-urls', (ctx) => {
      this.requireAdmin(ctx);
      return { items: Object.values(this.contentUrls.data.items), config: this.config.contentUrls };
    });
    router.post('/v1/admin/content-urls/:id', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ status?: 'accepted' | 'rejected' }>(ctx.req);
      const record = this.contentUrls.data.items[ctx.params.id];
      if (!record) throw notFound('No such content URL');
      if (body.status === 'accepted' || body.status === 'rejected') record.status = body.status;
      this.contentUrls.changed();
      return { record };
    });

    // A client that played content from outside the network reports its content id here;
    // the node keeps ids it did not have and rewards the reporter for them.
    router.post('/v1/reports', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<ReportRequest>(ctx.req);
      const id = String(body.id ?? '').trim();
      if (!id || id.length > 4096) throw badRequest('id is required');
      const known = Boolean(this.store.getContent(id)) || Boolean(this.store.getContent(baseId(id))) || Boolean(this.reports.data.ids[id]);
      let credited = 0;
      const rewards = this.config.rewards;
      if (!known) {
        this.reports.data.ids[id] = { at: new Date().toISOString(), account: account.id };
        if (Object.keys(this.reports.data.ids).length > 50_000) {
          const oldest = Object.entries(this.reports.data.ids).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(0, 10_000);
          for (const [key] of oldest) delete this.reports.data.ids[key];
        }
        this.reports.changed();
        if (rewards.report > 0 && this.ledger.daily(account, 'reports') < rewards.reportDailyCap) {
          this.ledger.addDaily(account, 'reports', 1);
          const updated = this.ledger.credit(account.id, rewards.report, 'report', id);
          ctx.res.setHeader('x-vs-balance', String(updated.balance));
          credited = rewards.report;
        }
      }
      return { known, credited } satisfies ReportResponse;
    });

    // A client suggests what this node is missing about content: links to it on other
    // platforms, another content id it duplicates (helps dedupe and compression), or
    // that its data is absent altogether. New suggestions are rewarded; the operator
    // reviews them in the dashboard.
    router.post('/v1/suggestions', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<ProviderSuggestionRequest>(ctx.req);
      return this.suggest(account, body);
    });

    router.get('/v1/suggestions/mine', (ctx) => {
      const account = this.auth.require(ctx);
      return {
        suggestions: Object.values(this.suggestions.data.items)
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    // Peering: content providers exchange content bytes with each other, addressed by
    // the hash of the bytes (the chunk id).
    router.post('/v1/peers/has', async (ctx) => {
      this.requirePeer(ctx, 'send');
      const body = await readJson<{ ids?: string[] }>(ctx.req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
      return { has: Object.fromEntries(ids.map((id) => [String(id), this.store.hasChunk(String(id))])) };
    });

    router.get('/v1/peers/chunks/:id', async (ctx) => {
      this.requirePeer(ctx, 'send');
      const id = ctx.params.id;
      if (!isChunkId(id)) throw badRequest('Not a chunk id');
      const data = await this.store.getChunk(id, { peers: false });
      if (!data) throw notFound('This node does not have the chunk');
      ctx.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      ctx.res.end(data);
    });

    router.put('/v1/peers/chunks/:id', async (ctx) => {
      this.requirePeer(ctx, 'receive');
      if (!this.config.peering.acceptPush) throw forbidden('This node does not accept pushed chunks');
      const id = ctx.params.id;
      if (!isChunkId(id)) throw badRequest('Not a chunk id');
      const data = await readBody(ctx.req, 9 * MiB);
      if (chunkIdOf(data) !== id) throw badRequest('The bytes do not match the chunk id');
      await this.store.putChunk(id, data);
      return { ok: true };
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

    // .vvsh verifiable video streams: the file itself is metadata and the tree root. Every
    // branch, chunk node and encoded payload is stored on its own under its hash, so a user
    // starts at any branch hash and works down, paying per chunk as they go.
    router.put('/v1/vvsh/objects/:hash', async (ctx) => {
      this.auth.require(ctx);
      const data = await readBody(ctx.req, 16 * MiB);
      const hash = String(ctx.params.hash);
      if (chunkIdOf(data) !== hash) throw badRequest('The bytes do not match the object hash');
      await this.store.putChunk(hash, data);
      return { ok: true, hash };
    });

    // One .vvsh stream as byte ranges — what a browser's seeking asks for. The bytes map
    // to chunks by arithmetic, every record is checked against its hash here, and only
    // the chunks that hold the asked-for bytes are read: a seek never pulls the video.
    router.get('/v1/vvsh/stream/:spec', async (ctx) => {
      const spec = JSON.parse(new TextDecoder().decode(fromBase64url(String(ctx.params.spec)))) as {
        r: string;
        c: number;
        q: string;
        d: number;
      };
      const total = Math.max(0, spec.d);
      const range = /bytes=(\d*)-(\d*)/.exec(String(ctx.req.headers.range ?? ''));
      const start = range && range[1] ? Number(range[1]) : 0;
      // A range answer is capped: an open-ended `bytes=0-` probe must never turn into one
      // giant response — the browser asks for the next part when it wants it, so playback
      // arrives in pieces and only the chunks those pieces fall in are fetched/paid for.
      const HARD_CAP = 2 * 1024 * 1024;
      const requestedEnd = range && range[2] ? Math.min(Number(range[2]) + 1, total) : total;
      const end = Math.min(requestedEnd, start + HARD_CAP);
      const bytes = await this.vvshRange(spec, start, end);
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=3600',
      };
      const status = range ? 206 : 200;
      if (range) headers['content-range'] = `bytes ${start}-${start + Math.max(0, bytes.length - 1)}/${total}`;
      ctx.res.writeHead(status, headers).end(Buffer.from(bytes));
    });

    router.get('/v1/vvsh/objects/:hash', async (ctx) => {
      const hash = String(ctx.params.hash);
      const account = this.auth.account(ctx);
      const data = await this.store.getChunk(hash);
      if (!data) throw notFound('This node does not have the object');
      // A direct URL open (a browser address bar) carries no account: it reads for
      // free. The app streams authenticated and pays per MiB as configured below.
      if (!account) {
        ctx.res
          .writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': data.length,
            'x-vs-charged': '0',
          })
          .end(data);
        return;
      }
      // .vvsh chunks are priced per MiB of the chunk — configurable on this node.
      const { charged, balance } = this.charge(account, data.length, undefined, 'vvsh chunk');
      if (balance !== undefined) ctx.res.setHeader('x-vs-balance', String(balance));
      ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'x-vs-charged': String(charged) }).end(data);
    });

    // Calculating a .vvsh here: the client uploads the video and its metadata configuration
    // (or takes this node's defaults) and the quote — driven by the metadata (chunks and
    // previews), the video's length and the encodings — is charged before the work runs.
    router.post('/v1/vvsh/quote', async (ctx) => {
      const body = await readJson<{ bytes?: number; totalSeconds?: number; config?: VvshBuildConfig }>(ctx.req);
      return { quote: quoteVvsh(this.config.vvsh.convert, this.vvshInput(body)) };
    });

    // Calculating a .vvsh here. The video arrives in pieces (so a long one never lands in
    // one huge buffer or a giant JSON string), the quote — driven by the metadata (chunks
    // and previews), the video's length and the encodings — is charged before the work
    // runs, and the finished stream is stored object by object under its hashes.
    router.post('/v1/vvsh/convert', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<{
        name?: string;
        bytes?: number;
        totalSeconds?: number;
        config?: VvshBuildConfig;
        meta?: Manifest['meta'];
        sourceMime?: string;
        previews?: string[];
      }>(ctx.req);
      const input = this.vvshInput(body);
      const declared = Math.max(1, Number(body.bytes ?? 0));
      const quote = quoteVvsh(this.config.vvsh.convert, { ...input, bytes: declared });
      if (quote.credits > 0) this.ledger.debit(account.id, quote.credits, 'vvsh convert', String(body.name ?? 'video.vvsh'));
      const jobId = randomId();
      this.vvshConverts.set(jobId, {
        account: account.id,
        name: String(body.name ?? 'video.vvsh'),
        input,
        declared,
        meta: body.meta,
        sourceMime: body.sourceMime,
        previews: body.previews,
        pieces: [],
        bytes: 0,
        quote,
        at: Date.now(),
      });
      return { jobId, quote };
    });

    router.put('/v1/vvsh/convert/:jobId/piece', async (ctx) => {
      const account = this.auth.require(ctx);
      const job = this.vvshConverts.get(String(ctx.params.jobId));
      if (!job || job.account !== account.id) throw notFound('No such conversion job');
      const piece = await readBody(ctx.req, 16 * MiB);
      if (job.bytes + piece.length > job.declared) throw badRequest('More video bytes than the job declared');
      job.pieces.push(piece);
      job.bytes += piece.length;
      return { ok: true, bytes: job.bytes };
    });

    router.post('/v1/vvsh/convert/:jobId/finish', async (ctx) => {
      const account = this.auth.require(ctx);
      const job = this.vvshConverts.get(String(ctx.params.jobId));
      if (!job || job.account !== account.id) throw notFound('No such conversion job');
      this.vvshConverts.delete(String(ctx.params.jobId));
      const source = Buffer.concat(job.pieces);
      job.pieces.length = 0;
      const { manifest } = await convertVvsh(
        source,
        {
          name: job.name,
          totalSeconds: job.input.totalSeconds,
          config: job.input.config,
          meta: job.meta,
          sourceMime: job.sourceMime,
          previews: job.previews,
        },
        async (hash, data) => {
          await this.store.putChunk(hash, Buffer.from(data));
        }
      );
      log.info(`Converted ${manifest.name} for ${account.id} into a .vvsh stream (${job.quote.credits} credits)`);
      return { manifest, quote: job.quote };
    });

    router.put('/v1/vvsh/manifest', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<{ manifest?: Manifest }>(ctx.req, 2 * 1024 * 1024);
      const manifest = validateManifest(body.manifest);
      if (!manifest.vvsh) throw badRequest('This manifest carries no vvsh stream');
      await this.store.addContent(manifest, account.id);
      return { cid: contentIdOf(manifest), status: 'ready' };
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
          // One content id can carry several sources: the manifest's own plus any the
          // operator accepted from client suggestions.
          sources: (() => {
            const merged = [...new Set([...(manifest?.sources ?? []), ...(record.sources ?? [])])].slice(0, 16);
            return merged.length ? merged : undefined;
          })(),
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
    // Everything the node knows about one content, for the dashboard's details modal.
    router.get('/v1/admin/content/:cid', (ctx) => {
      this.requireAdmin(ctx);
      const cid = ctx.params.cid;
      const record = this.store.getContent(cid);
      if (!record) throw notFound('No such content');
      const manifest = this.store.getManifest(cid);
      return {
        record,
        manifest: manifest
          ? {
              name: manifest.name,
              mime: manifest.mime,
              size: manifest.size,
              chunkSize: manifest.chunkSize,
              createdAt: manifest.createdAt,
              meta: manifest.meta,
              sources: manifest.sources,
              vvsh: manifest.vvsh,
              creator: manifest.creator
                ? { id: manifest.creator.id, name: manifest.creator.name, kind: manifest.creator.kind }
                : undefined,
            }
          : undefined,
        chunks: manifest?.chunks.map((chunk) => {
          const stored = this.store.chunkRecord(chunk.id);
          return { id: chunk.id, size: chunk.size, backends: stored ? Object.keys(stored.locations) : [] };
        }),
        suggestions: Object.values(this.suggestions.data.items)
          .filter((s) => s.contentId === cid)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(({ signature: _signature, ...suggestion }) => suggestion),
      };
    });
    // What clients suggested this node is missing, newest first.
    router.get('/v1/admin/suggestions', (ctx) => {
      this.requireAdmin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(this.suggestions.data.items)
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map(({ signature: _signature, ...suggestion }) => ({
          ...suggestion,
          title: this.store.getContent(suggestion.contentId)?.title ?? this.store.getContent(suggestion.contentId)?.name,
        }));
      return { suggestions };
    });
    router.post('/v1/admin/suggestions/:id/:action', (ctx) => {
      this.requireAdmin(ctx);
      const suggestion = this.suggestions.data.items[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        suggestion.status = 'accepted';
        suggestion.reviewedAt = new Date().toISOString();
        this.suggestions.changed();
        // Applied to the content record: sources become part of its catalog entry, and
        // duplicate ids are kept so the operator can dedupe or compress the store.
        this.store.annotate(suggestion.contentId, {
          sources: suggestion.sources?.map((source) => source.url),
          duplicates: suggestion.duplicateOf ? [suggestion.duplicateOf] : undefined,
        });
      } else if (ctx.params.action === 'reject') {
        suggestion.status = 'rejected';
        suggestion.reviewedAt = new Date().toISOString();
        this.suggestions.changed();
      } else throw notFound();
      return { ok: true };
    });
    // Peering: other content providers this node exchanges content bytes with.
    router.get('/v1/admin/peers', (ctx) => {
      this.requireAdmin(ctx);
      return { peers: this.config.peering.peers, acceptPush: this.config.peering.acceptPush, sync: this.config.peering.sync };
    });
    router.put('/v1/admin/peers', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ peers?: { ref: string; send?: boolean; receive?: boolean }[]; acceptPush?: boolean }>(ctx.req);
      const peers = (body.peers ?? []).slice(0, 100).map((peer) => {
        const ref = parseNodeRef(String(peer.ref ?? ''));
        if (!ref || ref.type !== 'provider') throw badRequest('Every peer must be a content provider node reference');
        return { ref: String(peer.ref).trim(), send: peer.send !== false, receive: peer.receive !== false };
      });
      this.configFile.data.peering = { ...this.configFile.data.peering, peers, acceptPush: body.acceptPush !== false };
      this.configFile.changed();
      return { peers, acceptPush: body.acceptPush !== false };
    });
    router.post('/v1/admin/peers/push', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ peer?: string; cid?: string }>(ctx.req);
      const manifest = this.store.getManifest(String(body.cid ?? ''));
      if (!manifest) throw notFound('No such content on this node');
      const targets = this.config.peering.peers.filter((peer) => peer.send && (!body.peer || peer.ref === body.peer));
      if (!targets.length) throw badRequest('No peer set to send to');
      const results: { peer: string; sent: number; skipped: number; error?: string }[] = [];
      for (const peer of targets) {
        let sent = 0;
        let skipped = 0;
        try {
          const client = this.peerClient(peer);
          const answer = await client.json<{ has: Record<string, boolean> }>('/v1/peers/has', {
            body: { ids: manifest.chunks.map((chunk) => chunk.id) },
            timeoutMs: 30000,
          });
          for (const chunk of manifest.chunks) {
            const data = answer.has[chunk.id] ? null : await this.store.getChunk(chunk.id, { peers: false });
            if (!data) {
              skipped++;
              continue;
            }
            await client.fetch(`/v1/peers/chunks/${chunk.id}`, { method: 'PUT', raw: data, timeoutMs: 120000 });
            sent++;
          }
          results.push({ peer: peer.ref, sent, skipped });
        } catch (error) {
          results.push({ peer: peer.ref, sent, skipped, error: (error as Error).message });
        }
      }
      return { results };
    });
    router.post('/v1/admin/peers/fetch', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ peer?: string; cid?: string }>(ctx.req);
      const manifest = this.store.getManifest(String(body.cid ?? ''));
      if (!manifest) throw notFound('No such content on this node');
      let fetched = 0;
      let missing = 0;
      for (const chunk of manifest.chunks) {
        if (this.store.hasChunk(chunk.id)) continue;
        const data = await this.fetchFromPeers(chunk.id, body.peer);
        if (data) {
          await this.store.putChunk(chunk.id, data);
          fetched++;
        } else missing++;
      }
      return { fetched, missing };
    });
    // Automatic syncing of content bytes with peers: run a round now, or set how often it
    // runs and the rate limits for sharing (sending) and receiving chunks.
    router.post('/v1/admin/peers/sync', async (ctx) => {
      this.requireAdmin(ctx);
      return this.syncPeers();
    });
    router.post('/v1/admin/peers/sync/config', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ enabled?: boolean; intervalMs?: number; sendRatePerMin?: number; receiveRatePerMin?: number }>(ctx.req);
      const sync = this.config.peering.sync;
      if (body.enabled !== undefined) sync.enabled = Boolean(body.enabled);
      if (body.intervalMs !== undefined) sync.intervalMs = Math.max(5_000, Math.round(Number(body.intervalMs) || 0));
      if (body.sendRatePerMin !== undefined) sync.sendRatePerMin = Math.max(0, Math.round(Number(body.sendRatePerMin) || 0));
      if (body.receiveRatePerMin !== undefined) sync.receiveRatePerMin = Math.max(0, Math.round(Number(body.receiveRatePerMin) || 0));
      this.configFile.changed();
      this.startSync();
      return { sync };
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

  async start(): Promise<void> {
    await super.start();
    this.startSync();
  }

  async stop(): Promise<void> {
    this.stopSync();
    clearInterval(this.gcTimer);
    this.service.stop();
    await super.stop();
  }

  flush(): void {
    super.flush();
    this.store.flush();
    this.uploads.flush();
    this.suggestions.flush();
    this.service.flush();
  }
}
