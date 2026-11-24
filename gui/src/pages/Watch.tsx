import {
  AlertTriangle,
  Ban,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Coins,
  Download,
  ExternalLink,
  Flag,
  HelpCircle,
  Info,
  Plus,
  Server,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { claimSourceMetrics } from '../../../src/algorithm/metrics';
import { SOURCE_CATALOG, sourceKeyOf } from '../../../src/algorithm/sources';
import type { ContentView, Job, NodeEntry, PublishPreview } from '../../../src/shared/clientapi';
import { VvshPlayer } from '../components/VvshPlayer';
import { parseNodeRef } from '../../../src/shared/noderef';
import { SUGGESTION_KINDS, type SuggestionKind } from '../../../src/shared/protocol';
import { IMAGE_LIST_MIME } from '../../../src/shared/image-list';
import { baseId, platformOf } from '../../../src/shared/sources';
import { ContentDataTab } from '../components/AboutContent';
import { RequestRemoval } from '../components/RequestRemoval';
import { ImageListView, UnverifiedImage, useVerified } from '../components/ImageList';
import { ThumbPicker } from '../components/PublishFields';
import {
  CREATOR_KIND_LABELS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATING_REASONS,
  RATINGS,
  TOPICS,
  topicIdOf,
  type CreatorKind,
} from '../../../src/shared/taxonomy';
import { api, errorMessage, uploadFile } from '../api';
import { FormatIcon } from '../components/ContentCard';
import { Comments } from '../components/Comments';
import { nodePreviewOf, useMediaSrc } from '../media';
import { Markdown } from '../markdown';
import { DownloadButton } from '../components/Download';
import { SaveCidButton } from '../components/SaveCid';
import { ShareButton } from '../components/Share';
import { StorageTierCard } from '../components/StorageTier';
import { Avatar, Chips, CopyButton, Loading, Modal, Spinner, WatchedBadge, toggle } from '../components/ui';
import { useApp } from '../state';
import { creatorPath, formatBytes, formatDuration, groupPath, profilePath, timeAgo, topicPath } from '../util';

// The corrections the dropdown offers. `tag` and `topic` have no editor of their own:
// content warnings post tags on their own and topics are edited as one corrected list.
const KIND_LABELS: Partial<Record<SuggestionKind, string>> = {
  format: 'Correct the format',
  rating: 'Correct the age rating',
  creator: 'Add the creator',
  published: 'Add the publish time',
  report: 'Report a problem',
  source: 'Add a source link',
  duplicate: 'Mark as duplicate of other content',
  title: 'Correct the title',
  description: 'Correct the content description',
  thumbnail: 'Correct the thumbnail',
  data: 'Correct the content data',
  topics: 'Edit topics',
};

/** A few of the standard topics to offer as picks in the editor — never the whole list. */
function suggestedTopics(shown: string[]): string[] {
  return TOPICS.filter((name) => !shown.includes(name)).slice(0, 6);
}

function TextViewer({ url: src, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const url = useMediaSrc(src);
  useEffect(() => {
    if (!url) return;
    fetch(url)
      .then((response) => response.text())
      .then(setText)
      .catch(() => setText('Could not load the text.'));
  }, [url]);
  if (text === null) return <div className="player text"><Spinner /></div>;
  return markdown ? (
    <div className="player text article">
      <Markdown text={text} />
    </div>
  ) : (
    <div className="player text">{text}</div>
  );
}

/** Width ÷ height of what the content is expected to look like, before it loads. */
function expectedRatio(view: ContentView): number {
  const media = view.item?.media;
  if (media?.width && media?.height) return media.width / media.height;
  const format = view.item?.format;
  if (format === 'short-video') return 9 / 16;
  if (format === 'image') return 1;
  return 16 / 9;
}

/** The content's own shape: what it was expected to be, then what it turns out to be. */
function useRatio(view: ContentView): [number, (width: number, height: number) => void] {
  const expected = expectedRatio(view);
  const [ratio, setRatio] = useState(expected);
  // A different content (not a refreshed view of the same one) starts from its expected shape.
  useEffect(() => setRatio(expected), [view.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const measured = useCallback((width: number, height: number) => {
    if (width > 0 && height > 0) setRatio(width / height);
  }, []);
  return [ratio, measured];
}

/** A player box with the content's proportions, as large as fits the window but never
 *  more than 80% of the screen height — scaled to fit, never cut off. */
function Fit({ ratio, children }: { ratio: number; children: React.ReactNode }) {
  const clamped = Math.min(4, Math.max(0.25, ratio));
  return (
    <div className={`player fit ${clamped <= 1 ? 'fit-tall' : ''}`} style={{ '--ratio': clamped } as React.CSSProperties}>
      {children}
    </div>
  );
}

function NativePlayer({
  view,
  autoplay,
  mediaRef,
}: {
  view: ContentView;
  autoplay: boolean;
  mediaRef: React.RefObject<HTMLMediaElement | null>;
}) {
  const mime = view.manifest!.mime;
  const src = useMediaSrc(view.streamUrl!);
  const download = useMediaSrc(view.downloadUrl);
  const [ratio, measured] = useRatio(view);
  // Images gate on the algorithm nodes' say-so: an image nobody has listed never loads.
  const verified = useVerified(view.item ? baseId(view.item.id) : undefined);
  // A .vvsh verifiable video stream plays chunk by chunk: seeking fetches only the chunk
  // under the playhead (each verified, each charged), never the whole file. It plays —
  // and its preview images show — only after the algorithm nodes vouch for the content.
  if (view.manifest?.vvsh) {
    if (verified === false) return <div className="player"><UnverifiedImage /></div>;
    if (verified === null) return <div className="player"><span className="image-skeleton" /></div>;
    return <VvshPlayer nodeId={view.provider?.id ?? ''} file={view.manifest.vvsh} name={view.manifest.name} />;
  }
  if (mime.startsWith('video/')) {
    return (
      <Fit ratio={ratio}>
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={src}
          controls
          autoPlay={autoplay}
          playsInline
          onLoadedMetadata={(e) => measured(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
        />
      </Fit>
    );
  }
  if (mime.startsWith('audio/')) {
    return (
      <div className="player audio">
        <div style={{ width: '100%', textAlign: 'center', color: 'white' }}>
          <FormatIcon format="music" size={54} />
          <div style={{ margin: '14px 0 20px', fontWeight: 600 }}>{view.item?.title ?? view.manifest!.name}</div>
          <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={src} controls autoPlay={autoplay} />
        </div>
      </div>
    );
  }
  // One packaged image list: the viewer pages through its pictures beside the arrows.
  if (view.item?.format === 'image-list' || view.manifest?.meta?.format === 'image-list' || mime === IMAGE_LIST_MIME) {
    return (
      <div className="player">
        <ImageListView id={view.item ? baseId(view.item.id) : undefined} url={view.streamUrl} title={view.item?.title ?? view.manifest!.name} />
      </div>
    );
  }
  if (mime.startsWith('image/')) {
    if (verified === false) return <div className="player"><UnverifiedImage /></div>;
    if (verified === null) return <div className="player"><span className="image-skeleton" /></div>;
    return (
      <Fit ratio={ratio}>
        <img src={src} alt={view.item?.title ?? view.manifest!.name} onLoad={(e) => measured(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
      </Fit>
    );
  }
  if (mime.startsWith('text/') || mime === 'application/json') return <TextViewer url={view.streamUrl!} markdown={mime === 'text/markdown'} />;
  if (mime === 'application/pdf') {
    return (
      <div className="player" style={{ aspectRatio: '4 / 5' }}>
        <iframe src={src} title={view.manifest!.name} />
      </div>
    );
  }
  return (
    <div className="player file">
      <div>
        <FormatIcon format={view.item?.format ?? 'file'} size={48} />
        <h2 style={{ margin: '12px 0 6px' }}>{view.manifest!.name}</h2>
        <p className="muted" style={{ marginBottom: 16 }}>
          {mime} · {formatBytes(view.manifest!.size)}
        </p>
        <a className="button primary" href={download} download={view.manifest!.name}>
          <Download size={16} /> Download
        </a>
      </div>
    </div>
  );
}

function ExternalPlayer({ view, index, setIndex }: { view: ContentView; index: number; setIndex: (i: number) => void }) {
  const embed = view.embeds[index];
  const [ratio, measured] = useRatio(view);
  // Platform pictures need the algorithm nodes' say-so just like native ones.
  const verified = useVerified(view.item ? baseId(view.item.id) : undefined);
  return (
    <>
      {view.embeds.length > 1 && (
        <div className="tabs" style={{ marginBottom: 12 }}>
          {view.embeds.map((e, i) => (
            <button key={i} className={`tab ${i === index ? 'on' : ''}`} onClick={() => setIndex(i)}>
              {e.label}
            </button>
          ))}
        </div>
      )}
      {embed.kind === 'iframe' ? (
        <Fit ratio={ratio}>
          <iframe
            src={embed.src}
            title={embed.label}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </Fit>
      ) : embed.kind === 'video' ? (
        <Fit ratio={ratio}>
          <video src={embed.src} controls playsInline onLoadedMetadata={(e) => measured(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
        </Fit>
      ) : embed.kind === 'audio' ? (
        <div className="player audio">
          <audio src={embed.src} controls />
        </div>
      ) : embed.kind === 'image' ? (
        verified === false ? (
          <div className="player"><UnverifiedImage /></div>
        ) : verified === null ? (
          <div className="player"><span className="image-skeleton" /></div>
        ) : (
          <Fit ratio={ratio}>
            <img src={embed.src} alt="" onLoad={(e) => measured(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
          </Fit>
        )
      ) : (
        <div className="player file">
          <div>
            <ExternalLink size={42} />
            <p style={{ margin: '12px 0' }}>This content lives on another site.</p>
            {embed.page && (
              <a className="button primary" href={embed.page} target="_blank" rel="noreferrer">
                Open {embed.label}
              </a>
            )}
          </div>
        </div>
      )}
      <p className="hint" style={{ marginTop: 8 }}>
        No content provider you use has this content, so it is shown from {embed.label}.{' '}
        {embed.page && (
          <a className="link" href={embed.page} target="_blank" rel="noreferrer">
            Open the original <ExternalLink size={12} />
          </a>
        )}
      </p>
    </>
  );
}

function Unavailable({ view, onAdded }: { view: ContentView; onAdded: () => void }) {
  const { toast, refresh, providers } = useApp();
  // A shared link can name the provider that hosts the content (?p=<reference>).
  const [params] = useSearchParams();
  const hint = params.get('p');
  const hinted = hint ? parseNodeRef(hint) : null;
  const suggested = [...view.suggestedProviders];
  if (hint && hinted?.type === 'provider' && !providers.some((node) => node.id === hinted.id || node.url === hinted.url) && !suggested.includes(hint)) {
    suggested.unshift(hint);
  }
  const add = async (ref: string) => {
    try {
      const result = await api<{ added: NodeEntry[]; errors: { error: string }[] }>('/api/nodes', { body: { text: ref } });
      if (result.errors.length) toast(result.errors[0].error, 'error');
      else toast(`Added ${result.added[0]?.name}`, 'success');
      await refresh();
      onAdded();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };
  return (
    <div className="player file">
      <div style={{ maxWidth: 520 }}>
        <Server size={42} />
        <h2 style={{ margin: '12px 0 8px' }}>Not available from your providers</h2>
        <div className="small muted" style={{ textAlign: 'left' }}>
          {view.providerErrors.length === 0 && <p>You have no enabled content provider nodes.</p>}
          {view.providerErrors.map((e) => (
            <div key={e.node + e.error}>
              <strong>{e.name}</strong>: {e.error}
            </div>
          ))}
        </div>
        {suggested.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p className="small">These providers host it:</p>
            {suggested.map((ref) => (
              <div key={ref} className="row" style={{ marginTop: 8, justifyContent: 'center' }}>
                <code className="tiny">{ref.length > 48 ? ref.slice(0, 48) + '…' : ref}</code>
                <button className="small" onClick={() => add(ref)}>
                  <Plus size={14} /> Add
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="small" style={{ marginTop: 16 }}>
          <Link className="link" to="/nodes">
            Manage your nodes
          </Link>
        </p>
      </div>
    </div>
  );
}

interface SourceRow {
  platform: string;
  url: string;
}

/** Platform + link rows: one content id can carry several sources. */
function SourceRows({ rows, onChange }: { rows: SourceRow[]; onChange: (rows: SourceRow[]) => void }) {
  const update = (index: number, patch: Partial<SourceRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="form-stack" style={{ gap: 6 }}>
      {rows.map((row, index) => (
        <div key={index} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <select value={row.platform} onChange={(e) => update(index, { platform: e.target.value })} style={{ maxWidth: 150 }}>
            {SOURCE_CATALOG.map((source) => (
              <option key={source.key} value={source.key}>
                {source.name}
              </option>
            ))}
          </select>
          <input type="url" placeholder="https://…" value={row.url} onChange={(e) => update(index, { url: e.target.value })} style={{ flex: 1 }} />
          <button className="ghost icon" title="Remove" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button className="small" onClick={() => onChange([...rows, { platform: 'youtube', url: '' }])}>
        <Plus size={14} /> Add another source
      </button>
    </div>
  );
}

/**
 * Uploads the content data when the providers do not have a content id yet. The content
 * id is the hash of the data: the client computes it here and fills the field, before
 * anything is uploaded — from a file picked here, or pulled from a URL.
 */
function UploadSection({ providers, algorithms, sources }: { providers: string[]; algorithms: string[]; sources: string[] }) {
  const { toast } = useApp();
  const [info, setInfo] = useState<{ fileId: string; name: string; mime: string; from: string } | null>(null);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'pull' | 'hash' | 'upload' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const sourceKey = sources.join('\n');

  // (Re)computes the content id: it covers the data and the sources named with it.
  const prepare = useCallback(
    async (held: { fileId: string; name: string; mime: string }) => {
      setBusy('hash');
      setResult(null);
      try {
        const request = {
          fileId: held.fileId,
          name: held.name,
          mime: held.mime,
          title: held.name,
          sources,
          sign: false,
        };
        setPreview(await api<PublishPreview>('/api/publish/preview', { body: request }));
      } catch (error) {
        setPreview(null);
        toast(errorMessage(error), 'error');
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKey]
  );

  useEffect(() => {
    if (info) void prepare(info);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.fileId, sourceKey]);

  const pickFile = async (chosen: File) => {
    setBusy('hash');
    try {
      const { fileId } = await uploadFile(chosen, () => undefined);
      const held = { fileId, name: chosen.name, mime: chosen.type || 'application/octet-stream', from: chosen.name };
      setInfo(held);
      setUrl('');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pullUrl = async () => {
    if (!url.trim()) return;
    setBusy('pull');
    try {
      const held = await api<{ fileId: string; size: number; name: string; mime: string }>('/api/upload/url', { body: { url: url.trim() } });
      setInfo({ fileId: held.fileId, name: held.name, mime: held.mime, from: url.trim() });
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    if (!preview || !info) return;
    setBusy('upload');
    setResult(null);
    try {
      let job = await api<Job>('/api/publish', {
        body: {
          fileId: info.fileId,
          name: info.name,
          mime: info.mime,
          title: info.name,
          sources,
          sign: false,
          manifest: preview.manifest,
          providers,
          algorithms,
        },
      });
      for (let attempt = 0; attempt < 240 && job.status === 'running'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await api<Job>(`/api/jobs/${job.id}`);
      }
      if (job.status === 'done' && job.result?.id) {
        setResult(
          job.result.id.split('~')[0] === preview.cid
            ? `Uploaded as ${job.result.id} — the id above is now on your nodes.`
            : `Uploaded as ${job.result.id}.`
        );
      } else if (job.status !== 'running') setResult(job.error ?? 'The upload failed.');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="form-stack" style={{ gap: 8 }}>
      <p className="small muted">
        The content id is the hash of the data: pick a file or pull one from a URL, and the client calculates the id here before anything
        is uploaded.
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input type="file" onChange={(e) => e.target.files?.[0] && void pickFile(e.target.files[0])} style={{ flex: 1 }} />
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input
          type="url"
          placeholder="…or pull the data from a URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="small" disabled={!url.trim() || busy !== null} onClick={pullUrl}>
          {busy === 'pull' && <Spinner />} Pull
        </button>
      </div>
      <label className="field">
        Content id (calculated on this device)
        <input type="text" className="mono" readOnly value={preview?.cid ?? ''} placeholder={busy === 'hash' ? 'Calculating…' : 'Pick a file or URL first'} />
        {preview && (
          <span className="hint">
            {preview.id} · {formatBytes(preview.size)}
            {info ? ` · from ${info.from}` : ''}
          </span>
        )}
      </label>
      <div className="row">
        <button className="primary small" disabled={!preview || busy !== null} onClick={upload}>
          {busy === 'upload' && <Spinner />} Upload content data
        </button>
        {result && <span className="small">{result}</span>}
      </div>
    </div>
  );
}

/** Reports the platform numbers of the content (views, likes, comments…) for credits. */
function ClaimDialog({ view, onClose }: { view: ContentView; onClose: () => void }) {
  const { toast } = useApp();
  const [source, setSource] = useState(() => sourceKeyOf({ id: baseId(view.id) }));
  const [values, setValues] = useState<Record<string, string>>({});
  const [publishedAt, setPublishedAt] = useState(view.item?.publishedAt?.slice(0, 10) ?? '');
  const [busy, setBusy] = useState(false);
  const defs = claimSourceMetrics(source);

  const submit = async () => {
    const metrics: Record<string, number> = {};
    for (const [key, text] of Object.entries(values)) {
      const number = Number(text);
      if (text.trim() !== '' && Number.isFinite(number) && number >= 0) metrics[key] = number;
    }
    if (!Object.keys(metrics).length) {
      toast('Enter at least one number', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ nodes: { name: string; credited?: number; multiplier?: number; newInfo?: boolean; error?: string }[] }>(
        '/api/claim',
        { body: { id: view.id, source, metrics, publishedAt: publishedAt || undefined } }
      );
      const earned = result.nodes.reduce((sum, node) => sum + (node.credited ?? 0), 0);
      const multiplier = result.nodes.find((node) => node.multiplier !== undefined)?.multiplier;
      toast(
        earned > 0
          ? `+${earned} credits for the report${multiplier !== undefined ? ` (multiplier ×${multiplier.toFixed(2)})` : ''}`
          : result.nodes.some((node) => node.newInfo === false)
            ? 'Your nodes already had these numbers — only new information is rewarded.'
            : 'Nothing earned.',
        earned > 0 ? 'success' : 'info'
      );
      onClose();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Report platform stats"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy && <Spinner />} Send
          </button>
        </>
      }
    >
      <div className="form-stack">
        <p className="small muted">
          Your algorithm nodes reward what they did not know yet: the numbers of the platform the content lives on multiply the reward,
          and posts that are newer earn more. Numbers grow over time — reporting again later, when they grew, earns again.
        </p>
        <label className="field">
          Platform
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setValues({});
            }}
          >
            {SOURCE_CATALOG.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          {defs.map((def) => (
            <label key={def.key} className="field">
              {def.label}
              <input
                type="number"
                min={0}
                placeholder="0"
                value={values[def.key] ?? ''}
                onChange={(e) => setValues({ ...values, [def.key]: e.target.value })}
              />
            </label>
          ))}
          <label className="field">
            Posted on
            <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
            <span className="hint">The newer the post, the more it earns.</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

/** One foldable section of the suggest modal: its description, inputs, and a note for the operator. */
function SuggestFold({
  title,
  open,
  onToggle,
  description,
  children,
  note,
  onNote,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  description: string;
  children?: React.ReactNode;
  note: string;
  onNote: (note: string) => void;
}) {
  return (
    <div className="suggest-fold">
      <button type="button" className="suggest-fold-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />} <strong>{title}</strong>
      </button>
      {open && (
        <div className="form-stack" style={{ marginTop: 8 }}>
          <p className="small muted">{description}</p>
          {children}
          <label className="field">
            Note for the operator (optional)
            <textarea value={note} onChange={(e) => onNote(e.target.value)} placeholder="Anything else the operator should know." />
          </label>
        </div>
      )}
    </div>
  );
}

function SuggestDialog({
  view,
  nodeId,
  mediaRef,
  onClose,
}: {
  view: ContentView;
  nodeId: string;
  mediaRef: React.RefObject<HTMLMediaElement | null>;
  onClose: () => void;
}) {
  const { providers, algorithms, toast } = useApp();
  const [tab, setTab] = useState<'provider' | 'algorithm'>(view.decidedBy ? 'algorithm' : 'provider');
  const [providerId, setProviderId] = useState(providers.find((node) => node.enabled)?.id ?? providers[0]?.id ?? '');
  const [algorithmId, setAlgorithmId] = useState(nodeId || algorithms.find((node) => node.enabled)?.id || algorithms[0]?.id || '');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<SourceRow[]>([{ platform: 'youtube', url: '' }]);
  const [duplicateOf, setDuplicateOf] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({ sources: '', duplicate: '', upload: '', meta: '', warnings: '' });
  const [kind, setKind] = useState<SuggestionKind>('topic');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  // The corrected fields: the current pairs and topics the form edits into the
  // corrected map/list it sends, and the picked replacement thumbnail.
  const [dataRows, setDataRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(view.item?.data ?? {}).map(([key, item]) => ({ key, value: item }))
  );
  const [topics, setTopics] = useState<string[]>(() => [...(view.item?.topics ?? [])]);
  const [topicInput, setTopicInput] = useState('');
  const [thumb, setThumb] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const media = mediaRef.current;
  const [atTime, setAtTime] = useState(Boolean(media && media.currentTime > 0));
  const time = media?.currentTime ?? 0;
  const [busy, setBusy] = useState(false);
  const setNote = (key: string, note: string) => setNotes((current) => ({ ...current, [key]: note }));
  const fold = (key: string) => () => setOpen((current) => ({ ...current, [key]: !current[key] }));
  // Adds exactly the typed topic — no near-match ever replaces the user's words.
  const addTopic = () => {
    const name = topicInput.trim();
    if (name && !topics.includes(name)) setTopics([...topics, name]);
    setTopicInput('');
  };

  // The corrected value of the picked item: plain text for the fields (empty clears
  // title, description and thumbnail), the corrected map/list as JSON for content data
  // and topics. Undefined means there is nothing to correct.
  const correctionValue = (): string | undefined => {
    switch (kind) {
      case 'title':
      case 'description':
        return value;
      case 'thumbnail':
        return thumb ?? '';
      case 'data': {
        const map: Record<string, string> = {};
        for (const row of dataRows) {
          const key = row.key.trim();
          if (key) map[key] = row.value;
        }
        return JSON.stringify(map);
      }
      case 'topics':
        return JSON.stringify(topics);
      case 'report':
        return value.trim() ? value || 'other' : undefined;
      case 'published':
        return value.trim() ? new Date(value).toISOString() : undefined;
      default:
        return value.trim() ? value : undefined;
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const sources = rows.filter((row) => row.url.trim());
      if (tab === 'provider') {
        if (sources.length) {
          await api('/api/suggest/provider', { body: { nodeId: providerId, id: view.id, kind: 'source', sources, note: notes.sources || undefined } });
        }
        if (duplicateOf.trim()) {
          await api('/api/suggest/provider', {
            body: { nodeId: providerId, id: view.id, kind: 'duplicate', duplicateOf: duplicateOf.trim(), note: notes.duplicate || undefined },
          });
        }
        if (!sources.length && !duplicateOf.trim()) {
          const note = notes.upload || notes.sources || notes.duplicate;
          if (note.trim().length < 3) throw new Error('Say what is missing');
          await api('/api/suggest/provider', { body: { nodeId: providerId, id: view.id, kind: 'missing', note: note.trim() } });
        }
        toast('Sent to the content provider node — thank you!', 'success');
      } else {
        const statuses: string[] = [];
        const suggest = async (body: Record<string, unknown>, note: string) => {
          const result = await api<{ status: string; agreeing: number }>('/api/suggest', {
            body: { nodeId: algorithmId, id: view.id, reason: note.trim() || reason.trim() || undefined, ...body },
          });
          statuses.push(result.status);
        };
        for (const row of sources) await suggest({ kind: 'source', value: row.url.trim(), platform: row.platform }, notes.sources);
        for (const warning of warnings) await suggest({ kind: 'tag', value: warning }, notes.warnings || `Content warning: ${warning}`);
        const correction = correctionValue();
        if (correction !== undefined) {
          await suggest(
            {
              kind,
              value: correction,
              timestamp: atTime ? time : undefined,
            },
            notes.meta
          );
        }
        if (!statuses.length) throw new Error('Add a source, a correction, or a content warning');
        toast(statuses.includes('accepted') ? 'Accepted — thanks! Credits were added to your account.' : 'Sent for review.', 'success');
      }
      onClose();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Suggest missing data"
      onClose={onClose}
      wide
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy && <Spinner />} Send
          </button>
        </>
      }
    >
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${tab === 'provider' ? 'on' : ''}`} onClick={() => setTab('provider')}>
          Content provider nodes
        </button>
        <button className={`tab ${tab === 'algorithm' ? 'on' : ''}`} onClick={() => setTab('algorithm')}>
          Algorithm search nodes
        </button>
      </div>
      <label className="field">
        {tab === 'provider' ? 'Content provider node' : 'Algorithm search node'}
        <select
          value={tab === 'provider' ? providerId : algorithmId}
          onChange={(e) => (tab === 'provider' ? setProviderId(e.target.value) : setAlgorithmId(e.target.value))}
        >
          {(tab === 'provider' ? providers : algorithms).map((node) => (
            <option key={node.id} value={node.id}>
              {node.name}
            </option>
          ))}
        </select>
      </label>
      <SuggestFold
        title="Missing sources"
        open={open.sources ?? false}
        onToggle={fold('sources')}
        description="Links to this content on other platforms — one content id can carry several sources. Pick the platform and paste the link."
        note={notes.sources}
        onNote={(note) => setNote('sources', note)}
      >
        <SourceRows rows={rows} onChange={setRows} />
      </SuggestFold>

      {tab === 'provider' && (
        <SuggestFold
          title="Duplicate content"
          open={open.duplicate ?? false}
          onToggle={fold('duplicate')}
          description="If this is the same content as some other id, say which: it helps the content provider node compress or dedupe its store."
          note={notes.duplicate}
          onNote={(note) => setNote('duplicate', note)}
        >
          <label className="field">
            The other content id
            <input type="text" className="mono" placeholder="vs1… or yt:…" value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)} />
          </label>
        </SuggestFold>
      )}

      <SuggestFold
        title="Missing content data"
        open={open.upload ?? false}
        onToggle={fold('upload')}
        description="If no node has the data of this content id, upload it here."
        note={notes.upload}
        onNote={(note) => setNote('upload', note)}
      >
        <UploadSection
          providers={tab === 'provider' && providerId ? [providerId] : providers.filter((node) => node.enabled).map((node) => node.id)}
          algorithms={tab === 'algorithm' && algorithmId ? [algorithmId] : []}
          sources={rows.filter((row) => row.url.trim()).map((row) => row.url.trim())}
        />
      </SuggestFold>
      {tab === 'algorithm' && (
        <>
          <SuggestFold
            title="Correct the metadata"
            open={open.meta ?? false}
            onToggle={fold('meta')}
            description="Algorithm nodes reward accepted suggestions with credits. Say why (optional), and point to the moment that shows it."
            note={notes.meta}
            onNote={(note) => setNote('meta', note)}
          >
            <label className="field">
              What
              <select value={kind} onChange={(e) => (setKind(e.target.value as SuggestionKind), setValue(''))}>
                {SUGGESTION_KINDS.filter((k) => k !== 'source' && k !== 'duplicate' && k !== 'rating' && k !== 'tag' && k !== 'topic').map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'format' ? (
              <label className="field">
                Format
                <select value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose…</option>
                  {FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </select>
              </label>
            ) : kind === 'report' ? (
              <label className="field">
                Problem
                <select value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose…</option>
                  <option value="illegal">Illegal content</option>
                  <option value="spam">Spam or scam</option>
                  <option value="misleading">Misleading</option>
                  <option value="copyright">Copyright</option>
                  <option value="other">Other</option>
                </select>
              </label>
            ) : kind === 'creator' ? (
              <label className="field">
                Creator
                <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Who made this" />
              </label>
            ) : kind === 'published' ? (
              <label className="field">
                Published
                <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            ) : kind === 'title' ? (
              <label className="field">
                Title
                <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Empty removes the title" />
              </label>
            ) : kind === 'description' ? (
              <label className="field">
                Content description
                <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} placeholder="Empty removes the description" />
              </label>
            ) : kind === 'thumbnail' ? (
              <div className="field">
                Thumbnail
                <ThumbPicker value={thumb} onChange={setThumb} />
                <span className="hint">Pick the right picture. Sending with an empty picker removes the current thumbnail.</span>
              </div>
            ) : kind === 'topics' ? (
              <div className="field">
                Topics
                {/* The topics as toggles, like the customization modal: a click drops or
                    keeps one, and Add takes exactly what was typed. */}
                <div className="chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {[...new Set([...(view.item?.topics ?? []), ...topics, ...suggestedTopics([...(view.item?.topics ?? []), ...topics])])].map(
                    (name) => {
                      const on = topics.includes(name);
                      return (
                        <button
                          key={name}
                          type="button"
                          className={`chip ${on ? 'on' : ''}`}
                          title={on ? 'In the corrected list — click to drop it' : 'Not in the corrected list — click to add it'}
                          onClick={() => setTopics(on ? topics.filter((entry) => entry !== name) : [...topics, name])}
                        >
                          {name}
                        </button>
                      );
                    }
                  )}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder="Add a topic"
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addTopic()}
                  />
                  <button type="button" className="small" onClick={addTopic}>
                    Add
                  </button>
                </div>
                <span className="hint">
                  The corrected list: a click drops or keeps a topic, Add takes it exactly as typed. Sending replaces the topics the content has.
                </span>
              </div>
            ) : kind === 'data' ? (
              <div className="field">
                Content data
                <div className="form-stack" style={{ gap: 6 }}>
                  {dataRows.map((row, at) => (
                    <div key={at} className="row" style={{ gap: 6 }}>
                      <input
                        type="text"
                        placeholder="Key"
                        aria-label={`Key ${at + 1}`}
                        style={{ flex: 1 }}
                        value={row.key}
                        onChange={(e) => setDataRows(dataRows.map((entry, index) => (index === at ? { ...entry, key: e.target.value } : entry)))}
                      />
                      <input
                        type="text"
                        placeholder="Value"
                        aria-label={`Value ${at + 1}`}
                        style={{ flex: 1 }}
                        value={row.value}
                        onChange={(e) => setDataRows(dataRows.map((entry, index) => (index === at ? { ...entry, value: e.target.value } : entry)))}
                      />
                      <button type="button" className="small" onClick={() => setDataRows(dataRows.filter((_, index) => index !== at))}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="small" onClick={() => setDataRows([...dataRows, { key: '', value: '' }])}>
                    + Add pair
                  </button>
                </div>
                <span className="hint">The corrected pairs: edit, remove or add. Sending replaces the content data the content has.</span>
              </div>
            ) : null}
            <label className="field">
              Why <span className="hint">(optional)</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe what in the content shows this." />
            </label>
            {media && (
              <label className="row small">
                <input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} /> Evidence at {formatDuration(time)}
              </label>
            )}
          </SuggestFold>

          <SuggestFold
            title="Content warnings"
            open={open.warnings ?? false}
            onToggle={fold('warnings')}
            description="What this content contains that its age rating is about — pick every warning that applies. This is separate from correcting the metadata."
            note={notes.warnings}
            onNote={(note) => setNote('warnings', note)}
          >
            <Chips options={RATING_REASONS} selected={warnings} onToggle={(warning) => setWarnings(toggle(warnings, warning))} />
          </SuggestFold>
        </>
      )}
    </Modal>
  );
}
/** Where the content comes from and how it is stored — behind the (i) next to the video. */
function InfoDialog({ view, embedIndex, onClose }: { view: ContentView; embedIndex: number; onClose: () => void }) {
  const [tab, setTab] = useState<'from' | 'tier' | 'data' | 'remove'>('from');
  return (
    <Modal title="About this content" onClose={onClose} wide>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${tab === 'from' ? 'on' : ''}`} onClick={() => setTab('from')}>
          Where it comes from
        </button>
        <button className={`tab ${tab === 'tier' ? 'on' : ''}`} onClick={() => setTab('tier')}>
          Storage tier
        </button>
        <button className={`tab ${tab === 'data' ? 'on' : ''}`} onClick={() => setTab('data')}>
          Content data
        </button>
        <button className={`tab ${tab === 'remove' ? 'on' : ''}`} onClick={() => setTab('remove')}>
          Request content removal
        </button>
      </div>
      {tab === 'remove' ? (
        <RequestRemoval target={{ id: view.item ? baseId(view.item.id) : view.id, title: view.item?.title }} />
      ) : tab === 'data' ? (
        <ContentDataTab data={view.item?.data} />
      ) : tab === 'from' ? (
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Algorithm</dt>
          <dd>
            {view.decidedBy ? (
              <span className="row" style={{ gap: 6 }}>
                <ShieldCheck size={14} /> {view.decidedBy.name} ({view.status})
              </span>
            ) : (
              'No algorithm node knows it'
            )}
          </dd>
          <dt>Provider</dt>
          <dd>
            {view.provider
              ? `${view.provider.name} · ${view.provider.perMiB} credit${view.provider.perMiB === 1 ? '' : 's'}/MiB (≈${view.provider.estimate} for all)`
              : view.embeds.length
                ? `External: ${view.embeds[embedIndex]?.label}`
                : 'Unavailable'}
          </dd>
          {view.manifest && (
            <>
              <dt>File</dt>
              <dd>
                {view.manifest.name} · {formatBytes(view.manifest.size)}
              </dd>
              <dt>Type</dt>
              <dd>{view.manifest.mime}</dd>
              <dt>Chunks</dt>
              <dd>
                {view.manifest.chunks === 1 ? '1 chunk' : `${view.manifest.chunks} chunks of ${formatBytes(view.manifest.chunkSize)}`}
              </dd>
            </>
          )}
          <dt>Published</dt>
          <dd>{timeAgo(view.item?.publishedAt ?? view.manifest?.createdAt) || '–'}</dd>
          <dt>Id</dt>
          <dd className="mono tiny">{view.id}</dd>
        </dl>
      ) : (
        <StorageTierCard cid={view.id} preferred={view.provider?.id} />
      )}
    </Modal>
  );
}

/** Only VibeShare key ids (vk1…) can receive credits; platform ids cannot. */
const canReceiveCredits = (id: string) => /^vk1[a-z2-7]{52}$/i.test(id);

export function WatchPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { state, refresh, toast } = useApp();
  const [view, setView] = useState<ContentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [embedIndex, setEmbedIndex] = useState(0);
  const [vote, setVote] = useState(0);
  const [stats, setStats] = useState({ likes: 0, dislikes: 0 });
  const [suggesting, setSuggesting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [info, setInfo] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);

  const load = useCallback(async () => {
    setView(null);
    setError(null);
    setReveal(false);
    setEmbedIndex(0);
    try {
      const result = await api<ContentView>(`/api/content/${encodeURIComponent(id)}`);
      setView(result);
      setStats(result.item?.stats ?? { likes: 0, dislikes: 0 });
      const title = result.item?.title ?? (result.manifest?.meta?.title as string | undefined) ?? result.manifest?.name ?? result.id;
      void api('/api/history', { body: { id: result.id, title, contentId: result.item?.contentId, link: result.item?.link } });
      // Content that plays from outside the network: report its id (or link) to the
      // nodes, which reward what they did not already have.
      if (!result.streamUrl) {
        void api<{ nodes: { credited?: number }[] }>('/api/report', { body: { id: result.id } })
          .then((reported) => {
            const earned = reported.nodes.reduce((sum, node) => sum + (node.credited ?? 0), 0);
            if (earned > 0) toast(`+${earned} credits for telling your nodes about this content`, 'success');
          })
          .catch(() => undefined);
      }
      if (result.decidedBy && result.status === 'listed') {
        api<{ vote: number }>(`/api/vote/${result.decidedBy.id}?content=${encodeURIComponent(result.id)}`)
          .then((r) => setVote(r.vote))
          .catch(() => setVote(0));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="page"><div className="banner danger">{error}</div></div>;
  if (!view || !state) return <div className="page"><Loading /></div>;

  const item = view.item;
  const meta = (view.manifest?.meta ?? {}) as { title?: string; description?: string; topics?: string[] };
  const title = item?.title ?? meta.title ?? view.manifest?.name ?? view.id;
  const creator = item?.creator ?? (view.manifest?.creator ? { id: view.manifest.creator.id, name: view.manifest.creator.name ?? 'Unnamed creator', kind: (view.manifest.creator.kind ?? 'unknown') as CreatorKind } : undefined);
  const subscribed = creator ? state.subscriptions.some((s) => s.id === creator.id) : false;
  const unknownMode = state.settings.unknownContent;
  const hidden = (view.status === 'blocked' || (view.status === 'unknown' && unknownMode === 'hide')) && !reveal;
  const playable = Boolean(view.streamUrl);

  const sendVote = async (value: 1 | -1) => {
    if (!view.decidedBy) return;
    const next = vote === value ? 0 : value;
    try {
      const result = await api<{ likes: number; dislikes: number; credited: number }>('/api/vote', {
        body: { nodeId: view.decidedBy.id, id: view.id, vote: next },
      });
      setVote(next);
      setStats({ likes: result.likes, dislikes: result.dislikes });
      if (result.credited) toast(`+${result.credited} credits on ${view.decidedBy.name} for voting`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const toggleSubscription = async () => {
    if (!creator) return;
    try {
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(creator.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: creator.id, name: creator.name, kind: creator.kind } });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const seek = (seconds: number) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = seconds;
      void mediaRef.current.play();
    }
  };

  return (
    <div className="page">
      {view.status === 'blocked' && (
        <div className="banner danger">
          <Ban size={18} />
          <div>
            <strong>Blocked by {view.decidedBy?.name}</strong>
            <div className="small">{view.reason ?? 'This algorithm node chose not to show this content.'}</div>
            {!reveal && (
              <button className="small" style={{ marginTop: 10 }} onClick={() => setReveal(true)}>
                Show anyway
              </button>
            )}
          </div>
        </div>
      )}
      {view.status === 'unknown' && unknownMode !== 'allow' && (
        <div className="banner warn">
          <HelpCircle size={18} />
          <div>
            <strong>Unknown content</strong>
            <div className="small">
              None of your algorithm nodes has reviewed this content, so nothing is known about its age rating or what it contains.
            </div>
            {hidden && (
              <button className="small" style={{ marginTop: 10 }} onClick={() => setReveal(true)}>
                Show it
              </button>
            )}
          </div>
        </div>
      )}
      <div className="watch">
        <div>
          {hidden ? (
            <div className="player file">
              <div>
                <AlertTriangle size={42} />
                <p style={{ marginTop: 12 }}>Hidden</p>
              </div>
            </div>
          ) : playable ? (
            <NativePlayer view={view} autoplay={state.settings.autoplay && view.status === 'listed'} mediaRef={mediaRef} />
          ) : view.embeds.length ? (
            <ExternalPlayer view={view} index={embedIndex} setIndex={setEmbedIndex} />
          ) : view.embedsDisabled && !view.native ? (
            <div className="player file">
              <div className="embed-placeholder">
                {/* Cookies off: the preview the algorithm node keeps of the content is
                    ours, and stands in for the platform's picture of the video. */}
                {view.item && nodePreviewOf(view.item) ? (
                  <img className="watch-preview" src={nodePreviewOf(view.item)} alt="" />
                ) : (
                  <div className="embed-placeholder-icon">
                    <FormatIcon format={view.item?.format ?? 'video'} size={54} />
                  </div>
                )}
                <p style={{ marginTop: 14, fontWeight: 600 }}>{title}</p>
                {creator && <p className="small muted">{creator.name}</p>}
                <p className="small faint embed-placeholder-text" style={{ marginTop: 10, maxWidth: 340 }}>
                  This is a placeholder standing in for {platformOf(view.item?.id ?? view.id).name}'s player. Third-party embeds are turned off for it: an
                  embedded player from another platform brings <strong>third-party tracking cookies</strong> with it. You can allow it — and change your
                  mind at any time — in{' '}
                  <Link className="link" to="/settings?tab=privacy">
                    Settings → Privacy
                  </Link>
                  .
                </p>
              </div>
            </div>
          ) : (
            <Unavailable view={view} onAdded={load} />
          )}

          <h1 className="watch-title">{title}</h1>
          {view.seen && (
            <div className="watch-watched">
              <WatchedBadge />
            </div>
          )}
          <div className="watch-actions">
            {creator && (
              <div className="row" style={{ marginRight: 12 }}>
                <Link to={creatorPath(creator.id)}>
                  <Avatar name={creator.name} id={creator.id} icon={creator.icon} />
                </Link>
                <div>
                  <Link to={creatorPath(creator.id)} style={{ fontWeight: 600 }}>
                    {creator.name}
                  </Link>
                </div>
                <button className={subscribed ? '' : 'primary'} onClick={toggleSubscription} style={{ marginLeft: 8 }}>
                  {subscribed ? 'Subscribed' : 'Subscribe'}
                </button>
              </div>
            )}
            <div className="spacer" />
            {view.decidedBy && view.status === 'listed' && (
              <div className="vote-group">
                <button className={vote === 1 ? 'on' : ''} onClick={() => sendVote(1)} title="Like">
                  <ThumbsUp size={16} /> {stats.likes}
                </button>
                <button className={vote === -1 ? 'on' : ''} onClick={() => sendVote(-1)} title="Dislike">
                  <ThumbsDown size={16} /> {stats.dislikes}
                </button>
              </div>
            )}
          </div>
          <div className="watch-actions watch-action-buttons">
            <button onClick={() => setSuggesting(true)}>
              <Flag size={16} /> Suggest
            </button>
            <button onClick={() => setClaiming(true)} title="Report the numbers you see on its platform (views, likes, comments…)">
              <BarChart3 size={16} /> Report stats
            </button>
            <SaveCidButton id={view.id} title={title} />
            {view.downloadUrl && <DownloadButton url={view.downloadUrl} name={view.manifest?.name} />}
            <ShareButton target={{ id: view.id, title }} className="" label="Share" />
            {/* Only a VibeShare key id can receive credits — a content whose creator is
                known only by a platform id (yt:…) hides this. */}
            {creator && canReceiveCredits(creator.id) && (
              <button onClick={() => navigate(`/wallet?tab=send&to=${encodeURIComponent(creator.id)}`)} title="Send credits to this content's creator">
                <Coins size={16} /> Send credits
              </button>
            )}
            <CopyButton text={view.id} label="Copy id" small={false} />
          </div>

          {item && (
            <div className="row" style={{ marginTop: 14 }}>
              <span className="badge accent">
                <FormatIcon format={item.format} size={12} /> {FORMAT_LABELS[item.format]}
              </span>
              <span className="badge">{RATING_LABELS[item.rating]}</span>
              {/* Who it comes from, and what it belongs to: creator, groups, topics. */}
              {item.creator && (
                <Link to={profilePath(item.creator.kind, item.creator.id)} className="badge" title="Open the creator">
                  {item.creator.name}
                </Link>
              )}
              {item.groups?.map((group) => (
                <Link key={group.id} to={groupPath(group.id)} className="badge" title={`Open the group ${group.name}`}>
                  {group.name}
                </Link>
              ))}
              {item.topics.map((topic) => {
                // The topic page's id is the hash of the name; a node that renamed a topic
                // keeps its own id, so only fall back to a search when it is not this one.
                const id = topicIdOf(topic);
                const known = item.topicIds?.includes(id);
                return (
                  <Link
                    key={topic}
                    to={known ? topicPath(id) : `/search?q=${encodeURIComponent('topic:' + topic)}`}
                    className="badge"
                    title={known ? 'Open this topic' : 'Search this topic'}
                  >
                    {topic}
                  </Link>
                );
              })}
            </div>
          )}
          {(item?.description ?? meta.description) && <div className="description">{item?.description ?? meta.description}</div>}
          {view.embeds.length > 0 && playable && (
            <div className="card">
              <h3>Also on</h3>
              <div style={{ marginTop: 10 }}>
                {view.embeds.map((embed) => (
                  <a key={embed.page} className="link row small" href={embed.page} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} /> {embed.label}
                  </a>
                ))}
              </div>
            </div>
          )}

        </div>

        <aside className="watch-info-col">
          <button className="ghost icon watch-info" title="Where it comes from and how it is stored" aria-label="About this content" onClick={() => setInfo(true)}>
            <Info size={18} />
          </button>
        </aside>
      </div>
      <Comments contentId={view.id} />
      {suggesting && (
        <SuggestDialog view={view} nodeId={view.decidedBy?.id ?? ''} mediaRef={mediaRef} onClose={() => setSuggesting(false)} />
      )}
      {claiming && <ClaimDialog view={view} onClose={() => setClaiming(false)} />}
      {info && <InfoDialog view={view} embedIndex={embedIndex} onClose={() => setInfo(false)} />}
    </div>
  );
}
