import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SOURCE_CATALOG } from '../../../src/algorithm/sources';
import type { FeedResponse } from '../../../src/shared/clientapi';
import type { CreatorInfo, TopicInfo } from '../../../src/shared/protocol';
import { CREATOR_KIND_LABELS, CREATOR_KINDS, FORMAT_LABELS, FORMATS, RATING_LABELS, RATINGS, TOPICS, type CreatorKind, type Format, type Rating } from '../../../src/shared/taxonomy';
import { api, errorMessage } from '../api';
import { Feed } from '../components/Feed';
import { Chips, toggle, Avatar, Modal } from '../components/ui';
import { useApp } from '../state';
import { groupPath, profilePath, topicPath } from '../util';

/** Groups matching the query: a group is searched and subscribed to like a creator. */
function GroupResults({ query }: { query: string }) {
  const [groups, setGroups] = useState<CreatorInfo[]>([]);
  useEffect(() => {
    let live = true;
    api<{ creators: CreatorInfo[] }>(`/api/creators?kind=group&q=${encodeURIComponent(query.trim())}`)
      .then((result) => live && setGroups(result.creators))
      .catch(() => live && setGroups([]));
    return () => {
      live = false;
    };
  }, [query]);
  if (!groups.length) return null;
  return (
    <div className="card form-stack" style={{ marginBottom: 24 }}>
      <h2>Groups</h2>
      <div className="page-list">
        {groups.map((group) => (
          <Link key={group.id} to={groupPath(group.id)} className="page-row" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Avatar name={group.name} id={group.id} icon={group.icon} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{group.name}</strong>
              <div className="tiny faint">
                {group.members?.length ?? 0} creator{(group.members?.length ?? 0) === 1 ? '' : 's'}
                {group.description ? ` · ${group.description}` : ''}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Creators matching the query (Explore shows creators too, and not only exact names). */
function CreatorResults({ query }: { query: string }) {
  const [creators, setCreators] = useState<CreatorInfo[]>([]);
  useEffect(() => {
    let live = true;
    api<{ creators: CreatorInfo[] }>(`/api/creators?q=${encodeURIComponent(query.trim())}`)
      .then((result) => live && setCreators(result.creators))
      .catch(() => live && setCreators([]));
    return () => {
      live = false;
    };
  }, [query]);
  if (!creators.length) return null;
  return (
    <div className="card form-stack" style={{ marginBottom: 24 }}>
      <h2>Creators</h2>
      <div className="page-list">
        {creators.map((creator) => (
          <Link key={creator.id} to={profilePath(creator.kind, creator.id)} className="page-row" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Avatar name={creator.name} id={creator.id} icon={creator.icon} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{creator.name}</strong>
              <div className="tiny faint">
                {CREATOR_KIND_LABELS[creator.kind]}
                {creator.accounts?.length ? ` · ${creator.accounts.map((account) => account.platform).join(', ')}` : ''}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
/**
 * Topics matching the query, each opening on its topic page. When no topic matches yet,
 * the user can bring one: the node stores it under the hash of its name, so the same name
 * always means the same topic.
 */
function TopicResults({ query }: { query: string }) {
  const { state, toast } = useApp();
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(0);
  const trimmed = query.trim();

  useEffect(() => {
    let live = true;
    api<{ topics: TopicInfo[] }>(`/api/topics?q=${encodeURIComponent(trimmed)}`)
      .then((result) => live && setTopics(result.topics))
      .catch(() => live && setTopics([]));
    return () => {
      live = false;
    };
  }, [trimmed, added]);

  useEffect(() => setName(trimmed), [trimmed]);
  const node = state?.nodes.find((entry) => entry.type === 'algorithm' && entry.enabled);

  const create = async () => {
    if (!node || !name.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ topic: TopicInfo; newInfo: boolean }>('/api/topics', {
        body: { nodeId: node.id, name: name.trim(), description: description.trim() || undefined },
      });
      toast(result.newInfo ? `Topic “${result.topic.name}” created` : `“${result.topic.name}” already exists`, 'success');
      setOpen(false);
      setDescription('');
      setAdded(added + 1);
      setTopics((list) => (list.some((topic) => topic.id === result.topic.id) ? list : [result.topic, ...list]));
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack" style={{ marginBottom: 24 }}>
      <div className="row between">
        <h2>Topics</h2>
        <button className="small" disabled={!node} title={node ? 'Bring a topic the nodes do not have yet' : 'No algorithm node is enabled'} onClick={() => setOpen(true)}>
          + Create a topic
        </button>
      </div>
      {topics.length ? (
        <div className="page-list">
          {topics.map((topic) => (
            <Link key={topic.id} to={topicPath(topic.id)} className="page-row" style={{ textDecoration: 'none', color: 'inherit' }}>
              <Avatar name={topic.name} id={topic.id} icon={topic.icon} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{topic.name}</strong>
                <div className="tiny faint">
                  {topic.items ?? 0} item{(topic.items ?? 0) === 1 ? '' : 's'}
                  {topic.description ? ` · ${topic.description}` : ''}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <span className="hint">No topic matches yet. Create it and the content filed under it shows on its page.</span>
      )}
      {open && (
        <Modal title="Create a topic" onClose={() => setOpen(false)}>
          <div className="form-stack">
            <label className="field">
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Science" />
            </label>
            <label className="field">
              Description <span className="hint">Optional</span>
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What belongs in this topic" />
            </label>
            <span className="hint">The topic id is the hash of its name: every node and every user asking for this name lands on the same topic.</span>
            <div className="row">
              <button className="primary" disabled={busy || !name.trim() || !node} onClick={() => void create()}>
                {busy ? 'Creating…' : 'Create topic'}
              </button>
              <button onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

}

/** What Explore shows: content, creators, groups, topics, or all of them (all by default). */
const SHOW_KINDS = ['content', 'creators', 'groups', 'topics'] as const;
type ShowKind = (typeof SHOW_KINDS)[number];
const SHOW_LABELS: Record<ShowKind, string> = { content: 'Content', creators: 'Creators', groups: 'Groups', topics: 'Topics' };

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [showFilters, setShowFilters] = useState(true);
  const [show, setShow] = useState<ShowKind[]>([...SHOW_KINDS]);
  const [formats, setFormats] = useState<Format[]>([]);
  const [rating, setRating] = useState<Rating | ''>('');
  const [topics, setTopics] = useState<string[]>([]);
  const [kinds, setKinds] = useState<CreatorKind[]>([]);
  const [platform, setPlatform] = useState('');
  const [sort, setSort] = useState<'relevance' | 'new' | 'top'>('relevance');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{query ? `Results for “${query}”` : 'Explore'}</h1>
          <p>
            Try <code>#tag</code>, <code>@creator</code>, <code>format:music</code> or <code>topic:science</code>. Leave empty to browse everything.
          </p>
        </div>
        <div className="row">
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ width: 'auto' }}>
            <option value="relevance">Most relevant</option>
            <option value="new">Newest</option>
            <option value="top">Top rated</option>
          </select>
          <button onClick={() => setShowFilters(!showFilters)}>
            <SlidersHorizontal size={16} /> Filters
          </button>
        </div>
      </div>
      {showFilters && (
        <div className="card form-stack" style={{ marginBottom: 24 }}>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Show</div>
            <Chips options={SHOW_KINDS} selected={show} labels={SHOW_LABELS} onToggle={(v) => setShow(toggle(show, v))} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Format</div>
            <Chips options={FORMATS} selected={formats} labels={FORMAT_LABELS} onToggle={(v) => setFormats(toggle(formats, v))} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Topic</div>
            <Chips options={TOPICS} selected={topics} onToggle={(v) => setTopics(toggle(topics, v))} />
          </div>
          <div className="form-grid">
            <label className="field">
              Age rating up to
              <select value={rating} onChange={(e) => setRating(e.target.value as Rating | '')}>
                <option value="">My preference</option>
                {RATINGS.map((r) => (
                  <option key={r} value={r}>
                    {RATING_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Platform
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">Any platform</option>
                {SOURCE_CATALOG.map((source) => (
                  <option key={source.key} value={source.key}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              Creator
              <Chips options={CREATOR_KINDS.filter((k) => k !== 'unknown')} selected={kinds} labels={CREATOR_KIND_LABELS} onToggle={(v) => setKinds(toggle(kinds, v))} />
            </div>
          </div>
          {query && (
            <div>
              <button className="small" onClick={() => setParams({})}>
                Clear search
              </button>
            </div>
          )}
        </div>
      )}
      {show.includes('creators') && <CreatorResults query={query} />}
      {show.includes('groups') && <GroupResults query={query} />}
      {show.includes('topics') && <TopicResults query={query} />}
      {show.includes('content') && (
        <Feed
          deps={[query, formats.join(), rating, topics.join(), kinds.join(), platform, sort]}
          load={(cursor) =>
            api<FeedResponse>('/api/search', {
              body: {
                query,
                sort,
                cursor,
                filters: {
                  formats: formats.length ? formats : undefined,
                  maxRating: rating || undefined,
                  topics: topics.length ? topics : undefined,
                  onlyTopics: topics.length ? true : undefined,
                  creatorKinds: kinds.length ? kinds : undefined,
                  platform: platform || undefined,
                },
              },
            })
          }
        />
      )}
      {show.length === 0 && <div className="banner info small">Choose what to show above: content, creators, groups, topics, or all of them.</div>}
    </div>
  );
}
