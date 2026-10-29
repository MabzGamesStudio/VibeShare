// Explicit no-FFmpeg browser fallback. MediaRecorder runs in realtime; each chunk uses a
// fresh element/recorder so stopping one recording cannot corrupt the next chunk.
import type { EncodeRow } from './transcode';

function event(target: EventTarget, name: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(name, () => resolve(), { once: true }));
}

async function recordChunk(file: Blob, row: EncodeRow, start: number, end: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  let audio: AudioContext | undefined;
  let recorder: MediaRecorder | undefined;
  let animation = 0;
  const streams: MediaStream[] = [];
  try {
    if (video.readyState < 1) await event(video, 'loadedmetadata');
    if (!Number.isFinite(video.duration) || start >= video.duration) throw new Error('The chunk starts beyond the end of the video');
    const height = Math.max(2, Math.round((row.height || video.videoHeight) / 2) * 2);
    const width =
      row.width > 0
        ? Math.max(2, Math.round(row.width / 2) * 2)
        : Math.max(2, Math.round((height * video.videoWidth) / Math.max(1, video.videoHeight) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot capture video frames');

    audio = new AudioContext();
    await audio.resume();
    const source = audio.createMediaElementSource(video);
    const destination = audio.createMediaStreamDestination();
    source.connect(destination); // deliberately not audio.destination: no audible playback
    const canvasStream = canvas.captureStream(row.fps);
    streams.push(canvasStream, destination.stream);
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser has no WebM MediaRecorder encoder');
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: row.kbps * 1000, audioBitsPerSecond: 128_000 });
    const pieces: Blob[] = [];
    recorder.ondataavailable = (event) => event.data.size && pieces.push(event.data);
    const stopped = new Promise<void>((resolve, reject) => {
      recorder!.onstop = () => resolve();
      recorder!.onerror = () => reject(new Error('MediaRecorder failed while encoding this chunk'));
    });

    const draw = () => {
      if (row.width > 0 && row.fit === 'crop') {
        // Scale to cover the frame, then cut the overflow off the sides or top/bottom.
        const scale = Math.max(width / Math.max(1, video.videoWidth), height / Math.max(1, video.videoHeight));
        const sw = width / scale;
        const sh = height / scale;
        context.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, width, height);
      } else {
        context.drawImage(video, 0, 0, width, height);
      }
      animation = requestAnimationFrame(draw);
    };
    if (video.readyState < 1) await event(video, 'loadeddata');
    const seeking = event(video, 'seeked');
    video.currentTime = start;
    await seeking;
    recorder.start(100);
    draw();
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timer = window.setInterval(() => {
        if (video.currentTime + 0.02 < end && !video.ended) return;
        window.clearInterval(timer);
        video.pause();
        if (recorder?.state === 'recording') recorder.stop();
        resolve();
      }, 20);
      video.onerror = () => {
        window.clearInterval(timer);
        reject(new Error('The browser could not decode this video'));
      };
    });
    await stopped;
    cancelAnimationFrame(animation);
    const bytes = new Uint8Array(await new Blob(pieces, { type: mimeType }).arrayBuffer());
    if (!bytes.length) throw new Error('MediaRecorder produced an empty chunk');
    return bytes;
  } finally {
    cancelAnimationFrame(animation);
    video.pause();
    if (recorder?.state === 'recording') recorder.stop();
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    await audio?.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Realtime segmented encoding, used only after the GUI has shown its fallback warning. */
export async function transcodeSegmentsMediaRecorder(
  file: Blob,
  row: EncodeRow,
  chunkSeconds: number,
  onProgress: ((fraction: number) => void) | undefined,
  totalSeconds: number
): Promise<Uint8Array[]> {
  if (typeof MediaRecorder === 'undefined') throw new Error('FFmpeg is unavailable and this browser does not support MediaRecorder');
  const count = Math.max(1, Math.ceil(totalSeconds / chunkSeconds));
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * chunkSeconds;
    chunks.push(await recordChunk(file, row, start, Math.min(totalSeconds, start + chunkSeconds)));
    onProgress?.((index + 1) / count);
  }
  return chunks;
}
