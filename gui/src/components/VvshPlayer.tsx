// Playing a .vvsh verifiable video stream on its content page. Scrubbing the slider
// shows the preview image of that section straight from the metadata (no chunk needed);
// letting go fetches just the chunks up to that point (each one verified against the
// merkle tree, each one charged by the provider) and plays the video from there. The
// decoded stream is the exact uploaded video, so the controls behave like a normal
// player while the bytes still arrive chunk by chunk.
import { useCallback, useEffect, useRef, useState } from 'react';
import { chunkAt, previewAt, type VvshFile } from '../../../src/shared/vvsh.js';
import { decodeVvshChunk, decodeVvshFrames } from '../../../src/shared/vvsh-encode.js';
import { fromBase64url } from '../../../src/shared/encoding.js';
import { api, errorMessage } from '../api';

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|avi|wav|mp3|m4a|ogg)$/i;
const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/ogg': '.ogv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
};

/** The name the downloaded file gets: `video.vvsh` → `video.mp4`, never `video.mp4.mp4`. */
export function downloadName(name: string, mime?: string): string {
  const base = name.replace(/\.vvsh$/i, '');
  return VIDEO_EXT.test(base) ? base : `${base}${EXT_BY_MIME[mime ?? ''] ?? '.mp4'}`;
}

/** The decoded stream bytes of one chunk: its I/P/B frames, in order. */
async function fetchChunk(nodeId: string, file: VvshFile, index: number, rendition: string): Promise<Uint8Array> {
  const answer = await api<{ data: string }>('/api/vvsh/chunk', { body: { nodeId, file, index, rendition } });
  const blocks = decodeVvshFrames(decodeVvshChunk(fromBase64url(answer.data)));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

export function VvshPlayer({ nodeId, file, name }: { nodeId: string; file: VvshFile; name: string }) {
  const meta = file.meta;
  const video = useRef<HTMLVideoElement | null>(null);
  const parts = useRef<Uint8Array[]>([]);
  const have = useRef(0);
  const wantTime = useRef(0);
  const wantPlay = useRef(false);
  const [rendition, setRendition] = useState(meta.bitrates[0].id);
  const renditionRef = useRef(rendition);
  const [seconds, setSeconds] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [fetched, setFetched] = useState(0);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const shell = useRef<HTMLDivElement | null>(null);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);

  /** Fetches the verified chunks up to one index — the provider charges each one. */
  const pull = useCallback(
    (upTo: number) => {
      // One at a time: overlapping fetches would push a chunk twice and break the stream.
      const run = queue.current.then(async () => {
        while (have.current <= Math.min(upTo, meta.chunkCount - 1)) {
          const block = await fetchChunk(nodeId, file, have.current, renditionRef.current);
          parts.current.push(block);
          have.current += 1;
          setFetched(have.current);
        }
      });
      queue.current = run.catch(() => undefined);
      return run;
    },
    [file, meta.chunkCount, nodeId]
  );

  /** Hands the stream built so far to the video element (the exact uploaded video). */
  const swap = useCallback(
    (at: number, play: boolean) => {
      wantTime.current = at;
      wantPlay.current = play;
      const url = URL.createObjectURL(new Blob(parts.current.map((part) => Uint8Array.from(part)), { type: meta.sourceMime ?? 'video/mp4' }));
      setVideoUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    },
    [meta.sourceMime]
  );

  /** From one moment of the video: fetch what is missing up to it, then play there. */
  const playFrom = useCallback(
    async (at: number, play = true) => {
      const target = chunkAt(meta, at);
      try {
        setError(null);
        if (have.current > target) {
          const v = video.current;
          if (v) {
            v.currentTime = at;
            if (play) void v.play();
          }
          return;
        }
        setBusy(true);
        await pull(target);
        swap(at, play);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [meta, pull, swap]
  );

  useEffect(() => {
    void playFrom(0, false);
    // (Once, on open: the first chunk comes in so the video is on screen.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Switching encoding re-fetches the stream at that bitrate from the start. */
  const changeRendition = (id: string) => {
    renditionRef.current = id;
    setRendition(id);
    parts.current = [];
    have.current = 0;
    setFetched(0);
    void playFrom(seconds, false);
  };

  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  return (
    <div className="form-stack">
      <div ref={shell}>
        <video
          ref={video}
          src={videoUrl}
          playsInline
          style={{ width: '100%', borderRadius: 8, background: '#111', display: 'block' }}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            if (v.paused) void v.play();
            else v.pause();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={() => {
            const v = video.current;
            if (!v) return;
            v.currentTime = Math.min(wantTime.current, v.duration || wantTime.current);
            if (wantPlay.current) void v.play();
          }}
          onEnded={() => {
            // The stream runs out exactly when the fetched chunks do — carry on.
            if (have.current < meta.chunkCount) void playFrom(seconds + 0.2, true);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setSeconds(v.currentTime);
            // Only what playback needs: one chunk of lookahead, each one charged. The
            // stream handed to the video grows as those chunks arrive.
            if (!v.paused && have.current < meta.chunkCount && v.currentTime > have.current * meta.chunkSeconds - 5) {
              void pull(have.current)
                .then(() => {
                  const now = video.current;
                  if (now) swap(now.currentTime, !now.paused);
                })
                .catch(() => undefined);
            }
          }}
        />
        {/* The player's own controls: play, time, speed, sound, fullscreen. */}
        <div className="row between" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button className="small" onClick={() => (playing ? video.current?.pause() : void video.current?.play())}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="hint">
            {fmt(seconds)} / {fmt(video.current?.duration || meta.totalSeconds)}
          </span>
          <label className="hint">
            Speed{' '}
            <select
              value={rate}
              onChange={(e) => {
                const next = Number(e.target.value);
                setRate(next);
                if (video.current) video.current.playbackRate = next;
              }}
            >
              {[0.5, 1, 1.25, 1.5, 2].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
          <label className="hint">
            Sound{' '}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              style={{ width: 90, verticalAlign: 'middle' }}
              onChange={(e) => {
                const next = Number(e.target.value);
                setVolume(next);
                if (video.current) video.current.volume = next;
              }}
            />
          </label>
          <button
            className="small"
            onClick={() => {
              const v = video.current;
              if (!v) return;
              v.muted = !v.muted;
              setVolume(v.muted ? 0 : v.volume || 1);
            }}
          >
            Mute
          </button>
          <button className="small" onClick={() => void shell.current?.requestFullscreen()}>
            Full screen
          </button>
          <label className="hint">
            Encoding{' '}
            <select value={rendition} onChange={(e) => changeRendition(e.target.value)}>
              {meta.bitrates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {/* The scrubber, with its small preview riding above the thumb as it moves. */}
      <div style={{ position: 'relative', paddingTop: 68 }}>
        {previewAt(meta, seconds) && (
          <img
            src={previewAt(meta, seconds)}
            alt="Preview at this point"
            style={{
              position: 'absolute',
              top: 0,
              left: `clamp(64px, ${(seconds / Math.max(1, meta.totalSeconds)) * 100}%, calc(100% - 64px))`,
              transform: 'translateX(-50%)',
              width: scrubbing ? 148 : 120,
              borderRadius: 6,
              boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
              transition: 'width 0.15s',
            }}
          />
        )}
        <input
          type="range"
          min={0}
          max={meta.totalSeconds}
          step={0.1}
          value={seconds}
          aria-label="Seek"
          style={{ width: '100%' }}
          onChange={(e) => {
            setSeconds(Number(e.target.value));
            setScrubbing(true);
          }}
          onPointerUp={() => {
            setScrubbing(false);
            void playFrom(seconds, true);
          }}
          onKeyUp={() => {
            setScrubbing(false);
            void playFrom(seconds, true);
          }}
        />
      </div>
      <div className="row between">
        <span className="hint">
          chunk {chunkAt(meta, seconds) + 1} of {meta.chunkCount} · {fetched} fetched (charged each){busy ? ' · fetching…' : ''}
        </span>
      </div>
      <div className="row">
        <button
          className="small"
          onClick={async () => {
            try {
              setError(null);
              const whole = await api<{ data: string; name: string }>('/api/vvsh/export', {
                body: { nodeId, file, rendition, name: downloadName(name, meta.sourceMime) },
              });
              const url = URL.createObjectURL(new Blob([Uint8Array.from(fromBase64url(whole.data))], { type: meta.sourceMime ?? 'video/mp4' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = downloadName(whole.name, meta.sourceMime);
              link.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Download the whole video ({rendition})
        </button>
      </div>
      {error && <div className="banner danger small">{error}</div>}
    </div>
  );
}