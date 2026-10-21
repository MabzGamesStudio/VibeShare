// Provider-side .vvsh work: pricing a conversion and running it. A client can upload just
// the video and let this node calculate the .vvsh stream (its encodings, chunk tree and
// previews) — the quote depends on the metadata (how many chunks and previews), the
// video's length and the encodings chosen.
import { DEFAULT_CHUNK_SIZE, type Manifest } from '../shared/content.js';
import { DEFAULT_VVSH_BUILD, buildVvsh, vvshPlan, type VvshBuildConfig } from '../shared/vvsh-encode.js';
import type { VvshConvertQuote, VvshFile, VvshHash, VvshRendition } from '../shared/vvsh.js';

/** What a .vvsh conversion costs on this node. */
export interface VvshConvertPricing {
  /** Credits per MiB of the uploaded video. */
  perMiB: number;
  /** Credits per chunk built (counted per bitrate encoding). */
  perChunk: number;
  /** Credits per bitrate encoding level. */
  perRendition: number;
  /** Credits per image preview. */
  perPreview: number;
}

/** What one conversion costs: the metadata (chunks, previews), the length and the encodings. */
export function quoteVvsh(
  pricing: VvshConvertPricing,
  input: { bytes: number; totalSeconds: number; config: VvshBuildConfig }
): VvshConvertQuote {
  const { chunkCount, previewCount } = vvshPlan(input.totalSeconds, input.config);
  const renditions = input.config.bitrates.length;
  const breakdown = {
    MiB: Math.ceil(input.bytes / (1024 * 1024)),
    chunks: chunkCount * renditions,
    renditions,
    previews: previewCount,
  };
  const credits =
    breakdown.MiB * pricing.perMiB + breakdown.chunks * pricing.perChunk + breakdown.renditions * pricing.perRendition + breakdown.previews * pricing.perPreview;
  return { credits: Math.max(0, Math.ceil(credits)), breakdown };
}

/**
 * Calculates one video's .vvsh stream here: the encodings, the chunk tree and the
 * previews. `onObject` receives every record and payload to store under its hash; the
 * returned manifest holds the metadata and root alone, ready for the client to sign.
 */
export async function convertVvsh(
  source: Uint8Array,
  options: {
    name: string;
    totalSeconds: number;
    config: VvshBuildConfig;
    meta?: Manifest['meta'];
    sourceMime?: string;
    previews?: string[];
    createdAt?: string;
  },
  onObject: (hash: VvshHash, data: Uint8Array) => void | Promise<void>
): Promise<{ manifest: Manifest; vvsh: VvshFile }> {
  const { file } = await buildVvsh(
    source,
    { totalSeconds: options.totalSeconds, config: options.config, sourceMime: options.sourceMime, previews: options.previews },
    (hash, data) => onObject(hash, data)
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
  return { manifest, vvsh: file };
}

/** The built-in default encodings a client gets when it sends no configuration. */
export function defaultVvshConfig(): { chunkSeconds: number; previewSplits: number; bitrates: VvshRendition[] } {
  return {
    chunkSeconds: DEFAULT_VVSH_BUILD.chunkSeconds,
    previewSplits: DEFAULT_VVSH_BUILD.previewSplits ?? 6,
    bitrates: [...DEFAULT_VVSH_BUILD.bitrates],
  };
}