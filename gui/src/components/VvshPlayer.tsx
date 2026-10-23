// Playing a .vvsh verifiable video stream on its content page. Scrubbing the slider
// shows the preview image of that section straight from the metadata (no chunk needed);
// letting go fetches just the chunks up to that point (each one verified against the
// merkle tree, each one charged by the provider) and plays the video from there. The
// decoded stream is the exact uploaded video, so the controls behave like a normal
// player while the bytes still arrive chunk by chunk.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Download, FileDown, Gauge, Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { chunkAt, pathToChunk, previewAt, serializeVvshFile, type VvshFile } from '../../../src/shared/vvsh.js';
import { assembleVvshWebm, decodeVvshChunk, decodeVvshFrames, exportVvshStream } from '../../../src/shared/vvsh-encode.js';
import { fromBase64url, base64url } from '../../../src/shared/encoding.js';
import { api, errorMessage, streamUrl } from '../api';
import { debugLog, setDebugLogs } from '../log';
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

/** One verified chunk: the request only names where to look — the tree root (or a branch
 *  already verified), the chunk index and the encoding — and the answer is the merkle
 *  path walked plus the leaf bytes. No metadata travels with it. */
const walked = new Map<string, { index: number; path: string[]; base: number }>();
// One fetch per chunk at a time: the prefetch and the player may both ask, and paying
// twice for the same chunk helps nobody.
const inflight = new Map<string, Promise<Uint8Array>>();

async function fetchChunk(nodeId: string, file: VvshFile, index: number, rendition: string): Promise<Uint8Array> {
  const key = `${nodeId}:${file.root}:${index}:${rendition}`;
  const running = inflight.get(key);
  if (running) return running;
  const task = fetchChunkOnce(nodeId, file, index, rendition);
  inflight.set(key, task);
  void task
    .catch(() => undefined)
    .then(() => inflight.delete(key));
  return task;
}

async function fetchChunkOnce(nodeId: string, file: VvshFile, index: number, rendition: string): Promise<Uint8Array> {
  const started = performance.now();
  // A branch already verified for a nearby chunk shortens the walk: the answer's path
  // says which branch sits above which chunks (its first hash is at `pathDepth`).
  const previous = walked.get(file.root);
  let from: { hash: string; depth: number } | undefined;
  if (previous) {
    const before = pathToChunk(file.meta.chunkCount, previous.index);
    const want = pathToChunk(file.meta.chunkCount, index);
    let shared = 0;
    while (shared < before.length && shared < want.length && before[shared] === want[shared]) shared++;
    // The deepest branch the paths share that the earlier answer actually named.
    const deepest = Math.min(shared, previous.base + previous.path.length - 2);
    if (deepest > 0 && deepest >= previous.base) from = { hash: previous.path[deepest - previous.base], depth: deepest };
  }
  const answer = await api<{ data: string; path: string[]; pathDepth: number }>('/api/vvsh/chunk', {
    body: { nodeId, root: file.root, chunkCount: file.meta.chunkCount, index, rendition, ...(from ? { from } : {}) },
  });
  walked.set(file.root, { index, path: answer.path, base: answer.pathDepth ?? 0 });
  const raw = fromBase64url(answer.data);
  debugLog(
    'chunk',
    `chunk ${index} (${rendition})${from ? ` from branch ${from.hash.slice(0, 10)}… depth ${from.depth}` : ' from root'} → ${raw.length} bytes · ${
      answer.path.length
    } steps · ${Math.round(performance.now() - started)}ms`
  );
  if (file.meta.codec === 'vvsh-webm/1') return raw;
  const blocks = decodeVvshFrames(decodeVvshChunk(raw));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

/** One content-addressed object by its hash (an encoding's init part, a tree record…). */
async function fetchObject(nodeId: string, hash: string): Promise<Uint8Array> {
  const answer = await api<{ data: string }>('/api/vvsh/object', { method: 'POST', body: { nodeId, hash } });
  return fromBase64url(answer.data);
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
  // Segmented streams (`vvsh-webm/1`) play through MediaSource: each chunk is a media
  // segment, so the player fetches and appends only what it needs around the playhead —
  // skipping to chunk 70 fetches chunk 70 and plays it, never the 40 chunks in between.
  // Where MediaSource with WebM is unavailable, the same chunks still play through the
  // progressive path (init part + every chunk is a plain WebM file again).
  const segmented = meta.codec === 'vvsh-webm/1';
  // A frames-mode stream with a known decoded size plays as a plain URL: the browser asks
  // for the byte ranges its seek needs and only those chunks are fetched — skipping to
  // chunk 267 fetches chunk 267 and starts there, never the 266 in between.
  const native = useRef<string | null>(null);
  const nativeFor = (id: string): string | null => {
    const rendition = meta.bitrates.find((entry) => entry.id === id) ?? meta.bitrates[0];
    if (segmented || !rendition.decodedBytes) return null;
    const spec = { n: nodeId, r: file.root, c: meta.chunkCount, q: id, d: rendition.decodedBytes };
    return streamUrl(`vvsh.${base64url(new TextEncoder().encode(JSON.stringify(spec)))}`);
  };
  const mseMime = segmented && meta.codecs ? `video/webm; codecs="${meta.codecs}"` : '';
  const mseOk = segmented && typeof MediaSource !== 'undefined' && !!mseMime && MediaSource.isTypeSupported(mseMime);
  const inits = useRef(new Map<string, Uint8Array>());
  const mse = useRef<{
    source: MediaSource;
    buffer: SourceBuffer | null;
    initHash: string;
    appended: Set<number>;
    queue: Uint8Array[];
    working: boolean;
  } | null>(null);

  /** The encoding's init part (its header and tracks), fetched once per encoding. */
  const ensureInit = async (id: string): Promise<Uint8Array> => {
    const have = inits.current.get(id);
    if (have) return have;
    const rendition = meta.bitrates.find((entry) => entry.id === id) ?? meta.bitrates[0];
    if (!segmented) return new Uint8Array(0);
    const bytes = await fetchObject(nodeId, rendition.initHash ?? '');
    inits.current.set(id, bytes);
    return bytes;
  };

  /** Appends queued segments one at a time — a SourceBuffer only takes one at a time. */
  const msePump = () => {
    const st = mse.current;
    if (!st || !st.buffer || st.working || st.buffer.updating) return;
    const next = st.queue.shift();
    if (!next) return;
    st.working = true;
    st.buffer.appendBuffer(next as unknown as BufferSource);
    st.buffer.onupdateend = () => {
      st.working = false;
      msePump();
    };
  };
  const mseAppend = (bytes: Uint8Array) => {
    const st = mse.current;
    if (!st) return;
    st.queue.push(bytes);
    msePump();
  };

  /** One chunk a moment needs: fetched (verified against the tree) and appended alone. */
  const mseWant = async (index: number, id: string) => {
    const st = mse.current;
    if (!alive.current || !st || st.appended.has(index)) return;
    st.appended.add(index); // before the fetch: nobody fetches the same chunk twice
    const block = await fetchChunk(nodeId, file, index, id);
    if (mse.current !== st) return;
    mseAppend(block);
  };

  /** Only the window from what is playing to a minute ahead — never the chunks behind. */
  const mseWindow = async (at: number, id: string) => {
    const ahead = Math.max(meta.chunkSeconds, prefetchSeconds);
    const from = chunkAt(meta, at);
    const to = Math.min(meta.chunkCount - 1, chunkAt(meta, at + ahead));
    const missing: number[] = [];
    for (let index = from; index <= to; index++) if (!mse.current?.appended.has(index)) missing.push(index);
    debugLog('fetch', `window chunks ${from}–${to} for ${id} (${missing.length} missing)`);
    for (let start = 0; start < missing.length; start += 6) {
      if (!alive.current) return; // the page was left: stop fetching
      await Promise.all(missing.slice(start, start + 6).map((index) => mseWant(index, id)));
    }
  };

  /** Opens a MediaSource for one encoding and plays from a moment of the video at once. */
  const mseOpen = async (id: string, at: number, play: boolean) => {
    const rendition = meta.bitrates.find((entry) => entry.id === id) ?? meta.bitrates[0];
    const source = new MediaSource();
    mse.current = { source, buffer: null, initHash: rendition.initHash ?? '', appended: new Set(), queue: [], working: false };
    wantTime.current = at;
    wantPlay.current = play;
    const url = URL.createObjectURL(source);
    setVideoUrl((old) => {
      if (old) staleUrls.current.push(old);
      return url;
    });
    await new Promise<void>((resolve, reject) => {
      // If the browser never opens the stream, give up quickly: the same chunks then
      // play as one file instead of the player sitting there doing nothing.
      const timer = setTimeout(() => reject(new Error('The browser would not open the video stream')), 4000);
      source.onsourceopen = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const st = mse.current;
    if (!st || mse.current !== st) return;
    st.buffer = source.addSourceBuffer(mseMime);
    mseAppend(Uint8Array.from(await ensureInit(id)));
    await mseWant(chunkAt(meta, at), id); // the chunk being played goes first, always
    const v = video.current;
    if (v) {
      v.currentTime = at;
      if (play) void v.play().catch(() => undefined);
    }
    void mseWindow(at, id); // and then only what runs ahead of it
  };
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
  // Leaving the page stops every in-flight fetch: nothing keeps asking for chunks.
  const alive = useRef(true);
  useEffect(() => {
    setDebugLogs(Boolean(state?.settings.debugLogs));
    const url = nativeFor(active.current);
    if (url) {
      native.current = url;
      debugLog('play', 'range streaming on — the browser fetches only the byte ranges a seek needs');
      setVideoUrl(url);
    }
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // How wide the scrub preview popup shows: the viewer's choice. The images themselves
  // are captured and sized by the publisher — that is recorded in the file.
  const scrubWidth = Math.min(640, Math.max(80, Number(state?.settings?.vvshScrubWidth ?? 220)));

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
      await ensureInit(id); // a segmented stream's blob starts with its init part
      const wanted = Math.min(upTo, meta.chunkCount - 1);
      const missing: number[] = [];
      for (let index = 0; index <= wanted; index++) if (!buffer.has(index)) missing.push(index);
      const lanes = 8;
      debugLog('fetch', `need chunks 0–${wanted} for ${id} — filling in groups of ${lanes}`);
      for (let at = 0; at < missing.length; at += lanes) {
        if (!alive.current) return; // the page was left: stop fetching
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
      // A segmented stream plays as its init part followed by the segments — a plain
      // WebM file again, which is exactly the fallback where MediaSource is unavailable.
      const init = inits.current.get(active.current);
      const parts: Uint8Array[] = init ? [Uint8Array.from(init)] : [];
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
      if (native.current) {
        // A range stream: quality change is a new URL picked up at the same moment.
        const v = video.current;
        const here = v?.currentTime ?? at;
        active.current = id;
        if (!autoRef.current) setRendition(id);
        const url = nativeFor(id);
        if (url) {
          native.current = url;
          wantTime.current = here;
          wantPlay.current = play;
          debugLog('play', `quality ${id} — range stream continues at ${here.toFixed(1)}s`);
          setVideoUrl((old) => {
            if (old) staleUrls.current.push(old);
            return url;
          });
        }
        return;
      }
      if (mseOk) {
        // Segments from the new encoding simply carry on at the playhead.
        active.current = id;
        if (!autoRef.current) setRendition(id);
        await playFrom(at, play);
        return;
      }
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
      if (native.current) {
        debugLog('seek', `seek to ${at.toFixed(1)}s — range streaming: only the bytes this seek needs are fetched`);
        const v = video.current;
        if (v) {
          v.currentTime = at;
          if (play) void v.play().catch(() => undefined);
        }
        return;
      }
      debugLog(
        'seek',
        `seek to ${at.toFixed(1)}s → chunk ${chunkAt(meta, at)}` +
          (mseOk
            ? ` · sparse: this chunk plus the ${prefetchSeconds}s window ahead`
            : ` · ${meta.codec} plays as one file — the chunks before it are part of it and get filled`)
      );
      if (mseOk) {
        // Sparse playback: the chunk that moment needs goes first, and only the window
        // ahead follows — nothing between the old position and the new one is fetched.
        try {
          setError(null);
          const want = meta.bitrates.find((entry) => entry.id === active.current) ?? meta.bitrates[0];
          const st = mse.current;
          if (!st || st.initHash !== (want.initHash ?? '')) {
            await mseOpen(active.current, at, play);
          } else {
            await mseWant(chunkAt(meta, at), active.current);
            const v = video.current;
            if (v) {
              v.currentTime = at;
              if (play) void v.play().catch(() => undefined);
            }
            void mseWindow(at, active.current);
          }
          setFetched(mse.current?.appended.size ?? 0);
          return;
        } catch {
          // MediaSource would not run here: fall through and play the chunks as one file.
          mse.current = null;
        }
      }
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
    if (mseOk) return; // segmented: MediaSource takes care of what is on screen
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
    const chosenRendition = meta.bitrates.find((entry) => entry.id === chosen) ?? meta.bitrates[0];
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
      const whole = file.meta.codec === 'vvsh-webm/1'
        ? assembleVvshWebm(await fetchObject(nodeId, chosenRendition.initHash ?? ''), pieces)
        : exportVvshStream(pieces);
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
            if (mse.current) return;
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
            if (mse.current) return;
            // The stream runs out exactly when the fetched chunks do — carry on.
            if (bufferOf(active.current).size < meta.chunkCount) void playFrom(seconds + 0.2, true);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            // The thumb follows the video only while the user is not holding it.
            if (!scrubbingRef.current) setSeconds(v.currentTime);
            if (native.current) return; // the browser's readahead handles what comes next
            // Keep the stream filled a configurable distance ahead while it plays (a
            // minute by default) — only those chunks get fetched, each verified and charged.
            const ahead = Math.max(meta.chunkSeconds, prefetchSeconds);
            const target = Math.min(meta.chunkCount - 1, chunkAt(meta, v.currentTime + ahead));
            if (mseOk) {
              // Segmented: keep only the window around what is playing filled.
              void mseWindow(v.currentTime, active.current);
              return;
            }
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
                  left: `clamp(${Math.round(scrubWidth / 2)}px, ${(seconds / Math.max(1, meta.totalSeconds)) * 100}%, calc(100% - ${Math.round(scrubWidth / 2)}px))`,
                  transform: 'translateX(-50%)',
                  width: scrubWidth,
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