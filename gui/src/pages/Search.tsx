import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FeedResponse } from '../../../src/shared/clientapi';
import { CREATOR_KIND_LABELS, CREATOR_KINDS, FORMAT_LABELS, FORMATS, RATING_LABELS, RATINGS, TOPICS, type CreatorKind, type Format, type Rating } from '../../../src/shared/taxonomy';
import { api } from '../api';
import { Feed } from '../components/Feed';
import { Chips, toggle } from '../components/ui';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [showFilters, setShowFilters] = useState(true);
  const [formats, setFormats] = useState<Format[]>([]);
  const [rating, setRating] = useState<Rating | ''>('');
  const [topics, setTopics] = useState<string[]>([]);
  const [kinds, setKinds] = useState<CreatorKind[]>([]);
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
      <Feed
        deps={[query, formats.join(), rating, topics.join(), kinds.join(), sort]}
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
              },
            },
          })
        }
      />
    </div>
  );
}
