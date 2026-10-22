// Playing a .vvsh verifiable video stream on its content page. Scrubbing the slider
// shows the preview image of that section straight from the metadata (no chunk needed);
// letting go fetches just the chunks up to that point (each one verified against the
// merkle tree, each one charged by the provider) and plays the video from there. The
// decoded stream is the exact uploaded video, so the controls behave like a normal
// player while the bytes still arrive chunk by chunk.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Download, FileDown, Gauge, Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { chunkAt, previewAt, serializeVvshFile, type VvshFile } from '../../../src/shared/vvsh.js';
import { decodeVvshChunk, decodeVvshFrames, exportVvshStream } from '../../../src/shared/vvsh-encode.js';
import { fromBase64url } from '../../../src/shared/encoding.js';
import { api, errorMessage } from '../api';
import { useApp } from '../state';

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
  const { state } = useApp();
  // Chunks keep downloading this far ahead while the video plays (Settings → prefetch).
  const prefetchSeconds = state?.settings?.vvshPrefetchSeconds ?? 60;
  // Where the player starts: 'auto' fits the network, 'highest'/'lowest' pin it (Settings).
  const defaultQuality = String(state?.settings?.vvshDefaultQuality ?? 'auto');
  const video = useRef<HTMLVideoElement | null>(null);
  // Every encoding keeps its own buffer, so changing quality never throws away what is
  // already fetched and never has to stop the video. Chunks are kept by index: a seek
  // fetches only the chunks it is missing (in parallel), never the ones in between again.
  const buffers = useRef(new Map<string, Map<number, Uint8Array>>());
  const bufferOf = (id: string) => {
    let entry = buffers.current.get(id);
    if (!entry) {
      entry = new Map();
      buffers.current.set(id, entry);
    }
    return entry;
  };
  const wantTime = useRef(0);
  const wantPlay = useRef(false);
  // 'auto' (the default) keeps the best encoding the measured download speed can carry.
  const [rendition, setRendition] = useState<string>(() => {
    if (defaultQuality === 'highest') return meta.bitrates[0].id;
    if (defaultQuality === 'lowest') return meta.bitrates[meta.bitrates.length - 1].id;
    return 'auto';
  });
  const active = useRef(rendition === 'auto' ? meta.bitrates[0].id : rendition);
  const autoRef = useRef(rendition === 'auto');
  const bandwidth = useRef(0);
  const scrubbingRef = useRef(false);
  const [seconds, setSeconds] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [fetched, setFetched] = useState(0);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const queue = useRef<Promise<void>>(Promise.resolve()); // (unused now that fetching runs in parallel lanes)
  const shell = useRef<HTMLDivElement | null>(null);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const scrubResume = useRef(false);
  const staleUrls = useRef<string[]>([]);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  // One open panel at a time (speed / sound / download): it fades away a second after the
  // pointer leaves it and closes when anything outside is clicked.
  const [panel, setPanel] = useState<'speed' | 'sound' | 'download' | null>(null);
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsBox = useRef<HTMLDivElement | null>(null);
  const skipSeconds = state?.settings?.vvshSkipSeconds ?? 10;

  const keepPanel = useCallback((name: 'speed' | 'sound' | 'download') => {
    if (panelTimer.current) clearTimeout(panelTimer.current);
    setPanel(name);
  }, []);
  const releasePanel = useCallback(() => {
    if (panelTimer.current) clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(() => setPanel(null), 1000);
  }, []);

  useEffect(() => {
    const onDocumentDown = (event: MouseEvent) => {
      if (panel && controlsBox.current && !controlsBox.current.contains(event.target as Node)) setPanel(null);
    };
    document.addEventListener('mousedown', onDocumentDown);
    return () => document.removeEventListener('mousedown', onDocumentDown);
  }, [panel]);

  // Left/right arrows skip through the video; the skip length is in Settings.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      const v = video.current;
      if (!v) return;
      const at = Math.max(0, Math.min(meta.totalSeconds, v.currentTime + (event.key === 'ArrowRight' ? skipSeconds : -skipSeconds)));
      setSeconds(at);
      void playFrom(at, !v.paused);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipSeconds, meta.totalSeconds]);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [full, setFull] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The controls fade out when the mouse rests, and back on when it moves — like most players. */
  const wake = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 2600);
  }, []);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => {
    if (!playing) setControlsVisible(true);
  }, [playing]);

  useEffect(() => {
    const onFull = () => {
      const isFull = Boolean(document.fullscreenElement);
      setFull(isFull);
      if (isFull) wake();
    };
    document.addEventListener('fullscreenchange', onFull);
    return () => document.removeEventListener('fullscreenchange', onFull);
  }, [wake]);

  /** Fetches the verified chunks one encoding is missing up to an index — several at a
   *  time, so skipping far ahead is a few round trips instead of one long walk. */
  const pull = useCallback(
    async (upTo: number, id: string) => {
      const buffer = bufferOf(id);
      const wanted = Math.min(upTo, meta.chunkCount - 1);
      const missing: number[] = [];
      for (let index = 0; index <= wanted; index++) if (!buffer.has(index)) missing.push(index);
      const lanes = 8;
      for (let at = 0; at < missing.length; at += lanes) {
        await Promise.all(
          missing.slice(at, at + lanes).map(async (index) => {
            const started = performance.now();
            const block = await fetchChunk(nodeId, file, index, id);
            // Measured download speed drives the auto quality choice.
            const secondsTaken = Math.max(0.001, (performance.now() - started) / 1000);
            const rateNow = block.length / secondsTaken;
            bandwidth.current = bandwidth.current ? bandwidth.current * 0.7 + rateNow * 0.3 : rateNow;
            buffer.set(index, block);
            if (id === active.current) setFetched(buffer.size);
          })
        );
      }
    },
    [file, meta.chunkCount, nodeId]
  );

  /** Hands the fetched stream of the active encoding to the video element. */
  const swap = useCallback(
    (at: number, play: boolean) => {
      const buffer = bufferOf(active.current);
      const parts: Uint8Array[] = [];
      for (let index = 0; index < meta.chunkCount; index++) {
        const block = buffer.get(index);
        if (!block) break; // the stream is only handed over whole, from its start
        parts.push(block);
      }
      if (!parts.length) return; // never hand the element an empty stream
      wantTime.current = at;
      wantPlay.current = play;
      const url = URL.createObjectURL(new Blob(parts.map((part) => Uint8Array.from(part)), { type: meta.sourceMime ?? 'video/mp4' }));
      setVideoUrl((old) => {
        // Never revoke the URL the element still points at — that is what "the media
        // resource … was not suitable" is. Old ones are cleared once it has moved on.
        if (old) staleUrls.current.push(old);
        return url;
      });
    },
    [meta.chunkCount, meta.sourceMime]
  );

  /** The best encoding the measured download speed can carry (auto quality). */
  const pickAuto = useCallback(() => {
    const budget = bandwidth.current * 0.8; // bytes per second to sustain
    if (!budget) return meta.bitrates[0].id;
    const fits = meta.bitrates.filter((entry) => (entry.kbps * 1000) / 8 <= budget);
    return (fits[0] ?? meta.bitrates[meta.bitrates.length - 1]).id;
  }, [meta.bitrates]);

  /** Moves playback to another encoding without stopping it. */
  const switchTo = useCallback(
    async (id: string, at: number, play: boolean) => {
      active.current = id;
      if (!autoRef.current) setRendition(id);
      const buffer = bufferOf(id);
      setFetched(buffer.size);
      if (!buffer.has(chunkAt(meta, at))) {
        setBusy(true);
        try {
          await pull(chunkAt(meta, at), id);
        } finally {
          setBusy(false);
        }
      }
      swap(at, play);
    },
    [meta, pull, swap]
  );

  /** From one moment of the video: fetch what is missing up to it, then play there. */
  const playFrom = useCallback(
    async (at: number, play = true) => {
      const target = chunkAt(meta, at);
      try {
        setError(null);
        const buffer = bufferOf(active.current);
        if (buffer.has(target)) {
          const v = video.current;
          if (v) {
            v.currentTime = at;
            if (play) void v.play().catch(() => undefined);
          }
          return;
        }
        setBusy(true);
        await pull(target, active.current);
        if (autoRef.current) {
          const pick = pickAuto();
          if (pick !== active.current) {
            await switchTo(pick, at, play);
            return;
          }
        }
        swap(at, play);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [meta, pickAuto, pull, swap, switchTo]
  );

  useEffect(() => {
    void playFrom(0, false);
    // (Once, on open: the first chunk comes in so the video is on screen, and the
    //  prefetch window fills behind it before the user even presses play.)
    void pull(Math.min(meta.chunkCount - 1, chunkAt(meta, prefetchSeconds)), active.current)
      .then(() => {
        const now = video.current;
        if (now && now.paused) swap(now.currentTime, false);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Changing encoding keeps the video playing — every encoding's buffer is kept. */
  const changeRendition = (value: string) => {
    const v = video.current;
    const at = v?.currentTime ?? seconds;
    const keepPlaying = Boolean(v && !v.paused);
    if (value === 'auto') {
      autoRef.current = true;
      setRendition('auto');
      const pick = pickAuto();
      if (pick !== active.current) void switchTo(pick, at, keepPlaying);
      return;
    }
    autoRef.current = false;
    void switchTo(value, at, keepPlaying);
  };

  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const iconBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'rgba(255,255,255,0.14)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '5px 8px',
    cursor: 'pointer',
  };
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3];
  const setSpeed = (value: number) => {
    setRate(value);
    if (video.current) video.current.playbackRate = value;
  };
  const toggleMute = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.6;
    setVolume(v.muted ? 0 : v.volume);
  };
  const downloadVideo = async (pick?: string) => {
    const chosen = pick ?? rendition;
    try {
      setError(null);
      setDownloadPct(0);
      // Fetch every chunk of the chosen encoding — each verified — and patch them
      // together here, with progress, instead of trusting one assembled response.
      const pieces: Uint8Array[] = [];
      for (let index = 0; index < meta.chunkCount; index++) {
        const answer = await api<{ data: string }>('/api/vvsh/chunk', { body: { nodeId, file, index, rendition: chosen } });
        pieces.push(fromBase64url(answer.data));
        setDownloadPct(Math.round(((index + 1) / meta.chunkCount) * 100));
      }
      const whole = exportVvshStream(pieces);
      const url = URL.createObjectURL(new Blob([Uint8Array.from(whole)], { type: meta.sourceMime ?? 'video/mp4' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName(name, meta.sourceMime);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDownloadPct(null);
    }
  };
  const downloadVvsh = () => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(serializeVvshFile(file))], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name.replace(/\.vvsh$/i, '')}.vvsh`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  return (
    <div className="form-stack">
      <div
        ref={shell}
        onMouseMove={wake}
        onTouchStart={wake}
        style={
          full
            ? {
                width: '100vw',
                height: '100vh',
                background: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                overflow: 'hidden',
                // The cursor only vanishes once the controls do, and only in fullscreen.
        cursor: full && !controlsVisible ? 'none' : 'auto',
              }
            : { position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden', cursor: controlsVisible ? 'auto' : 'none' }
        }
      >
        <video
          ref={video}
          src={videoUrl || undefined}
          poster={meta.previews?.images[0]}
          playsInline
          style={{ width: '100%', maxHeight: full ? '100vh' : undefined, objectFit: 'contain', display: 'block', borderRadius: full ? 0 : 8 }}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            if (v.paused) void v.play().catch(() => undefined);
            else v.pause();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            // Some mp4s only play once the whole file is present (their index sits at the
            // end) — finish fetching and hand the complete stream over.
            if (bufferOf(active.current).size < meta.chunkCount) {
              setBusy(true);
              void pull(meta.chunkCount - 1, active.current)
                .then(() => swap(wantTime.current, wantPlay.current))
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }
          }}
          onLoadedMetadata={() => {
            for (const url of staleUrls.current) URL.revokeObjectURL(url);
            staleUrls.current = [];
            const v = video.current;
            if (!v) return;
            v.currentTime = Math.min(wantTime.current, v.duration || wantTime.current);
            if (wantPlay.current) void v.play().catch(() => undefined);
          }}
          onEnded={() => {
            // The stream runs out exactly when the fetched chunks do — carry on.
            if (bufferOf(active.current).size < meta.chunkCount) void playFrom(seconds + 0.2, true);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            // The thumb follows the video only while the user is not holding it.
            if (!scrubbingRef.current) setSeconds(v.currentTime);
            // Keep the stream filled a configurable distance ahead while it plays (a
            // minute by default) — only those chunks get fetched, each verified and charged.
            const ahead = Math.max(meta.chunkSeconds, prefetchSeconds);
            const target = Math.min(meta.chunkCount - 1, chunkAt(meta, v.currentTime + ahead));
            // Only the window's end is fetched here: what is already in the buffer stays,
            // and pulling adds just what is missing between here and there, in parallel.
            if (!bufferOf(active.current).has(target)) {
              void pull(target, active.current)
                .then(() => {
                  const now = video.current;
                  if (!now) return;
                  // Auto quality: move to whatever the measured speed now allows.
                  if (autoRef.current) {
                    const pick = pickAuto();
                    if (pick !== active.current) {
                      void switchTo(pick, now.currentTime, !now.paused);
                      return;
                    }
                  }
                  swap(now.currentTime, !now.paused);
                })
                .catch(() => undefined);
            }
          }}
        />
        {/* Two rows over the picture: the scrub on top (its preview floats above it while
            the knob is held), then play on the left and everything else on the right. */}
        <div
          ref={controlsBox}
          onMouseMove={wake}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '30px 12px 10px',
            background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
            opacity: controlsVisible ? 1 : 0,
            transition: 'opacity 0.25s',
            pointerEvents: controlsVisible ? 'auto' : 'none',
          }}
        >
          {downloadPct !== null && (
            <div
              style={{ position: 'absolute', top: 22, left: 12, right: 12, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.22)' }}
              title={`Downloading… ${downloadPct}%`}
            >
              <div style={{ width: `${downloadPct}%`, height: '100%', borderRadius: 2, background: '#fff', transition: 'width 0.2s' }} />
            </div>
          )}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            {scrubbing && previewAt(meta, seconds) && (
              <img
                src={previewAt(meta, seconds)}
                alt="Preview at this point"
                style={{
                  position: 'absolute',
                  bottom: 26,
                  left: `clamp(68px, ${(seconds / Math.max(1, meta.totalSeconds)) * 100}%, calc(100% - 68px))`,
                  transform: 'translateX(-50%)',
                  width: 128,
                  borderRadius: 6,
                  boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                  zIndex: 2,
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
              style={{ width: '100%', margin: 0, height: 26 }}
              onChange={(e) => {
                // Hold the video still while the knob is down; it resumes on release.
                if (!scrubbingRef.current) {
                  scrubResume.current = Boolean(video.current && !video.current.paused);
                  video.current?.pause();
                }
                scrubbingRef.current = true;
                setScrubbing(true);
                setSeconds(Number(e.target.value));
              }}
              onPointerUp={() => {
                scrubbingRef.current = false;
                setScrubbing(false);
                void playFrom(seconds, scrubResume.current);
                scrubResume.current = false;
              }}
              onKeyUp={() => {
                scrubbingRef.current = false;
                setScrubbing(false);
                void playFrom(seconds, scrubResume.current);
                scrubResume.current = false;
              }}
            />
          </div>
          <div className="row between" style={{ gap: 8, alignItems: 'center', flexWrap: 'nowrap' }}>
            <button style={iconBtn} title={playing ? 'Pause' : 'Play'} onClick={() => (playing ? video.current?.pause() : void video.current?.play().catch(() => undefined))}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
            <span style={{ color: '#fff', fontSize: 12, fontVariantNumeric: 'tabular-nums', opacity: 0.9, whiteSpace: 'nowrap' }}>
              {fmt(seconds)} / {fmt(video.current?.duration || meta.totalSeconds)}
            </span>
            <div style={{ position: 'relative' }} onMouseEnter={() => keepPanel('speed')} onMouseLeave={releasePanel}>
              <button style={iconBtn} title="Playback speed" onClick={() => setPanel((open) => (open === 'speed' ? null : 'speed'))}>
                <Gauge size={16} />
                <span style={{ fontSize: 11, width: 38, textAlign: 'center', display: 'inline-block', fontVariantNumeric: 'tabular-nums' }}>{rate}×</span>
              </button>
              {panel === 'speed' && (
                <div
                  style={{ position: 'absolute', bottom: 34, right: 0, background: 'rgba(18,18,18,0.95)', borderRadius: 8, padding: 10, width: 150, zIndex: 4 }}
                  onMouseEnter={() => keepPanel('speed')}
                  onMouseLeave={releasePanel}
                >
                  <input
                    type="range"
                    min={0}
                    max={SPEEDS.length - 1}
                    step={1}
                    value={Math.max(0, SPEEDS.indexOf(rate))}
                    aria-label="Playback speed"
                    style={{ width: '100%' }}
                    onChange={(e) => setSpeed(SPEEDS[Number(e.target.value)])}
                  />
                  <div style={{ color: '#fff', textAlign: 'center', fontSize: 11 }}>{rate}× · 0.25 – 3</div>
                </div>
              )}
            </div>
            <div style={{ position: 'relative' }} onMouseEnter={() => keepPanel('sound')} onMouseLeave={releasePanel}>
              <button style={iconBtn} title={volume > 0 && !video.current?.muted ? 'Mute' : 'Unmute'} onClick={toggleMute}>
                {volume > 0 && !video.current?.muted ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>
              {panel === 'sound' && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 34,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(18,18,18,0.95)',
                    borderRadius: 8,
                    padding: '10px 8px',
                    zIndex: 4,
                  }}
                  onMouseEnter={() => keepPanel('sound')}
                  onMouseLeave={releasePanel}
                >
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    aria-label="Sound"
                    style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 88, width: 22 }}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setVolume(next);
                      if (video.current) {
                        video.current.volume = next;
                        video.current.muted = next === 0;
                      }
                    }}
                  />
                </div>
              )}
            </div>
            <select
              value={rendition}
              onChange={(e) => changeRendition(e.target.value)}
              title="Encoding"
              style={{ ...iconBtn, padding: '4px 5px', appearance: 'auto', maxWidth: 110 }}
            >
              <option value="auto">Auto</option>
              {meta.bitrates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <div style={{ position: 'relative' }} onMouseEnter={() => keepPanel('download')} onMouseLeave={releasePanel}>
              <button style={iconBtn} title="Download" onClick={() => setPanel((open) => (open === 'download' ? null : 'download'))}>
                <Download size={16} />
              </button>
              {panel === 'download' && (
                <div
                  style={{ position: 'absolute', bottom: 34, right: 0, background: 'rgba(18,18,18,0.95)', borderRadius: 8, padding: 6, minWidth: 168, zIndex: 4 }}
                  onMouseEnter={() => keepPanel('download')}
                  onMouseLeave={releasePanel}
                >
                  {meta.bitrates.map((entry) => (
                    <button
                      key={entry.id}
                      style={{ ...iconBtn, width: '100%', justifyContent: 'space-between', background: 'transparent' }}
                      onClick={() => {
                        setPanel(null);
                        void downloadVideo(entry.id);
                      }}
                    >
                      <span>{entry.label}</span>
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{entry.bytes ? `${(entry.bytes / (1024 * 1024)).toFixed(1)} MB` : ''}</span>
                    </button>
                  ))}
                  <button
                    style={{ ...iconBtn, width: '100%', justifyContent: 'space-between', background: 'transparent' }}
                    onClick={() => {
                      setPanel(null);
                      downloadVvsh();
                    }}
                  >
                    <span>.vvsh file</span>
                    <FileDown size={14} />
                  </button>
                </div>
              )}
            </div>
            <button
              style={iconBtn}
              title={full ? 'Leave full screen' : 'Full screen'}
              onClick={() => (full ? void document.exitFullscreen() : void shell.current?.requestFullscreen())}
            >
              {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            </div>
          </div>
        </div>
      </div>
      <div className="row between">
        <span className="hint">
          chunk {chunkAt(meta, seconds) + 1} of {meta.chunkCount} · {fetched} fetched (charged each){busy ? ' · fetching…' : ''}
        </span>
        <span className="hint">
          {Math.round(meta.chunkSeconds)}s chunks · prefetching {Math.max(meta.chunkSeconds, prefetchSeconds)}s ahead
        </span>
      </div>
      {error && <div className="banner danger small">{error}</div>}
    </div>
  );
}