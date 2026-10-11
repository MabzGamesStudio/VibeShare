import type { ServerResponse } from 'node:http';
import { chunkIdOf, chunksForRange, contentIdOf, MiB, validateManifest, type Manifest } from '../shared/content.js';
import type { NodeEntry } from '../shared/clientapi.js';
import { RemoteError } from '../shared/http.js';
import { log } from '../shared/log.js';
import type { ChunkCache } from './cache.js';
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
    private readonly cache: ChunkCache
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
   * Streams bytes [start, end] to an HTTP response (Range requests from <video>/<audio>),
   * fetching a couple of chunks ahead so playback does not stall at chunk boundaries.
   */
  async stream(cid: string, res: ServerResponse, range: string | undefined, download: boolean): Promise<void> {
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
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
    }
    const headers: Record<string, string | number> = {
      'content-type': manifest.mime,
      'accept-ranges': 'bytes',
      'content-length': size === 0 ? 0 : end - start + 1,
      'cache-control': 'private, max-age=3600',
      // Content comes from strangers and is served from the daemon's origin: if an HTML or
      // SVG file is ever opened directly, it runs sandboxed, without scripts or access to the API.
      'x-content-type-options': 'nosniff',
    };
    // (Browsers refuse to show PDFs in a sandbox; their viewer does not run page scripts in our origin.)
    if (manifest.mime !== 'application/pdf') {
      headers['content-security-policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'";
    }
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(manifest.name)}`;
    if (size === 0) {
      res.writeHead(200, headers).end();
      return;
    }
    const { first, last, offset } = chunksForRange(manifest, start, end);
    // Fetch the first chunk before answering, so errors still become a proper status code.
    let current = await this.chunk(cid, first);
    res.writeHead(partial ? 206 : 200, headers);
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const readAhead = download ? 4 : 2;
    const ahead = new Map<number, Promise<Buffer>>();
    for (let index = first; index <= last && !closed; index++) {
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
      const piece = current.subarray(from, to);
      if (!res.write(piece)) await new Promise<void>((resolve) => res.once('drain', resolve).once('close', resolve));
    }
    res.end();
  }

  forget(cid: string): void {
    this.manifests.delete(cid);
  }
}
