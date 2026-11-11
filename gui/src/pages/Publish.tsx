import { CheckCircle2, Circle, CircleAlert, Film, ImagePlus, Link2, Loader2, Upload, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Job } from '../../../src/shared/clientapi';
import { VvshCompose } from '../components/VvshCompose';
import type { ProviderInfo } from '../../../src/shared/protocol';
import type { Embed, ExternalSource } from '../../../src/shared/sources';
import { FORMAT_LABELS, FORMATS, type Format } from '../../../src/shared/taxonomy';
import { api, errorMessage, uploadFile } from '../api';
import {
  describeAlgorithm,
  describeProvider,
  emptyMeta,
  imageThumbnail,
  inspectMedia,
  MetaFields,
  mergeTopics,
  NodePicker,
  SignCard,
  ThumbPicker,
  type MetaState,
} from '../components/PublishFields';
import { Spinner } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, formatDuration, splitList, watchPath } from '../util';

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

/** What the file field takes for each format — the format at the top governs the picker. */
const FORMAT_ACCEPT: Record<Format, string> = {
  video: 'video/*,.mkv,.mov,.mp4,.m4v,.webm,.ogv,.avi,.wmv,.flv,.ts',
  'short-video': 'video/*,.mkv,.mov,.mp4,.m4v,.webm,.ogv,.avi,.wmv,.flv,.ts',
  live: 'video/*,.mkv,.mov,.mp4,.m4v,.webm,.ogv,.avi,.wmv,.flv,.ts',
  music: 'audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac',
  audio: 'audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac',
  podcast: 'audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac',
  image: 'image/*',
  'image-list': 'image/*',
  article: '.txt,.md,.markdown,.html,.htm,.epub,.pdf,text/*',
  game: '.zip,.7z,.rar,.apk,.jar,.exe,.dmg,.appimage,application/zip,application/x-7z-compressed',
  software: '.zip,.7z,.rar,.apk,.jar,.exe,.dmg,.appimage,application/zip,application/x-7z-compressed',
  book: '.pdf,.epub,.mobi,application/pdf,application/epub+zip',
  file: '',
  other: '',
};

const FORMAT_DROP: Record<Format, string> = {
  video: 'Drop a video or click to choose',
  'short-video': 'Drop a video or click to choose',
  live: 'Drop a video or click to choose',
  music: 'Drop an audio file or click to choose',
  audio: 'Drop an audio file or click to choose',
  podcast: 'Drop an audio file or click to choose',
  image: 'Drop an image or click to choose',
  'image-list': 'Drop an image or click to choose',
  article: 'Drop an article or click to choose',
  game: 'Drop a game or click to choose',
  software: 'Drop a program or click to choose',
  book: 'Drop a book or click to choose',
  file: 'Drop a file or click to choose',
  other: 'Drop a file or click to choose',
};

const VIDEO_EXT = ['.mkv', '.mov', '.mp4', '.m4v', '.webm', '.ogv', '.avi', '.wmv', '.flv', '.ts'];
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac'];
const DOC_EXT = ['.txt', '.md', '.markdown', '.html', '.htm', '.epub', '.pdf'];
const APP_EXT = ['.zip', '.7z', '.rar', '.apk', '.jar', '.exe', '.dmg', '.appimage'];
const BOOK_EXT = ['.pdf', '.epub', '.mobi'];

function extOf(name: string): string {
  const match = name.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : '';
}

/** Whether a file belongs in the format chosen at the top of the tab. */
function fitsFormat(file: File, format: Format): boolean {
  const mime = file.type || '';
  const ext = extOf(file.name);
  switch (format) {
    case 'video':
    case 'short-video':
    case 'live':
      return mime.startsWith('video/') || VIDEO_EXT.includes(ext);
    case 'music':
    case 'audio':
    case 'podcast':
      return mime.startsWith('audio/') || AUDIO_EXT.includes(ext);
    case 'image':
    case 'image-list':
      return mime.startsWith('image/');
    case 'article':
      return mime.startsWith('text/') || DOC_EXT.includes(ext);
    case 'game':
    case 'software':
      return APP_EXT.includes(ext) || mime === 'application/zip' || mime === 'application/x-7z-compressed' || mime === 'application/java-archive';
    case 'book':
      return mime === 'application/pdf' || mime === 'application/epub+zip' || BOOK_EXT.includes(ext);
    default:
      return true;
  }
}

function FileTab({ onVideo }: { onVideo?: () => void }) {
  const { state, providers, algorithms, toast } = useApp();
  const enabledProviders = providers.filter((n) => n.enabled && (n.info as ProviderInfo | undefined)?.pricing.upload.mode !== 'closed');
  const enabledAlgorithms = algorithms.filter((n) => n.enabled);
  const [file, setFile] = useState<File | null>(null);
  // The rest of a photo list: every image publishes on its own, and the list itself last.
  const [gallery, setGallery] = useState<File[]>([]);
  const [videoHint, setVideoHint] = useState(false);
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
  const listInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!chosenProviders.length && enabledProviders.length) setChosenProviders([enabledProviders[0].id]);
    if (!chosenAlgorithms.length && enabledAlgorithms.length) setChosenAlgorithms(enabledAlgorithms.map((n) => n.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length, algorithms.length]);

  const choose = async (picked: File) => {
    // The format at the top is the choice; the file field only takes what fits it.
    if (!fitsFormat(picked, meta.format)) {
      toast(`That file does not fit ${FORMAT_LABELS[meta.format].toLowerCase()} — change the format at the top to take it.`, 'error');
      return;
    }
    setFile(picked);
    setVideoHint((picked.type || '').startsWith('video/'));
    setThumbnail(undefined);
    setDuration(undefined);
    const mime = picked.type || 'application/octet-stream';
    setMeta((m) => ({ ...m, title: m.title || picked.name.replace(/\.[^.]+$/, '') }));
    if (mime.startsWith('image/')) setThumbnail(await imageThumbnail(picked));
    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      const info = await inspectMedia(picked);
      setDuration(info.duration);
      if (info.thumbnail) setThumbnail(info.thumbnail);
    }
  };

  /** Several images at once is a list of images: one content per image, one list of them. */
  const chooseMany = async (picked: FileList | File[]) => {
    const list = [...picked];
    if (!list.length) return;
    const images = list.filter((one) => (one.type || '').startsWith('image/'));
    if (list.length > 1 && images.length === list.length && (meta.format === 'image' || meta.format === 'image-list')) {
      setGallery(images.slice(1, 64));
      await choose(images[0]);
      setMeta((m) => ({ ...m, format: 'image-list' }));
      return;
    }
    setGallery([]);
    await choose(list[0]);
  };

  const images = file ? [file, ...gallery] : [];
  // A list of images publishes every image as its own content and the list itself last:
  // whenever several images were picked at once, or the format is "Image list".
  const asList = gallery.length > 0 || (meta.format === 'image-list' && (file?.type || '').startsWith('image/'));

  /** Takes one image out of the list (the first one hands its place to the next). */
  const dropImage = (index: number) => {
    if (index === 0) {
      setFile(gallery[0] ?? null);
      setGallery(gallery.slice(1));
    } else {
      setGallery(gallery.filter((_, at) => at !== index - 1));
    }
  };

  const publish = async () => {
    if (!file) return;
    try {
      setUploading(0);
      // A list of images: every image publishes as its own content first (each gets its
      // own id), and the list itself publishes last with all of those ids as its gallery.
      const galleryIds: string[] = [];
      for (const [index, image] of images.entries()) {
        if (asList) setUploading(index / (images.length + 1));
        const { fileId } = await uploadFile(image, asList ? () => undefined : setUploading);
        const one = await api<Job>('/api/publish', {
          body: {
            fileId,
            name: image.name,
            mime: image.type || 'application/octet-stream',
            title: asList ? `${meta.title} (${index + 1}/${images.length})` : meta.title,
            description: meta.description,
            format: asList ? 'image' : meta.format,
            rating: meta.rating,
            topics: mergeTopics(meta),
            language: meta.language || undefined,
            durationSeconds: asList ? undefined : duration,
            sources: asList ? undefined : splitList(sources),
            providers: chosenProviders,
            algorithms: chosenAlgorithms,
            thumbnail: asList ? undefined : thumbnail,
            sign,
          },
        });
        if (!asList) {
          watchJob(one.id);
          return;
        }
        // The list needs the id of every image, so it waits for each image to finish.
        let done = one;
        for (let tick = 0; tick < 240 && done.status === 'running'; tick++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          done = await api<Job>(`/api/jobs/${done.id}`);
        }
        if (done.status !== 'done' || !done.result?.id) throw new Error(done.error ?? `The upload of ${image.name} failed`);
        galleryIds.push(done.result.id.split('~')[0]);
      }
      // The list itself: a tiny carrier file, with its images named in its own metadata.
      const carrier = new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#151821"/><text x="600" y="335" fill="#9aa1b5" font-size="52" text-anchor="middle" font-family="sans-serif">Photo list</text></svg>',
        ],
        'photo-list.svg',
        { type: 'image/svg+xml' }
      );
      const { fileId } = await uploadFile(carrier, setUploading);
      setUploading(null);
      const created = await api<Job>('/api/publish', {
        body: {
          fileId,
          name: carrier.name,
          mime: carrier.type,
          title: meta.title,
          description: meta.description,
          format: 'image-list',
          rating: meta.rating,
          topics: mergeTopics(meta),
          language: meta.language || undefined,
          gallery: galleryIds,
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

  return (
    <div className="publish-layout">
      <div className="form-stack">
        <label className="field">
          Format
          <select value={meta.format} onChange={(e) => setMeta({ ...meta, format: e.target.value as Format })}>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
          <span className="hint">Decides what the file field below takes.</span>
        </label>
        {!file ? (
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void chooseMany(e.dataTransfer.files);
            }}
          >
            <UploadCloud size={44} />
            <h2 style={{ margin: '12px 0 6px', color: 'var(--text)' }}>{FORMAT_DROP[meta.format]}</h2>
            <p>It is split into chunks and uploaded to the providers you pick.</p>
            {meta.format === 'image' || meta.format === 'image-list' ? (
              <p className="hint">Pick several images at once to publish them as a list of images: one content per image, plus the list itself.</p>
            ) : (
              <p className="hint">The format at the top decides which files this field takes.</p>
            )}
          </div>
        ) : (
          <div className="card row between">
            <div>
              <strong>{file.name}</strong>
              <div className="small muted">
                {file.type || 'unknown type'} · {formatBytes(file.size)}
                {duration ? ` · ${formatDuration(duration)}` : ''}
                {asList ? ` · a list of ${images.length} image${images.length === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            <button className="small" onClick={() => (setFile(null), setGallery([]), setMeta(emptyMeta()))}>
              Change
            </button>
          </div>
        )}
        {videoHint && onVideo && (
          <div className="banner warn small">
            This is a video. Publishing it as a <strong>video stream</strong> makes it seekable chunk by chunk, with preview images and per-chunk
            pricing.{' '}
            <button className="small" onClick={onVideo}>
              Open Video stream
            </button>
          </div>
        )}
        <input
          ref={input}
          type="file"
          multiple={meta.format === 'image' || meta.format === 'image-list'}
          accept={FORMAT_ACCEPT[meta.format] || undefined}
          hidden
          onChange={(e) => e.target.files?.length && void chooseMany(e.target.files)}
        />
        <MetaFields meta={meta} setMeta={setMeta} hideFormat />
        {asList && file && (
          <div className="field">
            <span>
              Images in the list <span className="hint">Each one publishes as its own content; the list itself goes last.</span>
            </span>
            <div className="form-stack" style={{ gap: 6 }}>
              {images.map((image, index) => (
                <div key={`${image.name}-${index}`} className="card row between" style={{ padding: '6px 10px', margin: 0 }}>
                  <span className="small">
                    {index + 1}. {image.name} <span className="faint">· {formatBytes(image.size)}</span>
                  </span>
                  <button type="button" className="small" onClick={() => dropImage(index)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="small" style={{ alignSelf: 'flex-start' }} onClick={() => listInput.current?.click()}>
              <ImagePlus size={14} /> Add images
            </button>
            <input
              ref={listInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])].filter((one) => (one.type || '').startsWith('image/'));
                if (picked.length) setGallery([...gallery, ...picked].slice(0, 63));
                e.target.value = '';
              }}
            />
          </div>
        )}
        <label className="field">
          Fallback links <span className="hint">Copies elsewhere (YouTube, archive.org, IPFS…), shown when no provider has the file. One per line.</span>
          <textarea value={sources} onChange={(e) => setSources(e.target.value)} rows={2} placeholder="https://www.youtube.com/watch?v=…" />
        </label>
      </div>
      <div className="form-stack">
        <ThumbPicker value={thumbnail} onChange={setThumbnail} />
        <div className="field">
          <span>Upload to providers</span>
          <NodePicker nodes={enabledProviders} selected={chosenProviders} setSelected={setChosenProviders} describe={describeProvider} />
        </div>
        <div className="field">
          <span>Submit to algorithm nodes</span>
          <NodePicker nodes={enabledAlgorithms} selected={chosenAlgorithms} setSelected={setChosenAlgorithms} describe={describeAlgorithm} />
        </div>
        <SignCard sign={sign} setSign={setSign} />
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
          topics: mergeTopics(meta),
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
  const [tab, setTab] = useState<'file' | 'link' | 'vvsh'>('vvsh');
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
        <button className={`tab ${tab === 'vvsh' ? 'on' : ''}`} onClick={() => setTab('vvsh')}>
          <Film size={15} /> Video stream
        </button>
        <button className={`tab ${tab === 'link' ? 'on' : ''}`} onClick={() => setTab('link')}>
          <Link2 size={15} /> Share a link
        </button>
        <button className={`tab ${tab === 'file' ? 'on' : ''}`} onClick={() => setTab('file')}>
          <Upload size={15} /> Upload a file
        </button>
      </div>
      {tab === 'vvsh' ? <VvshCompose /> : tab === 'file' ? <FileTab onVideo={() => setTab('vvsh')} /> : <LinkTab />}
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
