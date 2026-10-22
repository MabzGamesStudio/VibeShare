// Encoding .vvsh chunks: the VVCH container of I/P/B frames and the built-in encoder.
// Each chunk of each bitrate is a standalone VVCH container: it starts with an I frame
// (a keyframe holding the block itself) and continues with P and B frames carrying only
// the change against the frame before them (zero-run packed deltas), which is what makes
// chunks efficient — a chunk decodes on its own, and unchanged regions cost almost
// nothing. The container is codec-agnostic: real encoders drop their own bytes in as
// frame payloads with the same I/P/B typing; the built-in `vvsh-frames/1` encoder is
// deterministic and lossless at the top bitrate, so exports reassemble the exact source.
// Browser-safe: no Node imports.
import type { VvshFrameStats, VvshMeta, VvshNode, VvshRendition } from './vvsh.js';
import { vvshPayloadHash, vvshRecordBytes, type VvshFile, type VvshHash } from './vvsh.js';

export type VvshFrameType = 'I' | 'P' | 'B';

/** One frame inside a chunk: its type and its payload. */
export interface VvshFrame {
  type: VvshFrameType;
  data: Uint8Array;
}

const MAGIC = [0x56, 0x56, 0x43, 0x48]; // "VVCH"

/** Packs a chunk of frames into a VVCH container. */
export function encodeVvshChunk(frames: VvshFrame[]): Uint8Array {
  if (!frames.length) throw new Error('A vvsh chunk needs at least one frame');
  if (frames[0].type !== 'I') throw new Error('A vvsh chunk starts with its I frame');
  let size = 9 + 5 * frames.length;
  for (const frame of frames) size += frame.data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = 1;
  view.setUint32(5, frames.length);
  let at = 9;
  for (const frame of frames) {
    out[at] = frame.type.charCodeAt(0);
    view.setUint32(at + 1, frame.data.length);
    out.set(frame.data, at + 5);
    at += 5 + frame.data.length;
  }
  return out;
}

/** Reads a VVCH container back into its frames; throws when the bytes are not one. */
export function decodeVvshChunk(bytes: Uint8Array): VvshFrame[] {
  if (bytes.length < 9 || !MAGIC.every((byte, index) => bytes[index] === byte) || bytes[4] !== 1) {
    throw new Error('Not a vvsh chunk container');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(5);
  const frames: VvshFrame[] = [];
  let at = 9;
  for (let i = 0; i < count; i++) {
    const type = String.fromCharCode(bytes[at]);
    if (type !== 'I' && type !== 'P' && type !== 'B') throw new Error('Bad vvsh frame type');
    const length = view.getUint32(at + 1);
    if (at + 5 + length > bytes.length) throw new Error('Truncated vvsh chunk');
    frames.push({ type, data: bytes.slice(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return frames;
}

/** How many of each frame type a list of frames holds. */
export function frameStats(frames: VvshFrame[]): VvshFrameStats {
  const stats: VvshFrameStats = { i: 0, p: 0, b: 0 };
  for (const frame of frames) stats[frame.type.toLowerCase() as 'i' | 'p' | 'b']++;
  return stats;
}

/** The frame layout every chunk follows: one I keyframe, then P and B frames. */
export function framePattern(gop: number): VvshFrameType[] {
  const pattern: VvshFrameType[] = ['I'];
  for (let i = 1; i < Math.max(1, gop); i++) pattern.push(i % 3 === 2 ? 'B' : 'P');
  return pattern;
}

/**
 * Packs a delta (XOR against the frame before) as zero runs and raw runs: where the
 * picture barely moves, a P or B frame costs almost nothing. The writer grows its typed
 * array geometrically — a plain JS array of numbers overflows on large frames.
 */
class ByteWriter {
  private bytes = new Uint8Array(1024);
  private used = 0;

  private need(extra: number): void {
    if (this.used + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.used + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.used));
    this.bytes = grown;
  }

  byte(value: number): void {
    this.need(1);
    this.bytes[this.used++] = value;
  }

  raw(source: Uint8Array): void {
    this.need(source.length);
    this.bytes.set(source, this.used);
    this.used += source.length;
  }

  take(): Uint8Array {
    return this.bytes.slice(0, this.used);
  }
}

function packDelta(delta: Uint8Array): Uint8Array {
  const out = new ByteWriter();
  let at = 0;
  while (at < delta.length) {
    const zero = delta[at] === 0;
    let end = at;
    while (end < delta.length && (delta[end] === 0) === zero && end - at < 0xffff) end++;
    out.byte(zero ? 0 : 1);
    out.byte((end - at) >> 8);
    out.byte((end - at) & 0xff);
    if (!zero) out.raw(delta.subarray(at, end));
    at = end;
  }
  return out.take();
}

function unpackDelta(packed: Uint8Array, length: number): Uint8Array {
  const delta = new Uint8Array(length);
  let at = 0;
  let out = 0;
  while (at < packed.length && out < length) {
    const kind = packed[at];
    const run = (packed[at + 1] << 8) | packed[at + 2];
    at += 3;
    if (kind === 0) {
      out += run;
    } else {
      delta.set(packed.subarray(at, at + run), out);
      at += run;
      out += run;
    }
  }
  return delta;
}

/**
 * Encodes one chunk's blocks into frames: the first is the I keyframe (the block itself),
 * the P and B frames after it carry only their change against the frame before.
 */
export function encodeVvshFrames(blocks: Uint8Array[], pattern: VvshFrameType[] = framePattern(blocks.length)): VvshFrame[] {
  if (!blocks.length) throw new Error('A chunk needs at least one frame block');
  const frames: VvshFrame[] = [];
  let previous: Uint8Array = new Uint8Array(blocks[0].length);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const type = pattern[Math.min(i, pattern.length - 1)];
    if (type === 'I' || block.length !== previous.length) {
      frames.push({ type: 'I', data: block });
    } else {
      const delta = new Uint8Array(block.length);
      for (let j = 0; j < block.length; j++) delta[j] = block[j] ^ previous[j];
      frames.push({ type, data: packDelta(delta) });
    }
    previous = block;
  }
  return frames;
}

/** What the user picks when building a .vvsh: the encodings, chunk length and previews. */
export interface VvshBuildConfig {
  /** The bitrate encodings to store every chunk at (the first is the largest). */
  bitrates: VvshRendition[];
  /** Length of time each chunk covers, in seconds. */
  chunkSeconds: number;
  /** How many image previews the video is split into (0 or omitted: none). */
  previewSplits?: number;
  /** Frames per chunk (one I keyframe, then P and B frames). Default 8. */
  gop?: number;
}

/** What a build gets when the user picks nothing of their own. */
export const DEFAULT_VVSH_BUILD: VvshBuildConfig = {
  chunkSeconds: 10,
  previewSplits: 6,
  bitrates: [
    { id: '2160p', label: '4K', height: 2160, kbps: 20_000 },
    { id: '1080p', label: '1080p', height: 1080, kbps: 5_000 },
    { id: '720p', label: '720p', height: 720, kbps: 2_500 },
  ],
};

/** The numbers one configuration gives: how many chunks and previews a video has. */
export function vvshPlan(totalSeconds: number, config: VvshBuildConfig): { chunkCount: number; previewCount: number } {
  if (!(totalSeconds > 0)) throw new Error('The video needs a length');
  if (!(config.chunkSeconds > 0)) throw new Error('A chunk needs a length in seconds');
  if (!config.bitrates.length) throw new Error('Pick at least one bitrate encoding');
  const chunkCount = Math.max(1, Math.ceil(totalSeconds / config.chunkSeconds));
  const previewCount = Math.max(0, Math.floor(config.previewSplits ?? 0));
  return { chunkCount, previewCount };
}

/** One chunk's worth of one rendition: its VVCH container and the frame statistics. */
export interface VvshEncodedChunk {
  id: string;
  data: Uint8Array;
  frames: VvshFrameStats;
}

/** Takes `count` bytes of a block, spread evenly over it (lower bitrates keep less). */
function sample(block: Uint8Array, count: number): Uint8Array {
  if (count >= block.length) return block;
  if (count <= 0) return new Uint8Array(0);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = block[Math.floor((i * block.length) / count)];
  return out;
}

/** Splits a block into `gop` frame blocks, as even as one byte can be. */
function frameBlocks(block: Uint8Array, gop: number): Uint8Array[] {
  const frames = Math.max(1, Math.min(gop, Math.max(1, block.length)));
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const start = Math.floor((i * block.length) / frames);
    const end = Math.floor(((i + 1) * block.length) / frames);
    blocks.push(block.subarray(start, end));
  }
  return blocks;
}

/** A tiny preview image for one section of the video (a data URL, a few hundred bytes). */
function previewImage(section: Uint8Array): string {
  let hue = 0;
  for (let i = 0; i < section.length; i += Math.max(1, Math.floor(section.length / 64))) hue = (hue * 31 + section[i]) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="hsl(${hue},60%,45%)"/><rect y="60" width="160" height="30" fill="hsl(${(hue + 40) % 360},50%,30%)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** What one .vvsh build needs beyond the video bytes themselves. */
export interface VvshBuildOptions {
  totalSeconds: number;
  config: VvshBuildConfig;
  /** Real preview thumbnails (frames pulled from the video); generated when absent. */
  previews?: string[];
  /** The mime of the video that was uploaded, so players know what the stream holds. */
  sourceMime?: string;
  /**
   * Pre-encoded streams per rendition (each already encoded to its resolution and frame
   * rate). When given, every encoding chunks its own stream — that is what makes one
   * quality actually differ from another. Without it the built-in encoder derives the
   * renditions from `source` (a real upload stays intact at every level).
   */
  streams?: Record<string, Uint8Array>;
}

/**
 * Builds a whole .vvsh stream from one source video: every chunk of every bitrate
 * encoding (I/P/B framed), the merkle tree above them, and the metadata. Every record and
 * payload goes out through `onObject` (which may return a promise) the moment it exists,
 * so a long video is never held twice in memory — only the chunk being built and the
 * tree's hashes. The largest bitrate keeps every source byte, so exporting it
 * reassembles the exact video back.
 */
export async function buildVvsh(
  source: Uint8Array,
  options: VvshBuildOptions,
  onObject?: (hash: VvshHash, data: Uint8Array, kind: 'branch' | 'chunk' | 'payload') => void | Promise<void>
): Promise<{ file: VvshFile; objects: number }> {
  const { config } = options;
  const { chunkCount, previewCount } = vvshPlan(options.totalSeconds, config);
  const gop = Math.max(1, Math.floor(config.gop ?? 8));
  const top = Math.max(...config.bitrates.map((rendition) => rendition.kbps));
  let objects = 0;
  const emit = async (hash: VvshHash, data: Uint8Array, kind: 'branch' | 'chunk' | 'payload') => {
    objects++;
    await onObject?.(hash, data, kind);
  };

  const nodeHashes: VvshHash[] = [];
  const bytesByRendition = new Map<string, number>();
  for (let index = 0; index < chunkCount; index++) {
    const start = Math.floor((index * source.length) / chunkCount);
    const end = Math.floor(((index + 1) * source.length) / chunkCount);
    const block = source.subarray(start, end);
    const renditions: { id: string; hash: VvshHash; size: number; frames: VvshFrameStats }[] = [];
    for (const rendition of config.bitrates) {
      // With a pre-encoded stream per encoding each quality is its own bytes; without one
      // a real video's container can't survive thinning, so every encoding of a real
      // upload carries the stream intact (they share one object). Synthetic input is
      // thinned to its declared rate.
      const stream = options.streams?.[rendition.id];
      const piece = stream
        ? stream.subarray(Math.floor((index * stream.length) / chunkCount), Math.floor(((index + 1) * stream.length) / chunkCount))
        : options.sourceMime
          ? block
          : sample(block, Math.max(1, Math.round((block.length * rendition.kbps) / top)));
      const frames = encodeVvshFrames(frameBlocks(piece, gop), framePattern(gop));
      const data = encodeVvshChunk(frames);
      const hash = vvshPayloadHash(data);
      await emit(hash, data, 'payload');
      renditions.push({ id: rendition.id, hash, size: data.length, frames: frameStats(frames) });
      bytesByRendition.set(rendition.id, (bytesByRendition.get(rendition.id) ?? 0) + data.length);
    }
    const node: VvshNode = { v: 1, kind: 'chunk', index, renditions };
    const bytes = vvshRecordBytes(node);
    const hash = vvshPayloadHash(bytes);
    await emit(hash, bytes, 'chunk');
    nodeHashes.push(hash);
  }

  // The last layers of the tree split into the bitrate encodings; above them the chunks
  // are merkle-ized in time order (the odd node out pairs with itself).
  let level = nodeHashes;
  while (level.length > 1) {
    const next: VvshHash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      const node: VvshNode = { v: 1, kind: 'branch', left, right };
      const bytes = vvshRecordBytes(node);
      const hash = vvshPayloadHash(bytes);
      await emit(hash, bytes, 'branch');
      next.push(hash);
    }
    level = next;
  }

  const images = options.previews?.length
    ? options.previews
    : Array.from({ length: previewCount }, (_, index) => {
        const start = Math.floor((index * source.length) / previewCount);
        const end = Math.floor(((index + 1) * source.length) / previewCount);
        return previewImage(source.subarray(start, end));
      });
  const meta: VvshMeta = {
    v: 1,
    codec: 'vvsh-frames/1',
    sourceMime: options.streams ? (options.sourceMime ?? 'video/webm') : options.sourceMime,
    chunkSeconds: config.chunkSeconds,
    chunkCount,
    totalSeconds: options.totalSeconds,
    bitrates: [...config.bitrates]
      .sort((a, b) => b.kbps - a.kbps)
      .map((rendition) => ({ ...rendition, bytes: bytesByRendition.get(rendition.id) ?? 0 })),
    frames: { gop, pattern: framePattern(gop).join('') },
    previews: images.length ? { seconds: options.totalSeconds / images.length, images } : undefined,
  };
  return { file: { meta, root: level[0] }, objects };
}

/** Pieces one bitrate's chunks back into the full stream (the file a user exports). */
export function exportVvshStream(chunks: Uint8Array[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const chunk of chunks) blocks.push(...decodeVvshFrames(decodeVvshChunk(chunk)));
  let size = 0;
  for (const block of blocks) size += block.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

/** Decodes a chunk's frames back into the blocks they hold, in order. */
export function decodeVvshFrames(frames: VvshFrame[]): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  for (const frame of frames) {
    if (frame.type === 'I') {
      blocks.push(frame.data);
      previous = frame.data;
    } else {
      const delta = unpackDelta(frame.data, previous.length);
      const block = new Uint8Array(previous.length);
      for (let j = 0; j < block.length; j++) block[j] = previous[j] ^ delta[j];
      blocks.push(block);
      previous = block;
    }
  }
  return blocks;
}