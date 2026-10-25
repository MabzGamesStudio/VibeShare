// Provider registration for the shared VVSH media encoder. NodeAV supplies server codecs
// to Mediabunny directly through FFmpeg's C API; no ffmpeg executable or PATH lookup is
// involved. The browser calls the very same transcodeVvshChunks implementation.
import { registerMediabunnyServer } from '@mediabunny/server';
import type { VvshBuildConfig } from '../shared/vvsh-encode.js';
import { transcodeVvshChunks } from '../shared/vvsh-transcode.js';

let registered = false;

export async function transcodeVvshWebm(
  source: Uint8Array,
  config: VvshBuildConfig,
  totalSeconds: number
): Promise<Record<string, Uint8Array[]>> {
  if (!registered) {
    registerMediabunnyServer();
    registered = true;
  }
  return transcodeVvshChunks(source, config, totalSeconds);
}
