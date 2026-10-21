// Building a .vvsh verifiable video stream from a video the user picks: the metadata
// configuration lives here — which bitrate encodings to store, how long each chunk is
// (the total number of chunks follows), and how many image previews the video splits
// into. The stream can be calculated here and published, or the provider can calculate
// it from just the video (it names its price from the metadata, length and encodings).
import { useMemo, useState } from 'react';
import type { VvshRendition } from '../../../src/shared/vvsh.js';
import { vvshPlan } from '../../../src/shared/vvsh-encode.js';
import { base64url } from '../../../src/shared/encoding.js';
import { api, errorMessage } from '../api';
import { useApp } from '../state';

/** Opens the picked video once to read its length and capture real preview thumbnails. */
async function probeVideo(file: File, splits: number): Promise<{ seconds: number; previews: string[] }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('This file did not open as a video'));
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

const CHOICES: VvshRendition[] = [
  { id: '2160p', label: '4K (2160p)', height: 2160, kbps: 20_000 },
  { id: '1080p', label: '1080p', height: 1080, kbps: 5_000 },
  { id: '720p', label: '720p', height: 720, kbps: 2_500 },
  { id: '480p', label: '480p', height: 480, kbps: 1_000 },
];

export function VvshCompose() {
  const { state, toast } = useApp();
  const provider = state?.nodes.find((node) => node.type === 'provider' && node.enabled);
  const [file, setFile] = useState<File | null>(null);
  const [seconds, setSeconds] = useState(60);
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>(['1080p', '720p']);
  const [chunkSeconds, setChunkSeconds] = useState(10);
  const [previews, setPreviews] = useState(6);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const bitrates = useMemo(() => CHOICES.filter((choice) => picked.includes(choice.id)), [picked]);
  const plan = useMemo(
    () => (seconds > 0 && chunkSeconds > 0 && bitrates.length ? vvshPlan(seconds, { bitrates, chunkSeconds, previewSplits: previews }) : null),
    [bitrates, chunkSeconds, previews, seconds]
  );
  const config = { bitrates, chunkSeconds, previewSplits: previews };

  const quote = async () => {
    if (!provider || !file) return;
    setBusy(true);
    try {
      const answer = await api<{ quote: { credits: number; breakdown: Record<string, number> } }>('/api/vvsh/quote', {
        body: { nodeId: provider.id, bytes: file.size, totalSeconds: seconds, config },
      });
      toast(`${answer.quote.credits} credits — ${JSON.stringify(answer.quote.breakdown)}`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const run = async (where: 'here' | 'provider') => {
    if (!provider || !file) return;
    setBusy(true);
    setResult(null);
    try {
      // Real preview thumbnails and the true length come straight from the video; the
      // bytes go up in pieces so a long video never overflows anything along the way.
      const { seconds: probed, previews: thumbnails } = await probeVideo(file, previews);
      const totalSeconds = probed || seconds;
      if (probed) setSeconds(Math.round(probed));
      const name = (title.trim() || file.name.replace(/\.[^.]+$/, '') || 'video') + '.vvsh';
      const meta = title.trim() ? { title: title.trim(), durationSeconds: totalSeconds, format: 'video' as const } : undefined;
      const session = await api<{ jobId: string }>('/api/vvsh/session', {
        body: {
          mode: where === 'here' ? 'publish' : 'convert',
          nodeId: provider.id,
          name,
          totalSeconds,
          config,
          meta,
          sourceMime: file.type || 'video/mp4',
          previews: thumbnails,
        },
      });
      const pieceSize = 2 * 1024 * 1024;
      for (let at = 0; at < file.size; at += pieceSize) {
        const slice = new Uint8Array(await file.slice(at, at + pieceSize).arrayBuffer());
        await api(`/api/vvsh/session/${session.jobId}/piece`, { body: { data: base64url(slice) } });
      }
      const answer = await api<{ cid: string }>(`/api/vvsh/session/${session.jobId}/finish`, { body: {} });
      setResult(answer.cid);
      toast('Published — open it from the feed or paste its id in Watch', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <h3>Verifiable video stream (.vvsh)</h3>
      <span className="hint">
        The video becomes chunks of I/P/B frames under a merkle tree whose last layers hold one encoding per bitrate. The .vvsh file itself is
        just its metadata and the tree root — every branch and chunk is stored on its own, so seeking fetches only what it needs.
      </span>
      <label className="field">
        Video file
        <input
          type="file"
          accept="video/*,audio/*,.mkv,.mov,.mp4,.m4v,.webm,.ogv,.avi,.wmv,.flv,.ts"
          onChange={async (e) => {
            const picked = e.target.files?.[0] ?? null;
            setFile(picked);
            if (picked) {
              // The length comes from the video itself — no typing needed.
              try {
                const probe = await probeVideo(picked, 0);
                if (probe.seconds > 0) setSeconds(Math.round(probe.seconds));
              } catch {
                // Not something the browser can open; the run will say so clearly.
              }
            }
          }}
        />
      </label>
      <div className="form-grid">
        <label className="field">
          Length (seconds)
          <input type="number" min={0} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
          <span className="hint">Filled in from the video · 1 or more</span>
        </label>
        <label className="field">
          Time per chunk (seconds)
          <input type="number" min={0} value={chunkSeconds} onChange={(e) => setChunkSeconds(Number(e.target.value))} />
          <span className="hint">1 or more · chunks = length ÷ this</span>
        </label>
        <label className="field">
          Image previews
          <input type="number" min={0} value={previews} onChange={(e) => setPreviews(Number(e.target.value))} />
          <span className="hint">0 or more · 0 = no preview strip</span>
        </label>
        <label className="field">
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? 'My video'} />
        </label>
      </div>
      <div className="field">
        <span>Bitrate encodings (every chunk is stored at each)</span>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {CHOICES.map((choice) => (
            <label key={choice.id} className="row small" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={picked.includes(choice.id)}
                onChange={(e) => setPicked((list) => (e.target.checked ? [...list, choice.id] : list.filter((id) => id !== choice.id)))}
              />
              {choice.label}
            </label>
          ))}
        </div>
      </div>
      {plan && (
        <span className="hint">
          {plan.chunkCount} chunk{plan.chunkCount === 1 ? '' : 's'} × {bitrates.length} encoding{bitrates.length === 1 ? '' : 's'} · {plan.previewCount} preview
          {plan.previewCount === 1 ? '' : 's'}
        </span>
      )}
      <div className="row">
        <button className="small" disabled={busy || !file || !provider} onClick={() => void quote()}>
          Ask the provider’s price
        </button>
        <button className="primary small" disabled={busy || !file || !provider || !bitrates.length} onClick={() => void run('provider')}>
          Convert on the provider
        </button>
        <button className="small" disabled={busy || !file || !provider || !bitrates.length} onClick={() => void run('here')}>
          Calculate here and publish
        </button>
      </div>
      {!provider && <span className="hint">Add a content provider node first.</span>}
      {result && (
        <span className="hint">
          Content id: <code>{result}</code>
        </span>
      )}
    </div>
  );
}