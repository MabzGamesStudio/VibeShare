// Native FFmpeg VVSH encoding. The executable and its VP9/Opus encoders are checked
// before this backend is selected; VIBESHARE_FFMPEG may name a non-PATH executable.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vvshPlan, type VvshBuildConfig } from '../shared/vvsh-encode.js';

const executable = () => process.env.VIBESHARE_FFMPEG?.trim() || 'ffmpeg';

async function processOutput(args: string[], input?: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => stdout.push(data));
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < 32_000) stderr += data.toString('utf8').slice(0, 32_000 - stderr.length);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`FFmpeg exited with ${code}: ${stderr.trim().slice(-4000) || 'no error output'}`));
    });
    child.stdin.on('error', (error) => {
      if (code(error) !== 'EPIPE') reject(error);
    });
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
}

function code(error: unknown): string {
  return (error as { code?: string })?.code ?? '';
}

let availability: Promise<boolean> | undefined;

/** True only when FFmpeg and both codecs required by the VVSH WebM encoding are usable. */
export function ffmpegAvailable(): Promise<boolean> {
  availability ??= processOutput(['-hide_banner', '-encoders'])
    .then((output) => {
      const encoders = output.toString('utf8');
      return /\blibvpx-vp9\b/.test(encoders) && /\blibopus\b/.test(encoders);
    })
    .catch(() => false);
  return availability;
}

/** Convert directly to standalone WebM segments at the exact VVSH chunk boundaries. */
export async function transcodeVvshFfmpeg(
  source: Uint8Array,
  config: VvshBuildConfig,
  totalSeconds: number,
  onProgress?: (rendition: number, chunk: number, fraction: number) => void
): Promise<Record<string, Uint8Array[]>> {
  if (!source.length) throw new Error('The uploaded video is empty');
  if (!(await ffmpegAvailable())) throw new Error('FFmpeg with libvpx-vp9 and libopus is not available');
  const { chunkCount } = vvshPlan(totalSeconds, config);
  const output: Record<string, Uint8Array[]> = {};
  for (const [renditionIndex, rendition] of config.bitrates.entries()) {
    const dir = await mkdtemp(join(tmpdir(), 'vibeshare-ffmpeg-'));
    try {
      const height = Math.max(0, Math.min(4320, Math.round(Number(rendition.height ?? 0))));
      const width = Math.max(0, Math.min(7680, Math.round(Number(rendition.width ?? 0))));
      const fps = Math.max(1, Math.min(240, Number(rendition.fps ?? 30)));
      const kbps = Math.max(1, Math.round(Number(rendition.kbps)));
      const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
      // A forced width×height either crops to fill (scale to cover, then cut the overflow
      // off the sides or the top/bottom) or squishes the picture into the frame; without a
      // width the video keeps its own shape.
      const scale =
        width && height
          ? rendition.fit === 'squish'
            ? `scale=${even(width)}:${even(height)}`
            : `scale=${even(width)}:${even(height)}:force_original_aspect_ratio=increase,crop=${even(width)}:${even(height)}`
          : height
            ? `scale=-2:${even(height)}`
            : '';
      const filters = [scale, `fps=${fps}`].filter(Boolean).join(',');
      const keyframes = Math.max(1, Math.round(config.chunkSeconds * fps));
      const args = [
        '-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?', '-t', String(totalSeconds),
        '-vf', filters, '-c:v', 'libvpx-vp9', '-b:v', `${kbps}k`,
        '-g', String(keyframes), '-keyint_min', String(keyframes), '-sc_threshold', '0',
        '-force_key_frames', `expr:gte(t,n_forced*${config.chunkSeconds})`,
        '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
        '-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1:first_pts=0',
        '-f', 'segment', '-segment_time', String(config.chunkSeconds),
        '-segment_format', 'webm', '-segment_start_number', '0', '-reset_timestamps', '1',
        join(dir, 'chunk-%06d.webm'),
      ];
      await processOutput(args, source);
      const names = (await readdir(dir)).filter((name) => /^chunk-\d+\.webm$/.test(name)).sort();
      if (names.length !== chunkCount) {
        throw new Error(`FFmpeg produced ${names.length} chunks for ${rendition.label || rendition.id}; expected ${chunkCount}`);
      }
      const chunks: Uint8Array[] = [];
      for (const [index, name] of names.entries()) {
        const data = await readFile(join(dir, name));
        if (!data.length) throw new Error(`FFmpeg produced an empty chunk for ${rendition.label || rendition.id}`);
        chunks.push(new Uint8Array(data));
        onProgress?.(renditionIndex, index, 1);
      }
      output[rendition.id] = chunks;
    } catch (error) {
      throw new Error(`Could not encode ${rendition.label || rendition.id} with FFmpeg: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return output;
}
