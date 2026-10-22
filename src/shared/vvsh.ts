// The .vvsh file: verifiable video stream hashing. A video is split into time chunks;
// every chunk holds one encoding per configured bitrate (its I/P/B frames in a VVCH
// container, see vvsh-encode.js) and the chunks sit under a merkle tree whose last layers
// split into the bitrate encodings. The file itself is just metadata plus the tree root —
// every branch, chunk node and payload is stored separately, content-addressed by its
// hash, so anyone can start at any branch hash and work down, verifying each step.
// Browser-safe: no Node imports.
import { chunkIdOf } from './content.js';
import { base32Decode, base32Encode } from './encoding.js';
import { CHUNK_PREFIX, isChunkId } from './sources.js';

/** The hash of one tree record or payload: its chunk id. */
export type VvshHash = string;

/** One bitrate encoding level a video is stored at. */
export interface VvshRendition {
  /** Short id, e.g. `720p`. */
  id: string;
  /** What the user sees, e.g. `1080p` or `4K`. */
  label: string;
  /** Vertical resolution, when known. */
  height?: number;
  /** Nominal bitrate in kbit/s (the encoding level). */
  kbps: number;
  /** Frames per second of this encoding, when it was encoded to one. */
  fps?: number;
  /** Total bytes this encoding takes across every chunk. */
  bytes?: number;
}

/** How many of each frame type a chunk holds. */
export interface VvshFrameStats {
  i: number;
  p: number;
  b: number;
}

/**
 * The metadata half of a .vvsh file. It says how the stream is laid out: how long each
 * chunk is, how many there are, which bitrate encodings every chunk holds, and how the
 * I/P/B frames are arranged inside a chunk.
 */
export interface VvshMeta {
  /** Data structure version of the format. */
  v: 1;
  /** What the frames hold: `vvsh-frames/1` (the built-in container) or a real codec id. */
  codec: string;
  /** The mime of the video that was uploaded, so players know what the stream holds. */
  sourceMime?: string;
  /** Length of time each chunk covers, in seconds. */
  chunkSeconds: number;
  /** Total number of chunks (the video's length in chunks). */
  chunkCount: number;
  /** Total length of the video in seconds. */
  totalSeconds: number;
  /** The bitrate encodings every chunk carries (the last layers of the tree). */
  bitrates: VvshRendition[];
  /** How the I/P/B frames are arranged inside each chunk. */
  frames: { gop: number; pattern: string };
  /** Average size of a chunk payload across every encoding, in bytes. */
  avgChunkBytes?: number;
  /**
   * Optional image previews: one image per `seconds` of video, so the client can scrub
   * and see the overall progression without fetching any chunk down to the leaf.
   */
  previews?: { seconds: number; images: string[] };
}

/** The .vvsh file itself: metadata and the root of the stream's merkle tree. */
export interface VvshFile {
  meta: VvshMeta;
  /** The hash of the top tree node (a branch, or the single chunk node). */
  root: VvshHash;
}

/** What one provider asks for a .vvsh conversion: the credits and why. */
export interface VvshConvertQuote {
  credits: number;
  breakdown: { MiB: number; chunks: number; renditions: number; previews: number };
}

/** A record stored on its own under its hash: either a branch of the tree or a chunk node. */
export type VvshNode =
  | { v: 1; kind: 'branch'; left: VvshHash; right: VvshHash }
  | {
      v: 1;
      kind: 'chunk';
      /** Which chunk of the video this is (its position in time). */
      index: number;
      /** Every bitrate encoding of this chunk, as the leaves under this node. */
      renditions: { id: string; hash: VvshHash; size: number; frames: VvshFrameStats }[];
    };

// ---------------------------------------------------------------------------
// The packed form. Tree records are binary (magic "VVND"), not JSON: hashes are their
// raw 32 bytes and numbers are varints — far smaller than the JSON text, which exists
// only as a human-readable translation (see `vvshNodeJson` / `vvshFileJson`).

const RECORD_MAGIC = Uint8Array.from([0x56, 0x56, 0x4e, 0x44]); // "VVND"

class Pack {
  private bytes = new Uint8Array(256);
  private used = 0;

  private need(extra: number): void {
    if (this.used + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.used + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.used));
    this.bytes = grown;
  }

  u8(value: number): void {
    this.need(1);
    this.bytes[this.used++] = value & 0xff;
  }

  u32(value: number): void {
    this.need(4);
    new DataView(this.bytes.buffer).setUint32(this.used, value);
    this.used += 4;
  }

  varint(value: number): void {
    let rest = Math.max(0, Math.floor(value));
    while (rest >= 0x80) {
      this.u8(0x80 | (rest & 0x7f));
      rest = Math.floor(rest / 128);
    }
    this.u8(rest);
  }

  str(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.varint(bytes.length);
    this.need(bytes.length);
    this.bytes.set(bytes, this.used);
    this.used += bytes.length;
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

class Unpack {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  private take(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new Error('Truncated vvsh record');
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return slice;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u32(): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength).getUint32(this.at);
    this.take(4);
    return value;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
  }

  str(): string {
    return new TextDecoder().decode(this.take(this.varint()));
  }

  raw(length: number): Uint8Array {
    return this.take(length);
  }

  get finished(): boolean {
    return this.at >= this.bytes.length;
  }
}

/** The raw 32 bytes inside one hash (`vc1` + base32 of the sha256 of the bytes). */
function hashBytes(hash: VvshHash): Uint8Array {
  if (!isChunkId(hash)) throw new Error('Not a vvsh hash');
  return base32Decode(hash.slice(CHUNK_PREFIX.length));
}

function hashFromBytes(bytes: Uint8Array): VvshHash {
  return CHUNK_PREFIX + base32Encode(bytes);
}

/**
 * The bytes of one tree record in its packed form; its chunk id is the hash the tree
 * uses for it. `vvshNodeJson` translates the same record into readable JSON.
 */
export function vvshRecordBytes(node: VvshNode): Uint8Array {
  const pack = new Pack();
  pack.raw(RECORD_MAGIC);
  pack.u8(1);
  if (node.kind === 'branch') {
    pack.u8(1);
    pack.raw(hashBytes(node.left));
    pack.raw(hashBytes(node.right));
  } else {
    pack.u8(2);
    pack.varint(node.index);
    pack.varint(node.renditions.length);
    for (const rendition of node.renditions) {
      pack.str(rendition.id);
      pack.raw(hashBytes(rendition.hash));
      pack.varint(rendition.size);
      pack.varint(rendition.frames.i);
      pack.varint(rendition.frames.p);
      pack.varint(rendition.frames.b);
    }
  }
  return pack.take();
}

/** Reads one packed record back; null when the bytes are not one. */
export function unpackVvshNode(bytes: Uint8Array): VvshNode | null {
  if (bytes.length < 6 || !RECORD_MAGIC.every((byte, index) => bytes[index] === byte)) return null;
  try {
    const unpack = new Unpack(bytes);
    unpack.raw(4);
    if (unpack.u8() !== 1) return null;
    const kind = unpack.u8();
    if (kind === 1) {
      const node: VvshNode = { v: 1, kind: 'branch', left: hashFromBytes(unpack.raw(32)), right: hashFromBytes(unpack.raw(32)) };
      return unpack.finished ? node : null;
    }
    if (kind !== 2) return null;
    const index = unpack.varint();
    const count = unpack.varint();
    if (count < 1 || count > 64) return null;
    const renditions = [];
    for (let i = 0; i < count; i++) {
      renditions.push({
        id: unpack.str(),
        hash: hashFromBytes(unpack.raw(32)),
        size: unpack.varint(),
        frames: { i: unpack.varint(), p: unpack.varint(), b: unpack.varint() },
      });
    }
    const node: VvshNode = { v: 1, kind: 'chunk', index, renditions };
    return unpack.finished ? node : null;
  } catch {
    return null;
  }
}

/** The human-readable JSON translation of one packed record. */
export function vvshNodeJson(node: VvshNode): Record<string, unknown> {
  return JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
}

/** The hash of a tree record (its chunk id, the same content addressing chunks use). */
export function vvshRecordHash(node: VvshNode): VvshHash {
  return chunkIdOf(vvshRecordBytes(node));
}

/** The hash of one encoded chunk payload (one bitrate of one chunk). */
export function vvshPayloadHash(data: Uint8Array): VvshHash {
  return chunkIdOf(data);
}

/** Which chunk each node of the top tree's bottom level stands for, in time order. */
export function treeLeaves(chunkCount: number): number[] {
  if (!Number.isInteger(chunkCount) || chunkCount < 1) throw new Error('A vvsh tree needs at least one chunk');
  return Array.from({ length: chunkCount }, (_, index) => index);
}

/**
 * The single path from the root down to one chunk node: which side to take at every
 * branch. It mirrors how the tree is built (each level pairs its nodes up, the odd one
 * out pairing with itself), so a client that only has the file can walk any path down.
 */
export function pathToChunk(chunkCount: number, index: number): ('left' | 'right')[] {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) throw new Error('No such chunk');
  const sides: ('left' | 'right')[] = [];
  let count = chunkCount;
  let at = index;
  while (count > 1) {
    sides.push(at % 2 === 0 ? 'left' : 'right');
    at = Math.floor(at / 2);
    count = Math.ceil(count / 2);
  }
  return sides.reverse();
}

/** Which chunk covers one moment of the video (the last chunk covers the tail). */
export function chunkAt(meta: VvshMeta, seconds: number): number {
  const index = Math.floor(Math.max(0, seconds) / meta.chunkSeconds);
  return Math.min(meta.chunkCount - 1, Math.max(0, index));
}

/** Which preview image represents one moment of the video (none when previews are off). */
export function previewAt(meta: VvshMeta, seconds: number): string | undefined {
  const previews = meta.previews;
  if (!previews?.images.length) return undefined;
  const index = Math.floor(Math.max(0, seconds) / Math.max(1, previews.seconds));
  return previews.images[Math.min(previews.images.length - 1, Math.max(0, index))];
}

/**
 * Builds the tree of one video: every chunk node (its bitrate leaves under it) and the
 * branches above them, up to the root. `onObject` receives every record and payload to
 * store under its hash — the file itself only keeps the metadata and the root.
 */
export function buildVvshTree(
  meta: VvshMeta,
  chunks: { renditions: { id: string; data: Uint8Array; frames: VvshFrameStats }[] }[],
  onObject?: (hash: VvshHash, data: Uint8Array, kind: 'branch' | 'chunk' | 'payload') => void
): VvshFile {
  if (chunks.length !== meta.chunkCount) throw new Error('The chunk count does not match the metadata');
  const nodeHashes: VvshHash[] = chunks.map((chunk, index) => {
    const renditions = chunk.renditions.map((rendition) => {
      const hash = vvshPayloadHash(rendition.data);
      onObject?.(hash, rendition.data, 'payload');
      return { id: rendition.id, hash, size: rendition.data.length, frames: rendition.frames };
    });
    const node: VvshNode = { v: 1, kind: 'chunk', index, renditions };
    const hash = vvshRecordHash(node);
    onObject?.(hash, vvshRecordBytes(node), 'chunk');
    return hash;
  });
  // The last layers of the tree split into the bitrate encodings; above them the chunks
  // are merkle-ized in time order (the last chunk node repeats to pad to a power of two).
  let level = nodeHashes;
  while (level.length > 1) {
    const next: VvshHash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      const node: VvshNode = { v: 1, kind: 'branch', left, right };
      const hash = vvshRecordHash(node);
      onObject?.(hash, vvshRecordBytes(node), 'branch');
      next.push(hash);
    }
    level = next;
  }
  return { meta, root: level[0] };
}

/** Parses one record received from anyone (packed, or the old JSON), checking its hash. */
export function parseVvshNode(bytes: Uint8Array, expect?: VvshHash): VvshNode | null {
  let node = unpackVvshNode(bytes);
  if (!node) {
    // The JSON form is accepted too, so old records and pasted ones still open.
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as VvshNode;
      if (parsed && typeof parsed === 'object' && parsed.v === 1 && (parsed.kind === 'branch' || parsed.kind === 'chunk')) node = parsed;
    } catch {
      node = null;
    }
  }
  if (!node) return null;
  if (node.kind === 'branch') {
    if (typeof node.left !== 'string' || typeof node.right !== 'string') return null;
  } else if (!Number.isInteger(node.index) || !Array.isArray(node.renditions)) {
    return null;
  } else {
    for (const rendition of node.renditions) {
      if (typeof rendition.id !== 'string' || typeof rendition.hash !== 'string' || !Number.isSafeInteger(rendition.size)) return null;
    }
  }
  const hash = chunkIdOf(bytes);
  return !expect || expect === hash ? node : null;
}

/**
 * Walks one path of the tree down from the root to the chunk node it covers, checking
 * every step against the hash its parent named. `fetch` hands back the bytes of one
 * record given its hash — starting at any branch hash works the same way.
 */
export async function walkToChunk(
  root: VvshHash,
  chunkCount: number,
  index: number,
  fetch: (hash: VvshHash) => Promise<Uint8Array | null>
): Promise<Extract<VvshNode, { kind: 'chunk' }> | null> {
  const path = pathToChunk(chunkCount, index);
  let hash = root;
  for (const side of path) {
    const bytes = await fetch(hash);
    const node = bytes ? parseVvshNode(bytes, hash) : null;
    if (!node || node.kind !== 'branch') return null;
    hash = node[side];
  }
  const bytes = await fetch(hash);
  const node = bytes ? parseVvshNode(bytes, hash) : null;
  return node && node.kind === 'chunk' && node.index === index ? node : null;
}

// ---------------------------------------------------------------------------
// The .vvsh file itself: packed bytes (magic "VVSH") — metadata and the root, nothing
// else. `vvshFileJson` translates it into the human-readable JSON form.

const FILE_MAGIC = Uint8Array.from([0x56, 0x56, 0x53, 0x48]); // "VVSH"

/** The .vvsh file's packed form: metadata and the root, nothing else. */
export function serializeVvshFile(file: VvshFile): Uint8Array {
  const pack = new Pack();
  pack.raw(FILE_MAGIC);
  pack.u8(1);
  pack.str(file.meta.codec);
  pack.str(file.meta.sourceMime ?? '');
  pack.u32(Math.round(file.meta.chunkSeconds * 1000));
  pack.u32(Math.round(file.meta.totalSeconds * 1000));
  pack.varint(file.meta.chunkCount);
  pack.varint(file.meta.frames.gop);
  pack.str(file.meta.frames.pattern);
  pack.varint(file.meta.avgChunkBytes ?? 0);
  pack.varint(file.meta.bitrates.length);
  for (const rendition of file.meta.bitrates) {
    pack.str(rendition.id);
    pack.str(rendition.label);
    pack.varint(rendition.height ?? 0);
    pack.varint(rendition.kbps);
    pack.varint(rendition.fps ?? 0);
    pack.varint(rendition.bytes ?? 0);
  }
  if (file.meta.previews) {
    pack.u8(1);
    pack.u32(Math.round(file.meta.previews.seconds * 1000));
    pack.varint(file.meta.previews.images.length);
    for (const image of file.meta.previews.images) pack.str(image);
  } else {
    pack.u8(0);
  }
  pack.raw(hashBytes(file.root));
  return pack.take();
}

/**
 * Reads a .vvsh file: the packed bytes, or the human-readable JSON form (what
 * `vvshFileJson` writes) — either way it validates what it read.
 */
export function parseVvshFile(input: Uint8Array | string): VvshFile {
  let file: VvshFile | null = null;
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.length > 4 && FILE_MAGIC.every((byte, index) => bytes[index] === byte)) {
    try {
      const unpack = new Unpack(bytes);
      unpack.raw(4);
      if (unpack.u8() !== 1) throw new Error('Unsupported vvsh file version');
      const codec = unpack.str();
      const sourceMime = unpack.str();
      const chunkSeconds = unpack.u32() / 1000;
      const totalSeconds = unpack.u32() / 1000;
      const chunkCount = unpack.varint();
      const gop = unpack.varint();
      const pattern = unpack.str();
      const avgChunkBytes = unpack.varint();
      const count = unpack.varint();
      if (count < 1 || count > 16) throw new Error('Invalid vvsh file: no bitrate encodings');
      const bitrates: VvshRendition[] = [];
      for (let i = 0; i < count; i++) {
        const id = unpack.str();
        const label = unpack.str();
        const height = unpack.varint();
        const kbps = unpack.varint();
        const fps = unpack.varint();
        const bytes = unpack.varint();
        bitrates.push({
          id,
          label,
          kbps,
          ...(height ? { height } : {}),
          ...(fps ? { fps } : {}),
          ...(bytes ? { bytes } : {}),
        });
      }
      const previews =
        unpack.u8() === 1
          ? {
              seconds: unpack.u32() / 1000,
              images: Array.from({ length: unpack.varint() }, () => unpack.str()),
            }
          : undefined;
      const root = hashFromBytes(unpack.raw(32));
      if (!unpack.finished) throw new Error('Invalid vvsh file: trailing bytes');
      file = {
        meta: {
          v: 1,
          codec,
          sourceMime: sourceMime || undefined,
          chunkSeconds,
          chunkCount,
          totalSeconds,
          bitrates,
          frames: { gop, pattern },
          ...(avgChunkBytes ? { avgChunkBytes } : {}),
          previews,
        },
        root,
      };
    } catch (error) {
      throw new Error(`Invalid vvsh file: ${(error as Error).message}`);
    }
  } else {
    // The human-readable JSON form.
    let value: { meta?: VvshMeta; root?: unknown };
    try {
      value = JSON.parse(typeof input === 'string' ? input : new TextDecoder().decode(input)) as { meta?: VvshMeta; root?: unknown };
    } catch {
      throw new Error('Invalid vvsh file: not a .vvsh file (neither packed bytes nor JSON)');
    }
    const meta = value?.meta;
    if (!meta || typeof meta !== 'object' || meta.v !== 1) throw new Error('Invalid vvsh file: bad metadata');
    if (!Number.isInteger(meta.chunkCount) || meta.chunkCount < 1) throw new Error('Invalid vvsh file: bad chunk count');
    if (!(meta.chunkSeconds > 0) || !(meta.totalSeconds > 0)) throw new Error('Invalid vvsh file: bad length');
    if (!Array.isArray(meta.bitrates) || !meta.bitrates.length) throw new Error('Invalid vvsh file: no bitrate encodings');
    if (typeof value.root !== 'string' || !value.root) throw new Error('Invalid vvsh file: no root');
    file = { meta, root: value.root };
  }
  return file;
}

/** The human-readable JSON translation of one packed .vvsh file (what the pages show). */
export function vvshFileJson(file: VvshFile): Record<string, unknown> {
  return { format: 'vvsh', v: 1, root: file.root, meta: JSON.parse(JSON.stringify(file.meta)) as Record<string, unknown> };
}