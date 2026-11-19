import { chunkIdOf, contentIdOf, validateManifest, type Manifest } from '../shared/content.js';
import { log } from '../shared/node/log.js';
import { JsonFile } from '../shared/node/store.js';
import type { TraceStore } from '../shared/node/tracing-node.js';
import type { BlobBackend } from './storage/backends.js';

export interface ChunkRecord {
  size: number;
  /** When the chunk was first stored (ms), for cleaning up abandoned uploads. */
  addedAt?: number;
  /** How many stored contents use this chunk. */
  refs: number;
  /** How many of those contents are still pending review (see ContentRecord.review). */
  pendingRefs?: number;
  /** Backend id → locator ('' when the backend uses the chunk id as the key). */
  locations: Record<string, string>;
}

export interface ContentRecord {
  cid: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  title?: string;
  creator?: string;
  /** Account on this node that uploaded the content ('operator' for the admin). */
  uploader: string;
  createdAt: string;
  downloads: number;
  bytesServed: number;
  creditsEarned: number;
  /** Extra platform links clients suggested (`yt:…`, `url:…`); one cid can carry several. */
  sources?: string[];
  /** Content ids clients reported as duplicates of this one (helps dedupe/compression). */
  duplicates?: string[];
  /** The creator shown in the dashboard (the signed manifest's creator is immutable). */
  creatorEdit?: { id: string; name?: string };
  /**
   * Review state of content pushed here from outside (client uploads, peer pushes):
   * pending content is stored but invisible and unserved until the operator accepts
   * it. Absent means accepted — what every record saved before reviews existed is.
   */
  review?: 'pending' | 'accepted' | 'rejected';
}

interface IndexData {
  chunks: Record<string, ChunkRecord>;
  contents: Record<string, ContentRecord>;
  manifests: Record<string, string>;
  order: string[];
}

/** Small LRU of hot chunks in memory, so popular streams do not hit the backends for every viewer. */
class ChunkCache {
  private map = new Map<string, Buffer>();
  private size = 0;
  constructor(private readonly limit: number) {}
  get(id: string): Buffer | undefined {
    const data = this.map.get(id);
    if (data) {
      this.map.delete(id);
      this.map.set(id, data);
    }
    return data;
  }
  set(id: string, data: Buffer): void {
    if (this.limit <= 0 || data.length > this.limit / 4 || this.map.has(id)) return;
    this.map.set(id, data);
    this.size += data.length;
    for (const [key, value] of this.map) {
      if (this.size <= this.limit) break;
      this.map.delete(key);
      this.size -= value.length;
    }
  }
  delete(id: string): void {
    const data = this.map.get(id);
    if (data) {
      this.size -= data.length;
      this.map.delete(id);
    }
  }
}

export interface StoreOptions {
  indexPath: string | null;
  backends: () => BlobBackend[];
  priorities: () => Record<string, number>;
  replication: () => number;
  cacheBytes: number;
  /** Last resort for chunks no backend has: ask client nodes that store them as a service. */
  peerFallback?: (chunkId: string) => Promise<Buffer | null>;
  /** Other content providers to ask for chunks no backend (or client) has. */
  chunkPeers?: (chunkId: string) => Promise<Buffer | null>;
  /** Write chunks fetched from peers or read-only backends back into writable backends. */
  cacheFetched?: () => boolean;
  /** The node's trace log (off by default; absent keeps every hook a no-op). */
  traces?: TraceStore;
}

/**
 * The provider's content: an index of manifests and chunks, with the bytes kept in
 * whichever storage backends the operator configured.
 */
export class ContentStore {
  private index: JsonFile<IndexData>;
  private cache: ChunkCache;

  constructor(private readonly options: StoreOptions) {
    this.index = new JsonFile<IndexData>(options.indexPath, () => ({ chunks: {}, contents: {}, manifests: {}, order: [] }));
    this.cache = new ChunkCache(options.cacheBytes);
  }

  private sortedBackends(): BlobBackend[] {
    const priorities = this.options.priorities();
    return [...this.options.backends()].sort((a, b) => (priorities[a.id] ?? 10) - (priorities[b.id] ?? 10));
  }

  hasChunk(id: string): boolean {
    const record = this.index.data.chunks[id];
    return Boolean(record && Object.keys(record.locations).length);
  }

  chunkRecord(id: string): ChunkRecord | undefined {
    return this.index.data.chunks[id];
  }

  /** Writes a chunk to `replication` writable backends (in priority order). */
  async putChunk(id: string, data: Buffer): Promise<void> {
    if (chunkIdOf(data) !== id) throw new Error('Chunk bytes do not match the chunk id');
    const record = (this.index.data.chunks[id] ??= { size: data.length, refs: 0, locations: {}, addedAt: Date.now() });
    const wanted = Math.max(1, this.options.replication());
    let stored = Object.keys(record.locations).filter((backend) => this.options.backends().some((b) => b.id === backend)).length;
    for (const backend of this.sortedBackends()) {
      if (stored >= wanted) break;
      if (!backend.writable || backend.id in record.locations) continue;
      try {
        record.locations[backend.id] = (await backend.put(id, data)) ?? '';
        stored++;
      } catch (error) {
        log.warn(`Backend ${backend.id} failed to store ${id.slice(0, 12)}: ${(error as Error).message}`);
        this.options.traces?.trace('error', 'provider.store', 'chunk store failed', {
          error: (error as Error).message,
          data: { backend: backend.id, chunk: id.slice(0, 12) },
        });
      }
    }
    if (stored === 0) {
      this.options.traces?.trace('error', 'provider.store', 'chunk store failed', { message: 'no storage backend accepted the chunk', data: { chunk: id.slice(0, 12) } });
      throw new Error('No storage backend accepted the chunk');
    }
    this.index.changed();
    // One summary line per write; the guard keeps the hot per-chunk loops allocation-free
    // while tracing is off.
    const traces = this.options.traces;
    if (traces?.recorder.shouldLog('basic')) {
      traces.trace('basic', 'provider.store', 'chunk stored', { data: { chunk: id.slice(0, 12), bytes: data.length, backends: stored } });
    }
  }

  /** One summary line per read outcome; guarded so hot reads stay allocation-free when off. */
  private readTrace(id: string, bytes: number, from: string): void {
    const traces = this.options.traces;
    if (traces?.recorder.shouldLog('basic')) {
      traces.trace('basic', 'provider.store', 'chunk read', { data: { chunk: id.slice(0, 12), bytes, from } });
    }
  }

  /**
   * Reads and checks a chunk: memory cache, known locations, every other backend, then
   * (unless `peers` is false) client nodes holding it for the storage service.
   */
  async getChunk(id: string, options: { peers?: boolean } = {}): Promise<Buffer | null> {
    const cached = this.cache.get(id);
    if (cached) {
      this.readTrace(id, cached.length, 'cache');
      return cached;
    }
    const record = this.index.data.chunks[id];
    const backends = this.sortedBackends();
    const known = backends.filter((backend) => record && backend.id in record.locations);
    const others = backends.filter((backend) => !known.includes(backend));
    for (const backend of [...known, ...others]) {
      try {
        const data = await backend.get(id, record?.locations[backend.id] || undefined);
        if (!data) continue;
        if (chunkIdOf(data) !== id) {
          log.warn(`Backend ${backend.id} returned wrong bytes for ${id.slice(0, 12)}`);
          this.options.traces?.trace('error', 'provider.store', 'chunk read failed', {
            message: 'a backend returned bytes that do not match the chunk id',
            data: { backend: backend.id, chunk: id.slice(0, 12) },
          });
          continue;
        }
        this.cache.set(id, data);
        if (!known.includes(backend) && record) await this.remember(id, data, backend);
        this.readTrace(id, data.length, backend.id);
        return data;
      } catch (error) {
        log.debug(`Backend ${backend.id} could not read ${id.slice(0, 12)}: ${(error as Error).message}`);
        this.options.traces?.trace('error', 'provider.store', 'chunk read failed', {
          error: (error as Error).message,
          data: { backend: backend.id, chunk: id.slice(0, 12) },
        });
      }
    }
    if (this.options.peerFallback && options.peers !== false) {
      const started = Date.now();
      const data = await this.options.peerFallback(id);
      if (data && chunkIdOf(data) === id) {
        this.cache.set(id, data);
        if (record) await this.remember(id, data);
        // Client holders of the storage service handed the bytes over (a paid retrieval).
        this.options.traces?.trace('dependency', 'provider.store', 'chunk fetched from holders', {
          data: this.options.traces.summarize({ chunk: id.slice(0, 12), url: `holder:${id.slice(0, 12)}`, method: 'GET', ms: Date.now() - started, status: 200, bytes: data.length }),
        });
        return data;
      }
    }
    // Peer content providers: chunks addressed by their hash, fetched from a peer.
    if (this.options.chunkPeers && options.peers !== false) {
      const started = Date.now();
      const data = await this.options.chunkPeers(id);
      if (data && chunkIdOf(data) === id) {
        this.cache.set(id, data);
        if (record) await this.remember(id, data);
        this.options.traces?.trace('dependency', 'provider.store', 'chunk fetched from peers', {
          data: this.options.traces.summarize({ chunk: id.slice(0, 12), url: `peer:/v1/peers/chunks/${id.slice(0, 12)}`, method: 'GET', ms: Date.now() - started, status: 200, bytes: data.length }),
        });
        return data;
      }
    }
    if (record) {
      // The index says this chunk is stored, yet nothing could read it: a real read
      // failure, not just a miss.
      this.options.traces?.trace('error', 'provider.store', 'chunk read failed', {
        message: 'stored chunk could not be read from any source',
        data: { chunk: id.slice(0, 12) },
      });
    } else {
      this.readTrace(id, 0, 'none');
    }
    return null;
  }

  /** After a read from a read-only backend or a peer, optionally keep a copy in writable backends. */
  private async remember(id: string, data: Buffer, from?: BlobBackend): Promise<void> {
    const record = this.index.data.chunks[id];
    if (!record) return;
    if (from?.writable) {
      record.locations[from.id] = '';
      this.index.changed();
      return;
    }
    if (this.options.cacheFetched?.()) {
      try {
        await this.putChunk(id, data);
      } catch {
        // keep serving even if no backend accepts it
      }
    }
  }

  async addContent(manifest: Manifest, uploader: string, review?: ContentRecord['review']): Promise<ContentRecord> {
    const cid = contentIdOf(manifest);
    const existing = this.index.data.contents[cid];
    if (existing) return existing;
    for (const chunk of manifest.chunks) {
      if (!this.hasChunk(chunk.id)) throw new Error(`Chunk ${chunk.id} is missing`);
    }
    const unique = new Set(manifest.chunks.map((chunk) => chunk.id));
    for (const id of unique) {
      const chunk = this.index.data.chunks[id];
      chunk.refs++;
      // Pending content's own chunks stay hidden until acceptance; the counter keeps a
      // chunk shared with accepted content servable (refs covers every claim).
      if (review === 'pending') chunk.pendingRefs = (chunk.pendingRefs ?? 0) + 1;
    }
    const text = JSON.stringify(manifest);
    this.index.data.manifests[cid] = text;
    // Manifests are tiny; keeping copies next to the chunks lets another node (or a
    // reinstall) pointed at the same storage recover the content.
    const writable = this.sortedBackends().filter((b) => b.writable).slice(0, Math.max(1, this.options.replication()));
    await Promise.all(
      writable.map((backend) =>
        backend.put(`m-${cid}`, Buffer.from(text)).catch((error) => {
          // Tolerated: these copies are a recovery aid, the index already holds the
          // manifest, so a failing one must not fail the content.
          this.options.traces?.trace('error', 'provider.store', 'manifest copy failed', {
            error: (error as Error).message,
            data: { backend: backend.id, cid: cid.slice(0, 16) },
          });
        })
      )
    );
    const record: ContentRecord = {
      cid,
      name: manifest.name,
      mime: manifest.mime,
      size: manifest.size,
      chunks: manifest.chunks.length,
      title: manifest.meta?.title,
      creator: manifest.creator?.id,
      uploader,
      createdAt: new Date().toISOString(),
      downloads: 0,
      bytesServed: 0,
      creditsEarned: 0,
      ...(review === 'pending' ? { review } : {}),
    };
    this.index.data.contents[cid] = record;
    this.index.data.order.push(cid);
    this.index.changed();
    this.options.traces?.trace('basic', 'provider.store', 'content added', {
      data: { cid: cid.slice(0, 16), chunks: record.chunks, bytes: record.size, uploader: uploader.slice(0, 16), review: review ?? 'accepted' },
    });
    return record;
  }

  /**
   * Registers content whose bytes live in the backends (a shared bucket, a mirror,
   * another provider) without copying them first: chunks are fetched on demand.
   */
  adopt(manifest: Manifest, uploader: string, review?: ContentRecord['review']): ContentRecord {
    const cid = contentIdOf(manifest);
    const existing = this.index.data.contents[cid];
    if (existing) return existing;
    for (const chunk of manifest.chunks) {
      this.index.data.chunks[chunk.id] ??= { size: chunk.size, refs: 0, locations: {}, addedAt: Date.now() };
    }
    for (const id of new Set(manifest.chunks.map((chunk) => chunk.id))) {
      const chunk = this.index.data.chunks[id];
      chunk.refs++;
      if (review === 'pending') chunk.pendingRefs = (chunk.pendingRefs ?? 0) + 1;
    }
    this.index.data.manifests[cid] = JSON.stringify(manifest);
    const record: ContentRecord = {
      cid,
      name: manifest.name,
      mime: manifest.mime,
      size: manifest.size,
      chunks: manifest.chunks.length,
      title: manifest.meta?.title,
      creator: manifest.creator?.id,
      uploader,
      createdAt: new Date().toISOString(),
      downloads: 0,
      bytesServed: 0,
      creditsEarned: 0,
      ...(review === 'pending' ? { review } : {}),
    };
    this.index.data.contents[cid] = record;
    this.index.data.order.push(cid);
    this.index.changed();
    this.options.traces?.trace('basic', 'provider.store', 'content adopted', {
      data: { cid: cid.slice(0, 16), chunks: record.chunks, bytes: record.size, review: review ?? 'accepted' },
    });
    return record;
  }

  /** Content pushed from outside that the operator has not accepted yet, newest first. */
  pendingContent(): ContentRecord[] {
    return Object.values(this.index.data.contents)
      .filter((record) => record.review === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Publishes content that was waiting for review: visible, servable and job-able. */
  acceptContent(cid: string): ContentRecord | undefined {
    const record = this.index.data.contents[cid];
    if (!record) return undefined;
    if (record.review === 'pending') {
      record.review = 'accepted';
      for (const chunk of this.getManifest(cid)?.chunks ?? []) {
        const entry = this.index.data.chunks[chunk.id];
        if (entry) entry.pendingRefs = Math.max(0, (entry.pendingRefs ?? 0) - 1);
      }
      this.index.changed();
      this.options.traces?.trace('basic', 'provider.store', 'content accepted', {
        data: { cid: cid.slice(0, 16), chunks: record.chunks, bytes: record.size },
      });
    }
    return record;
  }

  /** True while content pushed from outside waits for the operator's review. */
  isPending(cid: string): boolean {
    return this.index.data.contents[cid]?.review === 'pending';
  }

  /**
   * Whether a chunk may be served or advertised: bytes that only pending-review
   * content claims stay hidden, as if the node had never heard of them.
   */
  servesChunk(id: string): boolean {
    const record = this.index.data.chunks[id];
    if (!record) return false;
    const pending = record.pendingRefs ?? 0;
    return pending <= 0 || record.refs > pending;
  }

  getContent(cid: string): ContentRecord | undefined {
    return this.index.data.contents[cid];
  }

  getManifest(cid: string): Manifest | undefined {
    const text = this.index.data.manifests[cid];
    return text ? (JSON.parse(text) as Manifest) : undefined;
  }

  /** Reads a manifest straight from the backends (e.g. a bucket shared with another node). */
  async recoverManifest(cid: string): Promise<Manifest | undefined> {
    for (const backend of this.sortedBackends()) {
      try {
        const data = await backend.get(`m-${cid}`);
        if (!data) continue;
        const manifest = validateManifest(JSON.parse(data.toString('utf8')));
        if (contentIdOf(manifest) === cid) return manifest;
      } catch {
        // try the next backend
      }
    }
    return undefined;
  }

  recordServed(cid: string, bytes: number, credits: number, firstChunk: boolean): void {
    const record = this.index.data.contents[cid];
    if (!record) return;
    record.bytesServed += bytes;
    record.creditsEarned += credits;
    if (firstChunk) record.downloads++;
    this.index.changed();
  }

  /** Merges suggested sources and duplicate ids into a content record. */
  annotate(cid: string, patch: { sources?: string[]; duplicates?: string[] }): ContentRecord | undefined {
    const record = this.index.data.contents[cid];
    if (!record) return undefined;
    if (patch.sources?.length) {
      record.sources = [...new Set([...(record.sources ?? []), ...patch.sources])].slice(0, 16);
    }
    if (patch.duplicates?.length) {
      record.duplicates = [...new Set([...(record.duplicates ?? []), ...patch.duplicates])].slice(0, 64);
    }
    this.index.changed();
    return record;
  }

  async deleteContent(cid: string): Promise<boolean> {
    const manifest = this.getManifest(cid);
    if (!manifest) return false;
    const pending = this.index.data.contents[cid]?.review === 'pending';
    delete this.index.data.contents[cid];
    delete this.index.data.manifests[cid];
    this.index.data.order = this.index.data.order.filter((id) => id !== cid);
    const backends = this.options.backends();
    const ids = new Set(manifest.chunks.map((chunk) => chunk.id));
    for (const id of ids) {
      const record = this.index.data.chunks[id];
      if (!record) continue;
      record.refs--;
      if (pending) record.pendingRefs = Math.max(0, (record.pendingRefs ?? 0) - 1);
      if (record.refs > 0) continue;
      for (const [backendId, locator] of Object.entries(record.locations)) {
        const backend = backends.find((b) => b.id === backendId);
        await backend?.delete(id, locator || undefined).catch(() => undefined);
      }
      delete this.index.data.chunks[id];
      this.cache.delete(id);
    }
    for (const backend of backends.filter((b) => b.writable)) await backend.delete(`m-${cid}`).catch(() => undefined);
    this.index.changed();
    this.options.traces?.trace('basic', 'provider.store', 'content deleted', { data: { cid: cid.slice(0, 16), chunks: ids.size } });
    return true;
  }

  /**
   * Frees the local bytes of one content while keeping its manifest and index — the
   * storage tiers call this when backups elsewhere hold the data. Downloads then come
   * from external URL backups, client holders or peers.
   */
  async releaseContentBytes(cid: string): Promise<boolean> {
    const manifest = this.getManifest(cid);
    if (!manifest) return false;
    const backends = this.options.backends();
    const ids = new Set(manifest.chunks.map((chunk) => chunk.id));
    for (const id of ids) {
      const record = this.index.data.chunks[id];
      if (!record) continue;
      for (const [backendId, locator] of Object.entries(record.locations)) {
        await backends.find((b) => b.id === backendId)?.delete(id, locator || undefined).catch(() => undefined);
      }
      record.locations = {};
      this.cache.delete(id);
    }
    this.index.changed();
    this.options.traces?.trace('basic', 'provider.store', 'content bytes released', { data: { cid: cid.slice(0, 16), chunks: ids.size } });
    return true;
  }

  /** Newest first. Pending-review content is invisible here until it is accepted. */
  list(offset: number, limit: number): ContentRecord[] {
    const order = this.index.data.order;
    const out: ContentRecord[] = [];
    let skipped = 0;
    for (let i = order.length - 1; i >= 0 && out.length < limit; i--) {
      const record = this.index.data.contents[order[i]];
      if (!record || record.review === 'pending') continue;
      if (skipped++ < offset) continue;
      out.push(record);
    }
    return out;
  }

  /** Deletes chunks no content uses (abandoned uploads) that are older than `minAgeMs`, except `keep`. */
  async collectGarbage(keep: Set<string>, minAgeMs: number): Promise<number> {
    const backends = this.options.backends();
    let removed = 0;
    for (const [id, record] of Object.entries(this.index.data.chunks)) {
      if (record.refs > 0 || keep.has(id) || Date.now() - (record.addedAt ?? 0) < minAgeMs) continue;
      for (const [backendId, locator] of Object.entries(record.locations)) {
        await backends.find((b) => b.id === backendId)?.delete(id, locator || undefined).catch(() => undefined);
      }
      delete this.index.data.chunks[id];
      this.cache.delete(id);
      removed++;
    }
    if (removed) this.index.changed();
    this.options.traces?.trace('basic', 'provider.store', 'garbage collected', { data: { removed } });
    return removed;
  }

  stats(): { contents: number; bytes: number; chunks: number } {
    // Pending-review content is not catalog content yet — it counts once accepted.
    const contents = Object.values(this.index.data.contents).filter((record) => record.review !== 'pending');
    return {
      contents: contents.length,
      bytes: contents.reduce((sum, record) => sum + record.size, 0),
      chunks: Object.keys(this.index.data.chunks).length,
    };
  }

  /** Chunks and bytes kept on each configured backend. */
  backendStats(): Record<string, { items: number; bytes: number }> {
    const stats: Record<string, { items: number; bytes: number }> = {};
    for (const record of Object.values(this.index.data.chunks)) {
      for (const backend of Object.keys(record.locations)) {
        const entry = (stats[backend] ??= { items: 0, bytes: 0 });
        entry.items++;
        entry.bytes += record.size;
      }
    }
    return stats;
  }

  /** Updates the editable display details of one content: creator, sources, duplicates. */
  updateDetails(
    cid: string,
    patch: { creatorEdit?: { id: string; name?: string }; sources?: string[]; duplicates?: string[] }
  ): void {
    const record = this.index.data.contents[cid];
    if (!record) return;
    if (patch.creatorEdit !== undefined) record.creatorEdit = patch.creatorEdit;
    if (patch.sources !== undefined) record.sources = patch.sources;
    if (patch.duplicates !== undefined) record.duplicates = patch.duplicates;
    this.index.changed();
  }

  flush(): void {
    this.index.flush();
  }
}
