// The comments section of a content page: a hash-chained history kept by a search
// algorithm node. Nothing is shown until every block header and signature verifies;
// comments the node keeps back appear as removals. The user comments, replies, votes,
// edits their own comments and asks for them to go — anonymously if they choose — and
// decides how much of the posting time is written down.
import { Pencil, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  checkCommentChain,
  COMMENT_TIME_PRECISIONS,
  type ChainEntry,
  type CommentEntry,
  type CommentTimePrecision,
} from '../../../src/shared/comments';
import type { CommentPostRequest, CommentsResponse } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { Loading } from './ui';

const PRECISION_LABELS: Record<CommentTimePrecision, string> = {
  datetime: 'Date and time',
  date: 'Date only',
  year: 'Year only',
  none: 'Hide the date',
};

const PRECISION_HINTS: Record<CommentTimePrecision, string> = {
  datetime: 'the exact date and time',
  date: 'the date only',
  year: 'the year only',
  none: 'nothing at all',
};

/** How deep a comment sits in the reply chain (following replyFrom links). */
function depthOf(entry: CommentEntry, byId: Map<string, CommentEntry>): number {
  let depth = 0;
  let current: CommentEntry | undefined = entry;
  const seen = new Set<string>();
  while (current && current.replyFrom !== '0' && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.replyFrom);
    if (current) depth++;
    if (depth > 20) break;
  }
  return depth;
}

export function Comments({ contentId }: { contentId: string }) {
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [precision, setPrecision] = useState<CommentTimePrecision>('datetime');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [editing, setEditing] = useState<CommentEntry | null>(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<CommentsResponse>(`/api/comments/${encodeURIComponent(contentId)}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [contentId]);

  useEffect(() => {
    setData(null);
    setError(null);
    setReplyTo(null);
    setEditing(null);
    void load();
  }, [load]);

  const send = async (body: CommentPostRequest): Promise<boolean> => {
    setBusy(true);
    try {
      await api(`/api/comments/${encodeURIComponent(contentId)}`, { body });
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const vote = async (comment: string, value: 1 | -1 | 0) => {
    try {
      await api(`/api/comments/${encodeURIComponent(contentId)}/${encodeURIComponent(comment)}/vote`, { body: { vote: value } });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async (comment: string) => {
    try {
      await api(`/api/comments/${encodeURIComponent(contentId)}/${encodeURIComponent(comment)}/remove`, { body: {} });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const chain = data ? checkCommentChain(data.blocks, data.votes) : null;
  const broken = chain !== null && chain.errors.length > 0;
  const entries: ChainEntry[] = chain && !broken ? chain.entries : [];
  const byId = new Map(entries.filter((entry): entry is CommentEntry => !('removed' in entry)).map((entry) => [entry.id, entry]));

  return (
    <div className="card form-stack" style={{ marginTop: 24 }}>
      <h3>Comments</h3>
      {error && <div className="banner danger small">{error}</div>}
      {broken && (
        <div className="banner danger">
          The comment chain of this page does not verify — {chain!.errors[0]} — so no comments are shown. The data the node sent has been
          changed or cut.
        </div>
      )}
      {!data && !error && <Loading />}

      <div className="form-stack">
        <textarea rows={3} value={text} placeholder="Add a comment" onChange={(e) => setText(e.target.value)} disabled={busy} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Post anonymously
          </label>
          <label className="row small" style={{ gap: 6 }}>
            Write down
            <select value={precision} onChange={(e) => setPrecision(e.target.value as CommentTimePrecision)} style={{ width: 'auto' }}>
              {COMMENT_TIME_PRECISIONS.map((option) => (
                <option key={option} value={option}>
                  {PRECISION_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={busy || !text.trim()}
            onClick={async () => {
              if (await send({ text, anonymous, timePrecision: precision })) {
                setText('');
                setAnonymous(false);
              }
            }}
          >
            Comment
          </button>
        </div>
        <p className="hint">
          Your comment is signed with your key; only you can edit or remove it later. Anonymous comments show as “Anonymous” and can never be
          edited or removed. The node writes down {PRECISION_HINTS[precision]} of when you posted.
        </p>
      </div>

      <div className="form-stack">
        {entries.map((entry, index) => {
          if ('removed' in entry) {
            return (
              <div key={`removed-${index}`} className="small muted" style={{ fontStyle: 'italic' }}>
                A comment was removed by the node operator.
              </div>
            );
          }
          const mine = !entry.anonymous && entry.key === data?.you;
          const depth = depthOf(entry, byId);
          return (
            <div key={entry.id} style={{ marginLeft: depth * 24, borderTop: '1px solid var(--border, #eee)', paddingTop: 10 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <strong className="small">{entry.anonymous ? 'Anonymous' : `${entry.key!.slice(0, 14)}…`}</strong>
                {entry.time && <span className="tiny faint">{entry.time}</span>}
                {entry.edited && <span className="tiny faint">(edited)</span>}
              </div>
              <div style={{ margin: '6px 0' }}>{entry.text}</div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <button
                  className="small ghost"
                  title={entry.mine === 1 ? 'Take your like back' : 'Like'}
                  onClick={() => void vote(entry.id, entry.mine === 1 ? 0 : 1)}
                >
                  <ThumbsUp size={13} /> {entry.likes}
                </button>
                <button
                  className="small ghost"
                  title={entry.mine === -1 ? 'Take your dislike back' : 'Dislike'}
                  onClick={() => void vote(entry.id, entry.mine === -1 ? 0 : -1)}
                >
                  <ThumbsDown size={13} /> {entry.dislikes}
                </button>
                <button
                  className="small ghost"
                  onClick={() => {
                    setEditing(null);
                    setReplyTo(replyTo === entry.id ? null : entry.id);
                    setReplyText('');
                  }}
                >
                  Reply
                </button>
                {mine && (
                  <button
                    className="small ghost"
                    onClick={() => {
                      setReplyTo(null);
                      setEditing(editing?.id === entry.id ? null : entry);
                      setEditText(editing?.id === entry.id ? '' : entry.text);
                    }}
                  >
                    <Pencil size={13} /> Edit
                  </button>
                )}
                {mine && (
                  <button className="small ghost" title="Ask for this comment to be removed" onClick={() => void remove(entry.id)}>
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
              {replyTo === entry.id && (
                <div className="form-stack" style={{ margin: '8px 0 8px 24px' }}>
                  <textarea
                    rows={2}
                    value={replyText}
                    placeholder={`Reply to ${entry.anonymous ? 'Anonymous' : 'this comment'}`}
                    onChange={(e) => setReplyText(e.target.value)}
                  />
                  <div className="row">
                    <button
                      className="primary small"
                      disabled={busy || !replyText.trim()}
                      onClick={async () => {
                        if (await send({ text: replyText, replyFrom: entry.id, anonymous, timePrecision: precision })) {
                          setReplyTo(null);
                          setReplyText('');
                        }
                      }}
                    >
                      Reply
                    </button>
                    <button className="small" onClick={() => setReplyTo(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {editing?.id === entry.id && (
                <div className="form-stack" style={{ margin: '8px 0 8px 24px' }}>
                  <textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} />
                  <div className="row">
                    <button
                      className="primary small"
                      disabled={busy || !editText.trim()}
                      onClick={async () => {
                        if (await send({ text: editText, editOf: entry.id, replyFrom: entry.replyFrom })) {
                          setEditing(null);
                          setEditText('');
                        }
                      }}
                    >
                      Save
                    </button>
                    <button className="small" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                  <p className="hint">An edit is a new block in the chain; the earlier text stays in the history.</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {data && entries.length === 0 && !broken && <p className="small muted">No comments yet.</p>}
    </div>
  );
}