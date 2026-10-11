import { chunkIdOf, contentIdOf, validateManifest, type Manifest } from '../shared/content.js';
import { log } from '../shared/log.js';
import { JsonFile } from '../shared/store.js';
import type { BlobBackend } from './storage/backends.js';

export interface ChunkRecord {
  size: number;
  /** When the chunk was first stored (ms), for cleaning up abandoned uploads. */
  addedAt?: number;
  /** How many stored contents use this chunk. */
  refs: number;
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
  /** Write chunks fetched from peers or read-only backends back into writable backends. */
  cacheFetched?: () => boolean;
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
      }
    }
    if (stored === 0) throw new Error('No storage backend accepted the chunk');
    this.index.changed();
  }

  /** Reads and checks a chunk: memory cache, known locations, every other backend, then peers. */
  async getChunk(id: string): Promise<Buffer | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
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
          continue;
        }
        this.cache.set(id, data);
        if (!known.includes(backend) && record) await this.remember(id, data, backend);
        return data;
      } catch (error) {
        log.debug(`Backend ${backend.id} could not read ${id.slice(0, 12)}: ${(error as Error).message}`);
      }
    }
    if (this.options.peerFallback) {
      const data = await this.options.peerFallback(id);
      if (data && chunkIdOf(data) === id) {
        this.cache.set(id, data);
        if (record) await this.remember(id, data);
        return data;
      }
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

  async addContent(manifest: Manifest, uploader: string): Promise<ContentRecord> {
    const cid = contentIdOf(manifest);
    const existing = this.index.data.contents[cid];
    if (existing) return existing;
    for (const chunk of manifest.chunks) {
      if (!this.hasChunk(chunk.id)) throw new Error(`Chunk ${chunk.id} is missing`);
    }
    const unique = new Set(manifest.chunks.map((chunk) => chunk.id));
    for (const id of unique) this.index.data.chunks[id].refs++;
    const text = JSON.stringify(manifest);
    this.index.data.manifests[cid] = text;
    for (const backend of this.sortedBackends().filter((b) => b.writable).slice(0, 1)) {
      backend.put(`m-${cid}`, Buffer.from(text)).catch(() => undefined);
    }
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
    };
    this.index.data.contents[cid] = record;
    this.index.data.order.push(cid);
    this.index.changed();
    return record;
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

  async deleteContent(cid: string): Promise<boolean> {
    const manifest = this.getManifest(cid);
    if (!manifest) return false;
    delete this.index.data.contents[cid];
    delete this.index.data.manifests[cid];
    this.index.data.order = this.index.data.order.filter((id) => id !== cid);
    const backends = this.options.backends();
    for (const id of new Set(manifest.chunks.map((chunk) => chunk.id))) {
      const record = this.index.data.chunks[id];
      if (!record) continue;
      record.refs--;
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
    return true;
  }

  /** Newest first. */
  list(offset: number, limit: number): ContentRecord[] {
    const order = this.index.data.order;
    const out: ContentRecord[] = [];
    for (let i = order.length - 1 - offset; i >= 0 && out.length < limit; i--) {
      const record = this.index.data.contents[order[i]];
      if (record) out.push(record);
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
    return removed;
  }

  stats(): { contents: number; bytes: number; chunks: number } {
    const contents = Object.values(this.index.data.contents);
    return {
      contents: contents.length,
      bytes: contents.reduce((sum, record) => sum + record.size, 0),
      chunks: Object.keys(this.index.data.chunks).length,
    };
  }

  flush(): void {
    this.index.flush();
  }
}
