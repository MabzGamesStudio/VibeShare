// Manifests, chunks and content ids. Browser-safe (files on disk: contentfile.ts).
import { sha256, signData, verifySignature, type Identity, isKeyId } from './crypto.js';
import { base32Encode, canonicalJson } from './encoding.js';
import { CHUNK_PREFIX, NATIVE_PREFIX, isChunkId, parseSource } from './sources.js';
import { CREATOR_KINDS, FORMATS, RATINGS, type CreatorKind, type Format, type Rating } from './taxonomy.js';
import type { VvshFile } from './vvsh.js';

export const MiB = 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = MiB;
export const MAX_CHUNK_SIZE = 8 * MiB;
const MAX_CHUNKS = 2_000_000;

export interface ChunkRef {
  id: string;
  size: number;
}

/** What the creator says about their content. Algorithm nodes are free to use, change or ignore it. */
export interface ManifestMeta {
  title?: string;
  description?: string;
  format?: Format;
  rating?: Rating;
  topics?: string[];
  tags?: string[];
  language?: string;
  durationSeconds?: number;
  /** The images of a list-of-images content (their content ids or links), in order. */
  gallery?: string[];
  /** Free-form content data kept on the content: short string pairs. */
  data?: Record<string, string>;
  /**
   * Namespaced extension bag: arbitrary members a fork or app adds without a protocol
   * change. Like every other manifest field it is covered by the content id (the
   * canonical-JSON hash), so anything that stores or serves a manifest keeps it
   * byte-faithfully; readers that do not understand it simply ignore it.
   */
  x?: Record<string, unknown>;
}

export interface ManifestCreator {
  /** The creator's public key id (vk1…). */
  id: string;
  name?: string;
  kind?: CreatorKind;
  /** Signature over the manifest without this field. */
  sig: string;
}

/**
 * A manifest describes one piece of content. Its hash is the content id, so the
 * manifest (and every chunk, through its own hash) can be fetched from any
 * untrusted provider and checked.
 */
export interface Manifest {
  v: 1;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  chunks: ChunkRef[];
  createdAt: string;
  meta?: ManifestMeta;
  /** External copies (`yt:…`, `ia:…`) a client can fall back to. */
  sources?: string[];
  /**
   * A verifiable video stream: the .vvsh file is this metadata and root alone — every
   * branch, chunk node and payload of the tree is stored on its own under its hash.
   */
  vvsh?: VvshFile;
  creator?: ManifestCreator;
}

export function chunkIdOf(data: Uint8Array): string {
  return CHUNK_PREFIX + base32Encode(sha256(data));
}

/**
 * The content id of a downloadable copy: the hash of the bytes themselves. Used where a
 * client hands a provider a direct download link for a cid, so the bytes can be checked
 * against the cid exactly, without a manifest.
 */
export function bytesCid(data: Uint8Array): string {
  return NATIVE_PREFIX + base32Encode(sha256(data));
}

/**
 * What the user is told when content retrieved or downloaded from a node or a link does
 * not hash to the expected cid. Nothing is kept, played or saved in that case.
 */
export const CID_MISMATCH = 'The downloaded content from the node/link does not match the expected cid';

/** True when these bytes hash to exactly this content id (a downloadable copy's cid). */
export function bytesMatchCid(data: Uint8Array, cid: string): boolean {
  return cid === bytesCid(data) || cid === chunkIdOf(data);
}

/**
 * True when these bytes are the whole file a manifest describes: the same total size and
 * every chunk slice hashing to the chunk id the manifest lists. A native content id names
 * its manifest, so the file itself never hashes to the id — the chunks are what prove the
 * bytes (this is how a provider checks a URL that hosts the full file).
 */
export function bytesMatchManifest(data: Uint8Array, manifest: Manifest): boolean {
  if (data.length !== manifest.size) return false;
  let at = 0;
  for (const chunk of manifest.chunks) {
    if (chunkIdOf(data.subarray(at, at + chunk.size)) !== chunk.id) return false;
    at += chunk.size;
  }
  // The chunks must account for every byte: a manifest that stops short leaves the rest
  // of the file unproven, so it matches nothing.
  return at === data.length;
}

export function contentIdOf(manifest: Manifest): string {
  return NATIVE_PREFIX + base32Encode(sha256(canonicalJson(manifest)));
}

function unsignedPayload(manifest: Manifest): string {
  const { creator, ...rest } = manifest;
  const unsigned = creator ? { ...rest, creator: { ...creator, sig: undefined } } : rest;
  return 'vibeshare-manifest\n' + canonicalJson(unsigned);
}

export function signManifest(
  manifest: Manifest,
  identity: Identity,
  profile: { name?: string; kind?: CreatorKind } = {}
): Manifest {
  const draft: Manifest = { ...manifest, creator: { id: identity.id, name: profile.name, kind: profile.kind, sig: '' } };
  draft.creator!.sig = signData(identity, unsignedPayload(draft));
  return draft;
}

export function verifyManifestSignature(manifest: Manifest): boolean {
  if (!manifest.creator) return true;
  return verifySignature(manifest.creator.id, unsignedPayload(manifest), manifest.creator.sig);
}

function fail(message: string): never {
  throw new Error(`Invalid manifest: ${message}`);
}

function optionalString(value: unknown, field: string, max: number): void {
  if (value !== undefined && (typeof value !== 'string' || value.length > max)) fail(`${field} must be a string up to ${max} characters`);
}

function optionalStringList(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string' || item.length > 64)) {
    fail(`${field} must be a list of up to 64 short strings`);
  }
}

/** Checks a manifest received from anyone. Throws on the first problem. */
export function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object') fail('not an object');
  const manifest = value as Manifest;
  if (manifest.v !== 1) fail('unsupported version');
  if (typeof manifest.name !== 'string' || !manifest.name || manifest.name.length > 255) fail('bad name');
  if (typeof manifest.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(manifest.mime)) fail('bad mime type');
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) fail('bad size');
  if (!Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize < 1024 || manifest.chunkSize > MAX_CHUNK_SIZE) {
    fail('bad chunk size');
  }
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length > MAX_CHUNKS) fail('bad chunk list');
  let total = 0;
  manifest.chunks.forEach((chunk, index) => {
    if (!chunk || !isChunkId(chunk.id)) fail(`bad chunk id at ${index}`);
    const last = index === manifest.chunks.length - 1;
    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > manifest.chunkSize) fail(`bad chunk size at ${index}`);
    if (!last && chunk.size !== manifest.chunkSize) fail('only the last chunk may be smaller than the chunk size');
    total += chunk.size;
  });
  if (total !== manifest.size) fail('chunk sizes do not add up to the size');
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) fail('bad createdAt');
  if (manifest.meta !== undefined) {
    const meta = manifest.meta;
    if (!meta || typeof meta !== 'object') fail('bad meta');
    optionalString(meta.title, 'meta.title', 300);
    optionalString(meta.description, 'meta.description', 5000);
    optionalString(meta.language, 'meta.language', 16);
    optionalStringList(meta.topics, 'meta.topics');
    optionalStringList(meta.gallery, 'meta.gallery');
    if (meta.format !== undefined && !FORMATS.includes(meta.format)) fail('bad meta.format');
    if (meta.rating !== undefined && !RATINGS.includes(meta.rating)) fail('bad meta.rating');
    if (meta.durationSeconds !== undefined && !(typeof meta.durationSeconds === 'number' && meta.durationSeconds >= 0)) {
      fail('bad meta.durationSeconds');
    }
    // The extension bag is free-form but hashed into the content id: keep it a plain
    // object of a sane size so ids stay cheap to compute. Unknown keys are fine —
    // validation only ever looks at the members it knows.
    if (meta.x !== undefined) {
      if (!meta.x || typeof meta.x !== 'object' || Array.isArray(meta.x)) fail('bad meta.x');
      if (canonicalJson(meta.x).length > 8192) fail('meta.x is too large');
    }
  }
  if (manifest.sources !== undefined) {
    if (!Array.isArray(manifest.sources) || manifest.sources.length > 16) fail('bad sources');
    for (const source of manifest.sources) if (typeof source !== 'string' || !parseSource(source)) fail(`bad source ${source}`);
  }
  if (manifest.vvsh !== undefined) {
    const vvsh = manifest.vvsh;
    const meta = vvsh?.meta;
    if (!vvsh || typeof vvsh !== 'object' || typeof vvsh.root !== 'string' || !isChunkId(vvsh.root)) fail('bad vvsh root');
    if (!meta || meta.v !== 1 || !Number.isInteger(meta.chunkCount) || meta.chunkCount < 1) fail('bad vvsh metadata');
    if (!(meta.chunkSeconds > 0) || !(meta.totalSeconds > 0)) fail('bad vvsh length');
    if (!Array.isArray(meta.bitrates) || !meta.bitrates.length || meta.bitrates.length > 16) fail('bad vvsh bitrates');
    for (const rendition of meta.bitrates) {
      if (!rendition || typeof rendition.id !== 'string' || !rendition.id || typeof rendition.label !== 'string') fail('bad vvsh bitrate');
      if (!(rendition.kbps > 0)) fail('bad vvsh bitrate speed');
      if (rendition.bytes !== undefined && !(Number.isSafeInteger(rendition.bytes) && rendition.bytes >= 0)) fail('bad vvsh bitrate bytes');
    }
  }
  if (manifest.creator !== undefined) {
    const creator = manifest.creator;
    if (!creator || !isKeyId(creator.id) || typeof creator.sig !== 'string') fail('bad creator');
    optionalString(creator.name, 'creator.name', 120);
    if (creator.kind !== undefined && !CREATOR_KINDS.includes(creator.kind)) fail('bad creator.kind');
    if (!verifyManifestSignature(manifest)) fail('creator signature does not match');
  }
  return manifest;
}

/** Splits a stream into chunks of exactly `chunkSize` bytes (the last one may be shorter). */
export async function* chunkStream(source: AsyncIterable<Buffer | Uint8Array>, chunkSize: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingSize = 0;
  for await (const piece of source) {
    let buffer = Buffer.from(piece);
    while (buffer.length > 0) {
      const take = Math.min(chunkSize - pendingSize, buffer.length);
      pending.push(buffer.subarray(0, take));
      pendingSize += take;
      buffer = buffer.subarray(take);
      if (pendingSize === chunkSize) {
        yield Buffer.concat(pending);
        pending = [];
        pendingSize = 0;
      }
    }
  }
  if (pendingSize > 0) yield Buffer.concat(pending);
}

export interface BuildOptions {
  name: string;
  mime: string;
  chunkSize?: number;
  meta?: ManifestMeta;
  sources?: string[];
  createdAt?: string;
}

/**
 * Builds a manifest while streaming the content once. `onChunk` receives every
 * chunk (to store or upload it) in order.
 */
export async function buildManifest(
  source: AsyncIterable<Buffer | Uint8Array>,
  options: BuildOptions,
  onChunk?: (id: string, data: Buffer, index: number) => Promise<void> | void
): Promise<Manifest> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks: ChunkRef[] = [];
  let size = 0;
  for await (const data of chunkStream(source, chunkSize)) {
    const id = chunkIdOf(data);
    if (onChunk) await onChunk(id, data, chunks.length);
    chunks.push({ id, size: data.length });
    size += data.length;
  }
  const manifest: Manifest = {
    v: 1,
    name: options.name,
    mime: options.mime,
    size,
    chunkSize,
    chunks,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  if (options.meta && Object.keys(options.meta).length) manifest.meta = options.meta;
  if (options.sources?.length) manifest.sources = options.sources;
  return manifest;
}

export async function buildManifestFromBuffer(
  data: Buffer,
  options: BuildOptions,
  onChunk?: (id: string, data: Buffer, index: number) => Promise<void> | void
): Promise<Manifest> {
  async function* once() {
    yield data;
  }
  return buildManifest(once(), options, onChunk);
}

/** Which chunks hold bytes [start, end] (inclusive), and where in the first chunk the range begins. */
export function chunksForRange(manifest: Manifest, start: number, end: number): { first: number; last: number; offset: number } {
  const first = Math.floor(start / manifest.chunkSize);
  const last = Math.floor(end / manifest.chunkSize);
  return { first, last, offset: start - first * manifest.chunkSize };
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  json: 'application/json',
};

export function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
