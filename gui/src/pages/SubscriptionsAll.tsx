import { Search, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Subscription } from '../../../src/shared/clientapi';
import type { CreatorInfo, TopicInfo } from '../../../src/shared/protocol';
import { CREATOR_KIND_LABELS } from '../../../src/shared/taxonomy';
import { api, errorMessage } from '../api';
import { Avatar, Empty } from '../components/ui';
import { useApp } from '../state';
import { profilePath } from '../util';

/** Creators matching the query, each with a Subscribe button (or Unsubscribe). */
function AddSubscriptions({ subscriptions }: { subscriptions: Subscription[] }) {
  const { refresh, toast } = useApp();
  const [query, setQuery] = useState('');
  const [creators, setCreators] = useState<CreatorInfo[]>([]);
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [directId, setDirectId] = useState('');
  const [directName, setDirectName] = useState('');

  useEffect(() => {
    let live = true;
    const text = query.trim();
    if (!text) {
      setCreators([]);
      setTopics([]);
      return;
    }
    // Creators, groups and topics: a group is a creator, a topic its own kind of page.
    api<{ creators: CreatorInfo[] }>(`/api/creators?q=${encodeURIComponent(text)}`)
      .then((result) => live && setCreators(result.creators))
      .catch(() => live && setCreators([]));
    api<{ topics: TopicInfo[] }>(`/api/topics?q=${encodeURIComponent(text)}`)
      .then((result) => live && setTopics(result.topics))
      .catch(() => live && setTopics([]));
    return () => {
      live = false;
    };
  }, [query]);

  const toggleTopic = async (topic: TopicInfo) => {
    try {
      const subscribed = subscriptions.some((subscription) => subscription.id === topic.id);
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(topic.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: topic.id, name: topic.name, kind: 'topic', icon: topic.icon } });
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const toggle = async (creator: { id: string; name: string; kind?: CreatorInfo['kind'] }) => {
    try {
      const subscribed = subscriptions.some((subscription) => subscription.id === creator.id);
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(creator.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: creator.id, name: creator.name, kind: creator.kind } });
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const addDirect = async () => {
    const id = directId.trim();
    if (!id) return;
    try {
      await api('/api/subscriptions', { body: { id, name: directName.trim() || id } });
      setDirectId('');
      setDirectName('');
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  return (
    <div className="card form-stack" style={{ marginTop: 26 }}>
      <h2>Add subscriptions</h2>
      <p className="small muted">Search for a creator, a group or a topic by name, or paste a creator id to follow them.</p>
      <label className="field">
        Search creators, groups and topics
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, @handle, platform id, topic…" />
      </label>
      {creators.length > 0 && (
        <div className="page-list">
          {creators.map((creator) => {
            const subscribed = subscriptions.some((subscription) => subscription.id === creator.id);
            return (
              <div key={creator.id} className="page-row">
                <Link to={profilePath(creator.kind, creator.id)} className="row" style={{ gap: 10, flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}>
                  <Avatar name={creator.name} id={creator.id} icon={creator.icon} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{creator.name}</strong>
                    <div className="tiny faint">
                      {CREATOR_KIND_LABELS[creator.kind]}
                      {creator.accounts?.length ? ` · ${creator.accounts.map((account) => account.platform).join(', ')}` : ''}
                    </div>
                  </div>
                </Link>
                <button className={subscribed ? '' : 'primary'} onClick={() => toggle(creator)}>
                  {subscribed ? 'Unsubscribe' : 'Subscribe'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {topics.length > 0 && (
        <div className="page-list">
          {topics.map((topic) => {
            const subscribed = subscriptions.some((subscription) => subscription.id === topic.id);
            return (
              <div key={topic.id} className="page-row">
                <Link to={profilePath('topic', topic.id)} className="row" style={{ gap: 10, flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}>
                  <Avatar name={topic.name} id={topic.id} icon={topic.icon} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{topic.name}</strong>
                    <div className="tiny faint">Topic · {topic.items ?? 0} item{(topic.items ?? 0) === 1 ? '' : 's'}</div>
                  </div>
                </Link>
                <button className={subscribed ? '' : 'primary'} onClick={() => void toggleTopic(topic)}>
                  {subscribed ? 'Unsubscribe' : 'Subscribe'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: 2, minWidth: 200 }}>
          Creator id
          <input type="text" className="mono" value={directId} onChange={(e) => setDirectId(e.target.value)} placeholder="name:labs, yt:UC…, vs:creator:…" />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Name (optional)
          <input type="text" value={directName} onChange={(e) => setDirectName(e.target.value)} />
        </label>
        <button className="primary" onClick={addDirect} disabled={!directId.trim()}>
          <UserPlus size={16} /> Subscribe
        </button>
      </div>
    </div>
  );
}

/** Every subscription on one page: search through them, unsubscribe, add new ones. */
export function AllSubscriptionsPage() {
  const { state, refresh, toast } = useApp();
  const [query, setQuery] = useState('');
  if (!state) return null;
  const subscriptions = state.subscriptions;

  const unsubscribe = async (subscription: Subscription) => {
    try {
      await api(`/api/subscriptions/${encodeURIComponent(subscription.id)}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const text = query.trim().toLowerCase();
  const shown = text
    ? subscriptions.filter((subscription) => subscription.name.toLowerCase().includes(text) || subscription.id.toLowerCase().includes(text))
    : subscriptions;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>All subscriptions</h1>
          <p>Every creator you follow, on one page. Search through them, unsubscribe, or add new ones.</p>
        </div>
        <Link className="button" to="/subscriptions">
          Back to the feed
        </Link>
      </div>
      <div className="card form-stack">
        <label className="field">
          <span className="row" style={{ gap: 6 }}>
            <Search size={15} /> Search subscriptions
          </span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or id…" />
        </label>
        {subscriptions.length === 0 ? (
          <Empty icon={<Users size={42} />} title="No subscriptions yet">
            <p>Add creators below — or open any content or creator page and press Subscribe.</p>
          </Empty>
        ) : shown.length === 0 ? (
          <p className="small muted">No subscription matches “{query.trim()}”.</p>
        ) : (
          <div className="page-list">
            {shown.map((subscription) => (
              <div key={subscription.id} className="page-row">
                <Link to={profilePath(subscription.kind, subscription.id)} className="row" style={{ gap: 10, flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}>
                  <Avatar name={subscription.name} id={subscription.id} icon={subscription.icon} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{subscription.name}</strong>
                    <div className="tiny faint">
                      {subscription.kind === 'topic' ? 'Topic' : subscription.kind === 'group' ? 'Group' : 'Creator'} ·{' '}
                      <span className="mono">{subscription.id}</span>
                    </div>
                  </div>
                </Link>
                <button className="ghost icon small" onClick={() => unsubscribe(subscription)} aria-label={`Unsubscribe from ${subscription.name}`}>
                  <X size={13} /> Unsubscribe
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <AddSubscriptions subscriptions={subscriptions} />
    </div>
  );
}
