// VVSH encoding configuration and persistence helpers. Local FFmpeg runs in the client
// daemon; this module is the warned MediaRecorder fallback for browser-only publishing.
import { transcodeSegmentsMediaRecorder } from './recorder';

export const RESOLUTIONS = [360, 480, 720, 1080, 1440, 2160, 4320];
export const FRAME_RATES = [24, 25, 30, 50, 60];
export const PREVIEW_WIDTHS = [160, 220, 256, 320, 480, 640, 854, 1280];

export interface EncodeRow {
  id: string;
  height: number;
  fps: number;
  kbps: number;
  customFps?: boolean;
  customHeight?: boolean;
}

export function rowId(height: number, fps: number): string {
  return `${height}p${fps}`;
}

export function defaultKbps(height: number, fps: number): number {
  const atThirty: Record<number, number> = { 360: 800, 480: 1200, 720: 2500, 1080: 5000, 1440: 12_000, 2160: 20_000, 4320: 45_000 };
  return Math.round((atThirty[height] ?? Math.round(height * 8)) * (fps / 30));
}

export function estimateBytes(row: EncodeRow, seconds: number, audioKbps = 128): number {
  return Math.round(((row.kbps + audioKbps) * 1000 * Math.max(0, seconds)) / 8);
}

export function packSegments(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(4 + chunks.length * 4 + chunks.reduce((size, chunk) => size + chunk.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, chunks.length);
  let at = 4;
  chunks.forEach((chunk, index) => {
    view.setUint32(at + index * 4, chunk.length);
  });
  at += chunks.length * 4;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function unpackSegments(packed: Uint8Array): Uint8Array[] {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const count = view.getUint32(0);
  const sizes = Array.from({ length: count }, (_, index) => view.getUint32(4 + index * 4));
  let at = 4 + count * 4;
  return sizes.map((size) => {
    const chunk = packed.slice(at, at + size);
    at += size;
    return chunk;
  });
}

/** The browser's explicitly selected fallback when local FFmpeg is not configured. */
export function transcodeSegments(
  file: Blob,
  row: EncodeRow,
  chunkSeconds: number,
  onProgress: ((fraction: number) => void) | undefined,
  totalSeconds: number
): Promise<Uint8Array[]> {
  return transcodeSegmentsMediaRecorder(file, row, chunkSeconds, onProgress, totalSeconds);
}
