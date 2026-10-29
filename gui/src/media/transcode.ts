// VVSH encoding configuration and persistence helpers. Local FFmpeg runs in the client
// daemon; this module is the warned MediaRecorder fallback for browser-only publishing.
import { transcodeSegmentsMediaRecorder } from './recorder';

export const RESOLUTIONS = [360, 480, 720, 1080, 1440, 2160, 4320];
export const WIDTHS = [426, 640, 854, 1280, 1920, 2560, 3840, 7680];
export const FRAME_RATES = [24, 25, 30, 50, 60];
export const PREVIEW_WIDTHS = [160, 220, 256, 320, 480, 640, 854, 1280];

/** The common 16:9 sizes: picking a preset height or width pairs the other one. */
export const HEIGHT_TO_WIDTH: Record<number, number> = {
  360: 640,
  480: 854,
  720: 1280,
  1080: 1920,
  1440: 2560,
  2160: 3840,
  4320: 7680,
};
export const WIDTH_TO_HEIGHT: Record<number, number> = {
  640: 360,
  854: 480,
  1280: 720,
  1920: 1080,
  2560: 1440,
  3840: 2160,
  7680: 4320,
};

export interface EncodeRow {
  id: string;
  height: number;
  /** Target width; 0 while the field is empty (the form warns that it must be filled). */
  width: number;
  fps: number;
  kbps: number;
  /** How a width×height of another shape than the video treats it. */
  fit: 'crop' | 'squish';
  customFps?: boolean;
  customHeight?: boolean;
  customWidth?: boolean;
}

/** What a fixed width×height does to a video of another shape. */
export interface FitReport {
  /** Total percentage cropped off (crop mode), and off each side or each edge. */
  cropPct: number;
  cropEdgePct: number;
  /** Which edges lose the crop; null when nothing is cropped. */
  cropFrom: 'sides' | 'top and bottom' | null;
  /** Percentage the picture is squeezed out of shape (squish mode). */
  squishPct: number;
  /** The video is smaller than the target: it gets scaled up. */
  tooSmall: boolean;
  /** The target shape is far from the video's: which way round it does not fit. */
  ratioWarning: 'wide' | 'tall' | null;
  /** One line saying how the content will be adjusted, or null when it stays untouched. */
  note: string | null;
}

/** How much of a video a fixed width×height crops away or squishes, and what to warn about. */
export function fitReport(
  source: { width: number; height: number } | null,
  width: number,
  height: number,
  fit: 'crop' | 'squish'
): FitReport {
  const report: FitReport = {
    cropPct: 0,
    cropEdgePct: 0,
    cropFrom: null,
    squishPct: 0,
    tooSmall: false,
    ratioWarning: null,
    note: null,
  };
  if (!source || !source.width || !source.height || !width || !height) return report;
  report.tooSmall = width > source.width || height > source.height;
  const sourceRatio = source.width / source.height;
  const targetRatio = width / height;
  if (fit === 'crop') {
    if (sourceRatio > targetRatio + 1e-6) {
      report.cropFrom = 'sides';
      report.cropPct = (1 - targetRatio / sourceRatio) * 100;
    } else if (sourceRatio < targetRatio - 1e-6) {
      report.cropFrom = 'top and bottom';
      report.cropPct = (1 - sourceRatio / targetRatio) * 100;
    }
    report.cropEdgePct = report.cropPct / 2;
    if (report.cropFrom) {
      report.note = `The content will be adjusted: ${report.cropPct.toFixed(0)}% cropped from the ${report.cropFrom} (${report.cropEdgePct.toFixed(0)}% per ${report.cropFrom === 'sides' ? 'side' : 'edge'}).`;
    }
  } else {
    report.squishPct = Math.abs(1 - targetRatio / sourceRatio) * 100;
    if (report.squishPct > 0.5) {
      report.note = `The content will be adjusted: squished ${report.squishPct.toFixed(0)}% out of shape to fill ${width}×${height} (nothing is cropped).`;
    }
  }
  const change = fit === 'crop' ? report.cropPct : report.squishPct;
  if (change > 20) report.ratioWarning = targetRatio > sourceRatio ? 'wide' : 'tall';
  return report;
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
