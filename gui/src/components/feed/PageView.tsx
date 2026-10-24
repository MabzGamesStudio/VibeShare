import { AlertTriangle, Compass, Network, RefreshCw, Settings2, Sparkles, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FeedResponse, PageConfig } from '../../../../src/shared/clientapi';
import { pagePreferences } from '../../../../src/shared/clientdefaults';
import type { Preferences } from '../../../../src/shared/protocol';
import { FORMAT_LABELS, RATING_LABELS, type Format } from '../../../../src/shared/taxonomy';
import { api } from '../../api';
import { useApp } from '../../state';
import { AddNodes } from '../AddNodes';
import { Chips, Empty, Spinner } from '../ui';
import { GridLayout, ListLayout, MasonryLayout } from './Cards';
import { PageIconView } from './icons';
import { PageEditor } from './PageEditor';
import { ShortsLayout } from './Shorts';
import { StreamLayout } from './Stream';
import { usePaged, useFeedScroll, useSentinel } from './usePaged';

const QUICK: Format[] = ['video', 'short-video', 'music', 'podcast', 'image', 'article', 'game'];

function Welcome() {
  const { providers, algorithms } = useApp();
  return (
    <div className="page page-narrow">
      <Empty icon={<Sparkles size={46} />} title="Welcome to VibeShare">
        <p>
          VibeShare has no central server. You choose an <strong>algorithm node</strong> that decides what to show you, and{' '}
          <strong>content provider nodes</strong> that send you the content. Paste the references of the nodes you want to use.
        </p>
      </Empty>
      <div className="card">
        <h3>Add nodes</h3>
        <p className="small" style={{ marginBottom: 14 }}>
          You have {providers.length} provider and {algorithms.length} algorithm node{algorithms.length === 1 ? '' : 's'}. Node operators
          share their references on their node's web page.
        </p>
        <AddNodes />
      </div>
    </div>
  );
}

/** One line on what a page shows. */
function describe(page: PageConfig, preferences: Preferences, nodes: number, feedMode: string): string {
  const formats = page.filters.formats.map((format) => FORMAT_LABELS[format]).join(', ');
  const source =
    page.source === 'search'
      ? page.query
        ? `results for “${page.query}”`
        : 'everything, by search'
      : page.source === 'subscriptions'
        ? 'from your subscriptions'
        : feedMode === 'blend'
          ? `blending ${nodes} algorithm node${nodes === 1 ? '' : 's'}`
          : 'from your first algorithm node';
  const rating = pagePreferences(preferences, page.filters).maxRating ?? '16+';
  return [formats || null, page.filters.topics.length ? page.filters.topics.slice(0, 3).join(', ') : null, `up to ${RATING_LABELS[rating]}`, source]
    .filter(Boolean)
    .join(' · ');
}

export function PageView({ page, embedded }: { page: PageConfig; embedded?: boolean }) {
  const { state, algorithms, providers } = useApp();
  const [format, setFormat] = useState<Format | null>(null);
  const [seed, setSeed] = useState(() => Math.random().toString(36).slice(2));
  const [editing, setEditing] = useState(false);

  const settings = state?.settings;
  const filters = format ? { ...page.filters, formats: [format] } : page.filters;
  const enabled = algorithms.filter((node) => node.enabled);
  const subscriptions = state?.subscriptions ?? [];
  const key = JSON.stringify([
    page.source,
    page.query,
    filters,
    seed,
    settings?.preferences,
    settings?.feedMode,
    enabled.map((node) => node.id),
    page.source === 'subscriptions' ? subscriptions.map((s) => s.id) : null,
  ]);
  const paged = usePaged(
    (cursor) =>
      api<FeedResponse>('/api/browse', { body: { source: page.source, query: page.query, filters, sort: page.filters.sort, cursor, seed } }),
    key,
    settings?.loadPauseMs ?? 1500
  );
  const sentinel = useSentinel(paged.loadMore, !paged.done && page.layout !== 'shorts', paged.items.length);
  // Coming back to a page returns to where the reader left it: the items are kept and
  // the scroll position with them.
  useFeedScroll(page.id, paged.items.length > 0);

  if (!state || !settings) return null;
  if (!algorithms.length) return <Welcome />;

  const ipfsGateway = settings.ipfsGateway;
  const quick = page.filters.formats.length === 0 && page.layout !== 'shorts';
  const summary = describe(page, settings.preferences, enabled.length, settings.feedMode);

  const empty: ReactNode =
    page.source === 'subscriptions' && subscriptions.length === 0 ? (
      <Empty icon={<Users size={42} />} title="No subscriptions yet">
        <p>Open any content or creator page and press Subscribe.</p>
      </Empty>
    ) : (
      <Empty icon={<Compass size={42} />} title="Nothing here yet">
        <p>Your algorithm nodes returned nothing for this page. Try other filters, or add algorithm nodes that list more.</p>
        <button onClick={() => setEditing(true)}>
          <Settings2 size={16} /> Customize this page
        </button>
      </Empty>
    );

  const actions = (
    <div className="row">
      {page.source === 'feed' && (
        <button className="ghost icon" title="New mix" aria-label="New mix" onClick={() => setSeed(Math.random().toString(36).slice(2))}>
          <RefreshCw size={17} />
        </button>
      )}
      <button onClick={() => setEditing(true)}>
        <Settings2 size={16} /> Customize
      </button>
    </div>
  );

  const errors =
    paged.errors.length > 0 ? (
      <div className="banner warn">
        <AlertTriangle size={18} />
        <div className="small">
          {paged.errors.map((error) => (
            <div key={error.node + error.error}>
              <strong>{error.name}</strong>: {error.error}
            </div>
          ))}
        </div>
      </div>
    ) : null;

  const editor = editing && <PageEditor page={page} onClose={() => setEditing(false)} />;

  if (page.layout === 'shorts') {
    return (
      <div className="page-shorts">
        <ShortsLayout
          paged={paged}
          page={page}
          ipfsGateway={ipfsGateway}
          empty={paged.failure ? <div className="banner danger">{paged.failure}</div> : empty}
          header={
            embedded ? null : (
              <>
                <h1 className="row" style={{ gap: 8 }}>
                  <PageIconView icon={page.icon} size={20} /> {page.title}
                </h1>
                <button className="small" onClick={() => setEditing(true)}>
                  <Settings2 size={14} /> Customize
                </button>
              </>
            )
          }
        />
        {editor}
      </div>
    );
  }

  const Layout = page.layout === 'list' ? ListLayout : page.layout === 'masonry' ? MasonryLayout : page.layout === 'stream' ? null : GridLayout;

  return (
    <div className={`page ${page.layout === 'stream' ? 'page-stream' : ''}`}>
      {!embedded && (
        <div className="page-header">
          <div>
            <h1 className="row" style={{ gap: 10 }}>
              <PageIconView icon={page.icon} size={24} /> {page.title}
            </h1>
            <p>
              {summary} · <Link to="/settings" className="link">preferences</Link> ·{' '}
              <Link to="/nodes" className="link">
                <Network size={13} /> nodes
              </Link>
            </p>
          </div>
          {actions}
        </div>
      )}
      {page.id === 'home' && !providers.length && (
        <div className="banner info">
          <Sparkles size={18} />
          <div className="small">
            Content from other platforms plays from them; add a <Link to="/nodes" className="link">content provider node</Link> to watch
            content published on VibeShare.
          </div>
        </div>
      )}
      {quick && (
        <div style={{ marginBottom: 22 }}>
          <Chips
            options={['all', ...QUICK] as const}
            selected={[format ?? 'all']}
            labels={{ all: 'All', ...FORMAT_LABELS }}
            onToggle={(value) => setFormat(value === 'all' || value === format ? null : (value as Format))}
          />
        </div>
      )}
      {errors}
      {paged.failure && paged.items.length === 0 ? (
        <div className="banner danger">{paged.failure}</div>
      ) : paged.items.length === 0 && !paged.loading ? (
        empty
      ) : Layout ? (
        <Layout items={paged.items} page={page} inline={embedded} />
      ) : (
        <StreamLayout items={paged.items} page={page} ipfsGateway={ipfsGateway} />
      )}
      <div ref={sentinel} className="sentinel">
        {paged.loading && (
          <span className="row faint small">
            <Spinner /> Loading more…
          </span>
        )}
        {paged.done && paged.items.length > 8 && <span className="faint small">That is everything for now</span>}
      </div>
      {editor}
    </div>
  );
}
