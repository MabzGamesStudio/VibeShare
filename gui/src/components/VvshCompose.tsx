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
import { defaultKbps, estimateBytes, FRAME_RATES, RESOLUTIONS, rowId, transcode, type EncodeRow } from '../media/transcode';
import { clearJob, getBlob, getStoredFile, loadJob, newJobId, putBlob, saveJob, type VvshJob } from '../media/vvshjobs';

/** Opens the picked video once to read its length and capture real preview thumbnails. */
async function probeVideo(file: Blob, splits: number): Promise<{ seconds: number; previews: string[] }> {
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
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = Math.max(90, Math.round(((video.videoHeight || 180) / (video.videoWidth || 320)) * 320));
    const previews: string[] = [];
    for (let index = 0; index < Math.max(0, splits); index++) {
      const at = ((index + 0.5) * seconds) / splits;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(at, Math.max(0, (video.duration || seconds) - 0.05));
      });
      video.onseeked = null;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      previews.push(canvas.toDataURL('image/jpeg', 0.72));
    }
    return { seconds, previews };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const DEFAULT_ROWS: EncodeRow[] = [
  { id: rowId(1080, 30), height: 1080, fps: 30, kbps: defaultKbps(1080, 30) },
  { id: rowId(480, 30), height: 480, fps: 30, kbps: defaultKbps(480, 30) },
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
  const [chunkSeconds, setChunkSeconds] = useState('10');
  const [previews, setPreviews] = useState('6');
  const [job, setJob] = useState<VvshJob | null>(null);
  const jobRef = useRef<VvshJob | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // A job left over from an earlier visit (the page closed mid-publish) is picked up here.
  useEffect(() => {
    void loadJob().then((saved) => {
      if (saved && saved.status !== 'done') {
        jobRef.current = saved;
        setJob(saved);
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
  const bitrates: VvshRendition[] = rows.map((row) => ({
    id: row.id,
    label: `${row.height}p${row.fps}`,
    height: row.height,
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
      // The length comes from the video itself — no typing needed.
      const probe = await probeVideo(picked, 0);
      if (probe.seconds > 0) setSeconds(Math.round(probe.seconds));
    } catch {
      // Not something the browser can open; the run will say so clearly.
    }
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
      const probed = await probeVideo(source, previewSplits);
      const totalSeconds = probed.seconds || seconds;
      if (!(totalSeconds > 0)) throw new Error('Could not read a length from this video');
      if (!(chunkSecondsValue > 0)) throw new Error('Time per chunk must be 1 or more');
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
      // 1) Each quality is encoded once and kept — a resumed job does not redo them.
      const streams: Record<string, Uint8Array> = {};
      for (const row of rows) {
        const key = `${id}:enc:${row.id}`;
        const done = await getBlob(key);
        if (done) {
          streams[row.id] = done;
          continue;
        }
        await persist({ stage: `Encoding ${row.height}p ${row.fps}fps`, pct: 0 });
        const bytes = await transcode(source, row, (fraction) => void persist({ pct: Math.round(fraction * 99) }));
        await putBlob(key, bytes);
        streams[row.id] = bytes;
        await persist({ encoded: [...(jobRef.current?.encoded ?? []), row.id] });
      }
      // 2) Build and upload object by object; every hash is recorded, so a resume skips it.
      await persist({ stage: 'Uploading', pct: 0 });
      const estimate = Math.max(1, (plan?.chunkCount ?? 1) * (rows.length + 1) + 64);
      const meta = title.trim() ? { title: title.trim(), durationSeconds: totalSeconds, format: 'video' as const } : undefined;
      const { file: vvsh } = await buildVvsh(
        new Uint8Array(await source.arrayBuffer()),
        { totalSeconds, config, previews: probed.previews, sourceMime: 'video/webm', streams },
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

  /** Quick passthrough: let the provider store the source as-is at every level. */
  const runPassthrough = async () => {
    if (!provider || !file) return;
    try {
      const probed = await probeVideo(file, previewSplits);
      const totalSeconds = probed.seconds || seconds;
      const name = (title.trim() || file.name.replace(/\.[^.]+$/, '') || 'video') + '.vvsh';
      const session = await api<{ jobId: string }>('/api/vvsh/session', {
        body: {
          mode: 'convert',
          nodeId: provider.id,
          name,
          totalSeconds,
          config,
          sourceMime: file.type || 'video/mp4',
          previews: probed.previews,
        },
      });
      for (let at = 0; at < file.size; at += 2 * 1024 * 1024) {
        const slice = new Uint8Array(await file.slice(at, at + 2 * 1024 * 1024).arrayBuffer());
        await api(`/api/vvsh/session/${session.jobId}/piece`, { body: { data: base64url(slice) } });
      }
      const answer = await api<{ cid: string }>(`/api/vvsh/session/${session.jobId}/finish`, { body: {} });
      setResult(answer.cid);
      toast('Stored on the provider', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="card form-stack">
      <h3>Verifiable video stream (.vvsh)</h3>
      <span className="hint">
        The video becomes chunks of I/P/B frames under a merkle tree whose last layers hold one encoding per bitrate. The .vvsh file itself is
        just its metadata and the tree root — every branch and chunk is stored on its own, so seeking fetches only what it needs.
      </span>
      {!file ? (
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
      ) : (
        <div className="card row between">
          <div>
            <strong>{file.name}</strong>
            <div className="small muted">
              {file.type || 'video'} · {(file.size / (1024 * 1024)).toFixed(1)} MB{seconds ? ` · ${Math.round(seconds)}s` : ''}
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
        <div className="field">
          <span>Length (seconds)</span>
          <span className="mono" style={{ display: 'block' }}>
            {seconds > 0 ? `${seconds} s` : '—'}
          </span>
          <span className="hint" style={{ display: 'block' }}>
            Read from the video itself · 1 or more
          </span>
        </div>
        <label className="field">
          Time per chunk (seconds)
          <input
            type="number"
            min={0}
            value={chunkSeconds}
            placeholder="10"
            onChange={(e) => setChunkSeconds(e.target.value)}
          />
          <span className="hint">1 or more · chunks = length ÷ this</span>
        </label>
        <label className="field">
          Image previews
          <input
            type="number"
            min={0}
            value={previews}
            placeholder="6"
            onChange={(e) => setPreviews(e.target.value)}
          />
          <span className="hint">0 or more · 0 = no previews</span>
        </label>
        <label className="field">
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? 'My video'} />
        </label>
      </div>
      <div className="field">
        <span>Encodings — one row per quality: resolution and frame rate</span>
        {rows.map((row, index) => (
          <div className="row" key={`${index}-${row.id}`} style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'center' }}>
            <select value={row.height} onChange={(e) => updateRow(index, { height: Number(e.target.value) })} aria-label="Resolution">
              {RESOLUTIONS.map((height) => (
                <option key={height} value={height}>
                  {height}p
                </option>
              ))}
            </select>
            <select value={row.fps} onChange={(e) => updateRow(index, { fps: Number(e.target.value) })} aria-label="Frame rate">
              {FRAME_RATES.map((fps) => (
                <option key={fps} value={fps}>
                  {fps} fps
                </option>
              ))}
            </select>
            <span className="hint" style={{ minWidth: 96, whiteSpace: 'nowrap' }}>
              ≈ {(estimateBytes(row, seconds) / (1024 * 1024)).toFixed(1)} MB
            </span>
            <button className="small" onClick={() => setRows((current) => current.filter((_, i) => i !== index))} disabled={rows.length <= 1}>
              ×
            </button>
          </div>
        ))}
        <button
          className="small"
          onClick={() => setRows((current) => [...current, { id: rowId(720, 30), height: 720, fps: 30, kbps: defaultKbps(720, 30) }])}
        >
          + Add encoding
        </button>
        <span className="hint">Each row is really encoded to its resolution and frame rate, so the sizes and sharpness differ.</span>
      </div>
      {plan && (
        <span className="hint">
          {plan.chunkCount} chunk{plan.chunkCount === 1 ? '' : 's'} × {bitrates.length} encoding{bitrates.length === 1 ? '' : 's'} · {plan.previewCount} preview
          {plan.previewCount === 1 ? '' : 's'}
        </span>
      )}
      <div className="row">
        <button className="primary small" disabled={!file || !provider || !rows.length || job?.status === 'working'} onClick={() => void run(job)}>
          {job && job.status !== 'done' ? 'Resume publishing' : 'Process & publish'}
        </button>
        <button className="small" disabled={!file || !provider || !rows.length || job?.status === 'working'} onClick={() => void runPassthrough()}>
          Convert on the provider (source quality)
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
      {job && job.status !== 'done' && (
        <div className="card form-stack">
          <div className="row between">
            <strong>{job.stage}</strong>
            <span className="hint">
              {job.pct}% · {job.encoded.length}/{rows.length} encodings · {job.uploaded.length} objects uploaded
            </span>
          </div>
          <div style={{ height: 6, background: 'rgba(0,0,0,0.12)', borderRadius: 3 }}>
            <div style={{ width: `${job.pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          {job.error && <div className="banner danger small">{job.error}</div>}
          <span className="hint">Kept in this browser (IndexedDB) — closing or refreshing the page keeps the work; press resume to continue.</span>
        </div>
      )}
      {!provider && <span className="hint">Add a content provider node first.</span>}
      {result && (
        <span className="hint">
          Content id: <code>{result}</code>
        </span>
      )}
    </div>
  );
}