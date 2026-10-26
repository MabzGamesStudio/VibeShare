// Node-side VVSH encoding: native FFmpeg first, shared Mediabunny/NodeAV as the explicit
// no-executable fallback. Browsers use MediaRecorder when no local FFmpeg is configured.
import { log } from '../shared/log.js';
import type { VvshBuildConfig } from '../shared/vvsh-encode.js';
import { transcodeVvshChunks } from '../shared/vvsh-transcode.js';
import { ffmpegAvailable, transcodeVvshFfmpeg } from './ffmpeg.js';

let registered = false;
let warned = false;

/** NodeAV is optional: 32-bit distributions omit its native codecs and require FFmpeg. */
async function registerMediabunnyServer(): Promise<void> {
  if (registered) return;
  try {
    const server = await import('@mediabunny/server');
    server.registerMediabunnyServer();
    registered = true;
  } catch (error) {
    throw new Error(
      `FFmpeg is unavailable and Mediabunny's NodeAV codecs could not be loaded. Install FFmpeg with libvpx-vp9 and libopus on 32-bit Linux. (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

export { ffmpegAvailable } from './ffmpeg.js';

/** Which implementation this Node-side converter will actually use. */
export async function vvshEncoderBackend(): Promise<'ffmpeg' | 'mediabunny'> {
  return (await ffmpegAvailable()) ? 'ffmpeg' : 'mediabunny';
}

export async function transcodeVvshWebm(
  source: Uint8Array,
  config: VvshBuildConfig,
  totalSeconds: number,
  onProgress?: (rendition: number, chunk: number, fraction: number) => void
): Promise<Record<string, Uint8Array[]>> {
  if (await ffmpegAvailable()) return transcodeVvshFfmpeg(source, config, totalSeconds, onProgress);
  if (!warned) {
    log.warn('FFmpeg with libvpx-vp9/libopus is unavailable; using the slower Mediabunny fallback encoder');
    warned = true;
  }
  await registerMediabunnyServer();
  return transcodeVvshChunks(source, config, totalSeconds, onProgress);
}
