// Minimal WebM (Matroska) reader for .vvsh segmented streams.
//
// A progressive WebM file is one EBML header, a Segment holding Info + Tracks (the part
// every decoder needs up front — the "init segment"), and then a run of Cluster
// elements. Each Cluster stands on its own once its timecode is on the file's global
// timeline: that is exactly what MediaSource needs to play one .vvsh chunk while the
// chunks before and after it are still on the provider. Concatenating init + clusters
// back gives a plain WebM file again, so the progressive fallback is free.

/** One parsed EBML element: its id, and where it sits in the bytes. */
export interface WebmElement {
  id: number;
  /** Where the element starts (its tag). */
  start: number;
  /** Payload length in bytes. */
  size: number;
  /** Where the payload starts. */
  at: number;
  /** Total length of the element, tag + size field + payload. */
  total: number;
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_SIMPLE_BLOCK = 0xa3;

/** Reads an element tag (its id keeps the marker bit) and its size field. */
export function readWebmElement(bytes: Uint8Array, offset: number): WebmElement | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let idLength = 1;
  for (let mask = 0x80; mask > 0 && !(first & mask); mask >>= 1) idLength++;
  if (idLength > 4 || offset + idLength >= bytes.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[offset + i];
  const sizeFirst = bytes[offset + idLength];
  let sizeLength = 1;
  for (let mask = 0x80; mask > 0 && !(sizeFirst & mask); mask >>= 1) sizeLength++;
  if (sizeLength > 8 || offset + idLength + sizeLength > bytes.length) return null;
  let size = 0;
  let allOnes = true;
  for (let i = 0; i < sizeLength; i++) {
    const byte = bytes[offset + idLength + i];
    // Eight-byte VINTs have no value bits in their marker byte (0x01). Shifting
    // 0xff by 8 is a no-op in JavaScript, so handle that width explicitly.
    const firstMask = sizeLength === 8 ? 0 : 0xff >> sizeLength;
    const value = i === 0 ? byte & firstMask : byte;
    if (value !== (i === 0 ? firstMask : 0xff)) allOnes = false;
    size = size * 256 + value;
  }
  // All-ones means "until the parent ends" — the caller walks to the end of the bytes.
  if (allOnes) size = bytes.length - (offset + idLength + sizeLength);
  return { id, start: offset, size, at: offset + idLength + sizeLength, total: idLength + sizeLength + size };
}

/** A .vvsh webm stream split into its parts. */
export interface WebmSplit {
  /** Everything before the first Cluster: what a decoder needs to know the tracks. */
  init: Uint8Array;
  /** The Clusters, in order, each still carrying its own element tag. */
  clusters: Uint8Array[];
  /** Nanoseconds per timecode unit (Matroska's default is 1e6, i.e. milliseconds). */
  timecodeScale: number;
}

function children(bytes: Uint8Array, from: number, to: number): WebmElement[] {
  const out: WebmElement[] = [];
  let at = from;
  while (at < to) {
    const element = readWebmElement(bytes, at);
    if (!element || element.total <= 0) break;
    out.push(element);
    at += Math.min(element.total, to - at);
  }
  return out;
}

/** Splits a progressive WebM file into its init part and its Clusters. */
export function splitWebm(bytes: Uint8Array): WebmSplit {
  const top = children(bytes, 0, bytes.length);
  const header = top.find((element) => element.id === ID_EBML);
  const segment = top.find((element) => element.id === ID_SEGMENT);
  if (!header || !segment) throw new Error('Not a WebM file: no EBML header and Segment');
  const parts = children(bytes, segment.at, bytes.length); // to the end: an assembled
  // stream's clusters sit after the init part's Segment, outside its declared size
  const info = parts.find((element) => element.id === ID_INFO);
  const tracks = parts.find((element) => element.id === ID_TRACKS);
  if (!info || !tracks) throw new Error('Not a playable WebM file: no Info and Tracks');
  const clusters = parts
    .filter((element) => element.id === ID_CLUSTER)
    .map((element) => bytes.subarray(element.start, element.at + element.size));
  if (!clusters.length) throw new Error('Not a playable WebM file: no Clusters');
  // The init part: the header and a Segment holding just Info + Tracks. The Segment size
  // is written as 8 bytes so it always fits whatever the tracks need.
  const head = bytes.subarray(0, header.at + header.size);
  const infoBytes = bytes.subarray(info.start, info.at + info.size);
  const tracksBytes = bytes.subarray(tracks.start, tracks.at + tracks.size);
  const inner = infoBytes.length + tracksBytes.length;
  const init = new Uint8Array(head.length + 12 + inner); // Segment tag (4) + size field (8)
  init.set(head, 0);
  let at = head.length;
  init[at++] = 0x18; // Segment id, 0x18538067
  init[at++] = 0x53;
  init[at++] = 0x80;
  init[at++] = 0x67;
  init[at++] = 0x01; // size marker: one byte, then 7 more
  const rest = inner;
  for (let shift = 6; shift >= 0; shift--) {
    init[at++] = Math.floor(rest / 256 ** shift) % 256;
  }
  init.set(infoBytes, at);
  init.set(tracksBytes, at + infoBytes.length);
  const scale = readUint(bytes, info.at, info.at + info.size, ID_TIMECODE_SCALE);
  return { init, clusters, timecodeScale: scale ?? 1_000_000 };
}

/** Raw VVSH payloads back into their WebM Cluster elements, in their stored order. */
export function webmClusters(bytes: Uint8Array): Uint8Array[] {
  const clusters: Uint8Array[] = [];
  const walk = (from: number, to: number, insideSegment: boolean) => {
    let at = from;
    while (at < to) {
      const element = readWebmElement(bytes, at);
      if (!element || element.total <= 0) throw new Error('Invalid WebM media segment');
      if (element.id === ID_CLUSTER) clusters.push(bytes.slice(element.start, element.at + element.size));
      else if (element.id === ID_SEGMENT && !insideSegment) walk(element.at, Math.min(to, element.at + element.size), true);
      at += element.total;
    }
  };
  walk(0, bytes.length, false);
  if (!clusters.length) throw new Error('WebM media segment without Clusters');
  return clusters;
}

/**
 * Turns a split init part into a standalone WebM header. Its Segment becomes open-ended,
 * so following Clusters belong to the file instead of sitting outside a closed Segment.
 */
export function webmStandaloneInit(init: Uint8Array, durationSeconds?: number): Uint8Array {
  const out = Uint8Array.from(init);
  let at = 0;
  while (at < out.length) {
    const element = readWebmElement(out, at);
    if (!element) break;
    if (element.id === ID_SEGMENT) {
      const sizeLength = element.at - element.start - 4;
      if (sizeLength !== 8) throw new Error('Unexpected WebM Segment size field');
      out[element.at - 8] = 0x01; // eight-byte unknown size: marker + seven all-ones bytes
      out.fill(0xff, element.at - 7, element.at);
      break;
    }
    at += element.total;
  }
  if (durationSeconds !== undefined) patchDuration(out, Math.max(0, durationSeconds * 1000));
  return out;
}

function readUint(bytes: Uint8Array, from: number, to: number, id: number): number | null {
  for (const child of children(bytes, from, to)) {
    if (child.id !== id) continue;
    let value = 0;
    for (let i = 0; i < child.size; i++) value = value * 256 + bytes[child.at + i];
    return value;
  }
  return null;
}

/** A Cluster's timecode, in the file's timecode units (milliseconds by default). */
export function readClusterTimecode(cluster: Uint8Array): number {
  const element = readWebmElement(cluster, 0);
  if (!element || element.id !== ID_CLUSTER) throw new Error('Not a WebM Cluster');
  return readUint(cluster, element.at, element.at + element.size, ID_TIMECODE) ?? 0;
}

/** Moves a Cluster onto the global timeline (its blocks are relative to it, so they all move). */
export function patchClusterTimecode(cluster: Uint8Array, timecode: number): number {
  const element = readWebmElement(cluster, 0);
  if (!element || element.id !== ID_CLUSTER) throw new Error('Not a WebM Cluster');
  for (const child of children(cluster, element.at, element.at + element.size)) {
    if (child.id !== ID_TIMECODE) continue;
    let value = timecode;
    for (let i = child.size - 1; i >= 0; i--) {
      cluster[child.at + i] = value % 256;
      value = Math.floor(value / 256);
    }
    return timecode;
  }
  throw new Error('WebM Cluster without a timecode');
}

/** Width of a Cluster's timecode field, needed to recover older wrapped VVSH timestamps. */
export function clusterTimecodeWidth(cluster: Uint8Array): number {
  const element = readWebmElement(cluster, 0);
  if (!element || element.id !== ID_CLUSTER) throw new Error('Not a WebM Cluster');
  const field = children(cluster, element.at, element.at + element.size).find((child) => child.id === ID_TIMECODE);
  if (!field) throw new Error('WebM Cluster without a timecode');
  return field.size;
}

/**
 * Returns a Cluster with its timecode changed, resizing both the timecode and the Cluster
 * header as needed. The in-place patcher below is useful for small test fixtures, but a
 * global VVSH timestamp may need more bytes than the original per-chunk recording used.
 */
export function withClusterTimecode(cluster: Uint8Array, timecode: number): Uint8Array {
  if (!Number.isSafeInteger(timecode) || timecode < 0) throw new Error('Bad WebM Cluster timecode');
  const element = readWebmElement(cluster, 0);
  if (!element || element.id !== ID_CLUSTER) throw new Error('Not a WebM Cluster');
  const field = children(cluster, element.at, element.at + element.size).find((child) => child.id === ID_TIMECODE);
  if (!field) throw new Error('WebM Cluster without a timecode');
  const prefix = cluster.subarray(element.at, field.start);
  const suffix = cluster.subarray(field.at + field.size, element.at + element.size);
  const payloadSize = prefix.length + 10 + suffix.length; // timecode tag + one-byte size + u64
  const out = new Uint8Array(4 + 8 + payloadSize); // Cluster id + eight-byte size + payload
  out.set([0x1f, 0x43, 0xb6, 0x75], 0);
  out[4] = 0x01; // eight-byte size field
  for (let shift = 6; shift >= 0; shift--) out[5 + (6 - shift)] = Math.floor(payloadSize / 256 ** shift) % 256;
  let at = 12;
  out.set(prefix, at);
  at += prefix.length;
  out[at++] = 0xe7;
  out[at++] = 0x88; // Timecode, eight bytes
  for (let shift = 7; shift >= 0; shift--) out[at++] = Math.floor(timecode / 256 ** shift) % 256;
  out.set(suffix, at);
  return out;
}

/** How many keyframes and delta frames a Cluster holds (SimpleBlock flag, bit 7). */
export function countClusterFrames(cluster: Uint8Array): { key: number; delta: number } {
  const element = readWebmElement(cluster, 0);
  if (!element || element.id !== ID_CLUSTER) throw new Error('Not a WebM Cluster');
  let key = 0;
  let delta = 0;
  for (const child of children(cluster, element.at, element.at + element.size)) {
    if (child.id !== ID_SIMPLE_BLOCK) continue;
    // Track number (a vint), a relative timecode (2 bytes), then the flags byte.
    let at = child.at;
    const first = cluster[at];
    let length = 1;
    for (let mask = 0x80; mask > 0 && !(first & mask); mask >>= 1) length++;
    at += length + 2;
    const flags = cluster[at] ?? 0;
    if (flags & 0x80) key++;
    else delta++;
  }
  return { key, delta };
}

/** The codec ids of a WebM file's tracks, as MSE wants them: `vp8,opus` / `vp9,none`. */
export function webmCodecString(init: Uint8Array): string {
  const codecNames: Record<string, string> = {
    V_VP8: 'vp8',
    V_VP9: 'vp9',
    V_AV1: 'av01.0.04M.08',
    'V_MPEG4/ISO/AVC': 'avc1.42E01E',
    A_OPUS: 'opus',
    A_VORBIS: 'vorbis',
    A_AAC: 'mp4a.40.2',
  };
  const top = children(init, 0, init.length);
  const segment = top.find((element) => element.id === ID_SEGMENT);
  if (!segment) throw new Error('Not a WebM init segment');
  const parts = children(init, segment.at, segment.at + segment.size);
  const tracks = parts.find((element) => element.id === ID_TRACKS);
  if (!tracks) throw new Error('WebM init segment without Tracks');
  const codecs: string[] = [];
  for (const entry of children(init, tracks.at, tracks.at + tracks.size)) {
    if (entry.id !== 0xae) continue; // TrackEntry
    for (const field of children(init, entry.at, entry.at + entry.size)) {
      if (field.id !== 0x86) continue; // CodecID
      const id = new TextDecoder().decode(init.subarray(field.at, field.at + field.size)).replace(/\0+$/, '');
      codecs.push(codecNames[id] ?? id.toLowerCase());
    }
  }
  if (!codecs.length) throw new Error('WebM Tracks without a codec');
  return codecs.join(',');
}

/** Rewrites the Duration in a WebM init part, so players show the whole stream's length. */
export function patchDuration(init: Uint8Array, totalMs: number): void {
  const top = children(init, 0, init.length);
  const segment = top.find((element) => element.id === ID_SEGMENT);
  if (!segment) return;
  for (const part of children(init, segment.at, segment.at + segment.size)) {
    if (part.id !== ID_INFO) continue;
    for (const field of children(init, part.at, part.at + part.size)) {
      if (field.id !== ID_DURATION) continue;
      // A float element: 4 or 8 bytes, big-endian IEEE 754.
      const view = new DataView(init.buffer, init.byteOffset + field.at, field.size);
      if (field.size === 4) view.setFloat32(0, totalMs);
      else if (field.size === 8) view.setFloat64(0, totalMs);
      return;
    }
  }
}

/** Whether this browser can play WebM segments through MediaSource, best-effort. */
export function mseWebmMime(codecs: string): string {
  return `video/webm; codecs="${codecs}"`;
}
