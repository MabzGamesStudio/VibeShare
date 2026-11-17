// Publishing and .vvsh verifiable video streams: the id an upload will have before it is
// sent, pulling a file in from a link, building a stream here or letting a provider
// convert one, publishing it, and reading it back chunk by chunk — every record and
// payload verified against its hash. One collaborator of ClientCore; browser-safe.
import type { NodeEntry, PublishPreview, PublishRequest } from '../shared/clientapi.js';
import { bytesMatchCid, bytesMatchManifest, CID_MISMATCH } from '../shared/content.js';
import { DEFAULT_CHUNK_SIZE, chunkIdOf, contentIdOf, signManifest, type Manifest, type ManifestMeta } from '../shared/content.js';
import { badRequest } from '../shared/errors.js';
import { log } from '../shared/node/log.js';
import { claimSigningPayload } from '../shared/protocol.js';
import { RemoteError } from '../shared/remote.js';
import { signData } from '../shared/crypto.js';
import { formatSource, isNativeId, parseSource, sourceFromUrl } from '../shared/sources.js';
import { assembleVvshWebm, DEFAULT_VVSH_BUILD, buildVvsh as encodeVvsh, decodeVvshChunk, decodeVvshFrames, exportVvshStream, type VvshBuildConfig } from '../shared/vvsh-encode.js';
import { parseVvshNode, pathToChunk, type VvshConvertQuote, type VvshFile, type VvshFrameStats } from '../shared/vvsh.js';
import { rememberPublished } from './published.js';
import { errorText } from './nodes.js';
import type { ClientCore } from './core.js';

/** Publishing and .vvsh stream flows, for one client. */
export class Publishing {
  constructor(private readonly core: ClientCore) {}

  /** The content id an upload will have, computed on this client before publishing. */
  async previewPublish(request: PublishRequest): Promise<PublishPreview> {
    return this.core.publisher.preview(request);
  }

  /**
   * Pulls the data behind a URL into this client as a file to publish, e.g. when
   * suggesting missing content: the content id is then computed here and the bytes are
   * uploaded from this device.
   */
  async uploadFromUrl(rawUrl: string): Promise<{ fileId: string; size: number; name: string; mime: string }> {
    let url: URL;
    try {
      url = new URL(String(rawUrl ?? ''));
    } catch {
      throw badRequest('Not a URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('Only http(s) URLs can be pulled');
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw badRequest(`The URL answered ${response.status}`);
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream';
    const name = (decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '') || 'file').slice(0, 255);
    const stream = response.body;
    const stored = stream && this.core.uploads.putStream
      ? await this.core.uploads.putStream(stream)
      : await this.core.uploads.put(new Uint8Array(await response.arrayBuffer()));
    return { ...stored, name, mime };
  }

  /**
   * Fetches content from a link a provider offered (a provider sends a link instead of
   * the bytes when it does not hold them), or from a URL job's host. The retrieved
   * content is accepted only on an exact match: bytes that hash to the cid (a
   * downloadable copy), or — for a native content id, which names its manifest — a file
   * whose size and every chunk hash to that manifest (the same check a provider runs).
   * Otherwise the answer says the downloaded content from the node/link does not match
   * the expected cid.
   */
  async fetchContentLink(url: string, cid: string): Promise<{ ok: boolean; size: number; error?: string }> {
    let data: Uint8Array;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return { ok: false, size: 0, error: `The link answered ${response.status}` };
      data = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { ok: false, size: 0, error: 'The link could not be reached' };
    }
    if (bytesMatchCid(data, cid)) return { ok: true, size: data.length };
    // A native content id is the hash of its manifest, so the file itself never hashes to
    // it: the manifest's chunk hashes prove the bytes. The manifest comes from the cache
    // when it was just fetched, otherwise from the providers holding that content.
    if (isNativeId(cid)) {
      try {
        const { manifest } = await this.core.fetcher.manifest(cid);
        if (bytesMatchManifest(data, manifest)) return { ok: true, size: data.length };
        // Say how the bytes differ, so a wrong file at the URL is easy to spot.
        return {
          ok: false,
          size: 0,
          error: `${CID_MISMATCH} (the link served ${data.length} bytes; this content is ${manifest.size} bytes and its chunks do not match)`,
        };
      } catch {
        // No manifest could be read: nothing proves these bytes are that content.
      }
    }
    return { ok: false, size: 0, error: CID_MISMATCH }; // only an exact match is accepted
  }
  // -------------------------------------------------------------------------
  // .vvsh verifiable video streams: building one here or on a node, publishing it, and
  // reading it back chunk by chunk — every record and payload verified against its hash.

  /**
   * Builds one video's .vvsh stream and publishes it: every record and payload is uploaded
   * the moment it exists, so a long video is never held twice in memory, then the signed
   * manifest (the metadata and root alone) is committed.
   */
  async publishVvshStream(
    node: NodeEntry,
    source: Uint8Array,
    options: {
      name: string;
      totalSeconds: number;
      config?: VvshBuildConfig;
      meta?: ManifestMeta;
      sourceMime?: string;
      previews?: string[];
      /** Opt in to the daemon's configured native encoder (legacy API calls stay lossless). */
      encoder?: 'ffmpeg';
      /** External copies the manifest falls back to (raw links; normalized here). */
      sources?: string[];
      /** The algorithm nodes to put the content id in front of; every active one when omitted. */
      algorithms?: string[];
      /** Sign as the creator — off publishes without a creator identity. */
      sign?: boolean;
      /** A small image (data: URL) the algorithm nodes show with the listing. */
      thumbnail?: string;
      /** One stamp across providers keeps the content id the same everywhere. */
      createdAt?: string;
    }
  ): Promise<{ cid: string; manifest: Manifest; objects: number; listed: number }> {
    const client = this.core.nodes.client(node);
    this.core.traces.trace('basic', 'core.publish', 'publish vvsh', { message: options.name, data: { node: node.id, bytes: source.length } });
    const config = options.config ?? DEFAULT_VVSH_BUILD;
    const webm = options.encoder === 'ffmpeg' && this.core.options.transcodeVvsh
      ? await this.core.options.transcodeVvsh(source, config, options.totalSeconds)
      : undefined;
    const { file, objects } = await encodeVvsh(
      webm ? new Uint8Array(0) : source,
      { totalSeconds: options.totalSeconds, config, sourceMime: webm ? 'video/webm' : options.sourceMime, previews: options.previews, webm },
      async (hash, data) => {
        await client.json(`/v1/vvsh/objects/${encodeURIComponent(hash)}`, { method: 'PUT', raw: data });
      }
    );
    const manifest: Manifest = {
      v: 1,
      name: options.name,
      mime: 'video/x-vvsh',
      size: 0,
      chunkSize: DEFAULT_CHUNK_SIZE,
      chunks: [],
      createdAt: options.createdAt ?? new Date().toISOString(),
      vvsh: file,
    };
    if (options.meta && Object.keys(options.meta).length) manifest.meta = options.meta;
    const sources = this.normalizeVvshSources(options.sources);
    if (sources?.length) manifest.sources = sources;
    const signed = options.sign === false ? manifest : signManifest(manifest, this.core.store.identity, this.core.settings.profile);
    await client.json('/v1/vvsh/manifest', { method: 'PUT', body: { manifest: signed } });
    const cid = contentIdOf(signed);
    const listed = await this.submitVvshToAlgorithms(cid, signed, node, { algorithms: options.algorithms, sign: options.sign, thumbnail: options.thumbnail });
    rememberPublished(this.core.store, cid, signed.meta?.title ?? signed.name);
    this.core.traces.trace('basic', 'core.publish', 'publish vvsh → done', { data: { cid, objects, listed } });
    return { cid, manifest: signed, objects, listed };
  }

  /** The backend local publishing will use, including the warning the GUI must show. */
  encoderInfo(): Promise<{ backend: 'ffmpeg' | 'mediarecorder'; warning?: string }> {
    return this.core.options.encoderInfo?.() ?? Promise.resolve({
      backend: 'mediarecorder',
      warning: 'FFmpeg is not available in this browser. Using the slower, realtime MediaRecorder fallback.',
    });
  }

  /** What one provider asks to calculate a .vvsh from just the video. */
  quoteVvshConvert(
    node: NodeEntry,
    options: { bytes: number; totalSeconds: number; config?: VvshBuildConfig }
  ): Promise<{ quote: VvshConvertQuote }> {
    return this.core.nodes.client(node).json<{ quote: VvshConvertQuote }>('/v1/vvsh/quote', { method: 'POST', body: options });
  }

  /**
   * Lets a provider calculate the .vvsh stream from just the video, sent in pieces so a
   * long one never overflows anything: the quote first, then the pieces, then the work
   * (charged before it runs), then the signed manifest is committed there.
   */
  async convertVvshOn(
    node: NodeEntry,
    options: {
      data: Uint8Array;
      name: string;
      totalSeconds: number;
      config?: VvshBuildConfig;
      meta?: ManifestMeta;
      sourceMime?: string;
      previews?: string[];
      /** How far the provider's own processing is, 0–100, from each polled state. */
      onProgress?: (percent: number) => void;
      /** External copies the manifest falls back to (raw links; normalized here). */
      sources?: string[];
      /** The algorithm nodes to put the content id in front of; every active one when omitted. */
      algorithms?: string[];
      /** Sign as the creator — off publishes without a creator identity. */
      sign?: boolean;
      /** A small image (data: URL) the algorithm nodes show with the listing. */
      thumbnail?: string;
      /** One stamp across providers keeps the content id the same everywhere. */
      createdAt?: string;
    }
  ): Promise<{ cid: string; quote: VvshConvertQuote; manifest: Manifest; listed: number; warnings: string[] }> {
    const client = this.core.nodes.client(node);
    this.core.traces.trace('basic', 'core.publish', 'convert vvsh', { message: options.name, data: { node: node.id, bytes: options.data.length } });
    const warnings: string[] = [];
    const retryOnce = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        const transient = !(error instanceof RemoteError) || error.status === 429 || error.status >= 500;
        if (!transient) throw error;
        const warning = `${label} failed (${errorText(error)}). Retrying once.`;
        warnings.push(warning);
        log.warn(warning);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return run();
      }
    };
    const started = await client.json<{ jobId: string; quote: VvshConvertQuote }>('/v1/vvsh/convert', {
      method: 'POST',
      body: {
        name: options.name,
        bytes: options.data.length,
        totalSeconds: options.totalSeconds,
        config: options.config,
        meta: options.meta,
        sourceMime: options.sourceMime,
        previews: options.previews,
      },
    });
    const pieceSize = 2 * 1024 * 1024;
    for (let at = 0; at < options.data.length; at += pieceSize) {
      const index = Math.floor(at / pieceSize);
      await retryOnce(`Uploading video piece ${index + 1}`, () =>
        client.json(`/v1/vvsh/convert/${started.jobId}/piece?index=${index}`, {
          method: 'PUT',
          raw: options.data.subarray(at, at + pieceSize),
        })
      );
    }
    type ConversionState = {
      status: 'uploading' | 'running' | 'done' | 'error';
      progress?: number;
      manifest?: Manifest;
      quote: VvshConvertQuote;
      error?: string;
      warnings?: string[];
    };
    let converted = await retryOnce('Starting provider conversion', () =>
      client.json<ConversionState>(`/v1/vvsh/convert/${started.jobId}/finish`, { method: 'POST', body: {}, timeoutMs: 10_000 })
    );
    options.onProgress?.(converted.progress ?? 0);
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (converted.status !== 'done' && converted.status !== 'error') {
      if (Date.now() >= deadline) throw new Error('Provider conversion did not finish within 24 hours');
      // Spaced polling: the provider works for minutes on a large video — asking it every
      // few seconds is enough to notice progress without hammering it.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      converted = await retryOnce('Polling provider conversion', () =>
        client.json<ConversionState>(`/v1/vvsh/convert/${started.jobId}`, { timeoutMs: 10_000 })
      );
      options.onProgress?.(converted.progress ?? 0);
    }
    warnings.push(...(converted.warnings ?? []));
    if (converted.status === 'error' || !converted.manifest) {
      const why = converted.error || 'Provider conversion failed';
      this.core.traces.trace('error', 'core.publish', 'convert vvsh failed', { message: node.name, error: why });
      throw new Error(why);
    }
    // The caller's stamp and fallback links go in before signing: the same video on two
    // providers then lands on the same content id.
    const base: Manifest = { ...converted.manifest, ...(options.createdAt ? { createdAt: options.createdAt } : {}) };
    const sources = this.normalizeVvshSources(options.sources);
    if (sources?.length) base.sources = sources;
    const signed = options.sign === false ? base : signManifest(base, this.core.store.identity, this.core.settings.profile);
    const manifestStarted = Date.now();
    const committed = await client.json<{ cid: string }>('/v1/vvsh/manifest', { method: 'PUT', body: { manifest: signed } });
    this.core.traces.trace('dependency', 'core', 'PUT /v1/vvsh/manifest', {
      message: node.name,
      data: this.core.traces.summarize({ node: node.id, url: `${client.url}/v1/vvsh/manifest`, method: 'PUT', ms: Date.now() - manifestStarted, cid: committed.cid }),
    });
    const listed = await this.submitVvshToAlgorithms(committed.cid, signed, node, { algorithms: options.algorithms, sign: options.sign, thumbnail: options.thumbnail });
    rememberPublished(this.core.store, committed.cid, signed.meta?.title ?? signed.name);
    this.core.traces.trace('basic', 'core.publish', 'convert vvsh → done', { data: { cid: committed.cid, listed, warnings: warnings.length } });
    return { cid: committed.cid, quote: converted.quote, manifest: signed, listed, warnings };
  }

  /** One object (a tree record or a payload) given its hash, checked against that hash. */
  async vvshObject(node: NodeEntry, hash: string): Promise<Uint8Array> {
    const response = await this.core.nodes.client(node).fetch(`/v1/vvsh/objects/${encodeURIComponent(hash)}`);
    const data = new Uint8Array(await response.arrayBuffer());
    // Objects are named by their hash, not a content id: what does not hash to the name
    // it came under is never parsed, played or passed on.
    if (chunkIdOf(data) !== hash) throw new Error('The vvsh object sent does not match the hash naming it');
    return data;
  }

  /** Uploads one already-built .vvsh object (a record or a payload) to a provider. */
  async storeVvshObject(node: NodeEntry, hash: string, data: Uint8Array): Promise<void> {
    await this.core.nodes.client(node).json(`/v1/vvsh/objects/${encodeURIComponent(hash)}`, { method: 'PUT', raw: data });
  }

  /** Commits an already-uploaded .vvsh stream (its objects are on the node) and lists it. */
  async commitVvshStream(
    node: NodeEntry,
    manifest: Manifest,
    options: { algorithms?: string[]; sign?: boolean; thumbnail?: string; sources?: string[] } = {}
  ): Promise<{ cid: string; listed: number }> {
    const base: Manifest = { ...manifest };
    const sources = this.normalizeVvshSources(options.sources ?? manifest.sources);
    if (sources?.length) base.sources = sources;
    const signed = options.sign === false ? base : signManifest(base, this.core.store.identity, this.core.settings.profile);
    const committed = await this.core.nodes.client(node).json<{ cid: string }>('/v1/vvsh/manifest', { method: 'PUT', body: { manifest: signed } });
    const listed = await this.submitVvshToAlgorithms(committed.cid, signed, node, { algorithms: options.algorithms, sign: options.sign, thumbnail: options.thumbnail });
    rememberPublished(this.core.store, committed.cid, signed.meta?.title ?? signed.name);
    this.core.traces.trace('basic', 'core.publish', 'commit vvsh', { data: { cid: committed.cid, listed, node: node.id } });
    return { cid: committed.cid, listed };
  }

  /**
   * One verified chunk of one bitrate at one time. The request is just where to look —
   * the tree root (or a branch the caller already verified), the chunk index and the
   * encoding — and the walk down (single path, every step checked against its parent)
   * fetches only the records it needs, answering with the path it took and the leaf.
   */
  async vvshChunk(
    node: NodeEntry,
    ref: { root: string; chunkCount: number; from?: { hash: string; depth: number } },
    index: number,
    rendition: string
  ): Promise<{ data: Uint8Array; frames: VvshFrameStats; path: string[]; pathDepth: number }> {
    const fetchRecord = async (hash: string): Promise<Uint8Array | null> => {
      try {
        return await this.vvshObject(node, hash);
      } catch {
        return null;
      }
    };
    const steps = pathToChunk(ref.chunkCount, index);
    // A starting branch the caller already checked: only the rest of the path is walked.
    const fromDepth = ref.from && ref.from.depth >= 0 && ref.from.depth < steps.length ? ref.from.depth : 0;
    const path: string[] = [];
    let hash = ref.from && fromDepth ? ref.from.hash : ref.root;
    for (const side of steps.slice(fromDepth)) {
      const bytes = await fetchRecord(hash);
      const record = bytes ? parseVvshNode(bytes, hash) : null;
      if (!record || record.kind !== 'branch') throw new Error('The node did not give a verifiable path to that chunk');
      path.push(hash);
      hash = record[side];
    }
    const bytes = await fetchRecord(hash);
    const chunkNode = bytes ? parseVvshNode(bytes, hash) : null;
    if (!chunkNode || chunkNode.kind !== 'chunk') throw new Error('The node did not give a verifiable path to that chunk');
    path.push(hash);
    const leaf = chunkNode.renditions.find((entry) => entry.id === rendition);
    if (!leaf) throw new Error('This stream has no such bitrate encoding');
    const data = await this.vvshObject(node, leaf.hash);
    path.push(leaf.hash);
    // `path` starts wherever the walk started: `pathDepth` says which depth that is, so
    // a caller reusing a branch knows exactly which hash sits at which depth.
    return { data, frames: leaf.frames, path, pathDepth: fromDepth };
  }

  /** A byte range of one decoded stream by node id — what the /stream/vvsh routes call. */
  async vvshStreamRange(spec: { n: string; r: string; c: number; q: string; d: number }, start: number, end: number): Promise<Uint8Array> {
    return this.vvshRange(this.core.nodes.require(spec.n), { root: spec.r, chunkCount: spec.c }, spec.q, spec.d, start, end);
  }

  /** Every chunk of one bitrate, reassembled into the full video file to save. */
  async exportVvsh(
    node: NodeEntry,
    file: VvshFile,
    rendition: string
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < file.meta.chunkCount; index++) {
      chunks.push((await this.vvshChunk(node, { root: file.root, chunkCount: file.meta.chunkCount }, index, rendition)).data);
    }
    if (file.meta.codec === 'vvsh-webm/1') {
      const selected = file.meta.bitrates.find((entry) => entry.id === rendition);
      if (!selected?.initHash) throw new Error('This stream has no such bitrate encoding');
      const init = await this.vvshObject(node, selected.initHash);
      return assembleVvshWebm(init, chunks, { chunkSeconds: file.meta.chunkSeconds });
    }
    return exportVvshStream(chunks);
  }

  /** Decoded chunks kept briefly, so repeated byte ranges of one stream are cheap. */
  private vvshDecoded = new Map<string, Uint8Array>();

  /** One chunk's decoded bytes (its piece of the video), kept for the next range. */
  private async vvshDecodedChunk(
    node: NodeEntry,
    ref: { root: string; chunkCount: number },
    index: number,
    rendition: string
  ): Promise<Uint8Array> {
    const key = `${ref.root}:${rendition}:${index}`;
    const cached = this.vvshDecoded.get(key);
    if (cached) return cached;
    const chunk = await this.vvshChunk(node, ref, index, rendition);
    const blocks = decodeVvshFrames(decodeVvshChunk(chunk.data));
    const out = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
    let at = 0;
    for (const block of blocks) {
      out.set(block, at);
      at += block.length;
    }
    if (this.vvshDecoded.size > 64) this.vvshDecoded.delete(this.vvshDecoded.keys().next().value!);
    this.vvshDecoded.set(key, out);
    return out;
  }

  /**
   * One byte range of one bitrate's decoded stream — exactly the chunks that hold it and
   * nothing else. With the rendition's `decodedBytes` the chunk boundaries are known
   * arithmetic (`floor(i · bytes / chunks)` — the same cut the build made), so a seek to
   * any part of the video fetches only the chunk or two it lands on.
   */
  async vvshRange(
    node: NodeEntry,
    ref: { root: string; chunkCount: number; from?: { hash: string; depth: number } },
    rendition: string,
    decodedBytes: number,
    start: number,
    end: number
  ): Promise<Uint8Array> {
    const total = Math.max(0, decodedBytes);
    const from = Math.max(0, Math.min(start, total));
    const to = Math.max(from, Math.min(end, total));
    if (to <= from || !total) return new Uint8Array(0);
    const count = ref.chunkCount;
    const first = Math.min(count - 1, Math.floor((from * count) / total));
    const last = Math.min(count - 1, Math.floor(((to - 1) * count) / total));
    // The chunks that hold the range, fetched together — a range is never bigger than a
    // couple of them, and repeated ranges hit the cache instead of paying again.
    const indexes: number[] = [];
    for (let index = first; index <= last; index++) indexes.push(index);
    const decoded = await Promise.all(indexes.map((index) => this.vvshDecodedChunk(node, ref, index, rendition)));
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < indexes.length; i++) {
      const chunkStart = Math.floor((indexes[i] * total) / count);
      const takeStart = Math.max(0, from - chunkStart);
      const takeEnd = Math.min(decoded[i].length, to - chunkStart);
      if (takeEnd > takeStart) pieces.push(decoded[i].subarray(takeStart, takeEnd));
    }
    const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }

  /**
   * Puts a published .vvsh stream in front of the search algorithm nodes as well: the
   * chosen ones when the caller picked them, every active one otherwise.
   */
  private async submitVvshToAlgorithms(
    cid: string,
    manifest: Manifest,
    provider: NodeEntry,
    options: { algorithms?: string[]; sign?: boolean; thumbnail?: string } = {}
  ): Promise<number> {
    const profile = this.core.settings.profile;
    const sign = options.sign !== false;
    const chosen = options.algorithms
      ? this.core.nodes.list('algorithm').filter((node) => options.algorithms?.includes(node.id))
      : this.core.nodes.active('algorithm');
    let listed = 0;
    for (const node of chosen) {
      const client = this.core.nodes.client(node);
      try {
        const info = node.info ?? (await client.fetchInfo());
        const ts = Date.now();
        const submitted = Date.now();
        await client.json('/v1/submissions', {
          method: 'POST',
          timeoutMs: 30000,
          body: {
            id: cid,
            title: manifest.meta?.title ?? manifest.name,
            description: manifest.meta?.description,
            format: manifest.meta?.format ?? 'video',
            rating: manifest.meta?.rating,
            topics: manifest.meta?.topics,
            tags: manifest.meta?.tags,
            language: manifest.meta?.language,
            durationSeconds: manifest.meta?.durationSeconds,
            creator: sign ? { id: this.core.store.identity.id, name: profile.name || undefined, kind: profile.kind } : undefined,
            thumbnail: options.thumbnail,
            providers: [provider.ref],
            publishedAt: manifest.createdAt,
            creatorProof: sign ? { key: this.core.store.identity.id, ts, sig: signData(this.core.store.identity, claimSigningPayload(info.id, cid, ts)) } : undefined,
          },
        });
        this.core.traces.trace('dependency', 'core', 'POST /v1/submissions', {
          message: node.name,
          data: this.core.traces.summarize({ node: node.id, url: `${client.url}/v1/submissions`, method: 'POST', ms: Date.now() - submitted, cid }),
        });
        listed++;
      } catch (error) {
        this.core.traces.trace('dependency', 'core', 'POST /v1/submissions', {
          message: node.name,
          data: this.core.traces.summarize({ node: node.id, url: `${client.url}/v1/submissions`, method: 'POST', cid }),
          error: errorText(error),
        });
        // The stream is published either way; listing is the algorithm node's call.
      }
    }
    return listed;
  }

  /** External copies of a .vvsh stream, as the ids (`yt:…`, `ia:…`) clients fall back to. */
  private normalizeVvshSources(list: string[] | undefined): string[] | undefined {
    if (!list?.length) return undefined;
    const sources: string[] = [];
    for (const text of list) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      const source = parseSource(trimmed) && !/^https?:/.test(trimmed) ? parseSource(trimmed) : sourceFromUrl(trimmed);
      if (!source) throw badRequest(`Not a link or source: ${trimmed}`);
      sources.push(formatSource(source));
    }
    return sources.length ? sources : undefined;
  }
}
