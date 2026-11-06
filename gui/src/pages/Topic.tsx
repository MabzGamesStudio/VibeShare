import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TopicView } from '../../../src/shared/clientapi';
import type { TopicInfo, TopicSuggestion, TopicSuggestionResponse } from '../../../src/shared/protocol';
import { api, errorMessage } from '../api';
import { GridLayout } from '../components/feed/Cards';
import { CARD_PAGE } from '../components/Feed';
import { Avatar, CopyButton, Empty, Loading, Modal } from '../components/ui';
import { useApp } from '../state';
import { topicPath } from '../util';

/**
 * Suggesting what a topic's description or icon should say. The id never changes: it is
 * the hash of the name, so a topic stays the same category however it is described.
 */
function SuggestTopic({ topic, nodeId, onSaved }: { topic: TopicInfo; nodeId: string; onSaved: () => void }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [icon, setIcon] = useState<string | undefined>();
  const [mine, setMine] = useState<TopicSuggestion[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ suggestions: TopicSuggestion[] }>(`/api/topics/suggestions/${encodeURIComponent(nodeId)}`)
      .then((result) => setMine(result.suggestions.filter((s) => s.topicId === topic.id)))
      .catch(() => setMine([]));
  }, [nodeId, topic.id]);
  useEffect(load, [load]);

  const pickIcon = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api<TopicSuggestionResponse>('/api/topics/suggestions', {
        body: { nodeId, topic: topic.id, description: description.trim() || undefined, icon, reason: reason.trim() || undefined },
      });
      toast(result.newInfo ? 'Suggested — the operator reviews it' : 'This is already waiting', 'success');
      setDescription('');
      setReason('');
      setIcon(undefined);
      setOpen(false);
      load();
      onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <div className="row between">
        <h3>Suggest a description or icon for {topic.name}</h3>
        <button className="small" onClick={() => setOpen(true)}>
          + Suggest description or icon
        </button>
      </div>
      {open && (
        <Modal title={`Suggest for ${topic.name}`} onClose={() => setOpen(false)}>
          <div className="form-stack">
            <label className="field">
              Description
              <textarea
                rows={3}
                placeholder={topic.description ?? 'What belongs in this topic'}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="field">
              Topic icon
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => pickIcon(e.target.files?.[0])} />
            </label>
            {icon && (
              <div className="row">
                <Avatar name={topic.name} id={topic.id} icon={icon} />
                <span className="hint">This is the icon you suggest.</span>
              </div>
            )}
            <label className="field">
              Why
              <input type="text" placeholder="Optional: where you saw it" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              <button className="primary" disabled={busy || (!description.trim() && !icon)} onClick={() => void submit()}>
                {busy ? 'Sending…' : 'Send suggestion'}
              </button>
              <button onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
      {mine.length > 0 && (
        <div className="page-list">
          {mine.map((suggestion) => (
            <div key={suggestion.id} className="page-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                {[suggestion.description ? `description → ${suggestion.description}` : '', suggestion.icon ? 'icon' : ''].filter(Boolean).join(' · ')}
              </div>
              <span className={`badge ${suggestion.status === 'accepted' ? 'ok' : ''}`}>
                {suggestion.status === 'accepted' ? 'accepted' : suggestion.status === 'rejected' ? 'dropped' : 'waiting for the operator'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A topic page: a category of content, with the newest content filed under it, its
 * description and the buttons to suggest a description or a topic icon. A topic is
 * subscribed to exactly like a creator.
 */
export function TopicPage() {
  const { id = '' } = useParams();
  const { state, refresh, toast } = useApp();
  const [view, setView] = useState<TopicView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<TopicView>(`/api/topics/${encodeURIComponent(id)}`)
      .then(setView)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(() => {
    setView(null);
    setError(null);
    load();
  }, [load]);

  if (error) {
    return (
      <div className="page">
        <div className="banner danger">{error}</div>
      </div>
    );
  }
  if (!view || !state) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  const { topic } = view;
  const subscribed = state.subscriptions.some((s) => s.id === topic.id);

  const toggle = async () => {
    try {
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(topic.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: topic.id, name: topic.name, kind: 'topic', icon: topic.icon } });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ gap: 20, marginBottom: 12, alignItems: 'flex-start' }}>
        <Avatar name={topic.name} id={topic.id} large icon={topic.icon} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>
            <Link to={topicPath(topic.id)} className="link">
              {topic.name}
            </Link>
          </h1>
          <div className="row small muted" style={{ marginTop: 6 }}>
            <span className="badge">Topic</span>
            <span>
              {view.items.length} item{view.items.length === 1 ? '' : 's'}
            </span>
          </div>
          {topic.description && (
            <p className="muted" style={{ marginTop: 10 }}>
              {topic.description}
            </p>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className={subscribed ? '' : 'primary'} onClick={toggle}>
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </button>
            <CopyButton text={topic.id} label="Copy topic id" small={false} />
          </div>
        </div>
      </div>
      {view.via && <SuggestTopic topic={topic} nodeId={view.via} onSaved={load} />}
      {view.items.length ? (
        <GridLayout items={view.items} page={CARD_PAGE} />
      ) : (
        <Empty title="No content yet">
          <p>No content carrying this topic id is listed on your algorithm nodes.</p>
        </Empty>
      )}
    </div>
  );
}

