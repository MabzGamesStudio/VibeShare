// The image list container: one file holding many images, so a photo list publishes as
// ONE piece of content with ONE cid instead of a pile of separate images plus a carrier
// picture. Browser-safe and dependency-free:
//
//   VSLIST1\n        the magic, so a sniff tells the files apart
//   <4 bytes>        big-endian length of the JSON index
//   <JSON index>     [{ name, mime, offset, size }] — offsets into the data block
//   <data block>     the image bytes, in index order
//
// Malformed input never throws uncontrolled: parsing gives back null.

export const IMAGE_LIST_MAGIC = 'VSLIST1\n';
export const IMAGE_LIST_MIME = 'application/x-vibeshare-image-list';
/** The suffix a packed image list is published under. */
export const IMAGE_LIST_EXT = '.vslist';

const MAGIC = new TextEncoder().encode(IMAGE_LIST_MAGIC);
const MAX_HEADER = 1_000_000;
const MAX_IMAGES = 4096;

export interface ImageListImage {
  name: string;
  mime: string;
  data: Uint8Array;
}

interface ImageListEntry {
  name: string;
  mime: string;
  /** Offset of the image's bytes inside the data block (after the JSON index). */
  offset: number;
  size: number;
}

/** Packs images into one image-list container. */
export function packImageList(images: ImageListImage[]): Uint8Array {
  const index: ImageListEntry[] = [];
  let offset = 0;
  for (const image of images) {
    index.push({ name: String(image.name).slice(0, 300), mime: String(image.mime).slice(0, 100), offset, size: image.data.length });
    offset += image.data.length;
  }
  const header = new TextEncoder().encode(JSON.stringify(index));
  const out = new Uint8Array(MAGIC.length + 4 + header.length + offset);
  out.set(MAGIC, 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(MAGIC.length, header.length);
  out.set(header, MAGIC.length + 4);
  let at = MAGIC.length + 4 + header.length;
  for (const image of images) {
    out.set(image.data, at);
    at += image.data.length;
  }
  return out;
}

/** Whether these bytes start with the image-list magic. */
export function isImageList(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Reads an image-list container back into its images, in index order. Returns null for
 * anything that is not a well-formed container (never throws).
 */
export function parseImageList(bytes: Uint8Array): ImageListImage[] | null {
  try {
    if (!isImageList(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(MAGIC.length);
    const start = MAGIC.length + 4;
    if (!headerLength || headerLength > MAX_HEADER || start + headerLength > bytes.length) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + headerLength)));
    if (!Array.isArray(parsed) || parsed.length > MAX_IMAGES) return null;
    const out: ImageListImage[] = [];
    const data = start + headerLength;
    for (const raw of parsed) {
      const entry = (raw ?? {}) as Partial<ImageListEntry>;
      const name = String(entry.name ?? '');
      const mime = String(entry.mime ?? '');
      const offset = Number(entry.offset);
      const size = Number(entry.size);
      if (!name || !mime) return null;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size < 0) return null;
      if (data + offset + size > bytes.length) return null;
      out.push({ name, mime, data: bytes.slice(data + offset, data + offset + size) });
    }
    return out;
  } catch {
    return null;
  }
}
