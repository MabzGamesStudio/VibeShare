import { CheckCircle2, Circle, CircleAlert, ImagePlus, Link2, Loader2, Upload, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Job, NodeEntry } from '../../../src/shared/clientapi';
import type { AlgorithmInfo, ProviderInfo } from '../../../src/shared/protocol';
import type { Embed, ExternalSource } from '../../../src/shared/sources';
import {
  CREATOR_KIND_LABELS,
  CREATOR_KINDS,
  FORMAT_LABELS,
  FORMATS,
  guessFormat,
  RATING_LABELS,
  RATINGS,
  TOPICS,
  type CreatorKind,
  type Format,
  type Rating,
} from '../../../src/shared/taxonomy';
import { api, errorMessage, uploadFile } from '../api';
import { Chips, Spinner, Switch, toggle } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, formatDuration, splitList, watchPath } from '../util';

const MAX_THUMB = 190 * 1024;

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length * 0.75 < MAX_THUMB) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.3);
}

function drawScaled(source: CanvasImageSource, width: number, height: number): string {
  const scale = Math.min(1, 640 / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToDataUrl(canvas);
}

async function imageThumbnail(file: File): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    return drawScaled(bitmap, bitmap.width, bitmap.height);
  } catch {
    return undefined;
  }
}

/** Reads the duration of audio/video, and grabs a frame of video as the thumbnail. */
function inspectMedia(file: File): Promise<{ duration?: number; thumbnail?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = file.type.startsWith('video/');
    const element = document.createElement(video ? 'video' : 'audio');
    element.preload = 'metadata';
    element.muted = true;
    const done = (result: { duration?: number; thumbnail?: string }) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => done({}), 8000);
    element.onerror = () => {
      clearTimeout(timer);
      done({});
    };
    element.onloadedmetadata = () => {
      const duration = Number.isFinite(element.duration) ? element.duration : undefined;
      if (!video) {
        clearTimeout(timer);
        done({ duration });
        return;
      }
      const v = element as HTMLVideoElement;
      v.onseeked = () => {
        clearTimeout(timer);
        try {
          done({ duration, thumbnail: drawScaled(v, v.videoWidth, v.videoHeight) });
        } catch {
          done({ duration });
        }
      };
      v.currentTime = Math.min(2, (duration ?? 2) / 3);
    };
    element.src = url;
  });
}

function JobView({ job }: { job: Job }) {
  return (
    <div className="card">
      <div className="row between">
        <h3>{job.title}</h3>
        <span className={`badge ${job.status === 'done' ? 'ok' : job.status === 'error' ? 'danger' : 'accent'}`}>{job.status}</span>
      </div>
      <div className="progress" style={{ margin: '14px 0' }}>
        <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>
      {job.steps.map((step, i) => (
        <div key={i} className="step">
          {step.status === 'done' ? (
            <CheckCircle2 size={16} color="var(--ok)" />
          ) : step.status === 'error' ? (
            <CircleAlert size={16} color="var(--danger)" />
          ) : step.status === 'running' ? (
            <Loader2 size={16} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
          ) : (
            <Circle size={16} color="var(--text-faint)" />
          )}
          <span>{step.label}</span>
          {step.detail && <span className="detail">{step.detail}</span>}
        </div>
      ))}
      {job.error && <div className="banner danger small" style={{ marginTop: 10 }}>{job.error}</div>}
      {job.result && (
        <div className="row" style={{ marginTop: 12 }}>
          <Link className="button primary" to={watchPath(job.result.id)}>
            Open it
          </Link>
          <code className="tiny faint">{job.result.id}</code>
        </div>
      )}
    </div>
  );
}

function useJob(): [Job | null, (id: string) => void] {
  const [job, setJob] = useState<Job | null>(null);
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const current = await api<Job>(`/api/jobs/${id}`);
        if (stop) return;
        setJob(current);
        if (current.status === 'running') setTimeout(tick, 600);
      } catch {
        if (!stop) setTimeout(tick, 1500);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id]);
  return [job, setId];
}

interface MetaState {
  title: string;
  description: string;
  format: Format;
  rating: Rating;
  topics: string[];
  tags: string;
  language: string;
}

function MetaFields({ meta, setMeta }: { meta: MetaState; setMeta: (meta: MetaState) => void }) {
  return (
    <>
      <label className="field">
        Title
        <input type="text" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} maxLength={300} />
      </label>
      <label className="field">
        Description
        <textarea value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} rows={4} />
      </label>
      <div className="form-grid">
        <label className="field">
          Format
          <select value={meta.format} onChange={(e) => setMeta({ ...meta, format: e.target.value as Format })}>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Age rating
          <select value={meta.rating} onChange={(e) => setMeta({ ...meta, rating: e.target.value as Rating })}>
            {RATINGS.map((r) => (
              <option key={r} value={r}>
                {RATING_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Language
          <input type="text" value={meta.language} onChange={(e) => setMeta({ ...meta, language: e.target.value })} placeholder="en" />
        </label>
      </div>
      <div className="field">
        <span>Topics</span>
        <Chips options={TOPICS} selected={meta.topics} onToggle={(t) => setMeta({ ...meta, topics: toggle(meta.topics, t) })} />
      </div>
      <label className="field">
        Tags <span className="hint">Comma separated</span>
        <input type="text" value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} placeholder="tutorial, guitar, beginner" />
      </label>
    </>
  );
}

function NodePicker({
  nodes,
  selected,
  setSelected,
  describe,
}: {
  nodes: NodeEntry[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  describe: (node: NodeEntry) => string;
}) {
  if (!nodes.length) return <p className="small muted">None enabled. <Link className="link" to="/nodes">Add nodes</Link></p>;
  return (
    <div className="check-list">
      {nodes.map((node) => (
        <label key={node.id} className="check-item">
          <input type="checkbox" checked={selected.includes(node.id)} onChange={() => setSelected(toggle(selected, node.id))} />
          <div>
            <div style={{ fontWeight: 600 }}>{node.name}</div>
            <div className="tiny faint">{describe(node)}</div>
          </div>
        </label>
      ))}
    </div>
  );
}

const emptyMeta = (): MetaState => ({ title: '', description: '', format: 'video', rating: 'all', topics: [], tags: '', language: '' });

function describeProvider(node: NodeEntry): string {
  const info = node.info as ProviderInfo | undefined;
  if (!info) return node.url;
  const upload = info.pricing.upload;
  if (upload.mode === 'closed') return 'Does not accept uploads';
  return `${upload.mode === 'paid' ? `${upload.perMiB} credits/MiB` : 'Free uploads'} · up to ${formatBytes(upload.maxBytes)} · balance ${node.balance ?? '?'}`;
}

function describeAlgorithm(node: NodeEntry): string {
  const info = node.info as AlgorithmInfo | undefined;
  if (!info) return node.url;
  return `${info.pricing.submission ? `${info.pricing.submission} credits per submission` : 'Free submissions'} · reviewed by the operator`;
}

function FileTab() {
  const { state, providers, algorithms, updateSettings, toast } = useApp();
  const enabledProviders = providers.filter((n) => n.enabled && (n.info as ProviderInfo | undefined)?.pricing.upload.mode !== 'closed');
  const enabledAlgorithms = algorithms.filter((n) => n.enabled);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [meta, setMeta] = useState<MetaState>(emptyMeta);
  const [duration, setDuration] = useState<number | undefined>();
  const [thumbnail, setThumbnail] = useState<string | undefined>();
  const [sources, setSources] = useState('');
  const [chosenProviders, setChosenProviders] = useState<string[]>([]);
  const [chosenAlgorithms, setChosenAlgorithms] = useState<string[]>([]);
  const [sign, setSign] = useState(true);
  const [uploading, setUploading] = useState<number | null>(null);
  const [job, watchJob] = useJob();
  const input = useRef<HTMLInputElement>(null);
  const thumbInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!chosenProviders.length && enabledProviders.length) setChosenProviders([enabledProviders[0].id]);
    if (!chosenAlgorithms.length && enabledAlgorithms.length) setChosenAlgorithms(enabledAlgorithms.map((n) => n.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length, algorithms.length]);

  const choose = async (picked: File) => {
    setFile(picked);
    setThumbnail(undefined);
    setDuration(undefined);
    const mime = picked.type || 'application/octet-stream';
    setMeta((m) => ({ ...m, title: m.title || picked.name.replace(/\.[^.]+$/, ''), format: guessFormat(mime) }));
    if (mime.startsWith('image/')) setThumbnail(await imageThumbnail(picked));
    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      const info = await inspectMedia(picked);
      setDuration(info.duration);
      if (info.thumbnail) setThumbnail(info.thumbnail);
      setMeta((m) => ({ ...m, format: guessFormat(mime, info.duration) }));
    }
  };

  const publish = async () => {
    if (!file) return;
    try {
      setUploading(0);
      const { fileId } = await uploadFile(file, setUploading);
      setUploading(null);
      const created = await api<Job>('/api/publish', {
        body: {
          fileId,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          title: meta.title,
          description: meta.description,
          format: meta.format,
          rating: meta.rating,
          topics: meta.topics,
          tags: splitList(meta.tags),
          language: meta.language || undefined,
          durationSeconds: duration,
          sources: splitList(sources),
          providers: chosenProviders,
          algorithms: chosenAlgorithms,
          thumbnail,
          sign,
        },
      });
      watchJob(created.id);
    } catch (error) {
      setUploading(null);
      toast(errorMessage(error), 'error');
    }
  };

  if (!state) return null;
  if (job) {
    return (
      <div className="form-stack">
        <JobView job={job} />
        {job.status !== 'running' && (
          <button onClick={() => window.location.reload()} style={{ alignSelf: 'flex-start' }}>
            Publish something else
          </button>
        )}
      </div>
    );
  }

  const profile = state.settings.profile;
  return (
    <div className="publish-layout">
      <div className="form-stack">
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
            <h2 style={{ margin: '12px 0 6px', color: 'var(--text)' }}>Drop a file or click to choose</h2>
            <p>Video, music, podcasts, images, articles, games — any file. It is split into chunks and uploaded to the providers you pick.</p>
          </div>
        ) : (
          <div className="card row between">
            <div>
              <strong>{file.name}</strong>
              <div className="small muted">
                {file.type || 'unknown type'} · {formatBytes(file.size)}
                {duration ? ` · ${formatDuration(duration)}` : ''}
              </div>
            </div>
            <button className="small" onClick={() => (setFile(null), setMeta(emptyMeta()))}>
              Change
            </button>
          </div>
        )}
        <input ref={input} type="file" hidden onChange={(e) => e.target.files?.[0] && choose(e.target.files[0])} />
        <MetaFields meta={meta} setMeta={setMeta} />
        <label className="field">
          Fallback links <span className="hint">Copies elsewhere (YouTube, archive.org, IPFS…), shown when no provider has the file. One per line.</span>
          <textarea value={sources} onChange={(e) => setSources(e.target.value)} rows={2} placeholder="https://www.youtube.com/watch?v=…" />
        </label>
      </div>
      <div className="form-stack">
        <div className="field">
          <span>Thumbnail</span>
          <div className="preview-thumb" onClick={() => thumbInput.current?.click()} style={{ cursor: 'pointer' }}>
            {thumbnail ? <img src={thumbnail} alt="" /> : <ImagePlus size={32} className="faint" />}
          </div>
          <input
            ref={thumbInput}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const picked = e.target.files?.[0];
              if (picked) setThumbnail(await imageThumbnail(picked));
            }}
          />
        </div>
        <div className="field">
          <span>Upload to providers</span>
          <NodePicker nodes={enabledProviders} selected={chosenProviders} setSelected={setChosenProviders} describe={describeProvider} />
        </div>
        <div className="field">
          <span>Submit to algorithm nodes</span>
          <NodePicker nodes={enabledAlgorithms} selected={chosenAlgorithms} setSelected={setChosenAlgorithms} describe={describeAlgorithm} />
        </div>
        <div className="card form-stack" style={{ padding: 16 }}>
          <Switch checked={sign} onChange={setSign} label="Sign as the creator" />
          {sign ? (
            <>
              <p className="tiny faint">Your public key proves you made it, so people can subscribe to you.</p>
              <div className="row">
                <input
                  type="text"
                  defaultValue={profile.name}
                  placeholder="Creator name"
                  onBlur={(e) => e.target.value !== profile.name && void updateSettings({ profile: { ...profile, name: e.target.value } })}
                  style={{ flex: 1 }}
                />
                <select
                  value={profile.kind}
                  onChange={(e) => void updateSettings({ profile: { ...profile, kind: e.target.value as CreatorKind } })}
                  style={{ width: 'auto' }}
                >
                  {CREATOR_KINDS.filter((k) => k !== 'unknown').map((k) => (
                    <option key={k} value={k}>
                      {CREATOR_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <p className="tiny faint">Published without a creator identity.</p>
          )}
        </div>
        {uploading !== null && (
          <div>
            <div className="small muted">Sending to your client… {Math.round(uploading * 100)}%</div>
            <div className="progress">
              <div style={{ width: `${uploading * 100}%` }} />
            </div>
          </div>
        )}
        <button className="primary" onClick={publish} disabled={!file || !meta.title.trim() || !chosenProviders.length || uploading !== null}>
          {uploading !== null ? <Spinner /> : <Upload size={16} />} Publish
        </button>
      </div>
    </div>
  );
}

function LinkTab() {
  const { algorithms, toast } = useApp();
  const enabledAlgorithms = algorithms.filter((n) => n.enabled);
  const [url, setUrl] = useState('');
  const [detected, setDetected] = useState<{ id: string; source: ExternalSource; embed: Embed } | null>(null);
  const [meta, setMeta] = useState<MetaState>(emptyMeta);
  const [chosen, setChosen] = useState<string[]>(() => enabledAlgorithms.map((n) => n.id));
  const [job, watchJob] = useJob();

  useEffect(() => {
    if (!url.trim()) {
      setDetected(null);
      return;
    }
    const timer = setTimeout(() => {
      api<{ id: string; source: ExternalSource; embed: Embed }>(`/api/source?url=${encodeURIComponent(url.trim())}`)
        .then(setDetected)
        .catch(() => setDetected(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [url]);

  const publish = async () => {
    try {
      const created = await api<Job>('/api/publish/external', {
        body: {
          url,
          title: meta.title,
          description: meta.description,
          format: meta.format,
          rating: meta.rating,
          topics: meta.topics,
          tags: splitList(meta.tags),
          language: meta.language || undefined,
          algorithms: chosen,
        },
      });
      watchJob(created.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  if (job) return <JobView job={job} />;
  return (
    <div className="publish-layout">
      <div className="form-stack">
        <label className="field">
          Link
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=… · https://archive.org/details/… · ipfs://…" />
          <span className="hint">
            The content stays where it is; algorithm nodes list it and clients embed it. {detected && <>Content id: <code>{detected.id}</code></>}
          </span>
        </label>
        <MetaFields meta={meta} setMeta={setMeta} />
      </div>
      <div className="form-stack">
        <div className="preview-thumb">
          {detected?.embed.kind === 'iframe' ? (
            <iframe src={detected.embed.src} title="Preview" style={{ width: '100%', height: '100%', border: 0 }} sandbox="allow-scripts allow-same-origin" />
          ) : detected?.embed.kind === 'image' ? (
            <img src={detected.embed.src} alt="" />
          ) : (
            <Link2 size={32} className="faint" />
          )}
        </div>
        <div className="field">
          <span>Submit to algorithm nodes</span>
          <NodePicker nodes={enabledAlgorithms} selected={chosen} setSelected={setChosen} describe={describeAlgorithm} />
        </div>
        <button className="primary" onClick={publish} disabled={!detected || !meta.title.trim() || !chosen.length}>
          <Upload size={16} /> Submit
        </button>
      </div>
    </div>
  );
}

export function PublishPage() {
  const [tab, setTab] = useState<'file' | 'link'>('file');
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    api<{ jobs: Job[] }>('/api/jobs').then((r) => setJobs(r.jobs)).catch(() => undefined);
  }, [tab]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Publish</h1>
          <p>Upload to content providers and submit to algorithm nodes — or list something that already lives elsewhere.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'file' ? 'on' : ''}`} onClick={() => setTab('file')}>
          <Upload size={15} /> Upload a file
        </button>
        <button className={`tab ${tab === 'link' ? 'on' : ''}`} onClick={() => setTab('link')}>
          <Link2 size={15} /> Share a link
        </button>
      </div>
      {tab === 'file' ? <FileTab /> : <LinkTab />}
      {jobs.length > 0 && (
        <div className="section">
          <h2>Recent</h2>
          {jobs.slice(0, 5).map((job) => (
            <JobView key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}
