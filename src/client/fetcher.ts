import { bytesMatchCid, chunkIdOf, chunksForRange, CID_MISMATCH, contentIdOf, mimeFromName, MiB, validateManifest, type Manifest } from '../shared/content.js';
import { builtinContent, type BuiltinContent } from '../shared/builtin-content.js';
import type { ContentLink } from '../shared/protocol.js';
import type { NodeEntry } from '../shared/clientapi.js';
import { RemoteError } from '../shared/remote.js';
import { log } from '../shared/log.js';
import type { ChunkStore } from './model.js';
import { errorText, type NodeManager } from './nodes.js';
import { NO_TRACES, type TraceLog } from './trace.js';

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
 * The answer a provider sends when it does not hold a cid but knows where its bytes live:
 * `{ missing: true, links }` — the client fetches them itself and accepts only bytes that
 * hash to the cid exactly. Anything else is not a link answer.
 */
function offeredLinks(answer: unknown, cid: string): ContentLink[] | null {
  if (!answer || typeof answer !== 'object') return null;
  const body = answer as { missing?: unknown; links?: unknown };
  if (body.missing !== true || !Array.isArray(body.links)) return null;
  const links: ContentLink[] = [];
  for (const entry of body.links) {
    if (!entry || typeof entry !== 'object') continue;
    const link = entry as { cid?: unknown; url?: unknown };
    if (typeof link.url !== 'string' || !/^https?:\/\//.test(link.url)) continue;
    if (typeof link.cid === 'string' && link.cid && link.cid !== cid) continue;
    links.push({ cid, url: link.url });
  }
  return links;
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
  private links = new Map<string, ContentLink[]>();
  private inflight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly nodes: NodeManager,
    private readonly cache: ChunkStore,
    private readonly traces: TraceLog = NO_TRACES
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
    let mismatched = false;
    const skipped = this.nodes.active('provider').filter((node) => !this.nodes.affordable(node, this.nodes.providerPrice(node)));
    for (const node of skipped) attempts.push({ node: node.id, name: node.name, error: 'Above your price limit' });
    for (const provider of this.candidates()) {
      const client = this.nodes.client(provider);
      const url = `${client.url}/v1/content/${cid}`;
      const started = Date.now();
      try {
        const answer: unknown = await client.json(`/v1/content/${cid}`, { timeoutMs: 10000 });
        // A node that holds only a downloadable copy sends links instead of a manifest:
        // remember them and keep looking — a real manifest anywhere beats links.
        const links = offeredLinks(answer, cid);
        if (links) {
          const seen = this.links.get(cid) ?? [];
          this.links.set(cid, [...seen, ...links.filter((link) => !seen.some((known) => known.url === link.url))]);
          attempts.push({ node: provider.id, name: provider.name, error: 'Does not hold it — sent a download link' });
          continue;
        }
        const manifest = validateManifest(answer);
        // The retrieved content must match the cid the client asked for exactly: a manifest
        // is only taken when its own hash is exactly that cid.
        if (contentIdOf(manifest) !== cid) {
          mismatched = true;
          throw new Error(CID_MISMATCH);
        }
        const hit = { manifest, provider };
        this.manifests.set(cid, hit);
        this.traces.trace('dependency', 'fetcher', `GET /v1/content/${cid}`, {
          message: provider.name,
          data: this.traces.summarize({ node: provider.id, url, method: 'GET', ms: Date.now() - started, status: 200, chunks: manifest.chunks.length }),
        });
        return hit;
      } catch (error) {
        const notHere = error instanceof RemoteError && error.status === 404;
        this.traces.trace('dependency', 'fetcher', `GET /v1/content/${cid}`, {
          message: provider.name,
          data: this.traces.summarize({ node: provider.id, url, method: 'GET', ms: Date.now() - started, status: error instanceof RemoteError ? error.status : undefined }),
          error: notHere ? 'Does not have it' : errorText(error),
        });
        attempts.push({ node: provider.id, name: provider.name, error: notHere ? 'Does not have it' : errorText(error) });
      }
    }
    const why = mismatched ? CID_MISMATCH : 'No provider node has this content';
    this.traces.trace('error', 'fetcher', 'manifest failed', { message: cid, error: why });
    throw new FetchError(why, attempts);
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
    let mismatched = false;
    for (const provider of this.candidates(preferred)) {
      const client = this.nodes.client(provider);
      const path = `/v1/chunks/${chunkId}?cid=${cid}`;
      const started = Date.now();
      try {
        const response = await client.fetch(path, { timeoutMs: 60000 });
        const data = Buffer.from(await response.arrayBuffer());
        // The downloaded content must match the expected id exactly (each chunk id is the
        // hash of its bytes); anything else is not kept or sent on.
        if (chunkIdOf(data) !== chunkId) {
          mismatched = true;
          throw new Error(CID_MISMATCH);
        }
        await this.cache.put(chunkId, data);
        this.traces.trace('dependency', 'fetcher', `GET /v1/chunks/${chunkId.slice(0, 12)}`, {
          message: provider.name,
          data: this.traces.summarize({ node: provider.id, url: `${client.url}${path}`, method: 'GET', ms: Date.now() - started, status: response.status, bytes: data.length }),
        });
        return data;
      } catch (error) {
        this.traces.trace('dependency', 'fetcher', `GET /v1/chunks/${chunkId.slice(0, 12)}`, {
          message: provider.name,
          data: this.traces.summarize({ node: provider.id, url: `${client.url}${path}`, method: 'GET', ms: Date.now() - started, status: error instanceof RemoteError ? error.status : undefined }),
          error: errorText(error),
        });
        attempts.push({ node: provider.id, name: provider.name, error: errorText(error) });
        log.debug(`Chunk ${chunkId.slice(0, 12)} from ${provider.name}: ${errorText(error)}`);
      }
    }
    const why = mismatched ? CID_MISMATCH : 'No provider could send this part of the content';
    this.traces.trace('error', 'fetcher', 'chunk failed', { message: chunkId.slice(0, 12), error: why });
    throw new FetchError(why, attempts);
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
    this.traces.trace('basic', 'fetcher', 'open', { message: cid, data: { range: range ?? null, download } });
    // Content the client ships with (the default article describing VibeShare): its full
    // bytes are always on hand, so it streams and downloads with no provider connection.
    const builtin = builtinContent(cid);
    if (builtin) return this.builtinAnswer(builtin, range, download);
    let hit: ManifestHit;
    try {
      hit = await this.manifest(cid);
    } catch (error) {
      // Only downloadable copies: the providers sent links instead of a manifest. The
      // bytes behind them are taken only on an exact cid match.
      const links = this.links.get(cid);
      if (links?.length) return this.linkAnswer(cid, links, range, download);
      throw error;
    }
    const { manifest } = hit;
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
    // A download is verified in full before answering: the manifest was only accepted when
    // its hash is exactly the requested cid, and every chunk only when its bytes hash to
    // its id — so what is then sent is exactly the content that cid names, or nothing.
    if (download) for (let index = first; index <= last; index++) await this.chunk(cid, index);
    const firstChunk = await this.chunk(cid, first);
    this.traces.trace('basic', 'fetcher', 'open → ok', { data: { chunks: last - first + 1, status: partial ? 206 : 200 } });
    return { status: partial ? 206 : 200, headers, body: this.pieces(cid, manifest, firstChunk, first, last, offset, end, download ? 4 : 2) };
  }

  /** The client's own bytes for a content id it ships with — served like any other, minus the providers. */
  private builtinAnswer(found: BuiltinContent, range: string | null | undefined, download: boolean): ContentResponse {
    return this.blobAnswer(new TextEncoder().encode(found.text), found.name, found.mime, range, download);
  }

  /**
   * Content fetched whole from the links a provider sent (downloadable copies have no
   * manifest): every link is tried in order and only bytes that hash to the cid exactly
   * are ever served.
   */
  private async linkAnswer(cid: string, links: ContentLink[], range: string | null | undefined, download: boolean): Promise<ContentResponse> {
    const attempts: { node: string; name: string; error: string }[] = [];
    for (const link of links) {
      try {
        const response = await fetch(link.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) {
          attempts.push({ node: 'link', name: link.url, error: `The link answered ${response.status}` });
          continue;
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (!bytesMatchCid(data, cid)) {
          attempts.push({ node: 'link', name: link.url, error: CID_MISMATCH });
          continue;
        }
        const name = (decodeURIComponent(link.url.split('?')[0].split('/').filter(Boolean).pop() ?? '') || 'content').slice(0, 255);
        return this.blobAnswer(data, name, mimeFromName(name), range, download);
      } catch (error) {
        attempts.push({ node: 'link', name: link.url, error: errorText(error) });
      }
    }
    this.traces.trace('error', 'fetcher', 'link answer failed', { message: cid, error: 'No provider could send this content through its links' });
    throw new FetchError('No provider could send this content through its links', attempts);
  }

  /** One whole file held in memory, ranged and downloadable like the chunked content. */
  private blobAnswer(data: Uint8Array, name: string, mime: string, range: string | null | undefined, download: boolean): ContentResponse {
    const size = data.length;
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
      'content-type': mime,
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    };
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    async function* pieces(): AsyncGenerator<Uint8Array> {
      yield data.subarray(start, end + 1);
    }
    return { status: partial ? 206 : 200, headers, body: pieces() };
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
    this.links.delete(cid);
  }
}
