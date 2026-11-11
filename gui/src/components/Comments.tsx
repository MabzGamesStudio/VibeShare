// A verified comment chain presented as a foldable reply tree. Verification and the wire
// format stay in shared/comments; this component only changes composition and presentation.
import { ChevronDown, ChevronRight, MessageCircle, MoreHorizontal, Pencil, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  checkCommentChain,
  COMMENT_ORDERS,
  COMMENT_ORDER_LABELS,
  COMMENT_TIME_PRECISIONS,
  type ChainEntry,
  type CommentEntry,
  type CommentOrder,
  type CommentTimePrecision,
} from '../../../src/shared/comments';
import type { CommentPostRequest, CommentsResponse } from '../../../src/shared/clientapi';
import { commentThreads, formatCommentDate, type CommentDateDisplay, type CommentThread } from '../../../src/shared/comment-view';
import { api, errorMessage } from '../api';
import { useSentinel } from './feed/usePaged';
import { Loading, Spinner } from './ui';

const PRECISION_LABELS: Record<CommentTimePrecision, string> = {
  datetime: 'Date and time',
  date: 'Date only',
  year: 'Year only',
  none: 'Hide the date',
};

type DateDisplay = CommentDateDisplay;
const DATE_DISPLAY_LABELS: Record<DateDisplay, string> = {
  relative: 'Relative (2 hours ago)',
  local: 'Local date and time',
  iso: 'ISO 8601',
  hidden: 'Hide dates',
};

type Thread = CommentThread;

/** How many open panels are holding the page still. */
let scrollLocks = 0;

/**
 * Keeps the page behind a comments panel where it is: only the panel itself scrolls
 * until the last open panel closes.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    scrollLocks += 1;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      scrollLocks -= 1;
      if (!scrollLocks) document.body.style.overflow = previous;
    };
  }, [active]);
}

/**
 * The drag handle at the top of the comments panel on a short or an image post. Each
 * panel keeps its own height: dragging the handle sizes it — the share it returns feeds
 * the stage's --comments-share variable, so the picture takes what is left — and letting
 * go below a fifth of the screen closes the panel instead.
 */
export function useCommentsResize(onClose: () => void): {
  share: (percent: number) => string;
  handle: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
} {
  const [height, setHeight] = useState<number | null>(null);
  const drag = useRef<{ id: number; y: number; h: number } | null>(null);
  return {
    share: (percent: number) => (height != null ? `${height}px` : `${percent}%`),
    handle: {
      onPointerDown(event) {
        const panel = event.currentTarget.closest('.short-comments');
        const stage = event.currentTarget.closest<HTMLElement>('.short-stage, .image-stage');
        if (!panel || !stage) return;
        // No scrolling or text selection while the panel is being sized.
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        // The handle starts from the panel's size on the screen — never its content height.
        drag.current = {
          id: event.pointerId,
          y: event.clientY,
          h: Math.min(panel.getBoundingClientRect().height, stage.getBoundingClientRect().height),
        };
      },
      onPointerMove(event) {
        const current = drag.current;
        const stage = event.currentTarget.closest<HTMLElement>('.short-stage, .image-stage');
        if (!current || !stage || event.pointerId !== current.id) return;
        // Straight into the variable, no re-render per move: the picture resizes with the
        // panel live, and the height is committed to state only when the handle is let go.
        const next = Math.max(0, Math.min(stage.getBoundingClientRect().height, current.h + (current.y - event.clientY)));
        stage.style.setProperty('--comments-share', `${next}px`);
      },
      onPointerUp(event) {
        const current = drag.current;
        const panel = event.currentTarget.closest('.short-comments');
        if (!current || event.pointerId !== current.id) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const dropped = panel?.getBoundingClientRect().height ?? 0;
        if (dropped < window.innerHeight * 0.2) {
          // Dropped below a fifth of the screen: the panel goes away entirely.
          setHeight(null);
          onClose();
        } else {
          setHeight(dropped);
        }
      },
      onPointerCancel(event) {
        if (drag.current?.id === event.pointerId) drag.current = null;
      },
    },
  };
}

export function Comments({ contentId }: { contentId: string }) {
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [precision, setPrecision] = useState<CommentTimePrecision>('date');
  const [dateDisplay, setDateDisplay] = useState<DateDisplay>(() => {
    try {
      return (localStorage.getItem('vibeshare-comment-dates') as DateDisplay | null) ?? 'relative';
    } catch {
      return 'relative';
    }
  });
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [editing, setEditing] = useState<CommentEntry | null>(null);
  const [editText, setEditText] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // What the reader would like to see first; the algorithm search node decides the order
  // it actually sends (and which comment data loads first).
  const [order, setOrder] = useState<CommentOrder>('relevant');

  // Every answer carries all the block headers of the chain and the comment data of the
  // comments loaded so far; asking again with `offset` brings the data of the next ones.
  const load = useCallback(
    async (offset = 0) => {
      try {
        const suffix = `?order=${encodeURIComponent(order)}${offset ? `&offset=${offset}` : ''}`;
        setData(await api<CommentsResponse>(`/api/comments/${encodeURIComponent(contentId)}${suffix}`));
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [contentId, order]
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setReplyTo(null);
    setEditing(null);
    setCollapsed(new Set());
    void load();
  }, [load]);

  const chooseDateDisplay = (value: DateDisplay) => {
    setDateDisplay(value);
    try {
      localStorage.setItem('vibeshare-comment-dates', value);
    } catch {
      // The choice still works for this page when storage is unavailable.
    }
  };

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
  const entries = chain?.entries ?? [];
  const broken = Boolean(chain?.errors.length);
  const removed = entries.filter((entry): entry is Extract<ChainEntry, { removed: true }> => 'removed' in entry);
  // Comments whose data waits for the reader to scroll down to them (headers already in).
  const pending = entries.filter((entry): entry is Extract<ChainEntry, { pending: true }> => 'pending' in entry);
  const loaded = data?.loaded ?? 0;
  const total = data?.total ?? 0;
  const more = Boolean(data?.shown) && !broken && loaded < total;
  const sentinel = useSentinel(() => void load(loaded), more, loaded);
  // The order the node decided on: comments show up in it, their replies nested below.
  const rank = data?.rank ?? [];
  const rankOf = (id: string) => {
    const at = rank.indexOf(id);
    return at === -1 ? rank.length : at;
  };
  const byRank = (list: Thread[]): Thread[] =>
    [...list]
      .sort((a, b) => rankOf(a.entry.id) - rankOf(b.entry.id))
      .map((thread) => ({ ...thread, replies: byRank(thread.replies) }));
  const threads = byRank(commentThreads(entries, contentId));

  const toggleFold = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderComment = (thread: Thread): ReactNode => {
    const entry = thread.entry;
    const mine = Boolean(entry.key && entry.key === data?.you);
    const date = formatCommentDate(entry.time, dateDisplay);
    const folded = collapsed.has(entry.id);
    return (
      <article className="comment-item" key={entry.id}>
        <div className="comment-head">
          <span className={`comment-avatar${entry.anonymous ? ' anonymous' : ''}`} aria-hidden="true">
            {entry.anonymous ? 'A' : (entry.key ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <div className="comment-byline">
            <strong>{entry.anonymous ? 'Anonymous' : `Member ${entry.key?.slice(0, 10) ?? ''}…`}</strong>
            <span>
              {dateDisplay === 'hidden' ? '' : date || 'Date hidden'}
              {entry.edited ? ' · edited' : ''}
            </span>
          </div>
          {thread.replies.length > 0 && (
            <button
              className="comment-fold"
              onClick={() => toggleFold(entry.id)}
              aria-expanded={!folded}
              aria-label={folded ? `Expand ${thread.replies.length} replies` : `Collapse ${thread.replies.length} replies`}
            >
              {folded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
            </button>
          )}
        </div>
        <p className="comment-text">{entry.text}</p>
        <div className="comment-actions">
          <button className={entry.mine === 1 ? 'active' : ''} onClick={() => void vote(entry.id, entry.mine === 1 ? 0 : 1)} aria-label="Like comment">
            <ThumbsUp size={14} /> {entry.likes}
          </button>
          <button className={entry.mine === -1 ? 'active' : ''} onClick={() => void vote(entry.id, entry.mine === -1 ? 0 : -1)} aria-label="Dislike comment">
            <ThumbsDown size={14} /> {entry.dislikes}
          </button>
          <button
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
            <button className="danger" title="Ask for this comment to be removed" onClick={() => void remove(entry.id)}>
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
        {replyTo === entry.id && (
          <div className="comment-inline-form">
            <textarea
              rows={2}
              value={replyText}
              placeholder={`Reply to ${entry.anonymous ? 'Anonymous' : 'this comment'}…`}
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
                Post reply
              </button>
              <button className="small ghost" onClick={() => setReplyTo(null)}>Cancel</button>
            </div>
          </div>
        )}
        {editing?.id === entry.id && (
          <div className="comment-inline-form">
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
                Save edit
              </button>
              <button className="small ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
            <p className="hint">An edit adds a block to the verified chain; its earlier text stays in history.</p>
          </div>
        )}
        {thread.replies.length > 0 && !folded && <div className="comment-replies">{thread.replies.map(renderComment)}</div>}
      </article>
    );
  };


  return (
    <section className="comments-section">
      <div className="comments-title">
        <div>
          <h3>Comments</h3>
          <p>{entries.filter((entry) => !('removed' in entry) && !('pending' in entry)).length} verified comments and replies</p>
        </div>
        <MessageCircle size={21} aria-hidden="true" />
      </div>
      {error && <div className="banner danger small">{error}</div>}
      {broken && (
        <div className="banner danger small">
          This comment chain does not verify — {chain?.errors[0]} — so no comments are shown. Untrusted data never reaches the thread view.
        </div>
      )}
      {!broken && (
        <div className="comment-composer">
          <textarea
            rows={3}
            value={text}
            placeholder="Add to the conversation…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="comment-composer-footer">
            <div className="comment-compose-options">
              <label className="comment-anonymous">
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                <span title="The algorithm search node knows the account id that created the post, but it is not definitive whether they log who posted it.">
                  Post anonymously*
                </span>
              </label>
              {anonymous && (
                <p className="hint" style={{ margin: '4px 0 0', color: 'var(--warn)' }}>
                  There is no option to edit or delete the comment if it is anonymous after posting it.
                </p>
              )}
              <details className="comment-options">
                <summary className="comment-dots" aria-label="Comment settings" title="Comment settings">
                  <MoreHorizontal size={20} />
                </summary>
                <div className="comment-options-popover">
                  <fieldset>
                    <legend>Date format</legend>
                    {(Object.keys(DATE_DISPLAY_LABELS) as DateDisplay[]).map((value) => (
                      <label key={value}>
                        <input type="radio" name="comment-date-display" checked={dateDisplay === value} onChange={() => chooseDateDisplay(value)} />
                        <span>{DATE_DISPLAY_LABELS[value]}</span>
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>Timestamp stored on your posts</legend>
                    {COMMENT_TIME_PRECISIONS.map((value) => (
                      <label key={value}>
                        <input type="radio" name="comment-time-precision" checked={precision === value} onChange={() => setPrecision(value)} />
                        <span>{PRECISION_LABELS[value]}</span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="hint">
                    {anonymous
                      ? 'Anonymous posts cannot be edited or removed later.'
                      : 'Signed posts can be edited or removed by your key later.'}
                  </p>
                </div>
              </details>
            </div>
            <button
              className="primary comment-post"
              disabled={busy || !text.trim()}
              onClick={async () => {
                if (await send({ text, replyFrom: contentId, anonymous, timePrecision: precision })) setText('');
              }}
            >
              <MessageCircle size={15} /> Comment
            </button>
          </div>
        </div>
      )}
      {!data ? (
        <Loading />
      ) : (
        <>
          {data.shown && total > 1 && (
            <div className="segmented comment-order" role="tablist" aria-label="Comment order">
              {COMMENT_ORDERS.map((value) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={order === value}
                  className={order === value ? 'on' : ''}
                  onClick={() => setOrder(value)}
                >
                  {COMMENT_ORDER_LABELS[value]}
                </button>
              ))}
            </div>
          )}
          <div className="comment-list">
            {!broken && threads.map(renderComment)}
            {!broken && removed.map((entry) => <div className="comment-removed" key={entry.id}>A comment was removed</div>)}
            {!broken && pending.map((entry) => <div className="comment-pending" key={entry.id} aria-hidden="true" />)}
            {!broken && entries.length === 0 && <p className="comment-empty">No comments yet. Start the conversation.</p>}
          </div>
          {!broken && more && (
            <div ref={sentinel} className="comment-more">
              <Spinner />
            </div>
          )}
        </>
      )}
    </section>
  );
}
