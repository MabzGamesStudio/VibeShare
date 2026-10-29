// Building a .vvsh verifiable video stream from a video the user picks: the metadata
// configuration lives here — which bitrate encodings to store, how long each chunk is
// (the total number of chunks follows), and how many image previews the video splits
// into. The stream can be calculated here and published, or the provider can calculate
// it from just the video (it names its price from the metadata, length and encodings).
import { useEffect, useMemo, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import type { Manifest } from '../../../src/shared/content.js';
import type { VvshRendition } from '../../../src/shared/vvsh.js';
import { buildVvsh, vvshPlan } from '../../../src/shared/vvsh-encode.js';
import { base64url } from '../../../src/shared/encoding.js';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import {
  defaultKbps,
  estimateBytes,
  fitReport,
  FRAME_RATES,
  HEIGHT_TO_WIDTH,
  packSegments,
  PREVIEW_WIDTHS,
  RESOLUTIONS,
  rowId,
  transcodeSegments,
  unpackSegments,
  WIDTHS,
  WIDTH_TO_HEIGHT,
  type EncodeRow,
} from '../media/transcode';
import { clearJob, getBlob, getStoredFile, loadJob, newJobId, putBlob, saveJob, type VvshJob } from '../media/vvshjobs';

/** The video's length as hours:minutes:seconds.milliseconds, as the form shows it. */
function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ms = Math.min(99, Math.floor((seconds - whole) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

/** Browsers report the measured rate noisily (29.7 for a 30 fps video). Snapping to the
 *  nearest standard rate keeps a matching encoding from warning about being "above". */
function snapFps(measured: number): number {
  if (!measured) return 0;
  for (const rate of [24, 25, 30, 50, 60]) {
    if (Math.abs(measured - rate) <= rate * 0.1) return rate;
  }
  return Math.round(measured);
}

/** Opens the picked video once to read its length, shape and preview thumbnails.
 *  Size and JPEG quality come from the settings below. */
async function probeVideo(
  file: Blob,
  splits: number,
  width = 320,
  quality = 0.72
): Promise<{ seconds: number; previews: string[]; width: number; height: number; fps: number }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('This file did not open as a video (timed out)')), 30_000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('This file did not open as a video'));
      };
      video.load();
    });
    const seconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const sourceWidth = video.videoWidth || 0;
    const sourceHeight = video.videoHeight || 0;
    // The frame rate the file really carries, measured over a moment of playing.
    let fps = 0;
    try {
      video.muted = true;
      video.currentTime = 0;
      await video.play();
      const startedAt = performance.now();
      const frames0 = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const frames1 = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      if (frames1 > frames0) fps = Math.round(((frames1 - frames0) * 1000) / (performance.now() - startedAt));
      video.pause();
    } catch {
      fps = 0;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(90, Math.round(((video.videoHeight || 180) / (video.videoWidth || 320)) * width));
    const previews: string[] = [];
    for (let index = 0; index < Math.max(0, splits); index++) {
      const at = ((index + 0.5) * seconds) / splits;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(at, Math.max(0, (video.duration || seconds) - 0.05));
      });
      video.onseeked = null;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      previews.push(canvas.toDataURL('image/jpeg', quality));
    }
    return { seconds, previews, width: sourceWidth, height: sourceHeight, fps };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const DEFAULT_ROWS: EncodeRow[] = [
  { id: rowId(1080, 30), height: 1080, width: 1920, fit: 'crop', fps: 30, kbps: defaultKbps(1080, 30) },
  { id: rowId(480, 30), height: 480, width: 854, fit: 'crop', fps: 30, kbps: defaultKbps(480, 30) },
];

export function VvshCompose() {
  const { state, toast } = useApp();
  const provider = state?.nodes.find((node) => node.type === 'provider' && node.enabled);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [seconds, setSeconds] = useState(0);
  const [title, setTitle] = useState('');
  const [rows, setRows] = useState<EncodeRow[]>(DEFAULT_ROWS);
  const [chunkSeconds, setChunkSeconds] = useState('5');
  const [previews, setPreviews] = useState('100');
  const [job, setJob] = useState<VvshJob | null>(null);
  const jobRef = useRef<VvshJob | null>(null);
  const [passPct, setPassPct] = useState<number | null>(null);
  /** Provider-side processing percent while a conversion runs there. */
  const [processPct, setProcessPct] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // A job left over from an earlier visit (the page closed mid-publish) is picked up here.
  // The whole configuration comes back with it — the chunk length included — so a resumed
  // job keeps encoding into the same timeline its finished chunks were cut for.
  useEffect(() => {
    void loadJob().then((saved) => {
      if (saved && saved.status !== 'done') {
        jobRef.current = saved;
        setJob(saved);
        if (saved.rows?.length) {
          setRows(
            saved.rows.map((row) => ({
              ...row,
              width: row.width ?? 0,
              fit: row.fit ?? 'crop',
              customFps: false,
              customHeight: false,
              customWidth: false,
            }))
          );
        }
        if (saved.chunkSeconds > 0) setChunkSeconds(String(saved.chunkSeconds));
        if (saved.previewSplits > 0) setPreviews(String(saved.previewSplits));
        if (saved.totalSeconds > 0) setSeconds(saved.totalSeconds);
      }
    });
  }, []);

  const persist = async (patch: Partial<VvshJob>) => {
    if (!jobRef.current) return;
    const merged = { ...jobRef.current, ...patch };
    jobRef.current = merged;
    setJob(merged);
    await saveJob(merged);
  };

  // Empty fields are fine while typing — the numbers are only read when they are filled.
  const chunkSecondsValue = Number(chunkSeconds) || 0;
  const previewSplits = Number(previews) || 0;
  // The preview capture size and JPEG quality are the publisher's choice — they go into
  // the .vvsh metadata so every player knows how the images were made. (Viewers only pick
  // how wide the scrub popup shows them.)
  const [previewWidth, setPreviewWidth] = useState('256');
  const [previewWidthCustom, setPreviewWidthCustom] = useState(false);
  const [previewQuality, setPreviewQuality] = useState('0.5');
  // What the picked video really is: its size and frame rate — an encoding above them
  // only adds bytes, so the form says so.
  const [source, setSource] = useState<{ width: number; height: number; fps: number } | null>(null);
  const previewWidthValue = Math.min(1280, Math.max(80, Number(previewWidth) || 320));
  const previewQualityValue = Math.min(1, Math.max(0.1, Number(previewQuality) || 0.72));
  // Rough JPEG weight at this width and quality, times how many previews there are.
  const previewEstimateMb =
    (Math.max(0, previewSplits) * previewWidthValue * Math.round((previewWidthValue * 9) / 16) * 0.3 * previewQualityValue) / 1_048_576;
  // An encoding strictly above what the video really carries only adds bytes (an exact
  // match — 480p on a 480p file, 30 fps on a 30 fps file — is right and never warns), and
  // two of the same add nothing at all — the form points both out.
  const overSource = (row: { height: number; width?: number; fps: number }) =>
    Boolean(
      source &&
        (row.height > source.height || (row.width ?? 0) > source.width || (source.fps > 0 && row.fps > source.fps))
    );
  const seenConfigs = new Map<string, number>();
  for (const row of rows) seenConfigs.set(rowId(row.height, row.fps), (seenConfigs.get(rowId(row.height, row.fps)) ?? 0) + 1);
  const duplicates = [...seenConfigs.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const bitrates: VvshRendition[] = rows.map((row) => ({
    id: row.id,
    label: `${row.height}p${row.fps}`,
    height: row.height,
    width: row.width > 0 ? row.width : undefined,
    fit: row.fit,
    kbps: row.kbps,
    fps: row.fps,
  }));
  const plan = useMemo(
    () => (seconds > 0 && chunkSecondsValue > 0 && rows.length ? vvshPlan(seconds, { bitrates, chunkSeconds: chunkSecondsValue, previewSplits }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, chunkSecondsValue, previewSplits, seconds]
  );
  const config = { bitrates, chunkSeconds: chunkSecondsValue, previewSplits };

  const updateRow = (index: number, patch: Partial<EncodeRow>) => {
    setRows((current) =>
      current.map((row, i) => {
        if (i !== index) return row;
        const merged = { ...row, ...patch };
        merged.id = rowId(merged.height, merged.fps);
        merged.kbps = defaultKbps(merged.height, merged.fps);
        return merged;
      })
    );
  };

  const choose = async (picked: File) => {
    setFile(picked);
    setSeconds(0);
    try {
      // The length and the shape come from the video itself — no typing needed.
      const probe = await probeVideo(picked, 0, previewWidthValue, previewQualityValue);
      if (probe.seconds > 0) setSeconds(probe.seconds);
      setSource({ width: probe.width, height: probe.height, fps: snapFps(probe.fps) });
      // The video's own encoding is the only encoding to start: its exact size and frame
      // rate, so publishing the file as it is takes no editing at all.
      const fps = snapFps(probe.fps) || 30;
      if (probe.width > 0 && probe.height > 0) {
        setRows([
          {
            id: rowId(probe.height, fps),
            height: probe.height,
            width: probe.width,
            fit: 'crop',
            fps,
            kbps: defaultKbps(probe.height, fps),
          },
        ]);
      }
      // Sensible defaults, filled in for the user: 5-second chunks and one preview every
      // ten seconds of video (never more than 100), small and light images.
      setChunkSeconds('5');
      setPreviews(String(Math.min(100, Math.max(1, Math.ceil(probe.seconds / 10)))));
      setPreviewWidth('256');
      setPreviewQuality('0.5');
    } catch {
      // Not something the browser can open; the run will say so clearly.
    }
  };

  /** Piece uploads get one explicit retry. The finish runs the rest as a background job
   *  that is polled below — it retries itself once with a warning on a total failure. */
  const uploadVideo = async (
    mode: 'publish' | 'convert',
    source: Blob,
    name: string,
    totalSeconds: number,
    previewImages: string[],
    onProgress: (percent: number) => void,
    onProcessing?: (percent: number | null) => void
  ): Promise<{ cid: string; warnings?: string[] }> => {
    if (!provider) throw new Error('Add a provider first');
    const session = await api<{ jobId: string }>('/api/vvsh/session', {
      body: {
        mode,
        nodeId: provider.id,
        name,
        totalSeconds,
        config,
        sourceMime: source.type || 'video/mp4',
        previews: previewImages,
        encoder: mode === 'publish' ? 'ffmpeg' : undefined,
        meta: { title: title.trim() || name.replace(/\.vvsh$/i, ''), durationSeconds: totalSeconds, format: 'video' },
      },
    });
    const pieceSize = 2 * 1024 * 1024;
    for (let at = 0; at < source.size; at += pieceSize) {
      const slice = new Uint8Array(await source.slice(at, at + pieceSize).arrayBuffer());
      const path = `/api/vvsh/session/${session.jobId}/piece`;
      try {
        await api(path, { body: { data: base64url(slice), index: Math.floor(at / pieceSize) } });
      } catch (error) {
        toast(`Warning: uploading piece ${Math.floor(at / pieceSize) + 1} failed (${errorMessage(error)}). Retrying once.`, 'info');
        await new Promise((resolve) => setTimeout(resolve, 250));
        await api(path, { body: { data: base64url(slice), index: Math.floor(at / pieceSize) } });
      }
      onProgress(Math.min(99, Math.round(((at + slice.length) / source.size) * 100)));
    }
    // Finishing answers at once and the work runs as a job: poll it instead of holding
    // one request open for a large upload. Warnings of the job's automatic retry arrive
    // before the retry runs; a total failure arrives as the job's error.
    let state = await api<{ status: 'running' | 'done' | 'error'; warnings?: string[]; cid?: string; error?: string; progress?: number }>(
      `/api/vvsh/session/${session.jobId}/finish`,
      { body: {} }
    );
    const warned = new Set<string>();
    const showWarnings = () => {
      for (const warning of state.warnings ?? []) {
        if (warned.has(warning)) continue;
        warned.add(warning);
        toast(`Warning: ${warning}`, 'info');
      }
    };
    showWarnings();
    while (state.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      state = await api(`/api/vvsh/session/${session.jobId}`);
      onProcessing?.(state.progress ?? null);
      showWarnings();
    }
    onProcessing?.(null);
    if (state.status === 'error') throw new Error(state.error || 'The upload failed');
    return { cid: state.cid ?? '', warnings: state.warnings };
  };

  /** Publishes in stages — encode each quality, upload object by object, commit — and
   *  every finished step is recorded, so it can be picked back up after any interruption. */
  const run = async (existing?: VvshJob | null) => {
    if (!provider) return;
    try {
      setResult(null);
      const resuming = existing && existing.status !== 'done' ? existing : null;
      // After a reload the picker is empty — the video itself is kept in IndexedDB for
      // exactly this, so a resumed job does not need the file to be chosen again.
      const source: Blob | null = file ?? (resuming ? await getStoredFile(`${resuming.id}:source`) : null);
      if (!source) throw new Error('Pick the video file first');
      const probed = await probeVideo(source, previewSplits, previewWidthValue, previewQualityValue);
      const totalSeconds = probed.seconds || seconds;
      if (!(totalSeconds > 0)) throw new Error('Could not read a length from this video');
      if (!(chunkSecondsValue > 0)) throw new Error('Time per chunk must be 1 or more');
      if (rows.some((row) => !(row.width > 0) || !(row.height > 0))) throw new Error('Every encoding needs a width and a height');
      if (probed.seconds) setSeconds(Math.round(probed.seconds));
      const id = resuming?.id ?? newJobId();
      const fresh: VvshJob = {
        id,
        name: (title.trim() || (file?.name ?? resuming?.name ?? 'video').replace(/\.vvsh$/i, '').replace(/\.[^.]+$/, '') || 'video') + '.vvsh',
        totalSeconds,
        rows,
        chunkSeconds: chunkSecondsValue,
        previewSplits,
        sourceMime: 'video/webm',
        status: 'working',
        stage: 'Encoding',
        pct: 0,
        encoded: resuming?.encoded ?? [],
        uploaded: resuming?.uploaded ?? [],
        updatedAt: Date.now(),
      };
      jobRef.current = fresh;
      setJob(fresh);
      await saveJob(fresh);
      await putBlob(`${id}:source`, source);
      const encoder = await api<{ backend: 'ffmpeg' | 'mediarecorder'; warning?: string }>('/api/vvsh/encoder');
      if (encoder.backend === 'ffmpeg') {
        await persist({ stage: 'Uploading to the local FFmpeg encoder', pct: 0 });
        const published = await uploadVideo('publish', source, fresh.name, totalSeconds, probed.previews, (pct) => void persist({ pct }));
        await persist({ status: 'done', stage: 'Done (FFmpeg)', pct: 100, cid: published.cid });
        setResult(published.cid);
        toast('Published with FFmpeg', 'success');
        return;
      }
      if (encoder.warning) toast(`Warning: ${encoder.warning}`, 'info');
      // 1) Each quality is encoded once and kept — a resumed job does not redo them.
      // One WebM recording per chunk, so every chunk plays on its own (sparse playback).
      const webm: Record<string, Uint8Array[]> = {};
      for (const row of rows) {
        // The cache key carries the whole encode configuration: chunks recorded for a
        // different chunk length or size are never spliced into this timeline (that is
        // how a resumed job used to break playback — its old chunks sat in the wrong
        // time slots and the video played only the first seconds).
        const key = `${id}:enc3:${row.id}:${chunkSecondsValue}:${row.width}x${row.height}`;
        const done = await getBlob(key);
        if (done) {
          webm[row.id] = unpackSegments(done);
          continue;
        }
        await persist({ stage: `Encoding ${row.height}p ${row.fps}fps`, pct: 0 });
        const chunks = await transcodeSegments(source, row, config.chunkSeconds, (fraction) => void persist({ pct: Math.round(fraction * 99) }), totalSeconds);
        await putBlob(key, packSegments(chunks));
        webm[row.id] = chunks;
        await persist({ encoded: [...(jobRef.current?.encoded ?? []), row.id] });
      }
      // 2) Build and upload object by object; every hash is recorded, so a resume skips it.
      await persist({ stage: 'Uploading', pct: 0 });
      const estimate = Math.max(1, (plan?.chunkCount ?? 1) * (rows.length + 1) + 64);
      const meta = title.trim() ? { title: title.trim(), durationSeconds: totalSeconds, format: 'video' as const } : undefined;
      const { file: vvsh } = await buildVvsh(
        new Uint8Array(0),
        {
          totalSeconds,
          config,
          previews: probed.previews,
          previewWidth: previewWidthValue,
          previewQuality: previewQualityValue,
          sourceMime: 'video/webm',
          webm,
        },
        async (hash, data) => {
          if (jobRef.current?.uploaded.includes(hash)) return;
          await api('/api/vvsh/object', { method: 'PUT', body: { nodeId: provider.id, hash, data: base64url(data) } });
          const uploaded = [...(jobRef.current?.uploaded ?? []), hash];
          await persist({ uploaded, pct: Math.min(98, Math.round((uploaded.length / estimate) * 98)) });
        }
      );
      // 3) Commit the file (its metadata and root) and put it in front of the search nodes.
      await persist({ stage: 'Publishing', pct: 99 });
      const manifest: Manifest = {
        v: 1,
        name: fresh.name,
        mime: 'video/x-vvsh',
        size: 0,
        chunkSize: 1024 * 1024,
        chunks: [],
        createdAt: new Date().toISOString(),
        vvsh,
        meta,
      };
      const committed = await api<{ cid: string; listed: number }>('/api/vvsh/manifest', { body: { nodeId: provider.id, manifest } });
      await persist({ status: 'done', stage: 'Done', pct: 100, cid: committed.cid });
      setResult(committed.cid);
      toast('Published', 'success');
    } catch (e) {
      await persist({ status: 'error', stage: 'Stopped', error: errorMessage(e) });
      toast(errorMessage(e), 'error');
    }
  };

  /** Upload the source for provider-side conversion and polled completion. */
  const runPassthrough = async () => {
    if (!provider) return;
    if (rows.some((row) => !(row.width > 0) || !(row.height > 0))) {
      toast('Every encoding needs a width and a height', 'error');
      return;
    }
    try {
      setPassPct(0);
      setProcessPct(null);
      // After a reload the picker is empty — the video itself is kept in IndexedDB, so an
      // unfinished job's source is picked back up from there.
      const source: Blob | null = file ?? (job && job.status !== 'done' ? await getStoredFile(`${job.id}:source`) : null);
      if (!source) throw new Error('Pick the video file first');
      const probed = await probeVideo(source, previewSplits, previewWidthValue, previewQualityValue);
      const totalSeconds = probed.seconds || seconds;
      const name = (title.trim() || file?.name?.replace(/\.[^.]+$/, '') || job?.name?.replace(/\.vvsh$/i, '') || 'video') + '.vvsh';
      const answer = await uploadVideo('convert', source, name, totalSeconds, probed.previews, setPassPct, setProcessPct);
      setPassPct(100);
      setResult(answer.cid);
      toast('Stored on the provider', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setPassPct(null);
      setProcessPct(null);
    }
  };

  // A job still working when the page reopens continues on its own — the progress keeps
  // moving after a refresh instead of waiting for another button press.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || job?.status !== 'working' || !provider) return;
    autoStarted.current = true;
    void run(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, provider]);

  // The progress card is always on the page (below the buttons): whatever runs fills it
  // in where the user already is, instead of appearing somewhere they are not looking.
  const canResume = Boolean(job && job.status !== 'done');
  const progressPct = Math.max(
    0,
    Math.min(100, Math.round(processPct ?? passPct ?? (job && job.status !== 'done' ? job.pct : job?.status === 'done' ? 100 : 0)))
  );
  const progressTitle =
    processPct !== null
      ? 'Processing on the provider'
      : passPct !== null
        ? 'Uploading to the provider'
        : job && job.status !== 'done'
          ? job.stage
          : job?.status === 'done' || result
            ? 'Done'
            : 'Progress';
  const progressHint =
    processPct !== null
      ? `${processPct}% of the video processed`
      : passPct !== null
        ? `${passPct}%`
        : job && job.status !== 'done'
          ? `${job.pct}% · ${job.encoded.length}/${rows.length} encodings · ${job.uploaded.length} objects uploaded`
          : job?.status === 'done' || result
            ? 'Published'
            : 'Nothing running yet — encoding, uploading and provider processing all show right here.';

  return (
    <div className="card form-stack">
      <h3>Verifiable video stream (.vvsh)</h3>
      <span className="hint">
        The video becomes chunks of I/P/B frames under a merkle tree whose last layers hold one encoding per bitrate. The .vvsh file itself is
        just its metadata and the tree root — every branch and chunk is stored on its own, so seeking fetches only what it needs.
      </span>
      {!file ? (
        job && job.status !== 'done' ? (
          <div className="card row between">
            <div>
              <strong>{job.name}</strong>
              <div className="small muted">
                Unfinished job — the video itself is kept in this browser, so it survives a refresh. Resume below picks it back up.
              </div>
            </div>
            <button className="small" onClick={() => input.current?.click()}>
              Change
            </button>
          </div>
        ) : (
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const picked = e.dataTransfer.files[0];
            if (picked) void choose(picked);
          }}
        >
          <UploadCloud size={44} />
          <h2 style={{ margin: '12px 0 6px', color: 'var(--text)' }}>Drop a video or click to choose</h2>
          <p>Any video file — it is encoded to each quality below and published as a seekable stream.</p>
        </div>
        )
      ) : (
        <div className="card row between">
          <div>
            <strong>{file.name}</strong>
            <div className="small muted">
              {file.type || 'video'} · {(file.size / (1024 * 1024)).toFixed(1)} MB{seconds ? ` · ${formatClock(seconds)}` : ''}
            </div>
          </div>
          <button
            className="small"
            onClick={() => {
              setFile(null);
              setSeconds(0);
            }}
          >
            Change
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept="video/*,.mkv,.mov,.mp4,.m4v,.webm,.ogv,.avi,.wmv,.flv,.ts"
        onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])}
      />
      <div className="form-grid">
        <label className="field">
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? 'My video'} />
        </label>
        <div className="field">
          <span>Video length</span>
          <span className="mono" style={{ display: 'block', fontSize: '1.1em' }}>
            {seconds > 0 ? formatClock(seconds) : '—'}
          </span>
          <span className="hint" style={{ display: 'block' }}>
            Read from the video itself{source?.width ? ` · ${source.width}×${source.height}` : ''}
            {source?.fps ? ` · ${source.fps} fps` : ''}
          </span>
        </div>
      </div>
      <details className="field">
        <summary style={{ cursor: 'pointer' }}>Advanced settings — chunks and previews (filled in with sensible defaults)</summary>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="field">
            Time per chunk (seconds)
            <input
              type="number"
              min={0}
              value={chunkSeconds}
              placeholder="5"
              onChange={(e) => setChunkSeconds(e.target.value)}
            />
            <span className="hint">1 or more · chunks = length ÷ this · 5 by default</span>
          </label>
          <label className="field">
            Image previews
            <input
              type="number"
              min={0}
              value={previews}
              placeholder="100"
              onChange={(e) => setPreviews(e.target.value)}
            />
            <span className="hint">
              0 or more · 0 = no previews · one every 10 seconds of video, never more than 100 ·{' '}
              {previewWidthValue}px at quality {previewQualityValue} ≈{' '}
              {previewEstimateMb > 0.01 ? `${previewEstimateMb.toFixed(2)} MB` : '0 MB'} total
            </span>
          </label>
          <label className="field">
            Preview width (px)
            <select
              value={previewWidthCustom || !PREVIEW_WIDTHS.includes(Number(previewWidth)) ? 'custom' : previewWidth}
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'custom') setPreviewWidthCustom(true);
                else {
                  setPreviewWidthCustom(false);
                  setPreviewWidth(value);
                }
              }}
            >
              {PREVIEW_WIDTHS.map((width) => (
                <option key={width} value={width}>
                  {width}
                </option>
              ))}
              <option value="custom">Other…</option>
            </select>
            {(previewWidthCustom || !PREVIEW_WIDTHS.includes(Number(previewWidth))) && (
              <input
                type="number"
                min={80}
                max={1280}
                step={20}
                value={previewWidth}
                placeholder="256"
                onChange={(e) => setPreviewWidth(e.target.value)}
              />
            )}
            <span className="hint">80–1280 · 256 by default · recorded in the video's file</span>
          </label>
          <label className="field">
            Preview quality
            <input
              type="number"
              min={0.1}
              max={1}
              step={0.05}
              value={previewQuality}
              placeholder="0.5"
              onChange={(e) => setPreviewQuality(e.target.value)}
            />
            <span className="hint">0.1–1 · 0.5 by default · recorded in the video's file</span>
          </label>
        </div>
      </details>
      <div className="field">
        <span>Encodings — one row per quality: resolution and frame rate</span>
        {rows.map((row, index) => {
          const report = fitReport(source, row.width, row.height, row.fit);
          const change = row.fit === 'crop' ? report.cropPct : report.squishPct;
          const messages: string[] = [];
          if (!row.height || !row.width) messages.push('Width and height must not be empty.');
          if (overSource(row)) messages.push('This encoding is above what the video itself carries — the extra bytes add no detail.');
          if (report.tooSmall) {
            messages.push(`The content is too small (${source?.width}×${source?.height}) — it is scaled up, which adds no detail.`);
          }
          if (report.ratioWarning === 'wide') {
            messages.push(`The ratio is too wide for this video — ${change.toFixed(0)}% will be ${row.fit === 'crop' ? 'cropped from the top and bottom' : 'squished out of shape'}.`);
          }
          if (report.ratioWarning === 'tall') {
            messages.push(`The ratio is too tall for this video — ${change.toFixed(0)}% will be ${row.fit === 'crop' ? 'cropped from the sides' : 'squished out of shape'}.`);
          }
          if (report.note) messages.push(report.note);
          return (
          // Keyed by position only: editing a row re-derives its id (480p30 → 720p30),
          // and a changing key would remount the row — that is what stole the focus from
          // the field being typed and jolted the form.
          <div key={index} className="card form-stack">
            <div className="encode-grid">
              <label className="field">
                Height
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <select
                    value={row.customHeight || !RESOLUTIONS.includes(row.height) ? 'custom' : row.height}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === 'custom') updateRow(index, { customHeight: true });
                      else updateRow(index, { height: Number(value), width: HEIGHT_TO_WIDTH[Number(value)] ?? row.width, customHeight: false, customWidth: false });
                    }}
                    aria-label="Height"
                  >
                    {RESOLUTIONS.map((height) => (
                      <option key={height} value={height}>
                        {height}p
                      </option>
                    ))}
                    <option value="custom">Other…</option>
                  </select>
                  {(row.customHeight || !RESOLUTIONS.includes(row.height)) && (
                    <input
                      type="number"
                      min={1}
                      max={4320}
                      step={1}
                      aria-label="Custom height"
                      value={row.height ? String(row.height) : ''}
                      placeholder="Height"
                      style={{ width: 88 }}
                      onChange={(e) => updateRow(index, { height: e.target.value.trim() === '' ? 0 : Math.min(4320, Math.max(1, Math.round(Number(e.target.value) || 0))), customHeight: true })}
                    />
                  )}
                </div>
              </label>
              <label className="field">
                Width
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <select
                    value={row.customWidth || !WIDTHS.includes(row.width) ? 'custom' : row.width}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === 'custom') updateRow(index, { customWidth: true });
                      else updateRow(index, { width: Number(value), height: WIDTH_TO_HEIGHT[Number(value)] ?? row.height, customWidth: false, customHeight: false });
                    }}
                    aria-label="Width"
                  >
                    {WIDTHS.map((width) => (
                      <option key={width} value={width}>
                        {width}w
                      </option>
                    ))}
                    <option value="custom">Other…</option>
                  </select>
                  {(row.customWidth || !WIDTHS.includes(row.width)) && (
                    <input
                      type="number"
                      min={1}
                      max={7680}
                      step={1}
                      aria-label="Custom width"
                      value={row.width ? String(row.width) : ''}
                      placeholder="Width"
                      style={{ width: 88 }}
                      onChange={(e) => updateRow(index, { width: e.target.value.trim() === '' ? 0 : Math.min(7680, Math.max(1, Math.round(Number(e.target.value) || 0))), customWidth: true })}
                    />
                  )}
                </div>
              </label>
              <label className="field">
                Adjust to fill
                <select
                  value={row.fit}
                  onChange={(e) => updateRow(index, { fit: e.target.value as 'crop' | 'squish' })}
                  aria-label="Shape adjustment"
                >
                  <option value="crop">Crop to fill</option>
                  <option value="squish">Squish to fill</option>
                </select>
              </label>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="field" style={{ marginBottom: 0 }}>
                Frame rate
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <select
                    value={FRAME_RATES.includes(row.fps) ? row.fps : 'custom'}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === 'custom') updateRow(index, { customFps: true });
                      else updateRow(index, { fps: Number(value), customFps: false });
                    }}
                    aria-label="Frame rate"
                  >
                    {FRAME_RATES.map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} fps
                      </option>
                    ))}
                    <option value="custom">Other…</option>
                  </select>
                  {(row.customFps || !FRAME_RATES.includes(row.fps)) && (
                    <input
                      type="number"
                      min={1}
                      max={240}
                      step={1}
                      aria-label="Custom frame rate"
                      value={String(row.fps)}
                      style={{ width: 88 }}
                      onChange={(e) => updateRow(index, { fps: Math.min(240, Math.max(1, Math.round(Number(e.target.value) || 30))), customFps: true })}
                    />
                  )}
                </div>
              </label>
              <span className="hint" style={{ whiteSpace: 'nowrap' }}>
                ≈ {(estimateBytes(row, seconds) / (1024 * 1024)).toFixed(1)} MB
              </span>
              <button className="small" style={{ marginLeft: 'auto' }} onClick={() => setRows((current) => current.filter((_, i) => i !== index))} disabled={rows.length <= 1}>
                ×
              </button>
            </div>
          <div className="tiny" style={{ minHeight: 16, color: 'var(--warning, #b8860b)' }}>{messages.join(' ')}</div>
          </div>
          );
        })}
        <button
          className="small"
          onClick={() => setRows((current) => [...current, { id: rowId(720, 30), height: 720, width: 1280, fit: 'crop', fps: 30, kbps: defaultKbps(720, 30) }])}
        >
          + Add encoding
        </button>
        <span className="hint">Each row is really encoded to its resolution and frame rate, so the sizes and sharpness differ.</span>
        {/* Both banners sit in slots that are always the same height, so a warning coming
            or going never shifts the form or steals the focus from the field being typed. */}
        <span
          className="banner warning small"
          style={{ minHeight: 38, visibility: source && (source.height > 0 || source.fps > 0) && rows.some(overSource) ? 'visible' : 'hidden' }}
        >
          This video is {source?.height ?? ''}p{source?.fps ? ` at ${source.fps} fps` : ''} — encoding it higher than that adds bytes without adding
          detail. The marked rows are above the source.
        </span>
        <span className="banner warning small" style={{ minHeight: 38, visibility: duplicates.length > 0 ? 'visible' : 'hidden' }}>
          Two encodings are configured the same ({duplicates.join(', ')}) — one of them is redundant and only adds bytes.
        </span>
      </div>
      {plan && (
        <span className="hint">
          {plan.chunkCount} chunk{plan.chunkCount === 1 ? '' : 's'} × {bitrates.length} encoding{bitrates.length === 1 ? '' : 's'} · {plan.previewCount} preview
          {plan.previewCount === 1 ? '' : 's'}
        </span>
      )}
      <div className="row">
        <button className="primary small" disabled={(!file && !canResume) || !provider || !rows.length || job?.status === 'working'} onClick={() => void run(job)}>
          {job && job.status !== 'done' ? 'Resume publishing' : 'Process & publish'}
        </button>
        <button className="small" disabled={(!file && !canResume) || !provider || !rows.length || job?.status === 'working'} onClick={() => void runPassthrough()}>
          Convert on the provider
        </button>
        {job && job.status !== 'done' && (
          <button
            className="small"
            onClick={() => {
              void clearJob().then(() => {
                jobRef.current = null;
                setJob(null);
              });
            }}
          >
            Discard the unfinished job
          </button>
        )}
      </div>
      {/* Always in place: pressing a button fills this card in, so the progress is never
          somewhere else on the page than where the user is looking. */}
      <div className="card form-stack">
        <div className="row between">
          <strong>{progressTitle}</strong>
          <span className="hint">{progressHint}</span>
        </div>
        <div className="progress">
          <div style={{ width: `${progressPct}%` }} />
        </div>
        {job && job.status !== 'done' && job.error && <div className="banner danger small">{job.error}</div>}
        {job && job.status !== 'done' && (
          <span className="hint">Kept in this browser (IndexedDB) — closing or refreshing the page keeps the work; press resume to continue.</span>
        )}
        {result && (
          <span className="hint">
            Content id: <code>{result}</code>
          </span>
        )}
      </div>
      {!provider && <span className="hint">Add a content provider node first.</span>}
    </div>
  );
}