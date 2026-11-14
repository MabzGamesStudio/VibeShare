// Node-side VVSH encoding: native FFmpeg first, shared Mediabunny/NodeAV as the explicit
// no-executable fallback. Browsers use MediaRecorder when no local FFmpeg is configured.
import { log } from '../shared/log.js';
import type { TraceStore } from '../shared/tracing-node.js';
import type { VvshBuildConfig } from '../shared/vvsh-encode.js';
import { transcodeVvshChunks } from '../shared/vvsh-transcode.js';
import { ffmpegAvailable, transcodeVvshFfmpeg } from './ffmpeg.js';

let registered = false;
let warned = false;

// The node's trace log, installed once by the provider node. It lives here because
// `convertVvsh` calls this encoder without any node context; the events still join the
// timeline of the request that started the conversion (async context carries it).
let traces: TraceStore | undefined;

/** Wires the node's trace log in (or out); absent keeps every call below a no-op. */
export function setTranscodeTracing(store: TraceStore | undefined): void {
  traces = store;
}

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
  return (await ffmpegAvailable(traces)) ? 'ffmpeg' : 'mediabunny';
}

export async function transcodeVvshWebm(
  source: Uint8Array,
  config: VvshBuildConfig,
  totalSeconds: number,
  onProgress?: (rendition: number, chunk: number, fraction: number) => void
): Promise<Record<string, Uint8Array[]>> {
  const started = Date.now();
  const renditions = config.bitrates.length;
  if (traces?.recorder.shouldLog('basic')) {
    traces.trace('basic', 'provider.transcode', 'transcode start', { data: { bytes: source.length, seconds: totalSeconds, renditions } });
  }
  try {
    let webm: Record<string, Uint8Array[]>;
    let encoder: 'ffmpeg' | 'mediabunny';
    if (await ffmpegAvailable(traces)) {
      encoder = 'ffmpeg';
      webm = await transcodeVvshFfmpeg(source, config, totalSeconds, onProgress, traces);
    } else {
      encoder = 'mediabunny';
      if (!warned) {
        log.warn('FFmpeg with libvpx-vp9/libopus is unavailable; using the slower Mediabunny fallback encoder');
        warned = true;
      }
      await registerMediabunnyServer();
      webm = await transcodeVvshChunks(source, config, totalSeconds, onProgress);
    }
    if (traces?.recorder.shouldLog('basic')) {
      let chunks = 0;
      let bytes = 0;
      for (const list of Object.values(webm)) {
        chunks += list.length;
        for (const data of list) bytes += data.length;
      }
      traces.trace('basic', 'provider.transcode', 'transcode done', { data: { encoder, renditions, chunks, bytes, ms: Date.now() - started } });
    }
    return webm;
  } catch (error) {
    // The failure travels on to the conversion job; the detail learned here is traced
    // before it does, because the job only keeps the message.
    traces?.trace('error', 'provider.transcode', 'transcode failed', {
      error: (error as Error).message,
      data: { bytes: source.length, seconds: totalSeconds, renditions },
    });
    throw error;
  }
}
