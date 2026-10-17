import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SOURCE_CATALOG } from '../../../src/algorithm/sources';
import type { FeedResponse } from '../../../src/shared/clientapi';
import type { CreatorInfo } from '../../../src/shared/protocol';
import { CREATOR_KIND_LABELS, CREATOR_KINDS, FORMAT_LABELS, FORMATS, RATING_LABELS, RATINGS, TOPICS, type CreatorKind, type Format, type Rating } from '../../../src/shared/taxonomy';
import { api } from '../api';
import { Feed } from '../components/Feed';
import { Chips, toggle, Avatar } from '../components/ui';

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
          <Link key={creator.id} to={`/creator/${encodeURIComponent(creator.id)}`} className="page-row" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Avatar name={creator.name} id={creator.id} />
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
}

/** What Explore shows: content, creators, or both (both by default). */
const SHOW_KINDS = ['content', 'creators'] as const;
type ShowKind = (typeof SHOW_KINDS)[number];
const SHOW_LABELS: Record<ShowKind, string> = { content: 'Content', creators: 'Creators' };

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
      {show.length === 0 && <div className="banner info small">Choose what to show above: content, creators, or both.</div>}
    </div>
  );
}
