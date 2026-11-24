import { isAbsolute, join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { BaseNode, DEFAULT_NODE_TOR, type BaseConfig, type NodeOptions } from '../node/node.js';
import { defaultCryptoPaymentConfigs } from '../node/payments.js';
import type { Account } from '../node/ledger.js';
import { chunkIdOf, contentIdOf, bytesCid, bytesMatchCid, bytesMatchManifest, mimeFromName, MiB, validateManifest, type Manifest } from '../shared/content.js';
import { peerLinkFromProvider } from '../shared/peering.js';
import { isDevBuild } from '../shared/node/devbuild.js';
import { buildManifestFromFile } from '../shared/node/contentfile.js';
import type { ContentLink, ContentUrlRecord, ContentUrlSubmission } from '../shared/protocol.js';
import {
  badRequest,
  forbidden,
  HttpError,
  immutableHeaders,
  notFound,
  notModified,
  readBody,
  readJson,
  sendJson,
  unauthorized,
  type Ctx,
} from '../shared/node/http.js';
import { log } from '../shared/node/log.js';
import { NodeClient } from '../shared/nodeclient.js';
import { RemovalQueue } from './removals.js';
import { registerRemovalRoutes } from './removals-routes.js';
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
import { JsonFile } from '../shared/node/store.js';
import { RemoteError } from '../shared/node/http.js';
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
import { defaultTiersConfig, TierManager, tierJob, withDefaultTiers, type TierState, type TiersConfig } from './tiers.js';
import { vvshEncoderBackend, setTranscodeTracing } from './transcode.js';
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
  /**
   * Content pushed here from outside (client uploads, peer pushes) waits for the
   * operator's review before it is listed, served or given a storage job. Off accepts
   * pushed content immediately, like operator imports always do. `syncMinutes` runs
   * the algorithm-node sync over the queue that often (0 = only by hand).
   */
  review: { enabled: boolean; syncMinutes: number };
  /**
   * Trusted algorithm search nodes: content pushed here that one of them already
   * lists is accepted automatically (autoAccept), because it has been reviewed there.
   */
  algorithmPeers: { refs: string[]; autoAccept: boolean };
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
  /** Content storage tiers: where copies live, how many, and for how long. */
  tiers: TiersConfig;
}

export function providerDefaults(): ProviderConfig {
  return {
    name: 'VibeShare provider',
    description: 'A VibeShare content provider node.',
    host: '0.0.0.0',
    port: 7701,
    trustProxy: false,
    tor: { ...DEFAULT_NODE_TOR },
    transfers: { minSenderBalance: 1000 },
    signup: { grant: 500, powBits: 0, anonymous: true, perIpPerHour: 30 },
    payments: [{ id: 'voucher', type: 'voucher' }, ...defaultCryptoPaymentConfigs()],
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
    tiers: defaultTiersConfig(),
    storage: {
      backends: [{ id: 'local', type: 'local', path: 'blobs' }],
      replication: 1,
      cacheMiB: 128,
      cacheFetched: true,
      usePeers: true,
    },
    catalog: true,
    review: { enabled: true, syncMinutes: 0 },
    algorithmPeers: { refs: [], autoAccept: true },
    storageService: {
      enabled: true,
      retrievalIntervalSeconds: 0,
      offlineGraceSeconds: 120,
      taskTimeoutSeconds: 30,
      auto: {
        enabled: false,
        replicas: 2,
        durationDays: 30,
        rewards: { upfront: 5, perRetrieval: 1, completion: 20 },
        retrievalIntervalSeconds: 0,
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

/** What one manual push of one content to one target moved, for the admin's progress. */
interface PushItemResult {
  ref: string;
  cid: string;
  /** Chunks uploaded now. */
  sent: number;
  /** Chunks the target already had (or that the manifest names twice). */
  skipped: number;
  /** Chunks this node could not read: the target is still missing these. */
  missing: number;
  /** Bytes uploaded now. */
  bytes: number;
  /** The manifest is in place on the target; without it the content cannot be served. */
  manifest: boolean;
  /** What the target (or the transfer) said when something went wrong. */
  error?: string;
}

/** What one endpoint check found: does it serve the content, and do the bytes match. */
interface EndpointCheck {
  ok: boolean;
  url: string;
  bytes: number;
  chunks?: { matched: number; total: number };
  /** The HTTP status the endpoint answered with, when there was one. */
  status?: number;
  error?: string;
}

/** One of an account's content URLs and what one run did with it, in the order tried. */
type LinkOutcome = { id: string; outcome: 'success' | 'failed' | 'not tested' };

/** What one storage-job endpoint test found across its users' endpoints. */
interface JobTestResult {
  ok: boolean;
  account?: string;
  endpoint?: string;
  chunks?: { matched: number; total: number };
  /** Holders whose endpoints served the content, of the holders tested. */
  holders: { succeeded: number; total: number };
  /** Endpoint URLs that served the content, of the URLs tried. */
  urls: { served: number; checked: number };
  checked: number;
  total: number;
  error?: string;
  /**
   * Every content URL of the tested holders, in try order: the row that served, the rows
   * tried before it (failed), and the rows an earlier success left untried (not tested).
   */
  links?: LinkOutcome[];
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
  /** Content storage tiers: which copies live where, and for how long. */
  readonly tiers: TierManager;
  /** Content removal requests waiting for the operator's delete review. */
  readonly removals: RemovalQueue;
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
  private tierTimer: NodeJS.Timeout;
  private endpointTimer: NodeJS.Timeout;
  private syncTimer: NodeJS.Timeout | null = null;
  /** The automatic review sync (review.syncMinutes; 0 = only the manual button). */
  private reviewSyncTimer: NodeJS.Timeout;
  private lastReviewSyncAt = Date.now();
  private reviewSyncing = false;
  /** One pending re-check ladder per queued content, and its unref'd timers. */
  private reviewRechecks = new Set<string>();
  private reviewRecheckTimers = new Set<NodeJS.Timeout>();
  /** Clients for the targets of manual syncs, kept per ref so a long sync reuses sessions. */
  private adHocClients = new Map<string, NodeClient>();

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
      (id, options) => this.store.getChunk(id, options),
      // A holder that failed a retrieval is out of the job — the job's data is pulled from
      // the URLs that account offered (its base URL endpoint or its full URL) instead.
      (accountId, job) => {
        if (job?.cid) {
          void this.fetchContentUrl(job.cid, accountId)
            .then((ok) => {
              // The job is really failed only when its data is unavailable everywhere:
              // no endpoint worked, no holder is left, and this node keeps no copy.
              if (!ok && this.service.holdersOf(job.cid!) === 0 && !job.chunkIds.some((id) => this.store.hasChunk(id))) {
                this.service.failJob(job.id);
              }
            })
            .catch((error) => {
              // Tolerated: the pull is a recovery attempt, the job keeps its other sources.
              this.traces.trace('error', 'provider.node', 'holder-out pull failed', {
                error: (error as Error).message,
                data: { account: accountId.slice(0, 16), job: job.id },
              });
            });
        }
      },
      this.traces
    );
    this.removals = new RemovalQueue(this.path('removals.json'));
    this.store = new ContentStore({
      indexPath: this.path('content-index.json'),
      backends: () => this.backends(),
      priorities: () => Object.fromEntries(this.config.storage.backends.map((b) => [b.id, b.priority ?? 10])),
      replication: () => this.config.storage.replication,
      cacheBytes: this.config.storage.cacheMiB * MiB,
      peerFallback: (id) => (this.config.storage.usePeers ? this.service.retrieve(id) : Promise.resolve(null)),
      chunkPeers: (id) => this.fetchFromPeers(id),
      cacheFetched: () => this.config.storage.cacheFetched,
      traces: this.traces,
    });
    this.gcTimer = setInterval(() => void this.collectGarbage(), 15 * 60_000);
    this.gcTimer.unref();
    this.tiers = new TierManager(this.path('tiers.json'), () => this.config.tiers, this.ledger, {
      releaseBytes: (cid) => this.store.releaseContentBytes(cid),
      deleteContent: (cid) => this.removeContent(cid),
      holders: (cid) => this.service.holdersOf(cid),
      bytesOf: (cid) => this.store.getContent(cid)?.size ?? 0,
      // A tier change always reshapes the content's storage job (created, resized, deleted).
      onChanged: (cid) => this.syncTierJob(cid),
    }, this.traces);
    // The vvsh encoder runs outside any instance (it is called through convertVvsh) —
    // install this node's trace hook so its events join the requesting timeline.
    setTranscodeTracing(this.traces);
    // Tier lifecycles: expired assignments downgrade along their chain or are forgotten.
    this.tierTimer = setInterval(() => void this.tiers.tick().catch((error) => log.warn('tier tick:', error)), 3_600_000);
    this.tierTimer.unref();
    // Periodic endpoint tests for the jobs that want them (never client polling).
    this.endpointTimer = setInterval(() => void this.runEndpointTests().catch((error) => log.warn('endpoint tests:', error)), 30_000);
    this.reviewSyncTimer = setInterval(() => void this.runReviewSync().catch((error) => log.warn('review sync:', error)), 30_000);
    this.reviewSyncTimer.unref();
    this.endpointTimer.unref();
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
        this.traces.trace('error', 'provider.node', 'backend create failed', { error: (error as Error).message, data: { backend: config.id } });
      }
    }
    this.backendCache = { key, list };
    return list;
  }

  private createBackend(config: BackendConfig): BlobBackend {
    switch (config.type) {
      case 'memory':
        return new MemoryBackend(config.id, config, this.traces);
      case 'local':
        if (!this.options.dataDir && !isAbsolute(config.path)) return new MemoryBackend(config.id, config, this.traces);
        return new LocalBackend(config.id, config, this.options.dataDir, this.traces);
      case 's3':
        return new S3Backend(config.id, config, this.traces);
      case 'webdav':
        return new WebDavBackend(config.id, config, this.traces);
      case 'ipfs':
        return new IpfsBackend(config.id, config, this.traces);
      case 'http':
        return new HttpBackend(config.id, config, this.traces);
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
          },
          this.traces
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
    if (typeof config.review?.enabled !== 'boolean') throw badRequest('review.enabled must be true or false');
    const syncMinutes = Number(config.review?.syncMinutes);
    if (!Number.isFinite(syncMinutes) || syncMinutes < 0) throw badRequest('review.syncMinutes must be zero or a positive number of minutes');
    for (const ref of config.algorithmPeers?.refs ?? []) {
      const parsed = parseNodeRef(String(ref));
      if (!parsed || parsed.type !== 'algorithm') throw badRequest(`algorithmPeers: not an algorithm search node reference: ${String(ref).slice(0, 80)}`);
    }
    const ids = new Set<string>();
    for (const backend of config.storage.backends) {
      if (!backend.id || ids.has(backend.id)) throw badRequest('Storage backends need unique ids');
      ids.add(backend.id);
    }
    if (config.pricing.creatorShare < 0 || config.pricing.creatorShare > 1) throw badRequest('creatorShare is between 0 and 1');
    const tiers = config.tiers;
    if (tiers) {
      // A config without any tiers (an old or hand-edited one) always gets the stock plan
      // back — content must always have something to be set to.
      Object.assign(tiers, withDefaultTiers(tiers));
      const tierIds = new Set<string>();
      for (const tier of tiers.tiers ?? []) {
        if (!tier.id || tierIds.has(tier.id)) throw badRequest('Storage tiers need unique ids');
        if (tier.externalUrls < 0 || tier.pricePerMiB < 0 || tier.lifecycleDays < 0) throw badRequest('Tier numbers cannot be negative');
        if (tier.downgradeTo && !(tiers.tiers ?? []).some((other) => other.id === tier.downgradeTo)) {
          throw badRequest(`Tier ${tier.id} downgrades to a tier that does not exist`);
        }
        tierIds.add(tier.id);
      }
      if (tiers.tiers?.length && !tierIds.has(tiers.defaultTier)) throw badRequest('The default tier must be one of the tiers');
    }
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
      status: 'uploading' | 'running' | 'done' | 'error';
      /** Encoding progress on this node, 0–100 (what polling clients show). */
      progress: number;
      manifest?: Manifest;
      error?: string;
      warnings: string[];
      at: number;
    }
  >();

  /** Drops stale conversion states after retries/polled reads have had plenty of time. */
  private sweepVvshConverts(): void {
    const now = Date.now();
    for (const [id, job] of this.vvshConverts) {
      const lifetime = job.status === 'done' || job.status === 'error' ? 3_600_000 : 24 * 3_600_000;
      if (now - job.at > lifetime) this.vvshConverts.delete(id);
    }
  }

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
    // A copy this node already pulled from a client's link is kept here — its own address
    // for it comes first, so the bytes are served even when the offered URLs are down.
    if (this.downloads.data.items[cid]) out.push({ cid, url: `${this.sharedUrl()}/v1/downloads/${encodeURIComponent(cid)}` });
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
    const started = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        this.traces.trace('dependency', 'provider.node', 'content url pull failed', {
          message: `the endpoint answered ${response.status}`,
          data: this.traces.summarize({ cid: cid.slice(0, 16), url, method: 'GET', ms: Date.now() - started, status: response.status }),
        });
        return false;
      }
      data = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // Tolerated: one dead link just means the next one is tried.
      this.traces.trace('error', 'provider.node', 'content url pull failed', {
        error: (error as Error).message,
        data: this.traces.summarize({ cid: cid.slice(0, 16), url, method: 'GET', ms: Date.now() - started }),
      });
      return false;
    }
    // A native content id names its manifest, so a URL job hosts the whole file: the
    // manifest's chunk hashes prove it (exactly what verifyEndpoint accepts). A cid that
    // names a downloadable copy is proven by the bytes themselves.
    const manifest = this.store.getManifest(cid);
    const matches = bytesMatchCid(data, cid) || Boolean(manifest && bytesMatchManifest(data, manifest));
    if (!matches) {
      this.traces.trace('dependency', 'provider.node', 'content url pull failed', {
        message: 'the bytes do not match the content id',
        data: this.traces.summarize({ cid: cid.slice(0, 16), url, method: 'GET', ms: Date.now() - started, status: 200, bytes: data.length }),
      });
      return false; // the content does not match the cid
    }
    this.downloads.data.items[cid] = { data: data.toString('base64'), account: record.account, at: new Date().toISOString() };
    record.downloads++;
    const reward = Math.max(0, Math.round(this.config.contentUrls.creditPerDownload));
    if (reward > 0) {
      this.ledger.credit(record.account, reward, 'content download', cid);
      record.earned += reward;
    }
    this.traces.trace('dependency', 'provider.node', 'content url pulled', {
      data: this.traces.summarize({ cid: cid.slice(0, 16), url, method: 'GET', ms: Date.now() - started, status: 200, bytes: data.length, account: record.account.slice(0, 16), reward }),
    });
    this.contentUrls.changed();
    this.downloads.changed();
    return true;
  }

  /**
   * One chunk sliced out of the full copy pulled from a client's URL (the URL jobs flow).
   * The slice is only handed out when it hashes to the chunk id, so a stale or wrong copy
   * can never be served as content.
   */
  private chunkFromDownloadedCopy(cid: string, chunkId: string): Buffer | null {
    const item = this.downloads.data.items[cid];
    const manifest = this.store.getManifest(cid);
    if (!item || !manifest) return null;
    const data = Buffer.from(item.data, 'base64');
    let at = 0;
    for (const chunk of manifest.chunks) {
      if (chunk.id === chunkId) {
        const slice = data.subarray(at, at + chunk.size);
        return chunkIdOf(slice) === chunkId ? Buffer.from(slice) : null;
      }
      at += chunk.size;
    }
    return null;
  }

  /** Tries every accepted link for a cid, keeping the first whose content matches. */
  /** Tries every accepted link for a cid, keeping the first whose content matches.
   *  `preferAccount` walks one account's links first (the holder that just failed). */
  private async fetchContentUrl(cid: string, preferAccount?: string): Promise<boolean> {
    // Working endpoints are tried first: one that fails drops to the bottom of the list
    // until it starts answering again. When none of them works, the caller fails the job.
    const records = Object.values(this.contentUrls.data.items)
      .filter((record) => record.status === 'accepted')
      .sort(
        (a, b) =>
          Number(b.account === preferAccount) - Number(a.account === preferAccount) ||
          (a.fails ?? 0) - (b.fails ?? 0) ||
          (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0) ||
          b.createdAt.localeCompare(a.createdAt)
      );
    for (const record of records) {
      const url = record.cid === cid && record.url ? record.url : record.baseUrl ? `${record.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(cid)}` : undefined;
      if (!url) continue;
      if (await this.pullContentUrl(record, cid, url)) {
        record.fails = 0;
        this.contentUrls.changed();
        this.traces.trace('basic', 'provider.node', 'content url fetched', {
          data: { cid: cid.slice(0, 16), account: record.account.slice(0, 16) },
        });
        return true;
      }
      record.fails = (record.fails ?? 0) + 1;
      this.contentUrls.changed();
    }
    this.traces.trace('basic', 'provider.node', 'content url fetch', {
      message: 'no accepted link served this content',
      data: { cid: cid.slice(0, 16), tried: records.length },
    });
    return false;
  }

  /** Where a backend keeps its bytes: a directory on disk, a bucket URL, an API URL. */
  private backendLocation(id: string): string {
    const backend = this.config.storage.backends.find((entry) => entry.id === id);
    if (!backend) return id;
    if (backend.type === 'local') return isAbsolute(backend.path) ? backend.path : (this.path(backend.path) ?? backend.path);
    const remote = backend as { endpoint?: string; url?: string };
    return String(remote.endpoint ?? remote.url ?? id);
  }

  /**
   * Checks that an endpoint really serves a content: downloads it and verifies the
   * returned bytes against the expected hashes — every chunk of the content must hash
   * into the stream (or the whole blob must hash to the id). Nothing is kept; this is
   * a pure availability and integrity check. A test is only ever correct when the
   * returned chunks match the content id.
   */
  async verifyEndpoint(cid: string, url: string, timeoutMs = 30_000): Promise<EndpointCheck> {
    const target = url.startsWith('http') && !url.includes(' ') && url.endsWith(cid) ? url : `${url.replace(/\/+$/, '')}/${encodeURIComponent(cid)}`;
    // Every check is one call to the outside world: one dependency line for its outcome,
    // whichever way it went.
    let started = Date.now();
    const report = (result: EndpointCheck): EndpointCheck => {
      this.traces.trace('dependency', 'provider.node', 'endpoint check', {
        data: this.traces.summarize({
          cid: cid.slice(0, 16),
          url: target,
          method: 'GET',
          ms: Date.now() - started,
          status: result.ok ? 200 : result.status,
          ok: result.ok,
          bytes: result.bytes,
          matched: result.chunks?.matched,
          total: result.chunks?.total,
        }),
        error: result.error,
      });
      return result;
    };
    let data: Buffer;
    try {
      started = Date.now();
      const response = await fetch(target, { signal: AbortSignal.timeout(Math.max(50, timeoutMs)) });
      if (!response.ok) return report({ ok: false, url: target, bytes: 0, error: `The endpoint answered ${response.status}`, status: response.status });
      data = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.traces.trace('error', 'provider.node', 'endpoint check failed', { error: message, data: this.traces.summarize({ cid: cid.slice(0, 16), url: target, method: 'GET', ms: Date.now() - started }) });
      return report({ ok: false, url: target, bytes: 0, error: message });
    }
    const manifest = this.store.getManifest(cid);
    if (manifest?.chunks.length) {
      // The endpoint must serve the whole file: every chunk slice hashing to its id (the
      // shared helper), or a downloadable copy whose bytes hash to the cid itself.
      let start = 0;
      let matched = 0;
      for (const chunk of manifest.chunks) {
        const slice = data.subarray(start, start + chunk.size);
        start += chunk.size;
        if (chunkIdOf(slice) === chunk.id) matched++;
      }
      const chunks = { matched, total: manifest.chunks.length };
      if (bytesMatchManifest(data, manifest)) return report({ ok: true, url: target, bytes: data.length, chunks });
      if (bytesMatchCid(data, cid)) return report({ ok: true, url: target, bytes: data.length, chunks });
      return report({
        ok: false,
        url: target,
        bytes: data.length,
        chunks,
        error: `${chunks.total - chunks.matched} of ${chunks.total} chunks did not match the expected hashes`,
      });
    }
    if (!bytesMatchCid(data, cid)) {
      return report({ ok: false, url: target, bytes: data.length, error: 'The returned data does not match the expected hash' });
    }
    return report({ ok: true, url: target, bytes: data.length, chunks: { matched: 1, total: 1 } });
  }

  /**
   * Whether one account's submitted endpoints serve the job's content right now —
   * the gate for the upfront reward at acceptance (paid later, or never, when not).
   * A pure check: it never counts against the holder the way the job tests do.
   */
  private async endpointLiveFor(accountId: string, job: { cid?: string; maxLatencyMs?: number }): Promise<boolean> {
    if (!job.cid) return false;
    const records = Object.values(this.contentUrls.data.items)
      .filter((record) => record.account === accountId && Boolean(record.url ?? record.baseUrl))
      .sort((a, b) => (a.fails ?? 0) - (b.fails ?? 0) || (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0));
    for (const record of records) {
      // A single URL is only ever for its own content; a base URL serves any content.
      const target = record.cid === job.cid && record.url ? record.url : record.baseUrl ? `${record.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(job.cid)}` : undefined;
      if (!target) continue;
      const verify = await this.verifyEndpoint(job.cid, target, job.maxLatencyMs ?? 30_000);
      if (verify.ok) return true;
    }
    return false;
  }

  /**
   * Tests one storage job at its users' endpoints — never through the client's poll.
   * For each user the endpoint list is tried in order (best record first): the first
   * endpoint whose chunks match the content id wins and moves to the top of that user's
   * list. A failing endpoint counts a failed request (yellow once it reaches the job's
   * failure threshold); when every endpoint of a user fails, that user is red failed
   * and out of the job.
   */
  /**
   * A freshly offered URL is checked right away: when it serves the content, the holder
   * that offered it counts as live and the job reopens (this is what makes the dashboard
   * right at startup, instead of waiting for the 60-minute round). A URL that is not up
   * yet is only recorded — a fresh offer is not a failed check and never a strike.
   */
  private async probeOfferedContentUrl(record: ContentUrlRecord): Promise<void> {
    const cids = record.cid ? [record.cid] : this.jobCidsFor(record.account).slice(0, 20);
    let anyOk = false;
    for (const cid of cids) {
      const target =
        record.url && record.cid === cid
          ? record.url
          : record.baseUrl
            ? `${record.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(cid)}`
            : undefined;
      if (!target) continue;
      const verify = await this.verifyEndpoint(cid, target);
      if (!verify.ok) continue;
      anyOk = true;
      record.fails = 0;
      record.lastOkAt = Date.now();
      record.okCids = [...new Set([...(record.okCids ?? []), cid])].slice(-50);
      this.contentUrls.changed();
      const jobs = this.service.jobs().filter((job) => job.cid === cid);
      for (const job of jobs) {
        for (const assignment of this.service.assignmentsForAdmin().filter(
          (entry) => entry.jobId === job.id && entry.accountId === record.account
        )) {
          this.service.endpointLive(assignment.id);
        }
      }
      this.service.markEndpointTested(jobs.map((job) => job.id));
      this.traces.trace('basic', 'provider.node', 'offered content url served', {
        data: { account: record.account.slice(0, 16), cid: cid.slice(0, 16), jobs: jobs.length },
      });
    }
    // Only a content URL that failed is a recorded miss; for a base URL one content not
    // being served says nothing about the others, so its count is left alone.
    if (!anyOk && record.cid) {
      record.fails = (record.fails ?? 0) + 1;
      this.contentUrls.changed();
    }
  }

  /** The content ids this account holds an assignment for — what a base URL should serve. */
  private jobCidsFor(accountId: string): string[] {
    const cids = new Set<string>();
    for (const assignment of this.service.assignmentsForAdmin()) {
      if (assignment.accountId !== accountId) continue;
      const job = this.service.jobs().find((entry) => entry.id === assignment.jobId);
      if (job?.cid) cids.add(job.cid);
    }
    return [...cids];
  }

  /**
   * How many copies of a job are actually fulfilled right now: holders that are active,
   * plus holders still downloading whose offered URL already served the content.
   */
  private fulfilledHolders(job: { id: string; cid?: string }): number {
    const assignments = this.service
      .assignmentsForAdmin()
      .filter((a) => a.jobId === job.id && (a.status === 'active' || a.status === 'downloading'));
    return assignments.filter((a) => a.status === 'active' || this.servingUrlFor(a.accountId, job.cid)).length;
  }

  /** Whether one account has an accepted URL for this content that served it at least once. */
  private servingUrlFor(accountId: string, cid?: string): boolean {
    if (!cid) return false;
    return Object.values(this.contentUrls.data.items).some((record) => {
      if (record.account !== accountId || record.status !== 'accepted') return false;
      if (record.url !== undefined) {
        return record.cid === cid && (record.fails ?? 0) === 0 && record.lastOkAt !== undefined;
      }
      if (record.baseUrl === undefined) return false;
      // A base URL keeps success per content id (old records fall back to their last check).
      return record.okCids ? record.okCids.includes(cid) : (record.fails ?? 0) === 0 && record.lastOkAt !== undefined;
    });
  }

  async testStorageJob(jobId: string, onlyAccount?: string): Promise<JobTestResult> {
    const job = this.service.jobs().find((entry) => entry.id === jobId);
    if (!job) throw notFound('No such job');
    this.service.markEndpointTested([jobId]);
    // One summary per test run — the endpoint checks themselves trace one line each.
    const report = (result: JobTestResult): JobTestResult => {
      this.traces.trace('basic', 'provider.node', 'storage job test', {
        data: {
          job: jobId,
          account: result.account?.slice(0, 16),
          ok: result.ok,
          holders: result.holders.succeeded,
          holdersTotal: result.holders.total,
          checked: result.checked,
          total: result.total,
          matched: result.chunks?.matched,
          chunks: result.chunks?.total,
        },
        error: result.error,
      });
      return result;
    };
    const empty: JobTestResult = { ok: false, holders: { succeeded: 0, total: 0 }, urls: { served: 0, checked: 0 }, checked: 0, total: 0 };
    const cid = job.cid;
    if (!cid) return report({ ...empty, error: 'This job has no content id — there is nothing to fetch from its endpoints' });
    // Every row that exists for the job is tested — including ones the node had given up
    // on (removed, released, failed): the URL is the authority, and a check that serves
    // brings the copy back. Filtering by status made "Test storage job" answer "That user
    // is not part of this job" for a row the operator could see on screen.
    const holders = this.service
      .assignmentsForAdmin()
      .filter((assignment) => assignment.jobId === job.id && (!onlyAccount || assignment.accountId === onlyAccount));
    if (!holders.length) {
      return report({ ...empty, error: onlyAccount ? 'That user is not part of this job' : 'This job has no users to test yet' });
    }
    // A holder leaves the job only after this many consecutive failed checks — one
    // transient failure never destroys a holder.
    const threshold = Math.max(1, job.failedRequestsBeforeFailure ?? 3);
    let checked = 0;
    let total = 0;
    let servedUrls = 0;
    let succeeded = 0;
    const linkOutcomes: LinkOutcome[] = [];
    for (const holder of holders) {
      const records = Object.values(this.contentUrls.data.items)
        .filter((record) => record.account === holder.accountId && Boolean(record.url ?? record.baseUrl))
        .sort((a, b) => (a.fails ?? 0) - (b.fails ?? 0) || (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0));
      total += records.length;
      let served: { url: string; chunks?: { matched: number; total: number } } | null = null;
      const outcomes: LinkOutcome[] = [];
      for (const record of records) {
        checked++;
        const target = record.url ?? `${String(record.baseUrl).replace(/\/+$/, '')}/${encodeURIComponent(cid)}`;
        const verify = await this.verifyEndpoint(cid, target, job.maxLatencyMs ?? 30_000);
        if (verify.ok) {
          record.lastOkAt = Date.now();
          record.lastOutcome = 'success';
          served = { url: verify.url, chunks: verify.chunks };
          outcomes.push({ id: record.id, outcome: 'success' });
          break;
        }
        record.fails = (record.fails ?? 0) + 1;
        record.lastOutcome = 'failed';
        this.contentUrls.changed();
        outcomes.push({ id: record.id, outcome: 'failed' });
      }
      const tried = records.slice(0, outcomes.length);
      // The rows after the one that served were never reached: saying so keeps them from
      // looking like failures next to it. The outcome is kept on the record itself so it
      // survives the reload the admin console does after a test.
      for (const record of records.slice(outcomes.length)) {
        record.lastOutcome = 'not tested';
        outcomes.push({ id: record.id, outcome: 'not tested' });
      }
      this.contentUrls.changed();
      linkOutcomes.push(...outcomes);
      if (served) {
        succeeded++;
        servedUrls++;
        // A success wipes the failure history of the rows this run actually checked — the
        // rows it never reached keep theirs, so the history stays honest.
        for (const record of tried) record.fails = 0;
        this.contentUrls.changed();
        // The holder counts again (streak reset, a lost row restored) and the upfront
        // reward is paid if it was still owed.
        this.service.endpointLive(holder.id);
        if (onlyAccount) {
          return report({
            ok: true,
            account: holder.accountId,
            endpoint: served.url,
            chunks: served.chunks,
            holders: { succeeded: 1, total: 1 },
            urls: { served: 1, checked },
            checked,
            total,
            links: outcomes,
          });
        }
        continue;
      }
      // No endpoint served the content: a strike. The holder is removed only after
      // `threshold` strikes pile up with no success in between.
      if (records.length && this.service.noteFailedCheck(holder.id) >= threshold) {
        this.service.failHolder(holder.id);
      }
    }
    return report({
      ok: succeeded > 0,
      holders: { succeeded, total: holders.length },
      urls: { served: servedUrls, checked },
      checked,
      total,
      links: linkOutcomes,
      // A partial success is a success: only a run where nothing served is an error.
      error: succeeded > 0 ? undefined : onlyAccount ? `No endpoint of ${onlyAccount} served the content (${checked} tried)` : 'No endpoint served the content',
    });
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
        } catch (error) {
          // One unreachable peer must not stop the round — counted, traced, carried on.
          errors++;
          this.traces.trace('error', 'provider.node', 'peer sync error', {
            error: (error as Error).message,
            data: { peer: peer.ref.slice(0, 48) },
          });
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
    this.traces.trace('basic', 'provider.node', 'peer sync round', { data: { sent, received, errors } });
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

  /** Moderation entries travel with the same peers content syncs with. */
  protected moderationPeers(): string[] {
    return this.config.peering.peers.map((peer) => peer.ref);
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
      const client = this.peerClient(peer);
      const path = `/v1/peers/chunks/${encodeURIComponent(id)}`;
      const started = Date.now();
      try {
        const response = await client.fetch(path, { timeoutMs: 30_000 });
        const data = Buffer.from(await response.arrayBuffer());
        if (chunkIdOf(data) === id) {
          this.traces.trace('dependency', 'provider.node', 'peer chunk fetched', {
            data: this.traces.summarize({ peer: peer.ref.slice(0, 48), url: `${client.url}${path}`, method: 'GET', ms: Date.now() - started, status: response.status, chunk: id.slice(0, 12), bytes: data.length }),
          });
          return data;
        }
        this.traces.trace('error', 'provider.node', 'peer chunk fetch failed', {
          message: 'the bytes did not match the chunk id',
          data: this.traces.summarize({ peer: peer.ref.slice(0, 48), url: `${client.url}${path}`, method: 'GET', ms: Date.now() - started, chunk: id.slice(0, 12) }),
        });
      } catch (error) {
        log.debug(`Peer has no chunk ${id.slice(0, 12)}: ${(error as Error).message}`);
        this.traces.trace('error', 'provider.node', 'peer chunk fetch failed', {
          error: (error as Error).message,
          data: this.traces.summarize({ peer: peer.ref.slice(0, 48), url: `${client.url}${path}`, method: 'GET', ms: Date.now() - started, chunk: id.slice(0, 12) }),
        });
      }
    }
    return null;
  }

  /**
   * A client for a provider the admin named on a manual sync — not necessarily a peer
   * configured on this node. Kept per ref: a full-catalog sync asks the same target once
   * per content, and a fresh client would sign in again every time.
   */
  private adHocClient(ref: string): NodeClient {
    const existing = this.adHocClients.get(ref);
    if (existing) return existing;
    const parsed = parseNodeRef(ref)!;
    const client = new NodeClient({
      url: parsed.url,
      expectedId: parsed.id,
      expectedType: 'provider',
      auth: 'identity',
      identity: this.identity,
      transport: () => this.transport(parsed.url),
    });
    this.adHocClients.set(ref, client);
    return client;
  }

  /**
   * Sends one content to one provider: every chunk the target lacks (asked for first, so
   * nothing already there moves twice), then the manifest without which the target cannot
   * serve the content. Cheap and idempotent to re-run — the manual sync in the admin GUI
   * continues interrupted transfers this way. Trouble on the target comes back as `error`
   * alongside whatever did move, so the caller can show progress and retry.
   */
  async pushItem(ref: string, cid: string): Promise<PushItemResult> {
    const manifest = this.store.getManifest(cid);
    if (!manifest) throw notFound('No such content on this node');
    const client = this.adHocClient(ref);
    const result: PushItemResult = { ref, cid, sent: 0, skipped: 0, missing: 0, bytes: 0, manifest: false };
    const moved = new Set<string>();
    try {
      // The target answers per chunk id and caps a question at 500 ids: ask in batches.
      const has: Record<string, boolean> = {};
      const ids = [...new Set(manifest.chunks.map((chunk) => chunk.id))];
      for (let index = 0; index < ids.length; index += 500) {
        const answer = await client.json<{ has: Record<string, boolean> }>('/v1/peers/has', {
          body: { ids: ids.slice(index, index + 500) },
          timeoutMs: 30_000,
        });
        Object.assign(has, answer.has);
      }
      for (const chunk of manifest.chunks) {
        // A manifest can name the same bytes twice; they move once.
        if (moved.has(chunk.id)) {
          result.skipped++;
          continue;
        }
        moved.add(chunk.id);
        if (has[chunk.id]) {
          result.skipped++;
          continue;
        }
        const data = await this.store.getChunk(chunk.id, { peers: false });
        if (!data) {
          // This node cannot read its own copy (a backend is down): the target stays
          // missing the chunk, and a later run sends it when the backend is back.
          result.missing++;
          continue;
        }
        await client.fetch(`/v1/peers/chunks/${chunk.id}`, { method: 'PUT', raw: data, timeoutMs: 120_000 });
        result.sent++;
        result.bytes += data.length;
      }
    } catch (error) {
      this.traces.trace('error', 'provider.node', 'content push failed', {
        error: (error as Error).message,
        data: { ref: ref.slice(0, 48), cid: cid.slice(0, 16), sent: result.sent, missing: result.missing },
      });
      return { ...result, error: (error as Error).message };
    }
    try {
      await client.json(`/v1/peers/manifests/${encodeURIComponent(cid)}`, { method: 'PUT', body: manifest, timeoutMs: 60_000 });
      result.manifest = true;
    } catch (error) {
      this.traces.trace('error', 'provider.node', 'content push failed', {
        error: (error as Error).message,
        message: 'the manifest did not land on the target',
        data: { ref: ref.slice(0, 48), cid: cid.slice(0, 16), sent: result.sent, missing: result.missing },
      });
      return { ...result, error: (error as Error).message };
    }
    this.traces.trace('basic', 'provider.node', 'content pushed', {
      data: { ref: ref.slice(0, 48), cid: cid.slice(0, 16), sent: result.sent, skipped: result.skipped, missing: result.missing, bytes: result.bytes },
    });
    return result;
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
    registerRemovalRoutes(this);

    router.get('/v1/content/:cid', async (ctx) => {
      const cid = ctx.params.cid;
      // Content waiting for review is invisible: treated exactly like content this
      // node never heard of (links and 404 included). Someone wants it now though —
      // worth asking the trusted algorithm nodes once more, since their listing may
      // have landed after the push (the usual order is upload first, submit second).
      const pending = this.store.isPending(cid);
      if (pending) this.autoAcceptReviewed(cid);
      const manifest = pending ? undefined : await this.getManifest(cid);
      if (!manifest) {
        // Feature: this node does not hold the content, but a client's link may. Send the
        // link instead so the client can fetch the bytes and check the cid itself.
        const links = this.linksFor(cid);
        if (links.length) return { missing: true, links };
        throw notFound('This node does not have the content');
      }
      const price = this.config.pricing.manifest;
      // A priced manifest is the account's alone; a free one can sit in shared caches.
      const headers = immutableHeaders(cid, { scope: price > 0 ? 'private' : 'public' });
      if (ctx.req.method === 'HEAD') {
        ctx.res.writeHead(200, { 'content-type': 'application/json', ...headers }).end();
        return;
      }
      const account = price > 0 ? this.auth.require(ctx) : undefined;
      // Revalidating clients already hold the manifest: answer 304 instead of sending
      // — and charging for — a body they do not receive.
      if (notModified(ctx, cid)) return;
      if (account) this.ledger.debit(account.id, price, 'manifest', cid);
      sendJson(ctx.res, 200, manifest, headers);
      return undefined;
    });

    router.post('/v1/has', async (ctx) => {
      const body = await readJson<{ ids?: string[] }>(ctx.req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
      // Pending-review content is not advertised: it answers like unknown content.
      return { has: Object.fromEntries(ids.map((id) => [id, Boolean(this.store.getContent(String(id))) && !this.store.isPending(String(id))])) };
    });

    // ---- developer builds only: a static data host for testing the URL flows locally.
    // Packaged releases (NODE_ENV=production) never register these routes.
    if (isDevBuild()) {
      const devHost = new JsonFile<{ files: Record<string, string> }>(this.path('dev-host.json'), () => ({ files: {} }));
      router.put('/v1/dev/host/:cid', async (ctx) => {
        this.auth.require(ctx);
        const data = await readBody(ctx.req, 64 * 1024 * 1024);
        const cid = String(ctx.params.cid ?? '');
        if (bytesCid(data) !== cid) throw badRequest('The bytes do not hash to this cid');
        devHost.data.files[cid] = Buffer.from(data).toString('base64');
        devHost.changed();
        return { ok: true, cid, size: data.length };
      });
      router.get('/v1/dev/host', () => ({
        files: Object.entries(devHost.data.files).map(([cid, data]) => ({ cid, size: Buffer.from(data, 'base64').length })),
      }));
      const serve = (ctx: Ctx) => {
        const kept = devHost.data.files[String(ctx.params.cid ?? '')];
        if (!kept) throw notFound('Nothing hosted under that cid');
        const data = Buffer.from(kept, 'base64');
        ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length) }).end(data);
        return undefined;
      };
      router.get('/v1/dev/host/:cid', serve);
      // The base-URL shape: a client may offer `<base>`, and the provider queries `<base>/<cid>`.
      router.get('/v1/dev/host/base/:cid', serve);
    }

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
      // An accepted URL is an external backup for its content's tier (the domain rule
      // decides how much it counts for).
      if (record.status === 'accepted' && record.cid && record.url) this.tiers.recordUrl(record.cid, record.url);
      // A client that hands over a URL is usually the holder of one of this node's jobs:
      // probe it at once so the job shows the copy as working without waiting for the
      // schedule (a fresh offer is never a strike when the URL is simply not up yet).
      if (record.status === 'accepted') void this.probeOfferedContentUrl(record).catch(() => undefined);
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
      if (record.status === 'accepted' && record.cid && record.url) this.tiers.recordUrl(record.cid, record.url);
      return { record };
    });

    // Storage tiers: any user can see what tier a content is on and when its lifecycle
    // ends, and send credits to raise the tier or extend the lifecycle.
    router.get('/v1/content/:cid/tier', (ctx) => {
      const cid = String(ctx.params.cid).split('~')[0];
      // Content not assigned yet still shows its upgrade menu — a user can buy the first
      // tier with credits through the same route.
      const state = this.tiers.stateOf(cid) ?? this.tiers.preview(cid, this.store.getContent(cid)?.size ?? 0);
      return { tier: state };
    });
    router.post('/v1/content/:cid/tier', async (ctx) => {
      const account = this.auth.require(ctx);
      const cid = String(ctx.params.cid).split('~')[0];
      const body = await readJson<{ tier?: string; extendDays?: number }>(ctx.req);
      if (!body.tier && !(body.extendDays && body.extendDays > 0)) throw badRequest('tier or extendDays is required');
      if (body.tier && !this.tiers.tier(body.tier)) throw badRequest('No such tier on this node');
      try {
        return this.tiers.chargeTier(account.id, cid, body);
      } catch (error) {
        throw badRequest((error as Error).message);
      }
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
      // Bytes that only pending-review content claims are not advertised to peers.
      return { has: Object.fromEntries(ids.map((id) => [String(id), this.store.hasChunk(String(id)) && this.store.servesChunk(String(id))])) };
    });

    router.get('/v1/peers/chunks/:id', async (ctx) => {
      this.requirePeer(ctx, 'send');
      const id = ctx.params.id;
      if (!isChunkId(id)) throw badRequest('Not a chunk id');
      if (!this.store.hasChunk(id)) throw notFound('This node does not have the chunk');
      // Peer exchange is account-scoped: only the peer's own caches may keep the bytes.
      if (notModified(ctx, id)) return;
      const data = await this.store.getChunk(id, { peers: false });
      if (!data) throw notFound('This node does not have the chunk');
      ctx.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        ...immutableHeaders(id, { scope: 'private' }),
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
      // The ack names what the content-addressed URL now holds: exactly these bytes.
      sendJson(ctx.res, 200, { ok: true }, immutableHeaders(id, { scope: 'private' }));
      return undefined;
    });

    // A peer pushing content here sends the manifest as well: chunks without it cannot be
    // served. It is registered like a finished upload once every chunk has landed — or
    // earlier, with the rest still on its way, so the pushes that follow complete it.
    router.put('/v1/peers/manifests/:cid', async (ctx) => {
      const peer = this.requirePeer(ctx, 'receive');
      if (!this.config.peering.acceptPush) throw forbidden('This node does not accept pushed content');
      const cid = ctx.params.cid;
      const body = await readJson<unknown>(ctx.req, 64 * MiB);
      let manifest: Manifest;
      try {
        manifest = validateManifest(body);
      } catch (error) {
        throw badRequest((error as Error).message);
      }
      if (contentIdOf(manifest) !== cid) throw badRequest('The manifest does not match the content id');
      const complete = manifest.chunks.every((chunk) => this.store.hasChunk(chunk.id));
      const isNew = !this.store.getContent(cid);
      // Pushed content waits for the operator's review, like client uploads; the
      // accept route (or a disabled queue) makes it live and gives it its job.
      const review = this.config.review.enabled ? 'pending' : undefined;
      if (complete) {
        await this.store.addContent(manifest, peer.id, review);
        // New content earns its storage job once, like an upload or an import (a repeat
        // push of the same manifest must not open a second job).
        if (isNew) this.autoJob(cid, manifest);
      } else {
        this.store.adopt(manifest, peer.id, review);
      }
      // A trusted algorithm node's listing can clear the queue on its own.
      this.autoAcceptReviewed(cid);
      return { ok: true, cid, review: this.store.isPending(cid) ? 'pending' : 'accepted' };
    });

    router.get('/v1/quote/:cid', (ctx) => {
      const cid = ctx.params.cid;
      const content = this.store.isPending(cid) ? undefined : this.store.getContent(cid);
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
      // Bytes that only pending-review content claims are not served — as unknown.
      if (!record || !this.store.servesChunk(id)) throw notFound('This node does not have the chunk');
      const account = this.auth.account(ctx);
      // Check the price before reading, so an account without credits costs no backend traffic.
      const price = this.chunkPrice(record.size, cid);
      if (price > 0 && !account) throw unauthorized('An account is needed to download from this node');
      // Paid bytes are the account's alone (their balance rides on the reply); free
      // reads can sit in shared caches.
      const headers = immutableHeaders(id, { scope: account ? 'private' : 'public' });
      // The client already holds this exact chunk: no body, no backend read, no charge.
      if (notModified(ctx, id)) return;
      const data = await this.store.getChunk(id);
      if (!data) throw new HttpError(503, 'unavailable', 'The chunk is stored but no backend can read it right now');
      if (ctx.req.method === 'HEAD') {
        ctx.res.writeHead(200, { 'content-length': data.length, 'x-vs-price': String(price), ...headers }).end();
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
        ...headers,
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
      this.traces.trace('basic', 'provider.node', 'upload accepted', {
        data: { cid: cid.slice(0, 16), chunks: manifest.chunks.length, bytes: manifest.size, missing: missing.length, cost },
      });
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
      if (this.store.getContent(cid)) return { cid, status: this.store.isPending(cid) ? 'pending' : 'ready' };
      const upload = this.pendingUpload(ctx, cid);
      const missing = upload.manifest.chunks.filter((chunk) => !this.store.hasChunk(chunk.id)).map((chunk) => chunk.id);
      if (missing.length) throw new HttpError(409, 'incomplete', `${missing.length} chunks are still missing`, { missing });
      const settings = this.config.pricing.upload;
      if (upload.uploader !== 'operator' && settings.mode === 'paid') {
        const cost = Math.ceil((upload.manifest.size / MiB) * settings.perMiB);
        if (cost > 0) this.ledger.debit(upload.uploader, cost, 'upload', cid);
      }
      // Pushed content waits for the operator's review; autoJob below skips it until
      // the accept route runs it. Operator imports never land here.
      await this.store.addContent(upload.manifest, upload.uploader, this.config.review.enabled ? 'pending' : undefined);
      delete this.uploads.data.uploads[cid];
      this.uploads.changed();
      this.autoJob(cid, upload.manifest);
      // A trusted algorithm node's listing can clear the queue on its own — off the
      // response path, so a slow lookup never delays the upload.
      this.autoAcceptReviewed(cid);
      this.traces.trace('basic', 'provider.node', 'upload committed', {
        data: { cid: cid.slice(0, 16), chunks: upload.manifest.chunks.length, bytes: upload.manifest.size, uploader: upload.uploader.slice(0, 16), review: this.store.isPending(cid) },
      });
      if (!this.options.quietLogs) log.info(`Stored ${upload.manifest.name} (${cid.slice(0, 16)}…, ${(upload.manifest.size / MiB).toFixed(1)} MiB)`);
      return { cid, status: this.store.isPending(cid) ? 'pending' : 'ready' };
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
      this.sweepVvshConverts();
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
        status: 'uploading',
        progress: 0,
        warnings: [],
        at: Date.now(),
      });
      return { jobId, quote };
    });

    router.put('/v1/vvsh/convert/:jobId/piece', async (ctx) => {
      const account = this.auth.require(ctx);
      const job = this.vvshConverts.get(String(ctx.params.jobId));
      if (!job || job.account !== account.id) throw notFound('No such conversion job');
      if (job.status !== 'uploading') throw badRequest('This conversion has already finished uploading');
      const piece = await readBody(ctx.req, 16 * MiB);
      const index = Number(ctx.query.get('index') ?? -1);
      if (Number.isInteger(index) && index >= 0) {
        if (index >= Math.max(1, Math.ceil(job.declared / (2 * MiB)))) throw badRequest('Piece index is outside the declared upload');
        const previous = job.pieces[index];
        if (previous) {
          if (!previous.equals(piece)) throw badRequest('A different piece was already uploaded at this index');
          return { ok: true, bytes: job.bytes, duplicate: true };
        }
        if (job.bytes + piece.length > job.declared) throw badRequest('More video bytes than the job declared');
        job.pieces[index] = piece;
      } else {
        if (job.bytes + piece.length > job.declared) throw badRequest('More video bytes than the job declared');
        job.pieces.push(piece);
      }
      job.bytes = job.pieces.reduce((total, part) => total + (part?.length ?? 0), 0);
      if (job.bytes > job.declared) throw badRequest('More video bytes than the job declared');
      return { ok: true, bytes: job.bytes };
    });

    const conversionState = (job: {
      status: string;
      progress?: number;
      manifest?: Manifest;
      quote: VvshConvertQuote;
      error?: string;
      warnings: string[];
    }) => ({
      status: job.status,
      progress: job.progress ?? 0,
      manifest: job.manifest,
      quote: job.quote,
      error: job.error,
      warnings: job.warnings,
    });

    // Starting and finishing are separate: large conversions never hold one HTTP request
    // open. Both routes are idempotent so one retry cannot charge or encode twice.
    router.post('/v1/vvsh/convert/:jobId/finish', async (ctx) => {
      const account = this.auth.require(ctx);
      const jobId = String(ctx.params.jobId);
      this.sweepVvshConverts();
      const job = this.vvshConverts.get(jobId);
      if (!job || job.account !== account.id) throw notFound('No such conversion job');
      if (job.status === 'uploading') {
        if (job.bytes !== job.declared || Array.from({ length: job.pieces.length }, (_, index) => job.pieces[index]).some((piece) => !piece)) {
          throw badRequest('The video is not fully uploaded');
        }
        job.status = 'running';
        job.at = Date.now();
        void (async () => {
          try {
            if ((await vvshEncoderBackend()) !== 'ffmpeg') {
              job.warnings.push('FFmpeg with VP9/Opus is unavailable on this provider; conversion used the slower Mediabunny fallback');
            }
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
                onProgress: (percent) => {
                  job.progress = percent;
                  job.at = Date.now();
                },
              },
              async (hash, data) => {
                await this.store.putChunk(hash, Buffer.from(data));
              }
            );
            job.manifest = manifest;
            job.status = 'done';
            job.progress = 100;
            log.info(`Converted ${manifest.name} for ${account.id} into a .vvsh stream (${job.quote.credits} credits)`);
          } catch (error) {
            job.error = error instanceof Error ? error.message : String(error);
            job.status = 'error';
            // The catch keeps the failure on the job (polled by the client) — traced
            // here as well, because that state is the only report it gets.
            this.traces.trace('error', 'provider.node', 'conversion failed', {
              error: job.error,
              data: { job: jobId, account: account.id.slice(0, 16), bytes: job.declared },
            });
          } finally {
            job.at = Date.now();
          }
        })();
      }
      return conversionState(job);
    });

    router.get('/v1/vvsh/convert/:jobId', (ctx) => {
      const account = this.auth.require(ctx);
      this.sweepVvshConverts();
      const job = this.vvshConverts.get(String(ctx.params.jobId));
      if (!job || job.account !== account.id) throw notFound('No such conversion job');
      return conversionState(job);
    });

    router.put('/v1/vvsh/manifest', async (ctx) => {
      const account = this.auth.require(ctx);
      const body = await readJson<{ manifest?: Manifest }>(ctx.req, 2 * 1024 * 1024);
      const manifest = validateManifest(body.manifest);
      if (!manifest.vvsh) throw badRequest('This manifest carries no vvsh stream');
      // Pushed content waits for review like any other upload — the operator accepts
      // it in the Review tab, or a trusted algorithm node's listing clears it.
      await this.store.addContent(manifest, account.id, this.config.review.enabled ? 'pending' : undefined);
      const cid = contentIdOf(manifest);
      if (this.config.tiers.auto && !this.store.isPending(cid)) {
        this.tiers.assign(cid, this.store.getContent(cid)?.size ?? 0, manifest.meta?.title ?? manifest.name);
      }
      this.autoAcceptReviewed(cid);
      return { cid, status: this.store.isPending(cid) ? 'pending' : 'ready' };
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
      this.traces.trace('basic', 'provider.node', 'catalog built', { data: { offset, limit, items: items.length } });
      return { items, next: items.length === limit ? offset + limit : undefined };
    });

    this.serviceRoutes();
    this.adminRoutes();
  }

  private autoJob(cid: string, manifest: Manifest): void {
    // Content waiting for review earns no job — the accept route runs this again.
    if (this.store.isPending(cid)) return;
    // With automatic tiers on, the content's tier decides the storage job (syncTierJob
    // below runs when the tier assignment lands) — no second, plan-less job.
    const assigned = this.config.tiers.auto
      ? this.tiers.assign(cid, this.store.getContent(cid)?.size ?? 0, manifest.meta?.title ?? manifest.name)
      : undefined;
    if (assigned) {
      this.traces.trace('basic', 'provider.node', 'auto job', {
        message: 'the tier plan owns this content',
        data: { cid: cid.slice(0, 16), tier: assigned.tier },
      });
      return;
    }
    const auto = this.config.storageService.auto;
    if (!this.config.storageService.enabled || !auto.enabled) return;
    const job = this.service.createJob({
      cid,
      title: manifest.meta?.title ?? manifest.name,
      chunks: manifest.chunks,
      replicas: auto.replicas,
      durationSeconds: auto.durationDays * 86400,
      rewards: auto.rewards,
      requireIdentity: auto.requireIdentity,
    });
    this.traces.trace('basic', 'provider.node', 'auto job', {
      message: 'automatic storage job opened',
      data: { cid: cid.slice(0, 16), job: job.id, replicas: auto.replicas },
    });
  }

  /**
   * Keeps one storage job per tier-assigned content, shaped by the tier's plan: created
   * when the content lands on a tier, resized when it changes tier, deleted with it.
   * The job's replicas are the copies the plan wants (local media + URL backups).
   */
  private syncTierJob(cid: string): void {
    // Content waiting for review has no job to follow a tier yet.
    if (this.store.isPending(cid)) return;
    // A tier change replaces the content's job wholesale — the old terms end and the
    // plan's own job opens (or nothing, when no tier wants copies anymore).
    for (const job of this.service.jobs()) {
      if (job.cid === cid) this.service.deleteJob(job.id);
    }
    if (!this.config.tiers.enabled || !this.config.storageService.enabled) return;
    const state = this.tiers.stateOf(cid);
    const manifest = this.store.getManifest(cid);
    if (!state || !manifest?.chunks.length) return;
    const copies =
      Object.values(state.plan.media).reduce((sum, count) => sum + count, 0) + (state.plan.externalUrls ?? 0);
    if (copies <= 0) return;
    // The tier's own storage job settings: the per-MiB retrieval reward is scaled to
    // the content's size, the rest is taken as-is.
    const settings = tierJob(state.plan);
    const mib = Math.max(1, Math.round((manifest.size ?? 0) / MiB));
    const job = this.service.createJob({
      cid,
      title: manifest.meta?.title ?? manifest.name,
      chunks: manifest.chunks,
      replicas: Math.max(1, copies),
      durationSeconds: Math.max(86_400, (state.daysLeft ?? 90) * 86_400),
      rewards: {
        upfront: settings.upfrontCredits,
        perRetrieval: Math.round(settings.perMbRetrieval * mib),
        completion: settings.endOfTerm,
      },
      retrievalIntervalSeconds: Math.max(0, settings.retrievalTestEveryMinutes) * 60,
      maxLatencyMs: settings.maxLatencyMs,
      failedRequestsBeforeFailure: settings.failedRequestsBeforeFailure,
      requireIdentity: this.config.storageService.auto.requireIdentity,
      managed: true,
    });
    this.traces.trace('basic', 'provider.node', 'tier job synced', {
      data: { cid: cid.slice(0, 16), tier: state.tier, job: job.id, copies },
    });
  }

  /**
   * Periodic endpoint tests: each job's users' endpoints are fetched on the job's own
   * schedule ("retrieval test every"). The data is only ever checked at the endpoints —
   * never by polling a client for it. `all` runs one round over every job right now
   * (the startup refresh), ignoring the schedules.
   */
  private async runEndpointTests(all = false): Promise<void> {
    const now = Date.now();
    for (const job of this.service.jobs()) {
      const every = (job.retrievalIntervalSeconds ?? 0) * 1000;
      if (!all && (every <= 0 || job.status !== 'open')) continue;
      // A job that was never tested is tested at once — waiting a full interval from its
      // creation is why a fresh job showed "Last endpoint test: never" for an hour.
      if (!all && job.lastEndpointTestAt !== undefined && now - job.lastEndpointTestAt < every) continue;
      this.service.markEndpointTested([job.id], now);
      try {
        await this.testStorageJob(job.id);
      } catch (error) {
        log.debug('endpoint tests:', (error as Error).message);
        this.traces.trace('error', 'provider.node', 'endpoint test failed', {
          error: (error as Error).message,
          data: { job: job.id },
        });
      }
    }
  }

  private serviceRoutes(): void {
    const router = this.router;
    const base = '/v1/services/storage';
    router.get(`${base}/offers`, (ctx) => ({ offers: this.service.offers(this.auth.require(ctx)) }));
    router.post(`${base}/offers/:jobId/accept`, (ctx) =>
      this.service.accept(this.auth.require(ctx), ctx.params.jobId, (accountId, job) => this.endpointLiveFor(accountId, job))
    );
    router.get(`${base}/assignments`, (ctx) => {
      const account = this.auth.require(ctx);
      return {
        assignments: this.service.mine(account).map((assignment) => ({
          ...assignment,
          // The URL backups this account offers for the job's content (full URLs and
          // base URLs, which serve any content).
          links: Object.values(this.contentUrls.data.items)
            .filter((record) => record.account === account.id && (!record.cid || record.cid === assignment.cid))
            .map(({ id, url, baseUrl, status }) => ({ id, url, baseUrl, status })),
        })),
      };
    });
    router.get(`${base}/assignments/:id/chunks/:chunkId`, async (ctx) => {
      const account = this.auth.require(ctx);
      try {
        const data = await this.service.assignmentChunk(account, ctx.params.id, ctx.params.chunkId);
        ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
      } catch (error) {
        // The job exists but this node no longer holds the bytes (its copies were released,
        // or the job was opened for content it never stored). The URL jobs a client uploaded
        // are the fallback: pull the content from them, then serve the chunk from that copy.
        // Without this a holder can never fill such a job — it sits at 0/N forever, and the
        // client's storage worker keeps asking for chunks the node cannot answer.
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        const assignment = this.service.assignmentsForAdmin().find((entry) => entry.id === ctx.params.id);
        const cid = assignment ? this.service.jobs().find((job) => job.id === assignment.jobId)?.cid : undefined;
        if (!cid) throw error;
        let data = this.chunkFromDownloadedCopy(cid, ctx.params.chunkId);
        if (!data) {
          const offered = Object.values(this.contentUrls.data.items).some(
            (record) => record.status === 'accepted' && (!record.cid || record.cid === cid) && (record.url ?? record.baseUrl)
          );
          if (offered && (await this.fetchContentUrl(cid, account.id))) data = this.chunkFromDownloadedCopy(cid, ctx.params.chunkId);
        }
        if (!data) throw error;
        ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
      }
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
      const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
      if (!q) return { items: this.store.list(offset, limit), total: this.store.stats().contents, stats: this.store.stats() };
      // A search looks through the catalog (up to a sane cap) for the content id, the
      // file or title name, and the account that uploaded it.
      const matched = this.store
        .list(0, 5000)
        .filter(
          (record) =>
            record.cid.toLowerCase().includes(q) ||
            record.name.toLowerCase().includes(q) ||
            (record.title ?? '').toLowerCase().includes(q) ||
            record.uploader.toLowerCase().includes(q)
        );
      return { items: matched.slice(offset, offset + limit), total: matched.length, stats: this.store.stats() };
    });
    // The review queue: content pushed here from outside, waiting for the operator.
    // Registered before /v1/admin/content/:cid so the static path wins the match.
    router.get('/v1/admin/content/review', (ctx) => {
      this.requireAdmin(ctx);
      const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0));
      const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') ?? 100)));
      const pending = this.store.pendingContent();
      return { items: pending.slice(offset, offset + limit), total: pending.length };
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
        // The storage picture of this content: its tier and lifecycle, every job made for
        // it (with the accounts holding copies and the links those accounts offer), and
        // the media its bytes sit on.
        tier: this.tiers.stateOf(cid),
        // Every URL backup offered for this content (or by base URL for any content),
        // working endpoints first.
        urls: Object.values(this.contentUrls.data.items)
          .filter((record) => record.status === 'accepted' && (!record.cid || record.cid === cid))
          .sort((a, b) => (a.fails ?? 0) - (b.fails ?? 0))
          .map((record) => ({
            id: record.id,
            cid: record.cid,
            url: record.url,
            baseUrl: record.baseUrl,
            status: record.status,
            account: record.account,
            fails: record.fails ?? 0,
            location: record.url ?? `${record.baseUrl ?? ''}/${encodeURIComponent(cid)}`,
          })),
        jobs: this.service
          .jobs()
          .filter((job) => job.cid === cid)
          .map(({ chunkIds: _chunkIds, holders: _holders, assignments: _assignments, ...job }) => ({
            ...job,
            holders: this.service
              .assignmentsForAdmin()
              .filter((assignment) => assignment.jobId === job.id)
              .map(({ chunkIds: _chunkIds, ...assignment }) => ({
                ...assignment,
                links: Object.values(this.contentUrls.data.items)
                  .filter((record) => record.account === assignment.accountId)
                  .sort((a, b) => (a.fails ?? 0) - (b.fails ?? 0))
                  .map(({ id, cid: linkCid, url, baseUrl, status, fails, lastOutcome }) => ({
                    id,
                    cid: linkCid,
                    url,
                    baseUrl,
                    status,
                    fails: fails ?? 0,
                    lastOutcome,
                  })),
              })),
          })),
        media: [...new Set((manifest?.chunks ?? []).flatMap((chunk) => Object.keys(this.store.chunkRecord(chunk.id)?.locations ?? {})))].map(
          (id) => ({
            id,
            type: this.config.storage.backends.find((backend) => backend.id === id)?.type ?? 'unknown',
            medium: this.config.tiers.media?.find((entry) => (entry.backends ?? []).includes(id))?.label,
            location: this.backendLocation(id),
          })
        ),
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
      return {
        peers: this.config.peering.peers,
        // The same relationships in the vocabulary every node kind shares (src/shared/peering.ts),
        // so a fork's admin UI does not have to learn send/receive vs fetch/serve.
        links: this.config.peering.peers.map(peerLinkFromProvider),
        acceptPush: this.config.peering.acceptPush,
        sync: this.config.peering.sync,
      };
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
      const cid = String(body.cid ?? '');
      if (!this.store.getManifest(cid)) throw notFound('No such content on this node');
      const targets = this.config.peering.peers.filter((peer) => peer.send && (!body.peer || peer.ref === body.peer));
      if (!targets.length) throw badRequest('No peer set to send to');
      const results: { peer: string; sent: number; skipped: number; error?: string }[] = [];
      for (const peer of targets) {
        // Pushing sends the manifest too, so the peer can serve what it receives.
        const pushed = await this.pushItem(peer.ref, cid);
        results.push({ peer: peer.ref, sent: pushed.sent, skipped: pushed.skipped + pushed.missing, error: pushed.error });
      }
      this.traces.trace('basic', 'provider.node', 'peers push', { data: { cid: cid.slice(0, 16), peers: targets.length, sent: results.reduce((sum, r) => sum + r.sent, 0) } });
      return { results };
    });
    // Manual content sync (admin GUI): one content to one provider the admin named — a
    // peer configured here or not. The GUI walks the catalog pair by pair with this call,
    // shows what moves to each target and re-runs what is still missing: every call only
    // sends what the target lacks, so re-running is cheap and idempotent.
    router.post('/v1/admin/peers/push-item', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ ref?: string; cid?: string }>(ctx.req);
      const ref = String(body.ref ?? '').trim();
      const parsed = parseNodeRef(ref);
      if (!parsed || parsed.type === 'algorithm') throw badRequest('ref must be a content provider node reference (vs:provider:…@url or a plain URL)');
      return this.pushItem(ref, String(body.cid ?? ''));
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
      this.traces.trace('basic', 'provider.node', 'peers fetch', { data: { cid: String(body.cid ?? '').slice(0, 16), fetched, missing } });
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
      // Deleting content deletes its storage jobs with it (see removeContent).
      if (!(await this.removeContent(ctx.params.cid))) throw notFound('No such content');
      return { ok: true };
    });
    // The review queue's verdicts: accept publishes the content (it becomes visible,
    // servable and earns its storage job), reject deletes it with everything under it.
    router.post('/v1/admin/content/:cid/accept', async (ctx) => {
      this.requireAdmin(ctx);
      const cid = String(ctx.params.cid).split('~')[0];
      if (!(await this.publishReviewed(cid))) throw notFound('No such content');
      return { record: this.store.getContent(cid) };
    });
    router.post('/v1/admin/content/:cid/reject', async (ctx) => {
      this.requireAdmin(ctx);
      const cid = String(ctx.params.cid).split('~')[0];
      const body = await readJson<{ reason?: string; note?: string }>(ctx.req).catch(() => ({}) as { reason?: string; note?: string });
      const reason = String(body.reason ?? body.note ?? '').slice(0, 500) || undefined;
      if (!(await this.removeContent(cid))) throw notFound('No such content');
      this.traces.trace('basic', 'provider.node', 'content rejected from review', {
        message: reason,
        data: { cid: cid.slice(0, 16) },
      });
      if (!this.options.quietLogs) log.info(`Rejected pushed content ${cid.slice(0, 16)}…${reason ? `: ${reason}` : ''}`);
      return { ok: true, rejected: true, reason };
    });
    // One review-sync round by hand (the Review page's "Check algorithm nodes"): ask
    // the trusted algorithm nodes about everything queued and accept whatever any of
    // them lists — the same run the periodic job repeats every review.syncMinutes.
    router.post('/v1/admin/content/review/sync', async (ctx) => {
      this.requireAdmin(ctx);
      return this.syncReviewedQueue();
    });
    // Trusted algorithm search nodes: what they list already reviewed content, so the
    // queue accepts it on its own (see autoAcceptReviewed). Each entry is probed on
    // read, so the panel shows what is actually reachable.
    router.get('/v1/admin/algorithms', async (ctx) => {
      this.requireAdmin(ctx);
      return { refs: this.config.algorithmPeers.refs, autoAccept: this.config.algorithmPeers.autoAccept, nodes: await this.probeAlgorithmPeers() };
    });
    router.put('/v1/admin/algorithms', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ refs?: string[]; autoAccept?: boolean }>(ctx.req);
      const refs = body.refs === undefined ? this.config.algorithmPeers.refs : body.refs.map((entry) => String(entry).trim()).filter(Boolean);
      for (const ref of refs) {
        const parsed = parseNodeRef(ref);
        if (!parsed || parsed.type !== 'algorithm') throw badRequest(`Not an algorithm search node reference: ${ref.slice(0, 80)}`);
      }
      const autoAccept = body.autoAccept ?? this.config.algorithmPeers.autoAccept;
      this.configFile.data.algorithmPeers = { refs, autoAccept };
      this.configFile.changed();
      this.traces.trace('basic', 'provider.node', 'algorithm peers updated', { data: { refs: refs.length, autoAccept } });
      return { refs, autoAccept, nodes: await this.probeAlgorithmPeers() };
    });
    router.post('/v1/admin/content/import', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ path?: string; name?: string; mime?: string; meta?: Manifest['meta']; sources?: string[] }>(ctx.req);
      if (!body.path) throw badRequest('path is required');
      return this.importFile(body.path, body);
    });
    // A file dropped into (or picked by) the admin GUI: streamed to this machine's temp
    // directory and imported exactly like a local path.
    router.post('/v1/admin/content/upload', async (ctx) => {
      this.requireAdmin(ctx);
      const name = String(ctx.query.get('name') ?? '').trim() || 'upload.bin';
      const tmp = join(tmpdir(), `vibeshare-upload-${randomId('up', 12)}`);
      try {
        await pipeline(ctx.req, createWriteStream(tmp));
        return await this.importFile(tmp, { name });
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
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
      const stats = this.store.backendStats();
      const backends = await Promise.all(
        this.backends().map(async (backend) => ({
          id: backend.id,
          type: backend.type,
          writable: backend.writable,
          priority: priorities[backend.id] ?? 10,
          status: await backend.check(),
          items: stats[backend.id]?.items ?? 0,
          bytes: stats[backend.id]?.bytes ?? 0,
        }))
      );
      // The URL backups ("user job urls") keep copies outside every backend.
      const urls = Object.values(this.contentUrls.data.items).filter((record) => record.status === 'accepted');
      const urlCids = new Set(urls.map((record) => record.cid).filter(Boolean) as string[]);
      let urlBytes = 0;
      for (const cid of urlCids) urlBytes += this.store.getContent(cid)?.size ?? 0;
      return {
        backends,
        replication: this.config.storage.replication,
        media: this.config.tiers.media,
        urls: { items: urls.length, bytes: urlBytes },
      };
    });
    // Update one job's rewards and its retrieval / endpoint-test schedule.
    router.post('/v1/admin/storage/jobs/:id', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{
        rewards?: Partial<StorageRewards>;
        retrievalIntervalSeconds?: number;
      }>(ctx.req);
      this.service.updateJob(ctx.params.id, body);
      return { job: this.service.jobs().find((entry) => entry.id === ctx.params.id) };
    });
    router.get('/v1/admin/storage/jobs', (ctx) => {
      this.requireAdmin(ctx);
      // A copy counts as fulfilled once its data is reachable: actively held, or held by a
      // client whose offered URL has already served the content (a client that is still
      // downloading but hosts a working copy is a real copy — otherwise a fresh start shows
      // 0/N until someone presses Test).
      return {
        jobs: this.service.jobs().map((job) => ({ ...job, holders: this.fulfilledHolders(job) })),
        stats: this.service.stats(),
      };
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
      const job = this.service.createJob({
        cid: body.cid,
        title: manifest.meta?.title ?? manifest.name,
        chunks: manifest.chunks,
        replicas: body.replicas,
        durationSeconds: body.durationDays ? body.durationDays * 86400 : undefined,
        rewards: body.rewards,
        requireIdentity: body.requireIdentity,
        openUntil: body.openUntil,
      });
      this.traces.trace('basic', 'provider.node', 'storage job create', {
        data: { job: job.id, cid: job.cid?.slice(0, 16), chunks: job.chunkIds.length, replicas: job.replicas },
      });
      return job;
    });
    router.post('/v1/admin/storage/jobs/:id/close', (ctx) => {
      this.requireAdmin(ctx);
      this.service.closeJob(ctx.params.id);
      this.traces.trace('basic', 'provider.node', 'storage job close', { data: { job: ctx.params.id } });
      return { ok: true };
    });
    router.delete('/v1/admin/storage/jobs/:id', (ctx) => {
      this.requireAdmin(ctx);
      if (!this.service.deleteJob(ctx.params.id)) throw notFound('No such job');
      return { ok: true };
    });
    // A live test of one storage job: it goes through the users' endpoints (never the
    // client's poll) and is only ever correct when the served chunks match the content
    // id. The first working endpoint of a user wins and moves to the top of that user's
    // list; when every endpoint of a user fails, that user is red failed and out.
    router.post('/v1/admin/storage/jobs/:id/test', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ account?: string }>(ctx.req).catch(() => ({} as { account?: string }));
      return { test: await this.testStorageJob(ctx.params.id, body.account ? String(body.account) : undefined) };
    });
    // Availability + integrity check: the endpoint must answer with bytes that hash to
    // the expected id exactly. A failing endpoint drops to the bottom of the try order.
    router.post('/v1/admin/content/:cid/verify', async (ctx) => {
      this.requireAdmin(ctx);
      const cid = String(ctx.params.cid).split('~')[0];
      const body = await readJson<{ url: string; linkId?: string }>(ctx.req);
      if (!body?.url) throw badRequest('Give the endpoint to check');
      const verify = await this.verifyEndpoint(cid, body.url);
      const record = body.linkId ? this.contentUrls.data.items[String(body.linkId)] : undefined;
      if (record) {
        record.fails = verify.ok ? 0 : (record.fails ?? 0) + 1;
        record.lastOutcome = verify.ok ? 'success' : 'failed';
        if (verify.ok) record.lastOkAt = Date.now();
        this.contentUrls.changed();
        // The URL belongs to a holder of a job for this content, so the check also decides
        // that user's standing: a pass pays what is owed and restores the holder; a miss is
        // a strike, and the third one without a success frees the slot.
        const jobs = this.service.jobs().filter((job) => job.cid === cid);
        const assignments = this.service.assignmentsForAdmin().filter(
          (assignment) => assignment.accountId === record.account && jobs.some((job) => job.id === assignment.jobId)
        );
        for (const assignment of assignments) {
          if (verify.ok) {
            this.service.endpointLive(assignment.id);
          } else {
            const strikes = this.service.noteFailedCheck(assignment.id);
            const threshold = Math.max(1, jobs.find((job) => job.id === assignment.jobId)?.failedRequestsBeforeFailure ?? 3);
            if (strikes >= threshold) this.service.failHolder(assignment.id);
          }
        }
        if (assignments.length) this.service.markEndpointTested(jobs.map((job) => job.id));
      }
      return { verify };
    });
    // Edit the display details of one content: creator, sources and duplicates.
    router.post('/v1/admin/content/:cid/details', async (ctx) => {
      this.requireAdmin(ctx);
      const cid = String(ctx.params.cid).split('~')[0];
      if (!this.store.getContent(cid)) throw notFound('No such content');
      const body = await readJson<{ creator?: { id?: string; name?: string }; sources?: string[]; duplicates?: string[] }>(ctx.req);
      this.store.updateDetails(cid, {
        creatorEdit: body.creator
          ? { id: String(body.creator.id ?? '').slice(0, 300), name: String(body.creator.name ?? '').slice(0, 300) || undefined }
          : undefined,
        sources: Array.isArray(body.sources) ? body.sources.map((entry) => String(entry).slice(0, 500)).slice(0, 100) : undefined,
        duplicates: Array.isArray(body.duplicates) ? body.duplicates.map((entry) => String(entry).slice(0, 500)).slice(0, 100) : undefined,
      });
      return { record: this.store.getContent(cid) };
    });
    // Storage tiers: the assignments and the manual controls (the tier definitions
    // themselves live in the config, edited through /v1/admin/config).
    router.get('/v1/admin/tiers', (ctx) => {
      this.requireAdmin(ctx);
      return {
        config: this.config.tiers,
        assignments: this.tiers.assignments(),
        backends: this.config.storage.backends.map((backend) => backend.id),
      };
    });
    // Assigns every content that has no tier yet to one tier, in one batch (the admin
    // GUI's "assign unassigned" card). Registered before the /tiers/:cid routes so the
    // static path wins the match. The assignments are manual: automatic lifecycles never
    // undo this batch by themselves.
    router.post('/v1/admin/tiers/assign-unassigned', async (ctx) => {
      this.requireAdmin(ctx);
      const body = await readJson<{ tier?: string }>(ctx.req);
      const tier = String(body.tier ?? '');
      if (!this.tiers.tier(tier)) throw badRequest('No such tier on this node');
      const assigned = this.tiers.assignUnassigned(this.store.list(0, 50_000).map((record) => record.cid), tier);
      this.traces.trace('basic', 'provider.node', 'tiers assign unassigned', { data: { tier, assigned } });
      return { assigned };
    });
    router.post('/v1/admin/tiers/:cid', async (ctx) => {
      this.requireAdmin(ctx);
      const cid = String(ctx.params.cid).split('~')[0];
      const body = await readJson<{ tier?: string; extendDays?: number; title?: string }>(ctx.req);
      if (body.tier) {
        if (!this.tiers.tier(body.tier)) throw badRequest('No such tier on this node');
        this.tiers.setTier(cid, body.tier, { manual: true });
      }
      if (body.extendDays && body.extendDays > 0) this.tiers.extend(cid, body.extendDays);
      this.traces.trace('basic', 'provider.node', 'tiers update', {
        data: { cid: cid.slice(0, 16), tier: body.tier, extendDays: body.extendDays },
      });
      return { tier: this.tiers.stateOf(cid) };
    });
    router.delete('/v1/admin/tiers/:cid', async (ctx) => {
      this.requireAdmin(ctx);
      if (!(await this.tiers.forget(String(ctx.params.cid).split('~')[0]))) throw notFound('No tier assignment for that content');
      return { ok: true };
    });
    router.get('/v1/admin/storage/assignments', (ctx) => {
      this.requireAdmin(ctx);
      return { assignments: this.service.assignmentsForAdmin().slice(0, 500) };
    });
  }

  /**
   * Deletes a content everywhere it matters: its storage jobs (with their assignments)
   * go first — deleting content must never leave orphaned jobs behind — then the
   * content and its chunks.
   */
  /** Removes content with its storage jobs and bytes — the operator's and the creator's way. */
  async removeContent(cid: string): Promise<boolean> {
    for (const job of this.service.jobs()) if (job.cid === cid) this.service.deleteJob(job.id);
    this.service.flush();
    return this.store.deleteContent(cid);
  }

  /** The client this node talks to one trusted algorithm node with. */
  private algorithmPeerClient(parsed: { id?: string; url: string }): NodeClient {
    return new NodeClient({
      url: parsed.url,
      expectedId: parsed.id,
      expectedType: 'algorithm',
      auth: 'identity',
      identity: this.identity,
      transport: () => this.transport(parsed.url),
    });
  }

  /**
   * The accept path of the review queue, shared by the operator's verdict and the
   * automatic one: the content becomes visible and servable and earns its storage job.
   */
  private async publishReviewed(cid: string): Promise<boolean> {
    const record = this.store.acceptContent(cid);
    if (!record) return false;
    const manifest = await this.getManifest(cid);
    if (manifest) this.autoJob(cid, manifest);
    this.traces.trace('basic', 'provider.node', 'content accepted from review', {
      data: { cid: cid.slice(0, 16), chunks: record.chunks, bytes: record.size },
    });
    return true;
  }

  /**
   * Asks the trusted algorithm nodes about one pushed content: a listing there is the
   * review, so the content is accepted here at once (the same publish path as the
   * operator's Accept). Never throws — a broken or unreachable node vouches for
   * nothing — and reports what the checks found.
   */
  private async reviewWithAlgorithms(cid: string): Promise<{ checks: number; accepted: boolean; errors: number }> {
    let checks = 0;
    let errors = 0;
    if (!this.store.isPending(cid)) return { checks, accepted: false, errors };
    for (const ref of this.config.algorithmPeers?.refs ?? []) {
      const parsed = parseNodeRef(ref);
      if (!parsed || parsed.type !== 'algorithm') continue;
      try {
        const answer = await this.algorithmPeerClient(parsed).json<{ items: { id: string; status: string }[] }>('/v1/lookup', {
          body: { ids: [cid] },
          timeoutMs: 15000,
        });
        checks++;
        const listed = (answer.items ?? []).some((item) => item.id === cid && item.status === 'listed');
        this.traces.trace('dependency', 'provider.node', 'algorithm peer lookup', {
          message: listed ? 'listed — content accepted automatically' : 'not listed',
          data: { peer: parsed.id?.slice(0, 16), cid: cid.slice(0, 16), listed },
        });
        if (listed) {
          await this.publishReviewed(cid);
          return { checks, accepted: true, errors };
        }
      } catch (error) {
        errors++;
        // Unreachable or broken accepts nothing: the push itself already succeeded.
        this.traces.trace('error', 'provider.node', 'algorithm peer lookup failed', {
          error: (error as Error).message,
          data: { peer: parsed.id?.slice(0, 16), cid: cid.slice(0, 16) },
        });
      }
    }
    return { checks, accepted: false, errors };
  }

  /**
   * One review-sync round — what the "Check algorithm nodes" button and the periodic
   * job both run: every queued content is asked of the trusted algorithm nodes, and
   * whatever one of them lists is accepted.
   */
  async syncReviewedQueue(): Promise<{ checked: number; accepted: number; errors: number }> {
    let checked = 0;
    let accepted = 0;
    let errors = 0;
    for (const record of this.store.pendingContent()) {
      const result = await this.reviewWithAlgorithms(record.cid);
      checked++;
      if (result.accepted) accepted++;
      errors += result.errors;
    }
    this.traces.trace('basic', 'provider.node', 'review sync', { data: { checked, accepted, errors } });
    return { checked, accepted, errors };
  }

  /**
   * Content pushed here that a trusted algorithm node already lists needs no human
   * eyes — the listing there is the review. Runs after the push response goes out, so
   * a slow lookup never delays the push. The world usually catches up after the push
   * (upload first, submit to the algorithm nodes second), so a content nothing
   * vouches for yet is re-checked a few times before the queue keeps it.
   */
  private autoAcceptReviewed(cid: string): void {
    const peers = this.config.algorithmPeers;
    if (!this.config.review.enabled || !peers?.autoAccept || !peers.refs?.length) return;
    void this.reviewWithAlgorithms(cid).then((result) => {
      if (!result.accepted) this.recheckReviewedLater(cid, 0);
    });
  }

  /**
   * Re-checks one queued content after its push (45 seconds, then 5 minutes): the
   * listing on a trusted algorithm node can land any moment after the upload — and
   * anything beyond that is what the automatic sync and the manual button are for.
   */
  private recheckReviewedLater(cid: string, step: number): void {
    const delays = [45_000, 300_000];
    if (step >= delays.length || this.reviewRechecks.has(cid)) return;
    this.reviewRechecks.add(cid);
    const timer = setTimeout(() => {
      this.reviewRechecks.delete(cid);
      void this.reviewWithAlgorithms(cid).then((result) => {
        if (!result.accepted) this.recheckReviewedLater(cid, step + 1);
      });
    }, delays[step]);
    timer.unref();
    this.reviewRecheckTimers.add(timer);
  }

  /**
   * The automatic review sync: every review.syncMinutes minutes (0 = only the manual
   * button), the queue is run through the algorithm nodes exactly like a hand sync.
   * The timer is cheap and always on — the minutes themselves decide whether anything
   * happens, so a config change takes effect without rewiring anything.
   */
  private async runReviewSync(): Promise<void> {
    const minutes = Number(this.config.review.syncMinutes) || 0;
    if (minutes <= 0 || this.reviewSyncing) return;
    if (Date.now() - this.lastReviewSyncAt < minutes * 60_000) return;
    this.reviewSyncing = true;
    this.lastReviewSyncAt = Date.now();
    try {
      await this.syncReviewedQueue();
    } catch (error) {
      log.warn('review sync:', error);
    } finally {
      this.reviewSyncing = false;
    }
  }

  /** The trusted algorithm nodes, each probed once: name, online, latency or error. */
  private async probeAlgorithmPeers(): Promise<{ ref: string; id?: string; name?: string; online: boolean; ms: number; error?: string }[]> {
    return Promise.all(
      (this.config.algorithmPeers?.refs ?? []).map(async (ref) => {
        const started = Date.now();
        try {
          const parsed = parseNodeRef(ref);
          if (!parsed || parsed.type !== 'algorithm') throw new Error('Not an algorithm search node reference');
          const info = await this.algorithmPeerClient(parsed).fetchInfo();
          return { ref, id: parsed.id, name: info.name, online: true, ms: Date.now() - started };
        } catch (error) {
          return { ref, online: false, ms: Date.now() - started, error: (error as Error).message };
        }
      })
    );
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
    this.traces.trace('basic', 'provider.node', 'content imported', {
      data: { cid: record.cid.slice(0, 16), chunks: manifest.chunks.length, bytes: manifest.size },
    });
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
    this.traces.trace('basic', 'provider.node', 'content imported', {
      data: { cid: record.cid.slice(0, 16), chunks: manifest.chunks.length, bytes: manifest.size },
    });
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
    return {
      content: this.store.stats(),
      storageService: this.service.stats(),
      // The review queue's size drives the console's badge.
      pending: { reviewContent: this.store.pendingContent().length, removals: this.removals.pending().length },
    };
  }

  async start(): Promise<void> {
    await super.start();
    this.startSync();
    // Refresh every holder's status right away (async — startup never waits for it):
    // stale rows and old one-strike damage heal without waiting for the next schedule.
    void this.runEndpointTests(true).catch((error) => log.warn('endpoint tests:', error));
    // The demo (and any operator seeding content right after start) opens its jobs a moment
    // after the node is listening, so one follow-up round makes sure they were tested too.
    const firstRound = setTimeout(() => {
      void this.runEndpointTests(true).catch((error) => log.warn('endpoint tests:', error));
    }, 3_000);
    firstRound.unref();
    // A cold host (a static site waking up, DNS not ready) can make that first pass miss:
    // retry soon instead of leaving the dashboard wrong for the whole interval.
    for (const delay of [30_000, 120_000]) {
      const retry = setTimeout(() => {
        void this.runEndpointTests(true).catch((error) => log.warn('endpoint tests:', error));
      }, delay);
      retry.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopSync();
    clearInterval(this.gcTimer);
    clearInterval(this.reviewSyncTimer);
    for (const timer of this.reviewRecheckTimers) clearTimeout(timer);
    this.reviewRecheckTimers.clear();
    this.reviewRechecks.clear();
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
