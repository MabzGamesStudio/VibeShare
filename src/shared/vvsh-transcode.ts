// Shared non-realtime VVSH fallback encoder. Native FFmpeg is preferred where configured;
// provider nodes use this Mediabunny/NodeAV path when FFmpeg or its codecs are unavailable.
// Every chunk is converted directly from the source with an explicit time range, so chunk
// transitions do not depend on realtime playback or stopping/restarting a MediaRecorder.
import { ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, Output, WebMOutputFormat } from 'mediabunny';
import { vvshPlan, type VvshBuildConfig } from './vvsh-encode.js';

function mediaNumber(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const number = value ?? fallback;
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return number;
}

/**
 * Encodes every configured rendition into complete, standalone WebM files, one per chunk.
 * The returned shape is exactly what `buildVvsh({ webm })` consumes.
 */
export async function transcodeVvshChunks(
  source: Uint8Array,
  config: VvshBuildConfig,
  totalSeconds: number,
  onProgress?: (rendition: number, chunk: number, fraction: number) => void
): Promise<Record<string, Uint8Array[]>> {
  const { chunkCount } = vvshPlan(totalSeconds, config);
  if (!source.length) throw new Error('The uploaded video is empty');
  const output: Record<string, Uint8Array[]> = {};
  // Sequential conversions bound memory use. Each one reads the original source, never a
  // previously encoded quality, and emits only its own exact time interval.
  for (const [renditionIndex, rendition] of config.bitrates.entries()) {
    const height = mediaNumber(rendition.height, 0, 'Rendition height', 0, 4320);
    const fps = mediaNumber(rendition.fps, 30, 'Rendition fps', 1, 240);
    const kbps = mediaNumber(rendition.kbps, 0, 'Rendition bitrate', 1, 200_000);
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < chunkCount; index++) {
      const start = index * config.chunkSeconds;
      const end = Math.min(totalSeconds, start + config.chunkSeconds);
      const input = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
      const target = new BufferTarget();
      try {
        const conversion = await Conversion.init({
          input,
          output: new Output({ format: new WebMOutputFormat(), target }),
          trim: { start, end },
          video: async (track) => {
            const dimensions: { width?: number; height?: number } = {};
            if (height) {
              dimensions.height = Math.max(2, Math.round(height / 2) * 2);
              const aspect = (await track.getDisplayWidth()) / Math.max(1, await track.getDisplayHeight());
              dimensions.width = Math.max(2, Math.round((dimensions.height * aspect) / 2) * 2);
            }
            return {
              ...dimensions,
              fit: 'fill',
              allowRotationMetadata: false,
              frameRate: fps,
              codec: 'vp9',
              bitrate: Math.round(kbps) * 1000,
              keyFrameInterval: config.chunkSeconds,
              forceTranscode: true,
            };
          },
          audio: { codec: 'opus', bitrate: 128_000, forceTranscode: true },
          tags: {},
          showWarnings: false,
        });
        if (!conversion.isValid) throw new Error('No usable video track was found');
        conversion.onProgress = (fraction) => onProgress?.(renditionIndex, index, Math.max(0, Math.min(1, fraction)));
        await conversion.execute();
        if (!target.buffer || target.buffer.byteLength === 0) throw new Error('The encoder produced an empty chunk');
        chunks.push(new Uint8Array(target.buffer));
        onProgress?.(renditionIndex, index, 1);
      } catch (error) {
        throw new Error(
          `Could not encode ${rendition.label || rendition.id}, chunk ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        input.dispose();
      }
    }
    output[rendition.id] = chunks;
  }
  return output;
}
