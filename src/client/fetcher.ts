import { chunkIdOf, chunksForRange, contentIdOf, MiB, validateManifest, type Manifest } from '../shared/content.js';
import type { NodeEntry } from '../shared/clientapi.js';
import { RemoteError } from '../shared/remote.js';
import { log } from '../shared/log.js';
import type { ChunkStore } from './model.js';
import { errorText, type NodeManager } from './nodes.js';

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly attempts: { node: string; name: string; error: string }[]
  ) {
    super(message);
  }
}

interface ManifestHit {
  manifest: Manifest;
  provider: NodeEntry;
}

/** An answer to a (Range) request for content bytes, for any HTTP server or service worker. */
export interface ContentResponse {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** The bytes, verified chunk by chunk; stop iterating to stop fetching. */
  body: AsyncGenerator<Uint8Array> | null;
}

/**
 * Gets content bytes from the user's provider nodes. Providers are tried in the
 * user's priority order; any provider that is offline, does not have the content,
 * costs more than the user's limit or runs out of credits is skipped for the next.
 * Every manifest and chunk is checked against its hash, so no provider has to be trusted.
 */
export class Fetcher {
  private manifests = new Map<string, ManifestHit>();
  private inflight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly nodes: NodeManager,
    private readonly cache: ChunkStore
  ) {}

  private candidates(preferred?: string): NodeEntry[] {
    const providers = this.nodes.active('provider').filter((node) => this.nodes.affordable(node, this.nodes.providerPrice(node)));
    if (!preferred) return providers;
    return [...providers.filter((node) => node.id === preferred), ...providers.filter((node) => node.id !== preferred)];
  }

  async manifest(cid: string): Promise<ManifestHit> {
    const cached = this.manifests.get(cid);
    if (cached && this.nodes.get(cached.provider.id)?.enabled) return cached;
    const attempts: { node: string; name: string; error: string }[] = [];
    const skipped = this.nodes.active('provider').filter((node) => !this.nodes.affordable(node, this.nodes.providerPrice(node)));
    for (const node of skipped) attempts.push({ node: node.id, name: node.name, error: 'Above your price limit' });
    for (const provider of this.candidates()) {
      try {
        const manifest = validateManifest(await this.nodes.client(provider).json(`/v1/content/${cid}`, { timeoutMs: 10000 }));
        if (contentIdOf(manifest) !== cid) throw new Error('The provider sent a manifest that does not match the id');
        const hit = { manifest, provider };
        this.manifests.set(cid, hit);
        return hit;
      } catch (error) {
        const notHere = error instanceof RemoteError && error.status === 404;
        attempts.push({ node: provider.id, name: provider.name, error: notHere ? 'Does not have it' : errorText(error) });
      }
    }
    throw new FetchError('No provider node has this content', attempts);
  }

  /** One verified chunk: from the cache, or from a provider (paying its price). */
  async chunk(cid: string, index: number, preferred?: string): Promise<Buffer> {
    const { manifest, provider } = await this.manifest(cid);
    const ref = manifest.chunks[index];
    if (!ref) throw new Error(`No chunk ${index}`);
    const cached = await this.cache.get(ref.id);
    if (cached) return cached;
    const running = this.inflight.get(ref.id);
    if (running) return running;
    const task = this.download(cid, ref.id, preferred ?? provider.id).finally(() => this.inflight.delete(ref.id));
    this.inflight.set(ref.id, task);
    return task;
  }

  private async download(cid: string, chunkId: string, preferred: string): Promise<Buffer> {
    const attempts: { node: string; name: string; error: string }[] = [];
    for (const provider of this.candidates(preferred)) {
      try {
        const response = await this.nodes.client(provider).fetch(`/v1/chunks/${chunkId}?cid=${cid}`, { timeoutMs: 60000 });
        const data = Buffer.from(await response.arrayBuffer());
        if (chunkIdOf(data) !== chunkId) throw new Error('Corrupt chunk');
        const balance = response.headers.get('x-vs-balance');
        if (balance !== null) this.nodes.setBalance(provider.id, Number(balance));
        await this.cache.put(chunkId, data);
        return data;
      } catch (error) {
        attempts.push({ node: provider.id, name: provider.name, error: errorText(error) });
        log.debug(`Chunk ${chunkId.slice(0, 12)} from ${provider.name}: ${errorText(error)}`);
      }
    }
    throw new FetchError('No provider could send this part of the content', attempts);
  }

  /** Estimated credits to fetch the whole content from a provider (ignoring free allowances and cache). */
  estimate(manifest: Manifest, provider: NodeEntry): number {
    const perMiB = this.nodes.providerPrice(provider);
    return manifest.chunks.reduce((sum, chunk) => sum + Math.ceil((chunk.size * perMiB) / MiB), 0);
  }

  /**
   * Answers a request for bytes [start, end] of content (Range requests from <video>,
   * <audio>, <img> and downloads), fetching a couple of chunks ahead so playback does
   * not stall at chunk boundaries. The first chunk is fetched before answering, so
   * errors still become a proper status code.
   */
  async open(cid: string, range: string | null | undefined, download: boolean): Promise<ContentResponse> {
    const { manifest } = await this.manifest(cid);
    const size = manifest.size;
    let start = 0;
    let end = size - 1;
    let partial = false;
    const match = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (match && size > 0) {
      partial = true;
      if (match[1] === '' && match[2] !== '') {
        start = Math.max(0, size - Number(match[2]));
      } else {
        start = Number(match[1] || 0);
        if (match[2] !== '') end = Math.min(size - 1, Number(match[2]));
      }
      if (start > end || start >= size) return { status: 416, headers: { 'content-range': `bytes */${size}` }, body: null };
    }
    const headers: Record<string, string> = {
      'content-type': manifest.mime,
      'accept-ranges': 'bytes',
      'content-length': String(size === 0 ? 0 : end - start + 1),
      'cache-control': 'private, max-age=3600',
      // Content comes from strangers and is served from the client's origin: if an HTML or
      // SVG file is ever opened directly, it runs sandboxed, without scripts or access to the API.
      'x-content-type-options': 'nosniff',
    };
    // (Browsers refuse to show PDFs in a sandbox; their viewer does not run page scripts in our origin.)
    if (manifest.mime !== 'application/pdf') {
      headers['content-security-policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'";
    }
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(manifest.name)}`;
    if (size === 0) return { status: 200, headers, body: null };
    const { first, last, offset } = chunksForRange(manifest, start, end);
    const firstChunk = await this.chunk(cid, first);
    return { status: partial ? 206 : 200, headers, body: this.pieces(cid, manifest, firstChunk, first, last, offset, end, download ? 4 : 2) };
  }

  private async *pieces(
    cid: string,
    manifest: Manifest,
    firstChunk: Buffer,
    first: number,
    last: number,
    offset: number,
    end: number,
    readAhead: number
  ): AsyncGenerator<Uint8Array> {
    const ahead = new Map<number, Promise<Buffer>>();
    let current = firstChunk;
    for (let index = first; index <= last; index++) {
      for (let next = index + 1; next <= Math.min(last, index + readAhead); next++) {
        if (!ahead.has(next)) {
          const promise = this.chunk(cid, next);
          promise.catch(() => undefined);
          ahead.set(next, promise);
        }
      }
      if (index !== first) current = await ahead.get(index)!;
      ahead.delete(index);
      const from = index === first ? offset : 0;
      const to = index === last ? end - index * manifest.chunkSize + 1 : current.length;
      yield current.subarray(from, to);
    }
  }

  forget(cid: string): void {
    this.manifests.delete(cid);
  }
}
