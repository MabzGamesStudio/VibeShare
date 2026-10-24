// Real per-quality encoding, in the browser: the video is played through a canvas at the
// target resolution and frame rate and recorded with its audio — so a 480p/30fps row is
// genuinely softer and smaller than 1080p/60fps. (Without this step every "encoding"
// would just be a copy of the source and look identical.)
export const RESOLUTIONS = [360, 480, 720, 1080, 1440, 2160, 4320];
export const FRAME_RATES = [24, 25, 30, 50, 60];

export interface EncodeRow {
  id: string;
  height: number;
  fps: number;
  kbps: number;
  /** The fps came from the "Other…" box, not one of the presets. */
  customFps?: boolean;
}

export function rowId(height: number, fps: number): string {
  return `${height}p${fps}`;
}

/** The usual bitrate for one resolution and frame rate, in kbit/s. */
export function defaultKbps(height: number, fps: number): number {
  const atThirty: Record<number, number> = { 360: 800, 480: 1200, 720: 2500, 1080: 5000, 1440: 12_000, 2160: 20_000, 4320: 45_000 };
  return Math.round((atThirty[height] ?? Math.round(height * 8)) * (fps / 30));
}

/** Rough output size of one encoding: its video bitrate plus audio, over the duration. */
export function estimateBytes(row: EncodeRow, seconds: number, audioKbps = 128): number {
  return Math.round(((row.kbps + audioKbps) * 1000 * Math.max(0, seconds)) / 8);
}

export function pickMimeType(): string {
  for (const type of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

/** Encodes the picked video down to one resolution and frame rate. */
export async function transcode(file: Blob, row: EncodeRow, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.src = url;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('This file did not open as a video'));
      video.load();
    });
    const aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
    const height = Math.max(2, Math.round(row.height / 2) * 2);
    const width = Math.max(2, Math.round((height * aspect) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw video frames');
    const stream = canvas.captureStream(row.fps);
    // The sound is recorded but not heard: the element's audio goes through a graph that
    // is deliberately not connected to the speakers.
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaElementSource(video);
      const silent = audioContext.createMediaStreamDestination();
      sourceNode.connect(silent);
      for (const track of silent.stream.getAudioTracks()) stream.addTrack(track);
    } catch {
      // No audio graph — the picture still encodes, quietly.
    }
    const recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: Math.max(50, row.kbps) * 1000 });
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    const draw = () => {
      context.drawImage(video, 0, 0, width, height);
      if (!video.ended) requestAnimationFrame(draw);
    };
    video.onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
    video.ontimeupdate = () => onProgress?.(Math.min(0.99, video.currentTime / (video.duration || 1)));
    recorder.start(500);
    draw();
    await video.play();
    await stopped;
    onProgress?.(1);
    void audioContext?.close();
    return new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The pieces of one encoded row: one complete WebM recording per chunk. */
export function packSegments(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(4 + chunks.length * 4 + chunks.reduce((size, chunk) => size + chunk.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, chunks.length);
  let at = 4 + chunks.length * 4;
  chunks.forEach((chunk, index) => {
    view.setUint32(4 + index * 4, chunk.length);
    out.set(chunk, at);
    at += chunk.length;
  });
  return out;
}

/** Reads one encoded row back into its per-chunk recordings. */
export function unpackSegments(packed: Uint8Array): Uint8Array[] {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const count = view.getUint32(0);
  const chunks: Uint8Array[] = [];
  let at = 4 + count * 4;
  for (let index = 0; index < count; index++) {
    const length = view.getUint32(4 + index * 4);
    chunks.push(packed.subarray(at, at + length));
    at += length;
  }
  return chunks;
}

/**
 * Encodes the picked video in segments: one complete WebM recording per chunk, all cut at
 * the same instants. Recording start and stop at those instants is what puts a keyframe on
 * every chunk boundary, so any chunk plays on its own — the basis of sparse playback.
 */
export async function transcodeSegments(
  file: Blob,
  row: EncodeRow,
  chunkSeconds: number,
  onProgress?: (fraction: number) => void
): Promise<Uint8Array[]> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.src = url;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('This file did not open as a video'));
      video.load();
    });
    const aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
    const height = Math.max(2, Math.round(row.height / 2) * 2);
    const width = Math.max(2, Math.round((height * aspect) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw video frames');
    const stream = canvas.captureStream(row.fps);
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaElementSource(video);
      const silent = audioContext.createMediaStreamDestination();
      sourceNode.connect(silent);
      for (const track of silent.stream.getAudioTracks()) stream.addTrack(track);
    } catch {
      // No audio graph — the picture still encodes, quietly.
    }
    const chunks: Uint8Array[] = [];
    let parts: Blob[] = [];
    let recorder: MediaRecorder | null = null;
    let stopping = false;
    const startRecorder = () => {
      parts = [];
      recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: Math.max(50, row.kbps) * 1000 });
      recorder.ondataavailable = (event) => {
        if (event.data.size) parts.push(event.data);
      };
      recorder.start(500);
    };
    const stopRecorder = async () => {
      if (!recorder || recorder.state === 'inactive' || stopping) return;
      stopping = true;
      const current = recorder;
      const done = new Promise<void>((resolve) => {
        current.onstop = () => resolve();
      });
      current.stop();
      await done;
      stopping = false;
      if (parts.length) chunks.push(new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()));
    };
    const draw = () => {
      context.drawImage(video, 0, 0, width, height);
      if (!video.ended) requestAnimationFrame(draw);
    };
    let boundary = Math.max(0.5, chunkSeconds);
    video.ontimeupdate = () => {
      onProgress?.(Math.min(0.99, video.currentTime / (video.duration || 1)));
      // One recording per chunk: stop at the boundary (that file is one chunk), then go on.
      if (video.currentTime >= boundary) {
        boundary += chunkSeconds;
        void stopRecorder().then(() => {
          if (!video.ended) startRecorder();
        });
      }
    };
    await new Promise<void>((resolve) => {
      video.onended = () => {
        void stopRecorder().then(() => resolve());
      };
      startRecorder();
      draw();
      void video.play().catch(() => resolve());
    });
    onProgress?.(1);
    void audioContext?.close();
    return chunks;
  } finally {
    URL.revokeObjectURL(url);
  }
}