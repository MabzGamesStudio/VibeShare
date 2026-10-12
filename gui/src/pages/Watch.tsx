import {
  AlertTriangle,
  Ban,
  Download,
  ExternalLink,
  Flag,
  HelpCircle,
  Plus,
  Server,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ContentView, NodeEntry } from '../../../src/shared/clientapi';
import { parseNodeRef } from '../../../src/shared/noderef';
import { SUGGESTION_KINDS, type SuggestionKind } from '../../../src/shared/protocol';
import {
  CREATOR_KIND_LABELS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATINGS,
  TOPICS,
  type CreatorKind,
} from '../../../src/shared/taxonomy';
import { api, errorMessage } from '../api';
import { FormatIcon } from '../components/ContentCard';
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
  report: 'Report a problem',
};

function TextViewer({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
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
  const src = view.streamUrl!;
  if (mime.startsWith('video/')) {
    return (
      <div className="player">
        <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={src} controls autoPlay={autoplay} playsInline />
      </div>
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
      <div className="player">
        <img src={src} alt={view.item?.title ?? view.manifest!.name} />
      </div>
    );
  }
  if (mime.startsWith('text/') || mime === 'application/json') return <TextViewer url={src} markdown={mime === 'text/markdown'} />;
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
        <a className="button primary" href={view.downloadUrl}>
          <Download size={16} /> Download
        </a>
      </div>
    </div>
  );
}

function ExternalPlayer({ view, index, setIndex }: { view: ContentView; index: number; setIndex: (i: number) => void }) {
  const embed = view.embeds[index];
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
        <div className="player">
          <iframe
            src={embed.src}
            title={embed.label}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : embed.kind === 'video' ? (
        <div className="player">
          <video src={embed.src} controls />
        </div>
      ) : embed.kind === 'audio' ? (
        <div className="player audio">
          <audio src={embed.src} controls />
        </div>
      ) : embed.kind === 'image' ? (
        <div className="player">
          <img src={embed.src} alt="" />
        </div>
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
  const { toast } = useApp();
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
      const result = await api<{ status: string; agreeing: number }>('/api/suggest', {
        body: { nodeId, id: view.id, kind, value: kind === 'report' ? value || 'other' : value, reason, timestamp: atTime ? time : undefined },
      });
      toast(
        result.status === 'accepted'
          ? 'Accepted — thanks! Credits were added to your account.'
          : `Sent for review (${result.agreeing} agreeing so far).`,
        'success'
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
      title="Suggest a change"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || reason.trim().length < 3 || (kind !== 'report' && !value)}>
            {busy && <Spinner />} Send
          </button>
        </>
      }
    >
      <div className="form-stack">
        <p className="small muted">
          Algorithm nodes reward accepted suggestions with credits. Say why, and point to the moment that shows it.
        </p>
        <label className="field">
          What
          <select value={kind} onChange={(e) => (setKind(e.target.value as SuggestionKind), setValue(''))}>
            {SUGGESTION_KINDS.map((k) => (
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
            {view.decidedBy && (
              <button onClick={() => setSuggesting(true)}>
                <Flag size={16} /> Suggest
              </button>
            )}
            {view.downloadUrl && (
              <a className="button" href={view.downloadUrl}>
                <Download size={16} /> Download
              </a>
            )}
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
      {suggesting && view.decidedBy && (
        <SuggestDialog view={view} nodeId={view.decidedBy.id} mediaRef={mediaRef} onClose={() => setSuggesting(false)} />
      )}
    </div>
  );
}
