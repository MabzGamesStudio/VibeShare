// Explore: one relevance-ordered list of everything that matches — creators, groups,
// topics and content mixed together by how well they match — with the search settings
// kept for the session, and the seed and trace id the algorithm search node needs to
// repeat the very same search.
import { SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SOURCE_CATALOG } from '../../../src/algorithm/sources';
import type { FeedItem, FeedResponse } from '../../../src/shared/clientapi';
import type { CreatorInfo, TopicInfo } from '../../../src/shared/protocol';
import {
  CREATOR_KIND_LABELS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATING_REASONS,
  RATINGS,
  TOPICS,
  type Format,
  type Rating,
} from '../../../src/shared/taxonomy';
import { api } from '../api';
import { Fields } from '../components/feed/Fields';
import { Poster } from '../components/feed/Player';
import { usePaged, useSentinel } from '../components/feed/usePaged';
import { Avatar, Chips, Spinner, toggle } from '../components/ui';
import { useApp } from '../state';
import { groupPath, profilePath, splitList, topicPath, watchPath } from '../util';

type ShowKind = 'content' | 'creators' | 'groups' | 'topics';

const SHOW_KINDS: ShowKind[] = ['content', 'creators', 'groups', 'topics'];
const SHOW_LABELS: Record<ShowKind, string> = {
  content: 'Content',
  creators: 'Creators',
  groups: 'Groups',
  topics: 'Topics',
};

/** Everything the search remembers about how the user searches, kept for the session. */
interface SearchSettings {
  show: ShowKind[];
  formats: Format[];
  /** Topics to show (names or topic ids) and topics to leave out. */
  topics: string[];
  blockedTopics: string[];
  /** Creators and groups to show (ids) and to leave out. */
  creators: string[];
  blockedCreators: string[];
  /** The age restriction of this search (empty = the account's own preference). */
  rating: Rating | '';
  /** Content warning types to leave out entirely. */
  disregard: string[];
  /** Platforms to search in, and platforms to leave out. */
  platforms: string[];
  blockedPlatforms: string[];
  sort: 'relevance' | 'new' | 'top';
  /** endless: results load as the reader scrolls; pages: a page at a time. */
  paging: 'lazy' | 'pages';
  pageSize: number;
  /** The seed the node's non-deterministic steps draw from (advanced). */
  seed: string;
  /** The trace id: with the same one (and the same parameters) the node repeats the
   *  exact same search (advanced). */
  trace: string;
}

const SESSION_KEY = 'vibeshare-search-settings';

function loadSettings(): SearchSettings {
  const base: SearchSettings = {
    show: [...SHOW_KINDS],
    formats: [],
    topics: [],
    blockedTopics: [],
    creators: [],
    blockedCreators: [],
    rating: '',
    disregard: [],
    platforms: [],
    blockedPlatforms: [],
    sort: 'relevance',
    paging: 'lazy',
    pageSize: 24,
    seed: '',
    trace: '',
  };
  try {
    return { ...base, ...(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '{}') as Partial<SearchSettings>) };
  } catch {
    return base;
  }
}

/** How well a name matches the query — what the mix of result kinds is ordered by. */
function matchScore(name: string, query: string): number {
  const wanted = query.trim().toLowerCase();
  const mine = name.toLowerCase();
  if (!wanted) return 120;
  if (mine === wanted) return 300;
  if (mine.startsWith(wanted)) return 240;
  if (mine.split(/\s+/).some((word) => word.startsWith(wanted))) return 200;
  if (mine.includes(wanted)) return 160;
  return 110;
}

type Row =
  | { type: 'creator' | 'group'; key: string; score: number; info: CreatorInfo }
  | { type: 'topic'; key: string; score: number; info: TopicInfo }
  | { type: 'content'; key: string; score: number; item: FeedItem };

/** One result of the mixed list: a creator, a group, a topic, or a piece of content. */
function ResultRow({ row }: { row: Row }) {
  if (row.type === 'content') {
    return (
      <Link to={watchPath(row.item.id)} className="page-row search-result" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="search-thumb">
          <Poster item={row.item} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{row.item.title}</strong>
          <Fields item={row.item} fields={['creator', 'published', 'likes', 'platform']} variant="compact" />
        </div>
      </Link>
    );
  }
  if (row.type === 'topic') {
    return (
      <Link to={topicPath(row.info.id)} className="page-row search-result" style={{ textDecoration: 'none', color: 'inherit' }}>
        <Avatar name={row.info.name} id={row.info.id} icon={row.info.icon} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{row.info.name}</strong>
          <div className="tiny faint">Topic{row.info.description ? ` · ${row.info.description}` : ''}</div>
        </div>
      </Link>
    );
  }
  const group = row.type === 'group';
  return (
    <Link
      to={group ? groupPath(row.info.id) : profilePath(row.info.kind, row.info.id)}
      className="page-row search-result"
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <Avatar name={row.info.name} id={row.info.id} icon={row.info.icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{row.info.name}</strong>
        <div className="tiny faint">
          {group ? `${row.info.members?.length ?? 0} creator${(row.info.members?.length ?? 0) === 1 ? '' : 's'}` : CREATOR_KIND_LABELS[row.info.kind]}
          {row.info.accounts?.length ? ` · ${row.info.accounts.map((account) => account.platform).join(', ')}` : ''}
          {row.info.description ? ` · ${row.info.description}` : ''}
        </div>
      </div>
    </Link>
  );
}

/** Platforms with three states: not picked, searched in, or left out entirely. */
function PlatformPicker({ included, excluded, onChange }: { included: string[]; excluded: string[]; onChange: (included: string[], excluded: string[]) => void }) {
  return (
    <div className="chips">
      {SOURCE_CATALOG.map((source) => {
        const state = included.includes(source.key) ? 'on' : excluded.includes(source.key) ? 'off' : '';
        return (
          <button
            key={source.key}
            type="button"
            className={`chip ${state}`}
            title={state === 'on' ? 'Searching this platform' : state === 'off' ? 'Left out of the search' : 'Not picked — click to search it'}
            onClick={() => {
              if (included.includes(source.key)) onChange(included.filter((key) => key !== source.key), [...excluded, source.key]);
              else if (excluded.includes(source.key)) onChange(included, excluded.filter((key) => key !== source.key));
              else onChange([...included, source.key], excluded);
            }}
          >
            {source.name}
            {state === 'off' ? ' ✕' : ''}
          </button>
        );
      })}
    </div>
  );
}

/** A text field that fills a list: names or ids, comma or newline separated. */
function ListField({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="field">
      {label}
      <input type="text" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(splitList(text))} />
    </label>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const { state } = useApp();
  // The settings of the search are kept for the whole session (until the tab closes).
  const [settings, setSettings] = useState<SearchSettings>(loadSettings);
  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(settings));
    } catch {
      // Private mode: the settings then only live for this page.
    }
  }, [settings]);
  const set = (patch: Partial<SearchSettings>) => setSettings((current) => ({ ...current, ...patch }));

  const [showFilters, setShowFilters] = useState(false);
  const [matches, setMatches] = useState<CreatorInfo[]>([]);
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [suggested, setSuggested] = useState<CreatorInfo[]>([]);
  const [page, setPage] = useState(0);

  // The creators, groups and topics that match the query, and a few suggested creators
  // and groups the search offers as picks when nothing is typed yet.
  useEffect(() => {
    let live = true;
    api<{ creators: CreatorInfo[] }>(`/api/creators?q=${encodeURIComponent(query)}`)
      .then((result) => live && setMatches(result.creators))
      .catch(() => live && setMatches([]));
    api<{ topics: TopicInfo[] }>(`/api/topics?q=${encodeURIComponent(query)}`)
      .then((result) => live && setTopics(result.topics))
      .catch(() => live && setTopics([]));
    api<{ creators: CreatorInfo[] }>('/api/creators?q=')
      .then((result) => live && setSuggested(result.creators.slice(0, 8)))
      .catch(() => live && setSuggested([]));
    return () => {
      live = false;
    };
  }, [query]);

  const load = useCallback(
    (cursor?: string) =>
      api<FeedResponse>('/api/search', {
        body: {
          query,
          sort: settings.sort,
          cursor,
          seed: settings.seed.trim() || undefined,
          trace: settings.trace.trim() || undefined,
          filters: {
            formats: settings.formats.length ? settings.formats : undefined,
            maxRating: settings.rating || undefined,
            disregard: settings.disregard.length ? settings.disregard : undefined,
            topics: settings.topics.length ? settings.topics : undefined,
            onlyTopics: settings.topics.length ? true : undefined,
            blockedTopics: settings.blockedTopics.length ? settings.blockedTopics : undefined,
            creatorIds: settings.creators.length ? settings.creators : undefined,
            onlyCreators: settings.creators.length ? true : undefined,
            blockedCreators: settings.blockedCreators.length ? settings.blockedCreators : undefined,
            preferredPlatforms: settings.platforms.length ? settings.platforms : undefined,
            platformLevel: settings.platforms.length ? 'only' : undefined,
            blockedPlatforms: settings.blockedPlatforms.length ? settings.blockedPlatforms : undefined,
          },
        },
      }),
    [query, settings]
  );

  const size = Math.min(50, Math.max(3, Number(settings.pageSize) || 24));
  const paged = usePaged(load, JSON.stringify([query, settings]), settings.paging === 'pages' ? 0 : state?.settings.loadPauseMs ?? 1500);

  // Everything that matches, mixed into one list ordered by how well it matches — the
  // format on the page never has to be all creators, then all groups, then all content.
  const rows = useMemo(() => {
    const mixed: Row[] = [];
    if (settings.show.includes('creators')) {
      for (const info of matches) {
        if (info.kind === 'group') continue;
        mixed.push({ type: 'creator', key: `c:${info.id}`, score: matchScore(info.name, query) + 15, info });
      }
    }
    if (settings.show.includes('groups')) {
      for (const info of matches) {
        if (info.kind !== 'group') continue;
        mixed.push({ type: 'group', key: `g:${info.id}`, score: matchScore(info.name, query) + 10, info });
      }
    }
    if (settings.show.includes('topics')) {
      for (const info of topics) mixed.push({ type: 'topic', key: `t:${info.id}`, score: matchScore(info.name, query) + 12, info });
    }
    const content = settings.show.includes('content')
      ? paged.items.map((item, index) => ({ type: 'content' as const, key: `x:${item.id}`, score: 250 - index * 2, item }))
      : [];
    return [...mixed, ...content].sort((a, b) => b.score - a.score);
  }, [matches, topics, paged.items, query, settings.show]);

  // Pages: one screenful of the mixed list at a time — a page holds whatever blend of the
  // kinds matched (nine content results and a creator, five creators and five content…).
  const pageRows = useMemo(() => {
    if (settings.paging !== 'pages') return rows;
    return rows.slice(page * size, page * size + size);
  }, [rows, settings.paging, page, size]);

  const sentinel = useSentinel(() => paged.loadMore(), settings.paging === 'lazy' && !paged.done, paged.items.length);
  // A new search or a different page size starts over on the first page.
  useEffect(() => setPage(0), [query, settings.paging, settings.pageSize, settings.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const pager = settings.paging === 'pages' && rows.length > 0;
  const lastPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  const goPage = (next: number) => {
    if ((next + 1) * size > rows.length && !paged.done) paged.loadMore();
    setPage(Math.max(0, next));
  };
  const pageNav = pager ? (
    <div className="row between" style={{ margin: '10px 0' }}>
      <button className="small" disabled={page === 0} onClick={() => goPage(page - 1)}>
        ← Previous
      </button>
      <span className="small muted">
        Page {page + 1}
        {paged.done ? ` of ${lastPage + 1}` : ''}
      </span>
      <button className="small" disabled={paged.done && page >= lastPage} onClick={() => goPage(page + 1)}>
        Next →
      </button>
    </div>
  ) : null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{query ? `“${query}”` : 'Explore'}</h1>
          <p className="small muted">Creators, groups, topics and content — mixed together by how well they match.</p>
        </div>
        <div className="row">
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="hint">Sort</span>
            <select value={settings.sort} onChange={(e) => set({ sort: e.target.value as SearchSettings['sort'] })}>
              <option value="relevance">Relevance</option>
              <option value="new">Newest</option>
              <option value="top">Top</option>
            </select>
          </label>
          <button onClick={() => setShowFilters(!showFilters)}>
            <SlidersHorizontal size={16} /> Filters
          </button>
        </div>
      </div>
      {showFilters && (
        <div className="card form-stack" style={{ marginBottom: 24 }}>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Show</div>
            <Chips options={SHOW_KINDS} selected={settings.show} labels={SHOW_LABELS} onToggle={(v) => set({ show: toggle(settings.show, v) })} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Format</div>
            <Chips options={FORMATS} selected={settings.formats} labels={FORMAT_LABELS} onToggle={(v) => set({ formats: toggle(settings.formats, v) })} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Suggested creators and groups — click to search only them</div>
            <div className="chips">
              {suggested.map((creator) => (
                <button
                  key={creator.id}
                  type="button"
                  className={`chip ${settings.creators.includes(creator.id) ? 'on' : ''}`}
                  onClick={() => set({ creators: toggle(settings.creators, creator.id) })}
                >
                  {creator.name}
                </button>
              ))}
            </div>
          </div>
          <div className="form-grid">
            <ListField label="Creators or groups to show" value={settings.creators} onChange={(creators) => set({ creators })} placeholder="ids, comma separated" />
            <ListField label="Creators or groups to hide" value={settings.blockedCreators} onChange={(blockedCreators) => set({ blockedCreators })} placeholder="ids, comma separated" />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Suggested topics — click to search only them</div>
            <Chips options={[...TOPICS].slice(0, 12)} selected={settings.topics} onToggle={(v) => set({ topics: toggle(settings.topics, v) })} />
          </div>
          <div className="form-grid">
            <ListField label="Topics to show" value={settings.topics} onChange={(topics) => set({ topics })} placeholder="names or topic ids, comma separated" />
            <ListField label="Topics to hide" value={settings.blockedTopics} onChange={(blockedTopics) => set({ blockedTopics })} placeholder="names or topic ids, comma separated" />
          </div>
          <div className="form-grid">
            <label className="field">
              Age rating up to
              <select value={settings.rating} onChange={(e) => set({ rating: e.target.value as Rating | '' })}>
                <option value="">My preference</option>
                {RATINGS.map((r) => (
                  <option key={r} value={r}>
                    {RATING_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Content warnings — leave these out entirely</div>
            <Chips options={[...RATING_REASONS]} selected={settings.disregard} onToggle={(v) => set({ disregard: toggle(settings.disregard, v) })} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Platforms — click to search one, click again to leave it out</div>
            <PlatformPicker
              included={settings.platforms}
              excluded={settings.blockedPlatforms}
              onChange={(platforms, blockedPlatforms) => set({ platforms, blockedPlatforms })}
            />
          </div>
          <details>
            <summary style={{ cursor: 'pointer' }}>Advanced — paging, seed and trace id</summary>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <label className="field">
                Results
                <select value={settings.paging} onChange={(e) => set({ paging: e.target.value as SearchSettings['paging'] })}>
                  <option value="lazy">Load as I scroll</option>
                  <option value="pages">One page at a time</option>
                </select>
              </label>
              <label className="field">
                Items per page
                <input type="number" min={3} max={50} value={settings.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) || 24 })} />
              </label>
              <label className="field">
                Seed
                <input type="text" value={settings.seed} placeholder="Anything — same seed, same order" onChange={(e) => set({ seed: e.target.value.slice(0, 200) })} />
                <span className="hint">The node draws its non-deterministic steps from this instead of chance.</span>
              </label>
              <label className="field">
                Trace id
                <input type="text" value={settings.trace} placeholder="Your search version and parameters" onChange={(e) => set({ trace: e.target.value.slice(0, 200) })} />
                <span className="hint">With the same trace id and the same parameters the node repeats the exact same search.</span>
              </label>
            </div>
          </details>
          {query && (
            <div>
              <button className="small" onClick={() => setParams({})}>
                Clear search
              </button>
            </div>
          )}
        </div>
      )}
      {pageNav}
      {paged.errors.map((failure) => (
        <div key={failure.node + failure.error} className="banner danger small" style={{ marginBottom: 10 }}>
          {failure.name}: {failure.error}
        </div>
      ))}
      {pageRows.length === 0 && !paged.loading ? (
        <div className="banner info small">
          {query ? 'Nothing matches this search with the current filters.' : 'Search for something, or open Filters to pick creators and topics.'}
        </div>
      ) : (
        <div className="page-list">
          {pageRows.map((row) => (
            <ResultRow key={row.key} row={row} />
          ))}
        </div>
      )}
      {paged.loading && (
        <div className="row" style={{ justifyContent: 'center', padding: 14 }}>
          <Spinner />
        </div>
      )}
      {settings.paging === 'lazy' && !paged.done && <div ref={sentinel} style={{ height: 1 }} />}
      {pageNav}
    </div>
  );
}