import {
  AlertTriangle,
  Ban,
  BarChart3,
  Download,
  ExternalLink,
  Flag,
  HelpCircle,
  Plus,
  Server,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { claimSourceMetrics } from '../../../src/algorithm/metrics';
import { SOURCE_CATALOG, sourceKeyOf } from '../../../src/algorithm/sources';
import type { ContentView, Job, NodeEntry, PublishPreview } from '../../../src/shared/clientapi';
import { parseNodeRef } from '../../../src/shared/noderef';
import { SUGGESTION_KINDS, type SuggestionKind } from '../../../src/shared/protocol';
import { baseId } from '../../../src/shared/sources';
import {
  CREATOR_KIND_LABELS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATINGS,
  TOPICS,
  type CreatorKind,
} from '../../../src/shared/taxonomy';
import { api, errorMessage, uploadFile } from '../api';
import { FormatIcon } from '../components/ContentCard';
import { useMediaSrc } from '../media';
import { Markdown } from '../markdown';
import { ShareButton } from '../components/Share';
import { Avatar, CopyButton, Loading, Modal, Spinner } from '../components/ui';
import { useApp } from '../state';
import { creatorPath, formatBytes, formatDuration, timeAgo } from '../util';

const KIND_LABELS: Record<SuggestionKind, string> = {
  tag: 'Add a tag',
  topic: 'Add a topic',
  format: 'Correct the format',
  rating: 'Correct the age rating',
  creator: 'Add the creator',
  published: 'Add the publish time',
  report: 'Report a problem',
  source: 'Add a source link',
  duplicate: 'Mark as duplicate of other content',
};

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

/** A player box with the content's proportions, as large as fits the window. */
function Fit({ ratio, children }: { ratio: number; children: React.ReactNode }) {
  const clamped = Math.min(4, Math.max(0.25, ratio));
  return (
    <div className="player fit" style={{ '--ratio': clamped } as React.CSSProperties}>
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
  if (mime.startsWith('image/')) {
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

function DownloadButton({ url, name }: { url: string; name?: string }) {
  const href = useMediaSrc(url);
  return (
    <a className="button" href={href} download={name}>
      <Download size={16} /> Download
    </a>
  );
}

function ExternalPlayer({ view, index, setIndex }: { view: ContentView; index: number; setIndex: (i: number) => void }) {
  const embed = view.embeds[index];
  const [ratio, measured] = useRatio(view);
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
        <Fit ratio={ratio}>
          <img src={embed.src} alt="" onLoad={(e) => measured(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
        </Fit>
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
  const [rows, setRows] = useState<SourceRow[]>([{ platform: 'youtube', url: '' }]);
  const [duplicateOf, setDuplicateOf] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<SuggestionKind>('tag');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const media = mediaRef.current;
  const [atTime, setAtTime] = useState(Boolean(media && media.currentTime > 0));
  const time = media?.currentTime ?? 0;
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const sources = rows.filter((row) => row.url.trim());
      if (tab === 'provider') {
        if (sources.length) {
          await api('/api/suggest/provider', { body: { nodeId: providerId, id: view.id, kind: 'source', sources, note: note || undefined } });
        }
        if (duplicateOf.trim()) {
          await api('/api/suggest/provider', {
            body: { nodeId: providerId, id: view.id, kind: 'duplicate', duplicateOf: duplicateOf.trim(), note: note || undefined },
          });
        }
        if (!sources.length && !duplicateOf.trim()) {
          if (note.trim().length < 3) throw new Error('Say what is missing');
          await api('/api/suggest/provider', { body: { nodeId: providerId, id: view.id, kind: 'missing', note: note.trim() } });
        }
        toast('Sent to the content provider node — thank you!', 'success');
      } else {
        if (reason.trim().length < 3) throw new Error('Say why (at least a few words)');
        const statuses: string[] = [];
        const suggest = async (body: Record<string, unknown>) => {
          const result = await api<{ status: string; agreeing: number }>('/api/suggest', {
            body: { nodeId: algorithmId, id: view.id, reason, ...body },
          });
          statuses.push(result.status);
        };
        for (const row of sources) await suggest({ kind: 'source', value: row.url.trim(), platform: row.platform });
        if (duplicateOf.trim()) await suggest({ kind: 'duplicate', value: duplicateOf.trim() });
        if (value.trim()) {
          await suggest({
            kind,
            value: kind === 'report' ? value || 'other' : kind === 'published' ? new Date(value).toISOString() : value,
            timestamp: atTime ? time : undefined,
          });
        }
        if (!statuses.length) throw new Error('Add a source, a duplicate id, or a correction');
        toast(
          statuses.includes('accepted') ? 'Accepted — thanks! Credits were added to your account.' : 'Sent for review.',
          'success'
        );
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
      <div className="form-stack">
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

        <h3>Missing sources</h3>
        <p className="small muted">
          Links to this content on other platforms — one content id can carry several sources. Pick the platform and paste the link.
        </p>
        <SourceRows rows={rows} onChange={setRows} />

        <h3>Duplicate content</h3>
        <p className="small muted">
          If this is the same content as some other id, say which: it helps the content provider node compress or dedupe its store.
        </p>
        <label className="field">
          The other content id
          <input type="text" className="mono" placeholder="vs1… or yt:…" value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)} />
        </label>

        <h3>Missing content data</h3>
        <p className="small muted">If no node has the data of this content id, upload it here.</p>
        <UploadSection
          providers={tab === 'provider' && providerId ? [providerId] : providers.filter((node) => node.enabled).map((node) => node.id)}
          algorithms={tab === 'algorithm' && algorithmId ? [algorithmId] : []}
          sources={rows.filter((row) => row.url.trim()).map((row) => row.url.trim())}
        />

        {tab === 'algorithm' ? (
          <>
            <h3>Correct the metadata</h3>
            <p className="small muted">
              Algorithm nodes reward accepted suggestions with credits. Say why, and point to the moment that shows it.
            </p>
            <label className="field">
              What
              <select value={kind} onChange={(e) => (setKind(e.target.value as SuggestionKind), setValue(''))}>
                {SUGGESTION_KINDS.filter((k) => k !== 'source' && k !== 'duplicate').map((k) => (
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
        ) : kind === 'rating' ? (
          <label className="field">
            Age rating
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Choose…</option>
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {RATING_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        ) : kind === 'topic' ? (
          <label className="field">
            Topic
            <input list="topics" value={value} onChange={(e) => setValue(e.target.value)} />
            <datalist id="topics">
              {TOPICS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
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
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Who made this" />
          </label>
        ) : kind === 'published' ? (
          <label className="field">
            Published
            <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : (
          <label className="field">
            Tag
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. jump-scares" />
          </label>
        )}
        <label className="field">
          Why
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe what in the content shows this." />
        </label>
        {media && (
          <label className="row small">
            <input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} /> Evidence at {formatDuration(time)}
          </label>
        )}
          </>
        ) : (
          <label className="field">
            Note for the operator (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else the operator should know." />
          </label>
        )}
      </div>
    </Modal>
  );
}

export function WatchPage() {
  const { id = '' } = useParams();
  const { state, refresh, toast } = useApp();
  const [view, setView] = useState<ContentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [embedIndex, setEmbedIndex] = useState(0);
  const [vote, setVote] = useState(0);
  const [stats, setStats] = useState({ likes: 0, dislikes: 0 });
  const [suggesting, setSuggesting] = useState(false);
  const [claiming, setClaiming] = useState(false);
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
      void api('/api/history', { body: { id: result.id, title } });
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
  const meta = (view.manifest?.meta ?? {}) as { title?: string; description?: string; tags?: string[] };
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
          ) : (
            <Unavailable view={view} onAdded={load} />
          )}

          <h1 className="watch-title">{title}</h1>
          <div className="watch-actions">
            {creator && (
              <div className="row" style={{ marginRight: 12 }}>
                <Link to={creatorPath(creator.id)}>
                  <Avatar name={creator.name} id={creator.id} />
                </Link>
                <div>
                  <Link to={creatorPath(creator.id)} style={{ fontWeight: 600 }}>
                    {creator.name}
                  </Link>
                  <div className="tiny faint">{CREATOR_KIND_LABELS[creator.kind]}</div>
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
            <button onClick={() => setSuggesting(true)}>
              <Flag size={16} /> Suggest
            </button>
            <button onClick={() => setClaiming(true)} title="Report the numbers you see on its platform (views, likes, comments…)">
              <BarChart3 size={16} /> Report stats
            </button>
            {view.downloadUrl && <DownloadButton url={view.downloadUrl} name={view.manifest?.name} />}
            <ShareButton target={{ id: view.id, title }} className="" label="Share" />
            <CopyButton text={view.id} label="Copy id" small={false} />
          </div>

          {item && (
            <div className="row" style={{ marginTop: 14 }}>
              <span className="badge accent">
                <FormatIcon format={item.format} size={12} /> {FORMAT_LABELS[item.format]}
              </span>
              <span className="badge">{RATING_LABELS[item.rating]}</span>
              {item.topics.map((topic) => (
                <Link key={topic} to={`/search?q=${encodeURIComponent('topic:' + topic)}`} className="badge">
                  {topic}
                </Link>
              ))}
              {item.tags.map((tag) => (
                <Link key={tag} to={`/search?q=${encodeURIComponent('#' + tag)}`} className="badge">
                  #{tag}
                </Link>
              ))}
            </div>
          )}
          {(item?.description ?? meta.description) && <div className="description">{item?.description ?? meta.description}</div>}
        </div>

        <aside className="side-panel">
          <div className="card">
            <h3>Where it comes from</h3>
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
              <dd>{timeAgo(item?.publishedAt ?? view.manifest?.createdAt) || '–'}</dd>
              <dt>Id</dt>
              <dd className="mono tiny">{view.id}</dd>
            </dl>
          </div>
          {item?.notes && item.notes.length > 0 && (
            <div className="card">
              <h3>Why it is tagged</h3>
              <div style={{ marginTop: 12 }}>
                {item.notes.map((note) => (
                  <div key={note.kind + note.value} className="note">
                    <strong>
                      {note.kind}: {note.value}
                    </strong>
                    {note.timestamp !== undefined && (
                      <button className="small ghost" onClick={() => seek(note.timestamp!)} style={{ marginLeft: 6 }}>
                        at {formatDuration(note.timestamp)}
                      </button>
                    )}
                    <div className="muted small">{note.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
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
        </aside>
      </div>
      {suggesting && (
        <SuggestDialog view={view} nodeId={view.decidedBy?.id ?? ''} mediaRef={mediaRef} onClose={() => setSuggesting(false)} />
      )}
      {claiming && <ClaimDialog view={view} onClose={() => setClaiming(false)} />}
    </div>
  );
}
