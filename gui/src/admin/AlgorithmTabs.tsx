import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSource, parseContentId, sourceFromUrl } from '../../../src/shared/sources';
import {
  CREATOR_KIND_LABELS,
  CREATOR_KINDS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATINGS,
  type CreatorKind,
  type Format,
  type Rating,
} from '../../../src/shared/taxonomy';
import { Loading, Modal } from '../components/ui';
import { formatDuration, splitList, timeAgo } from '../util';
import { ListControls, Pager, Sentinel, useConsoleList, type Paging } from './paging';
import { admin, message } from './api';
import { useToast } from './AdminApp';
import { Claims } from './ClaimsTab';
import { Peers } from './PeersTab';
import { ApiKeys, Sources } from './SourcesTabs';

interface Submission {
  id: string;
  contentId: string;
  accountId: string;
  verifiedCreator?: string;
  thumbnail?: string;
  createdAt: string;
  request: {
    title: string;
    description?: string;
    format?: Format;
    rating?: Rating;
    topics?: string[];
    tags?: string[];
    creator?: { name?: string; kind?: CreatorKind };
    providers?: string[];
  };
}

interface Suggestion {
  id: string;
  contentId: string;
  title?: string;
  kind: string;
  value: string;
  votes: { account: string; reason: string; timestamp?: number }[];
  createdAt: string;
}

/** Content a client suggested as related to a creator, for the operator to accept or delete. */
interface CreatorSuggestion {
  id: string;
  creatorId: string;
  creatorName?: string;
  contentId: string;
  contentRef: string;
  title?: string;
  message?: string;
  status: string;
  createdAt: string;
}

/** Account links proposed without the creator's key, for the operator to link or not. */
interface AccountLinkProposalView {
  id: string;
  creatorId: string;
  creatorName?: string;
  accounts: { platform: string; handle: string; url?: string }[];
  status: string;
  createdAt: string;
}

/** An icon a client suggested for a creator, for the operator to accept or delete. */
interface IconSuggestionView {
  id: string;
  creatorId: string;
  creatorName?: string;
  icon: string;
  status: string;
  createdAt: string;
}

function SubmissionCard({ submission, done }: { submission: Submission; done: () => void }) {
  const r = submission.request;
  const [title, setTitle] = useState(r.title);
  const [format, setFormat] = useState<Format>(r.format ?? 'other');
  const [rating, setRating] = useState<Rating>(r.rating ?? 'all');
  const [tags, setTags] = useState((r.tags ?? []).join(', '));
  const [topics, setTopics] = useState((r.topics ?? []).join(', '));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const act = async (action: 'accept' | 'reject') => {
    try {
      await admin(`/v1/admin/submissions/${submission.id}/${action}`, {
        body: action === 'accept' ? { title, format, rating, tags: splitList(tags), topics: splitList(topics), note } : { note },
      });
      done();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="card" style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 18 }}>
      <div className="preview-thumb">{submission.thumbnail ? <img src={submission.thumbnail} alt="" /> : <span className="faint small">No thumbnail</span>}</div>
      <div className="form-stack" style={{ gap: 10 }}>
        <div className="row between">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ fontWeight: 600 }} />
        </div>
        <div className="small muted">
          {r.creator?.name ?? 'No creator name'} ({r.creator?.kind ?? 'unknown'}){' '}
          {submission.verifiedCreator ? <span className="badge ok">key verified</span> : <span className="badge">unverified</span>} ·{' '}
          {timeAgo(submission.createdAt)}
        </div>
        <div className="mono tiny faint">{submission.contentId}</div>
        {r.description && <p className="small">{r.description}</p>}
        <div className="form-grid">
          <label className="field">
            Format
            <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Rating
            <select value={rating} onChange={(e) => setRating(e.target.value as Rating)}>
              {RATINGS.map((x) => (
                <option key={x} value={x}>
                  {RATING_LABELS[x]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Topics
            <input type="text" value={topics} onChange={(e) => setTopics(e.target.value)} />
          </label>
          <label className="field">
            Tags
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
        </div>
        {r.providers?.length ? <div className="tiny faint">Hosted on {r.providers.length} provider(s)</div> : null}
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the submitter (optional)" />
        {error && <div className="banner danger small">{error}</div>}
        <div className="row">
          <button className="primary" onClick={() => act('accept')}>
            List it
          </button>
          <button onClick={() => act('reject')}>Reject</button>
          <a className="link small" href={`/v1/content/${encodeURIComponent(submission.contentId)}`} target="_blank" rel="noreferrer">
            raw
          </a>
        </div>
      </div>
    </div>
  );
}

function Review({ section }: { section: 'submissions' | 'suggestions' | 'creators' | 'icons' | 'links' }) {
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [creatorIdeas, setCreatorIdeas] = useState<CreatorSuggestion[]>([]);
  const [accountLinks, setAccountLinks] = useState<AccountLinkProposalView[]>([]);
  const [icons, setIcons] = useState<IconSuggestionView[]>([]);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ submissions: Submission[] }>('/v1/admin/submissions').then((r) => setSubmissions(r.submissions)).catch((e) => show(message(e)));
    admin<{ suggestions: Suggestion[] }>('/v1/admin/suggestions').then((r) => setSuggestions(r.suggestions)).catch(() => undefined);
    admin<{ suggestions: CreatorSuggestion[] }>('/v1/admin/creator-suggestions')
      .then((r) => setCreatorIdeas(r.suggestions))
      .catch(() => undefined);
    admin<{ suggestions: IconSuggestionView[] }>('/v1/admin/creator-icons')
      .then((r) => setIcons(r.suggestions))
      .catch(() => undefined);
    admin<{ proposals: AccountLinkProposalView[] }>('/v1/admin/account-links')
      .then((r) => setAccountLinks(r.proposals))
      .catch(() => undefined);
  }, [show]);
  useEffect(load, [load]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      {section === 'submissions' && (<>
      <h2>Submissions</h2>
      {!submissions ? (
        <Loading />
      ) : submissions.length === 0 ? (
        <p className="muted small">Nothing waiting.</p>
      ) : (
        submissions.map((submission) => <SubmissionCard key={submission.id} submission={submission} done={load} />)
      )}
      </>
      )}
      {section === 'suggestions' && (<>
      <h2 style={{ marginTop: 20 }}>Suggestions</h2>
      {suggestions.length === 0 ? (
        <p className="muted small">Nothing waiting.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>
                      {s.kind}: {s.value}
                    </strong>{' '}
                    on {s.title ?? s.contentId}
                    {s.votes.map((vote, i) => (
                      <div key={i} className="small muted">
                        “{vote.reason}”{vote.timestamp !== undefined && <span className="badge">at {formatDuration(vote.timestamp)}</span>}
                      </div>
                    ))}
                  </td>
                  <td className="small">{s.votes.length} agree</td>
                  <td>
                    <div className="row">
                      <button
                        className="small primary"
                        onClick={async () => {
                          await admin(`/v1/admin/suggestions/${s.id}/accept`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        {s.kind === 'report' ? 'Block content' : 'Accept'}
                      </button>
                      <button
                        className="small"
                        onClick={async () => {
                          await admin(`/v1/admin/suggestions/${s.id}/reject`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
      {section === 'creators' && (<>
      <h2 style={{ marginTop: 20 }}>Content for creators</h2>
      {creatorIdeas.length === 0 ? (
        <p className="muted small">Nothing waiting.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {creatorIdeas.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.creatorName ?? s.creatorId}</strong> ← <code>{s.contentRef}</code>
                    {s.title ? ` (${s.title})` : ''}
                    {s.message && <div className="small muted">“{s.message}”</div>}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        className="small primary"
                        onClick={async () => {
                          await admin(`/v1/admin/creator-suggestions/${s.id}/accept`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Accept
                      </button>
                      <button
                        className="small danger"
                        onClick={async () => {
                          await admin(`/v1/admin/creator-suggestions/${s.id}/delete`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
      {section === 'icons' && (<>
      <h2 style={{ marginTop: 20 }}>Creator icons</h2>
      {icons.length === 0 ? (
        <p className="muted small">Nothing waiting.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {icons.map((s) => (
                <tr key={s.id}>
                  <td>
                    <img src={s.icon} alt="" style={{ width: 32, height: 32, borderRadius: 6, verticalAlign: 'middle', marginRight: 8 }} />
                    <strong>{s.creatorName ?? s.creatorId}</strong>
                  </td>
                  <td>
                    <div className="row">
                      <button
                        className="small primary"
                        onClick={async () => {
                          await admin(`/v1/admin/creator-icons/${s.id}/accept`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Use it
                      </button>
                      <button
                        className="small danger"
                        onClick={async () => {
                          await admin(`/v1/admin/creator-icons/${s.id}/delete`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
      {section === 'links' && (<>
      <h2 style={{ marginTop: 20 }}>Account links without the creator key</h2>
      {accountLinks.length === 0 ? (
        <p className="muted small">Nothing waiting.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {accountLinks.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.creatorName ?? p.creatorId}</strong>
                    <div className="small muted">
                      {p.accounts.map((a) => a.url || `${a.platform}:${a.handle}`).join(' · ')}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <button
                        className="small primary"
                        onClick={async () => {
                          await admin(`/v1/admin/account-links/${p.id}/accept`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Link them
                      </button>
                      <button
                        className="small danger"
                        onClick={async () => {
                          await admin(`/v1/admin/account-links/${p.id}/delete`, { body: {} }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
    </div>
  );
}

interface Entry {
  id: string;
  sources: string[];
  status: 'listed' | 'blocked' | 'pending';
  origin?: 'operator' | 'submission' | 'crawler' | 'report' | 'peer';
  adapter?: string;
  pageUrl?: string;
  reason?: string;
  title: string;
  description?: string;
  format: Format;
  rating: Rating;
  topics: string[];
  tags: string[];
  language?: string;
  creatorId?: string;
  link?: string;
  providers?: string[];
  likes: number;
  dislikes: number;
  updatedAt: string;
  addedAt?: string;
  publishedAt?: string;
  durationSeconds?: number;
  notes?: { kind: string; value: string; reason: string; timestamp?: number }[];
  /** Preview image: a /v1/thumbnails/… path on this node, or a remote image. */
  thumbnail?: string;
  /** Platform numbers clients claimed (views, likes, comments…). */
  platformStats?: Record<string, number>;
}

/** Where an entry was found, in operator words (kept separate from its status). */
function originLabel(entry: Entry): string {
  switch (entry.origin) {
    case 'crawler':
      return `crawler${entry.adapter ? ` (${entry.adapter})` : ''}`;
    case 'submission':
      return 'user upload';
    case 'report':
      return 'user suggestion';
    case 'peer':
      return 'peer node';
    case 'operator':
      return 'the operator';
    default:
      return 'unknown';
  }
}

/** The preset reason tags of an age rating; “other” carries a custom description. */
const RATING_REASONS = ['violence', 'language', 'sexual content', 'nudity', 'drugs', 'fear', 'gambling', 'hate speech'];

/** The age-rating reason note of an entry, when one is tagged. */
function ratingReasonOf(entry: { notes?: { kind: string; value: string; reason: string }[] }): { value: string; reason: string } | null {
  return entry.notes?.find((note) => note.kind === 'rating') ?? null;
}

/** A timestamp first, then how long ago it was (2 weeks ago, 5 mins ago). */
function stampWithAgo(value?: string): string {
  if (!value) return '—';
  return `${new Date(value).toLocaleString()} (${timeAgo(value) || 'just now'})`;
}

/** Everything the node knows about one entry, opened by clicking it in the catalog. */
function EntryDetails({ entry, onClose, onEdit }: { entry: Entry; onClose: () => void; onEdit: () => void }) {
  const fullId = [entry.id, ...entry.sources].join('~');
  return (
    <Modal
      title="Content details"
      onClose={onClose}
      wide
      actions={
        <>
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={onEdit}>
            Edit
          </button>
        </>
      }
    >
      <div className="form-stack">
        {entry.thumbnail && <img src={entry.thumbnail} alt="Preview image" className="admin-thumb-large" />}
        <div>
          <h3>{entry.title}</h3>
          <div className="mono tiny faint">{fullId}</div>
        </div>
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <span className={`badge ${entry.status === 'listed' ? 'ok' : entry.status === 'pending' ? 'warn' : 'danger'}`}>{entry.status}</span>
            {entry.reason && <div className="tiny" style={{ color: 'var(--danger)' }}>{entry.reason}</div>}
          </dd>
          <dt>Found via</dt>
          <dd>{originLabel(entry)}</dd>
          <dt>Format</dt>
          <dd>
            {FORMAT_LABELS[entry.format]}
            {entry.durationSeconds ? ` · ${formatDuration(entry.durationSeconds)}` : ''}
            {entry.language ? ` · ${entry.language}` : ''}
          </dd>
          <dt>Age rating</dt>
          <dd>
            <span className="badge">{RATING_LABELS[entry.rating]}</span>
            {(() => {
              const reason = ratingReasonOf(entry);
              return reason ? <span className="badge">{reason.value === 'other' ? reason.reason : reason.value}</span> : null;
            })()}
          </dd>
          <dt>Topics</dt>
          <dd>{entry.topics.length ? entry.topics.join(', ') : '—'}</dd>
          <dt>Tags</dt>
          <dd>{entry.tags.length ? entry.tags.map((tag) => `#${tag}`).join(' ') : '—'}</dd>
          <dt>Creator</dt>
          <dd className="mono tiny">{entry.creatorId ?? '—'}</dd>
          <dt>Published</dt>
          <dd>{stampWithAgo(entry.publishedAt)}</dd>
          <dt>Votes</dt>
          <dd>
            👍 {entry.likes} · 👎 {entry.dislikes}
          </dd>
          <dt>Platform numbers</dt>
          <dd>
            {entry.platformStats && Object.keys(entry.platformStats).length
              ? Object.entries(entry.platformStats)
                  .map(([key, value]) => `${key} ${value}`)
                  .join(' · ')
              : 'None reported'}
          </dd>
          <dt>Content id</dt>
          <dd className="mono tiny">{entry.sources.length ? entry.sources.join(' · ') : 'No fallback sources'}</dd>
          {entry.pageUrl && (
            <>
              <dt>Page</dt>
              <dd>
                <a className="link" href={entry.pageUrl} target="_blank" rel="noreferrer">
                  {entry.pageUrl}
                </a>
              </dd>
            </>
          )}
          <dt>Added</dt>
          <dd>
            {stampWithAgo(entry.addedAt)}
            {entry.updatedAt ? ` · updated ${stampWithAgo(entry.updatedAt)}` : ''}
          </dd>
        </dl>
        {entry.description && <p className="small">{entry.description}</p>}
        {entry.notes && entry.notes.filter((note) => note.kind !== 'rating').length > 0 && (
          <div>
            <h3>Why it is tagged</h3>
            {entry.notes
              .filter((note) => note.kind !== 'rating')
              .map((note) => (
              <div key={note.kind + note.value} className="note small">
                <strong>
                  {note.kind}: {note.value}
                </strong>
                <div className="muted">{note.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

const blankEntry = (): Partial<Entry> => ({ id: '', title: '', format: 'video', rating: 'all', topics: [], tags: [], status: 'listed' });

function EntryEditor({ entry, onClose, onSaved }: { entry: Partial<Entry>; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(entry);
  const ratingNote = (draft.notes ?? []).find((note) => note.kind === 'rating') ?? null;
  // The age-rating reason: a preset tag from the dropdown, or “other” with a custom text.
  const setRatingNote = (value: string, reason: string) => {
    const notes = (draft.notes ?? []).filter((note) => note.kind !== 'rating');
    if (value) notes.push({ kind: 'rating', value, reason });
    setDraft({ ...draft, notes });
  };
  const [idText, setIdText] = useState(entry.id ? [entry.id, ...(entry.sources ?? [])].join('~') : '');
  const [error, setError] = useState<string | null>(null);
  const resolvedId = (() => {
    const text = idText.trim();
    if (parseContentId(text)) return text;
    const source = sourceFromUrl(text);
    return source ? formatSource(source) : '';
  })();

  const save = async () => {
    try {
      await admin('/v1/admin/content', {
        method: 'PUT',
        // The preview image is shown here but never edited back: the thumbnail field
        // only accepts data: URLs (set it with Add content or a suggestion).
        body: {
          ...draft,
          id: resolvedId,
          sources: undefined,
          likes: undefined,
          dislikes: undefined,
          updatedAt: undefined,
          thumbnail: undefined,
        },
      });
      onSaved();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <Modal
      title={entry.id ? 'Edit entry' : 'Add content'}
      onClose={onClose}
      actions={
        <button className="primary" onClick={save} disabled={!resolvedId || !draft.title}>
          Save
        </button>
      }
    >
      <div className="form-stack">
        <label className="field">
          Content id or link
          <input type="text" className="mono" value={idText} onChange={(e) => setIdText(e.target.value)} disabled={Boolean(entry.id)} placeholder="vs1… or https://youtube.com/watch?v=…" />
          {resolvedId && resolvedId !== idText.trim() && <span className="hint">Id: {resolvedId}</span>}
        </label>
        {entry.thumbnail && <img src={entry.thumbnail} alt="Preview image" className="admin-thumb-large" />}
        <label className="field">
          Title
          <input type="text" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label className="field">
          Description
          <textarea value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} />
        </label>
        <div className="form-grid">
          <label className="field">
            Status
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Entry['status'] })}>
              <option value="listed">Listed (whitelist)</option>
              <option value="blocked">Blocked (blacklist)</option>
            </select>
          </label>
          <label className="field">
            Format
            <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as Format })}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Rating
            <select value={draft.rating} onChange={(e) => setDraft({ ...draft, rating: e.target.value as Rating })}>
              {RATINGS.map((x) => (
                <option key={x} value={x}>
                  {RATING_LABELS[x]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Age rating reason
            <select
              value={ratingNote ? (RATING_REASONS.includes(ratingNote.value) ? ratingNote.value : 'other') : ''}
              onChange={(e) => setRatingNote(e.target.value, e.target.value === 'other' ? (ratingNote?.reason ?? '') : '')}
            >
              <option value="">No reason tagged</option>
              {RATING_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
              <option value="other">Other (custom description)</option>
            </select>
          </label>
          {ratingNote && !RATING_REASONS.includes(ratingNote.value) && (
            <label className="field">
              Custom description
              <input type="text" value={ratingNote.reason} onChange={(e) => setRatingNote('other', e.target.value)} />
            </label>
          )}
          <label className="field">
            Language
            <input type="text" value={draft.language ?? ''} onChange={(e) => setDraft({ ...draft, language: e.target.value || undefined })} />
          </label>
        </div>
        <label className="field">
          Topics
          <input type="text" defaultValue={(draft.topics ?? []).join(', ')} onBlur={(e) => setDraft({ ...draft, topics: splitList(e.target.value) })} />
        </label>
        <label className="field">
          Tags
          <input type="text" defaultValue={(draft.tags ?? []).join(', ')} onBlur={(e) => setDraft({ ...draft, tags: splitList(e.target.value) })} />
        </label>
        <label className="field">
          Creator id
          <input type="text" value={draft.creatorId ?? ''} onChange={(e) => setDraft({ ...draft, creatorId: e.target.value || undefined })} />
        </label>
        <div className="form-grid">
          <label className="field">
            Duration (seconds)
            <input
              type="number"
              min={0}
              value={draft.durationSeconds ?? ''}
              onChange={(e) => setDraft({ ...draft, durationSeconds: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
          <label className="field">
            Published
            <input
              type="date"
              value={(draft.publishedAt ?? '').slice(0, 10)}
              onChange={(e) => setDraft({ ...draft, publishedAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
            />
          </label>
        </div>
        <label className="field">
          Link (where the content lives outside VibeShare)
          <input type="text" className="mono" value={draft.link ?? ''} onChange={(e) => setDraft({ ...draft, link: e.target.value || undefined })} placeholder="yt:… or url:…" />
        </label>
        <label className="field">
          Page URL
          <input type="url" value={draft.pageUrl ?? ''} onChange={(e) => setDraft({ ...draft, pageUrl: e.target.value || undefined })} />
        </label>
        <label className="field">
          Providers <span className="hint">Node references, comma separated</span>
          <input type="text" defaultValue={(draft.providers ?? []).join(', ')} onBlur={(e) => setDraft({ ...draft, providers: splitList(e.target.value) })} />
        </label>
        <div className="field">
          <span>Platform metrics</span>
          {Object.entries(draft.platformStats ?? {}).map(([name, value]) => (
            <div key={name} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input type="text" value={name} disabled style={{ opacity: 0.7 }} />
              <input
                type="number"
                value={value}
                onChange={(e) => setDraft({ ...draft, platformStats: { ...(draft.platformStats ?? {}), [name]: Number(e.target.value) } })}
              />
              <button
                className="small danger"
                aria-label="Remove"
                onClick={() => {
                  const { [name]: _gone, ...rest } = draft.platformStats ?? {};
                  setDraft({ ...draft, platformStats: rest });
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="small"
            onClick={() => {
              const name = window.prompt('Metric name (views, likes, comments…)');
              if (name?.trim()) setDraft({ ...draft, platformStats: { ...(draft.platformStats ?? {}), [name.trim()]: 0 } });
            }}
          >
            + Add metric
          </button>
        </div>
        {draft.status === 'blocked' && (
          <label className="field">
            Reason shown to clients
            <input type="text" value={draft.reason ?? ''} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
          </label>
        )}
        {error && <div className="banner danger small">{error}</div>}
      </div>
    </Modal>
  );
}


function Catalog() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Entry> | null>(null);
  const [details, setDetails] = useState<Entry | null>(null);
  const [provider, setProvider] = useState('');
  const [toast, show] = useToast();
  const { prefs, save: savePaging } = useConsoleList('catalog');

  const fetchAt = useCallback(
    async (at: number, append: boolean) => {
      setLoading(true);
      try {
        const result = await admin<{ items: Entry[]; total?: number }>(
          `/v1/admin/content?q=${encodeURIComponent(q)}&status=${status}&limit=${prefs.perPage}&cursor=${at}`
        );
        setItems((list) => (append ? [...(list ?? []), ...result.items] : result.items));
        setTotal(result.total ?? 0);
      } catch (e) {
        show(message(e));
      } finally {
        setLoading(false);
      }
    },
    [q, status, prefs.perPage, show]
  );
  useEffect(() => {
    setPage(0);
    void fetchAt(0, false);
  }, [fetchAt]);
  const load = useCallback(() => void fetchAt(0, false), [fetchAt]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Import from a provider</h3>
        <p className="small muted">Queues everything a provider hosts for review. Nothing is listed until you accept it.</p>
        <div className="row">
          <input type="text" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="vs:provider:vk1…@https://… or URL" style={{ flex: 1 }} />
          <button
            disabled={!provider.trim()}
            onClick={async () => {
              try {
                const result = await admin<{ queued: number; skipped: number }>('/v1/admin/import', { body: { provider: provider.trim() } });
                show(`Queued ${result.queued} for review (${result.skipped} already known)`);
              } catch (e) {
                show(message(e));
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
      <div className="row">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles or ids" style={{ flex: 1 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All</option>
          <option value="listed">Listed</option>
          <option value="pending">Found by the crawler, waiting for review</option>
          <option value="blocked">Blocked</option>
        </select>
        {status === 'pending' && items && items.length > 0 && (
          <button
            onClick={async () => {
              await admin('/v1/admin/content/bulk', { body: { ids: items.map((entry) => entry.id), status: 'listed' } }).catch((e) => show(message(e)));
              load();
            }}
          >
            List all {items.length}
          </button>
        )}
        <ListControls prefs={prefs} save={savePaging} />
        <button className="primary" onClick={() => setEditing(blankEntry())}>
          Add content
        </button>
      </div>
      {items && prefs.paging === 'pages' && (
        <Pager
          page={page}
          perPage={prefs.perPage}
          total={total}
          loading={loading}
          go={(next) => {
            setPage(next);
            void fetchAt(next * prefs.perPage, false);
          }}
        />
      )}
      <p className="hint">Ids that are not here are reported to clients as “unknown”.</p>
      {!items ? (
        <Loading />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <tbody>
              {(items ?? []).map((entry) => (
                <tr key={entry.id}>
                  <td style={{ cursor: 'pointer' }} title="Open details" onClick={() => setDetails(entry)}>
                    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                      {entry.thumbnail ? (
                        <img src={entry.thumbnail} alt="" className="admin-thumb" loading="lazy" />
                      ) : (
                        <div className="admin-thumb empty" title="No preview image" />
                      )}
                      <div>
                        <strong>{entry.title}</strong>
                        <div className="mono tiny faint">{entry.id}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${entry.status === 'listed' ? 'ok' : entry.status === 'pending' ? 'warn' : 'danger'}`}>{entry.status}</span>
                  </td>
                  <td className="small">{FORMAT_LABELS[entry.format]}</td>
                  <td className="small">
                    <div>👍 {entry.likes}</div>
                    <div>👎 {entry.dislikes}</div>
                  </td>
                  <td>
                    <div className="row">
                      <button className="small" onClick={() => setEditing(entry)}>
                        Edit
                      </button>
                      {entry.status === 'listed' ? (
                        <button
                          className="small danger"
                          onClick={async () => {
                            const reason = window.prompt('Reason (shown to clients)', 'Blocked by the operator');
                            if (reason === null) return;
                            await admin(`/v1/admin/content/${encodeURIComponent(entry.id)}/block`, { body: { reason } }).catch((e) => show(message(e)));
                            load();
                          }}
                        >
                          Block
                        </button>
                      ) : (
                        <button
                          className="small"
                          onClick={async () => {
                            await admin('/v1/admin/content', { method: 'PUT', body: { id: entry.id, status: 'listed' } }).catch((e) => show(message(e)));
                            load();
                          }}
                        >
                          List
                        </button>
                      )}
                      <button
                        className="small"
                        title="Forget it: clients see it as unknown"
                        onClick={async () => {
                          await admin(`/v1/admin/content/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                          load();
                        }}
                      >
                        Forget
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items && prefs.paging === 'lazy' && (
        <>
          <Sentinel onMore={() => !loading && void fetchAt(items.length, true)} done={items.length >= total} />
          {items.length < total && <p className="hint">Scroll for more ({items.length} of {total})</p>}
        </>
      )}
      {items && prefs.paging === 'pages' && (
        <Pager
          page={page}
          perPage={prefs.perPage}
          total={total}
          loading={loading}
          go={(next) => {
            setPage(next);
            void fetchAt(next * prefs.perPage, false);
          }}
        />
      )}
      {details && (
        <EntryDetails
          entry={details}
          onClose={() => setDetails(null)}
          onEdit={() => {
            setEditing(details);
            setDetails(null);
          }}
        />
      )}
      {editing && (
        <EntryEditor
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

interface Creator {
  id: string;
  name: string;
  kind: CreatorKind;
  description?: string;
  keys?: string[];
  links?: string[];
  icon?: string;
  accounts?: { platform: string; handle: string; url?: string }[];
  status: 'listed' | 'blocked';
  addedAt?: string;
}

function Creators() {
  const [q, setQ] = useState('');
  const [creators, setCreators] = useState<Creator[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Creator> | null>(null);
  const [toast, show] = useToast();
  const { prefs, save: savePaging } = useConsoleList('creators');

  const fetchAt = useCallback(
    async (at: number, append: boolean) => {
      setLoading(true);
      try {
        const result = await admin<{ creators: Creator[]; total?: number }>(
          `/v1/admin/creators?q=${encodeURIComponent(q)}&limit=${prefs.perPage}&cursor=${at}`
        );
        setCreators((list) => (append ? [...(list ?? []), ...result.creators] : result.creators));
        setTotal(result.total ?? 0);
      } catch (e) {
        show(message(e));
      } finally {
        setLoading(false);
      }
    },
    [q, prefs.perPage, show]
  );
  useEffect(() => {
    setPage(0);
    void fetchAt(0, false);
  }, [fetchAt]);
  const load = useCallback(() => void fetchAt(0, false), [fetchAt]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="row between">
        <p className="small muted">People, companies and groups. Creators with a key id (vk1…) are proven by signatures; blocking a creator hides all their content.</p>
        <div className="row">
          <ListControls prefs={prefs} save={savePaging} />
          <button className="primary" onClick={() => setEditing({ id: '', name: '', kind: 'person', status: 'listed' })}>
            Add creator
          </button>
        </div>
      </div>
      <div className="row">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names or ids" style={{ flex: 1 }} />
      </div>
      {creators && prefs.paging === 'pages' && (
        <Pager
          page={page}
          perPage={prefs.perPage}
          total={total}
          loading={loading}
          go={(next) => {
            setPage(next);
            void fetchAt(next * prefs.perPage, false);
          }}
        />
      )}
      {!creators ? (
        <Loading />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {creators.map((c) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} title="Open details" onClick={() => setEditing(c)}>
                  <td>
                    <strong>{c.name}</strong>
                    <div className="mono tiny faint">{c.id}</div>
                  </td>
                  <td className="small">{CREATOR_KIND_LABELS[c.kind]}</td>
                  <td>
                    <span className={`badge ${c.status === 'listed' ? 'ok' : 'danger'}`}>{c.status}</span>
                  </td>
                  <td>
                    <button className="small" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creators && prefs.paging === 'lazy' && (
        <>
          <Sentinel onMore={() => !loading && void fetchAt(creators.length, true)} done={creators.length >= total} />
          {creators.length < total && <p className="hint">Scroll for more ({creators.length} of {total})</p>}
        </>
      )}
      {creators && prefs.paging === 'pages' && (
        <Pager
          page={page}
          perPage={prefs.perPage}
          total={total}
          loading={loading}
          go={(next) => {
            setPage(next);
            void fetchAt(next * prefs.perPage, false);
          }}
        />
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit creator' : 'Add creator'}
          onClose={() => setEditing(null)}
          actions={
            <button
              className="primary"
              disabled={!editing.id || !editing.name}
              onClick={async () => {
                try {
                  await admin('/v1/admin/creators', { method: 'PUT', body: editing });
                  setEditing(null);
                  load();
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Save
            </button>
          }
        >
          <div className="form-stack">
            {editing.addedAt && <div className="hint">Added {new Date(editing.addedAt).toLocaleString()}</div>}
            <label className="field">
              Id <span className="hint">A key id (vk1…) or any name like name:my-studio</span>
              <input type="text" className="mono" value={editing.id ?? ''} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
            </label>
            <label className="field">
              Name
              <input type="text" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <div className="form-grid">
              <label className="field">
                Kind
                <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as CreatorKind })}>
                  {CREATOR_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {CREATOR_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Status
                <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as Creator['status'] })}>
                  <option value="listed">Listed</option>
                  <option value="blocked">Blocked</option>
                </select>
              </label>
            </div>
            <label className="field">
              Description
              <textarea value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={3} />
            </label>
            <label className="field">
              Keys <span className="hint">One per line: the key ids (vk1…) whose signatures prove this creator</span>
              <textarea
                className="mono"
                rows={2}
                value={(editing.keys ?? []).join('\n')}
                onChange={(e) => {
                  const keys = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                  setEditing({ ...editing, keys });
                }}
              />
            </label>
            <label className="field">
              Links <span className="hint">One per line: links to the creator's own pages</span>
              <textarea
                rows={2}
                value={(editing.links ?? []).join('\n')}
                onChange={(e) => {
                  const links = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                  setEditing({ ...editing, links });
                }}
              />
            </label>
            <label className="field">
              Icon <span className="hint">A small picture of the creator: a data: URL of an image up to 200 kB</span>
              <input type="text" className="mono" value={editing.icon ?? ''} onChange={(e) => setEditing({ ...editing, icon: e.target.value })} />
              {editing.icon && (
                <img src={editing.icon} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, marginTop: 6 }} />
              )}
            </label>
            <label className="field">
              Linked accounts <span className="hint">One per line: platform handle [url] — e.g. yt @channel https://youtube.com/@channel</span>
              <textarea
                rows={3}
                value={(editing.accounts ?? []).map((a) => [a.platform, a.handle, a.url].filter(Boolean).join(' ')).join('\n')}
                onChange={(e) => {
                  const accounts = e.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => {
                      const [platform, handle, url] = line.split(/\s+/);
                      return { platform, handle, ...(url ? { url } : {}) };
                    });
                  setEditing({ ...editing, accounts });
                }}
              />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface CrawlerStatus {
  enabled: boolean;
  userAgent: string;
  autoList: boolean;
  searchPlatforms: boolean;
  adapters: {
    id: string;
    label: string;
    description: string;
    enabled: boolean;
    blocked: boolean;
    targets: number;
    search: boolean;
    api?: { configured: boolean; optional?: boolean; pausedUntil?: string };
    stats: { runs: number; found: number; added: number; errors: number; blocked: number; lastRun?: string; lastError?: string };
  }[];
  queues: { frontier: number; identify: number; seen: number };
  queries: string[];
  recentSearches: { query: string; count: number; last: string }[];
  hosts: { host: string; requests: number; blocked: number; errors: number; lastError?: string }[];
}

function Crawler() {
  const [status, setStatus] = useState<CrawlerStatus | null>(null);
  const [config, setConfig] = useState<{ crawler: { seeds?: string[]; queries: string[]; defaultRating: Rating; adapters: { web: { seeds: string[] } } } } | null>(null);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<CrawlerStatus>('/v1/admin/crawler').then(setStatus).catch((e) => show(message(e)));
    admin<NonNullable<typeof config>>('/v1/admin/config').then(setConfig).catch(() => undefined);
  }, [show]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const set = async (patch: Record<string, unknown>) => {
    try {
      await admin('/v1/admin/config', { method: 'PUT', body: { crawler: patch } });
      load();
    } catch (e) {
      show(message(e));
    }
  };

  if (!status || !config) return <Loading />;
  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <div className="row between">
          <div>
            <h3>Content discovery</h3>
            <p className="small muted" style={{ marginTop: 4 }}>
              The crawler looks for videos, shorts, images and music on other platforms and lists them here. It reads each site's robots.txt
              first and keeps away from what it disallows, waits between requests to the same site, and identifies itself as{' '}
              <code>{status.userAgent}</code>.
            </p>
          </div>
          <button className={status.enabled ? '' : 'primary'} onClick={() => set({ enabled: !status.enabled })}>
            {status.enabled ? 'Pause' : 'Start'}
          </button>
        </div>
        <div className="form-grid">
          <label className="field">
            New discoveries
            <select value={String(status.autoList)} onChange={(e) => set({ autoList: e.target.value === 'true' })}>
              <option value="true">List them right away</option>
              <option value="false">Wait for my review (Catalog → pending)</option>
            </select>
          </label>
          <label className="field">
            Age rating when the platform says nothing
            <select value={config.crawler.defaultRating} onChange={(e) => set({ defaultRating: e.target.value })}>
              {RATINGS.map((rating) => (
                <option key={rating} value={rating}>
                  {RATING_LABELS[rating]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            When clients search
            <select value={String(status.searchPlatforms)} onChange={(e) => set({ searchPlatforms: e.target.value === 'true' })}>
              <option value="true">Also search the platforms</option>
              <option value="false">Only search what is listed here</option>
            </select>
          </label>
        </div>
        <div className="small muted">
          Queues: {status.queues.frontier} pages to visit · {status.queues.identify} platform links to identify · {status.queues.seen} URLs seen
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Found</th>
              <th>New</th>
              <th>Robots / errors</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.adapters.map((adapter) => (
              <tr key={adapter.id}>
                <td>
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={adapter.enabled}
                      disabled={adapter.id === 'identify'}
                      onChange={(e) => set({ adapters: { [adapter.id]: { enabled: e.target.checked } } })}
                    />
                    <strong>{adapter.label}</strong>
                    {adapter.search && <span className="badge">search</span>}
                    {adapter.api && <span className="badge">API</span>}
                    {adapter.blocked && <span className="badge warn">blocked in Sources</span>}
                    {adapter.api && !adapter.api.configured && !adapter.api.optional && <span className="badge">needs a key (API keys tab)</span>}
                    {adapter.api?.pausedUntil && <span className="badge warn">rate limited</span>}
                  </label>
                  <div className="tiny faint">{adapter.description}</div>
                  {adapter.stats.lastError && (
                    <div className="tiny ellipsis" style={{ color: 'var(--warn)', maxWidth: 280 }} title={adapter.stats.lastError}>
                      {adapter.stats.lastError}
                    </div>
                  )}
                </td>
                <td className="small">{adapter.stats.found}</td>
                <td className="small">{adapter.stats.added}</td>
                <td className="small">
                  {adapter.stats.blocked} / {adapter.stats.errors}
                </td>
                <td>
                  <button
                    className="small"
                    disabled={
                      busy !== null ||
                      !adapter.enabled ||
                      adapter.blocked ||
                      Boolean(adapter.api && !adapter.api.configured && !adapter.api.optional) ||
                      (adapter.id !== 'web' && adapter.targets === 0)
                    }
                    onClick={async () => {
                      setBusy(adapter.id);
                      try {
                        const result = await admin<{ found: number; added: number; target?: string }>('/v1/admin/crawler/run', { body: { adapter: adapter.id } });
                        show(`${adapter.label}: ${result.found} found, ${result.added} new${result.target ? ` (${result.target})` : ''}`);
                      } catch (e) {
                        show(message(e));
                      } finally {
                        setBusy(null);
                        load();
                      }
                    }}
                  >
                    {busy === adapter.id ? 'Running…' : 'Run now'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card form-stack">
        <h3>Seed sites</h3>
        <p className="small muted">Pages the web crawler starts from: it lists the video and photo pages it finds and identifies links to platforms.</p>
        {config.crawler.adapters.web.seeds.map((url) => (
          <div key={url} className="row between small">
            <code>{url}</code>
            <button
              className="small"
              onClick={() => set({ adapters: { web: { seeds: config.crawler.adapters.web.seeds.filter((s) => s !== url) } } })}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <input type="url" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="https://example.org/gallery" style={{ flex: 1 }} />
          <button
            disabled={!seed.trim()}
            onClick={async () => {
              try {
                await admin('/v1/admin/crawler/seeds', { body: { url: seed.trim() } });
                setSeed('');
                load();
              } catch (e) {
                show(message(e));
              }
            }}
          >
            Add seed
          </button>
        </div>
      </div>

      <div className="card form-stack">
        <h3>What to look for</h3>
        <label className="field">
          Discovery queries <span className="hint">Comma separated. Recent searches of your users are added automatically.</span>
          <input
            type="text"
            key={config.crawler.queries.join(',')}
            defaultValue={config.crawler.queries.join(', ')}
            onBlur={(e) => set({ queries: splitList(e.target.value) })}
          />
        </label>
        {status.recentSearches.length > 0 && (
          <div className="small muted">
            Recent searches: {status.recentSearches.map((search) => `${search.query} (${search.count})`).join(', ')}
          </div>
        )}
      </div>

      {status.hosts.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Requests</th>
                <th>Kept out by robots.txt</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {status.hosts.map((host) => (
                <tr key={host.host}>
                  <td className="small">
                    {host.host}
                    {host.lastError && <div className="tiny faint">{host.lastError}</div>}
                  </td>
                  <td className="small">{host.requests}</td>
                  <td className="small">{host.blocked}</td>
                  <td className="small">{host.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AlgorithmTabs({ tab }: { tab: string }) {
  if (tab === 'crawler') return <Crawler />;
  if (tab === 'apis') return <ApiKeys />;
  if (tab === 'sources') return <Sources />;
  if (tab === 'claims') return <Claims />;
  if (tab === 'peers') return <Peers />;
  if (tab === 'review') return <Review section="submissions" />;
  if (tab === 'review-suggestions') return <Review section="suggestions" />;
  if (tab === 'review-content') return <Review section="creators" />;
  if (tab === 'review-icons') return <Review section="icons" />;
  if (tab === 'review-links') return <Review section="links" />;
  if (tab === 'catalog') return <Catalog />;
  if (tab === 'creators') return <Creators />;
  if (tab === 'comments') return <CommentsTab />;
  return null;
}

interface CommentSectionSummary {
  content: string;
  blocks: number;
  hidden: number;
  shown: boolean;
}

interface AdminComment {
  id: string;
  text: string;
  key?: string;
  time: string;
  replyFrom: string;
  hidden: boolean;
  likes: number;
  dislikes: number;
}

interface AdminCommentsView {
  content: string;
  shown: boolean;
  blocks: number;
  comments: AdminComment[];
}

/**
 * The comment sections of content pages: the operator opens one by its content id (or
 * from the list), reads what was said, and decides whether the page shows its comments
 * at all. Hiding a section — or one comment — keeps the block headers but sends no data;
 * clients then show that the node operator removed something.
 */
function CommentsTab() {
  const [sections, setSections] = useState<CommentSectionSummary[] | null>(null);
  const [open, setOpen] = useState<AdminCommentsView | null>(null);
  const [pick, setPick] = useState('');
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(50);
  const [toast, show] = useToast();
  const { prefs, save: savePaging } = useConsoleList('comments');

  const load = useCallback(() => {
    admin<{ sections: CommentSectionSummary[] }>('/v1/admin/comments')
      .then((result) => setSections(result.sections))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  // The same pagination and lazy loading as the catalog and creators lists.
  const total = sections?.length ?? 0;
  const visible = sections
    ? prefs.paging === 'pages'
      ? sections.slice(page * prefs.perPage, (page + 1) * prefs.perPage)
      : sections.slice(0, count)
    : [];

  const openSection = async (id: string) => {
    try {
      setOpen(await admin<AdminCommentsView>(`/v1/admin/comments/${encodeURIComponent(id)}`));
    } catch (e) {
      show(message(e));
    }
  };

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <p className="small muted">
        What people say on each content page, as one hash-chained log. Turning a page's comments off keeps the block headers but sends no
        comment data: clients see that something was removed here. Comments hidden one by one stay that way until shown again. Flushing a
        page removes everything this node keeps about it. Pages without comments hold nothing and are not listed.
      </p>
      <div className="row">
        <input
          type="text"
          value={pick}
          placeholder="Open a comment section by content id"
          onChange={(e) => setPick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pick.trim()) void openSection(pick.trim());
          }}
          style={{ flex: 1 }}
        />
        <button className="primary" disabled={!pick.trim()} onClick={() => void openSection(pick.trim())}>
          Open
        </button>
        <ListControls
          prefs={prefs}
          save={(patch) => {
            savePaging(patch);
            setPage(0);
            setCount(patch.perPage ?? prefs.perPage);
          }}
        />
      </div>
      {sections && prefs.paging === 'pages' && (
        <Pager page={page} perPage={prefs.perPage} total={total} loading={false} go={setPage} />
      )}
      {!sections ? (
        <Loading />
      ) : sections.length === 0 ? (
        <p className="small muted">No comment sections yet.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {visible.map((section) => (
                <tr key={section.content} style={{ cursor: 'pointer' }} title="Open details" onClick={() => void openSection(section.content)}>
                  <td className="mono small">{section.content}</td>
                  <td className="small">
                    {section.blocks} blocks · {section.hidden} hidden
                  </td>
                  <td>
                    <span className={`badge ${section.shown ? 'ok' : 'danger'}`}>{section.shown ? 'shown' : 'data kept back'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sections && prefs.paging === 'lazy' && (
        <>
          <Sentinel onMore={() => setCount((n) => n + prefs.perPage)} done={count >= total} />
          {count < total && (
            <p className="hint">
              Scroll for more ({Math.min(count, total)} of {total})
            </p>
          )}
        </>
      )}
      {sections && prefs.paging === 'pages' && (
        <Pager page={page} perPage={prefs.perPage} total={total} loading={false} go={setPage} />
      )}
      {open && (
        <div className="card form-stack">
          <div className="row between">
            <h3 style={{ margin: 0 }}>{open.content}</h3>
            <div className="row" style={{ gap: 8 }}>
              {open.blocks > 0 && (
                <>
                  <button
                    className="small"
                    title="Remove every block, vote and hiding this node keeps for the page"
                    onClick={async () => {
                      try {
                        await admin(`/v1/admin/comments/${encodeURIComponent(open.content)}`, { method: 'DELETE' });
                        setOpen(null);
                        show('All comment data of this page is gone.');
                        load();
                      } catch (e) {
                        show(message(e));
                      }
                    }}
                  >
                    Flush all comment data
                  </button>
                  <button
                    className={open.shown ? '' : 'primary'}
                    onClick={async () => {
                      try {
                        setOpen(
                          await admin<AdminCommentsView>(`/v1/admin/comments/${encodeURIComponent(open.content)}`, {
                            method: 'PUT',
                            body: { shown: !open.shown },
                          })
                        );
                        load();
                      } catch (e) {
                        show(message(e));
                      }
                    }}
                  >
                    {open.shown ? 'Turn comments off (keep headers only)' : 'Turn comments on'}
                  </button>
                </>
              )}
              <button className="small ghost" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          </div>
          {open.blocks === 0 ? (
            <p className="small muted">No comments on this page.</p>
          ) : (
            <>
          <p className="small muted">
            {open.blocks} blocks in the chain. Clients verify every header; {open.comments.length} comments carry data here.
          </p>
          {open.comments.map((comment) => (
            <div key={comment.id} style={{ borderTop: '1px solid var(--border, #eee)', paddingTop: 10 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <strong className="small">{comment.key ? `${comment.key.slice(0, 14)}…` : 'Anonymous'}</strong>
                {comment.time && <span className="tiny faint">{comment.time}</span>}
                <span className="tiny faint">
                  {comment.likes} likes · {comment.dislikes} dislikes
                  {comment.replyFrom !== '0' ? ' · a reply' : ''}
                </span>
                {comment.hidden && <span className="badge danger">hidden</span>}
              </div>
              <div style={{ margin: '6px 0' }}>{comment.text}</div>
              <button
                className="small"
                onClick={async () => {
                  try {
                    setOpen(
                      await admin<AdminCommentsView>(
                        `/v1/admin/comments/${encodeURIComponent(open.content)}/${encodeURIComponent(comment.id)}/${comment.hidden ? 'show' : 'hide'}`,
                        { method: 'POST', body: {} }
                      )
                    );
                    load();
                  } catch (e) {
                    show(message(e));
                  }
                }}
              >
                {comment.hidden ? 'Show again' : 'Hide (keep the header only)'}
              </button>
            </div>
          ))}
          {open.comments.length === 0 && <p className="small muted">No comment data here (every block may be hidden, or none were written).</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
