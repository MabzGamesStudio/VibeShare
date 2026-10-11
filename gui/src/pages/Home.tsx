import { Network, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedResponse } from '../../../src/shared/clientapi';
import { FORMAT_LABELS, RATING_LABELS, type Format } from '../../../src/shared/taxonomy';
import { api } from '../api';
import { AddNodes } from '../components/AddNodes';
import { Feed } from '../components/Feed';
import { Chips, Empty } from '../components/ui';
import { useApp } from '../state';

const QUICK: Format[] = ['video', 'short-video', 'music', 'podcast', 'image', 'article', 'game'];

export function HomePage() {
  const { state, algorithms, providers } = useApp();
  const [format, setFormat] = useState<Format | null>(null);
  const [seed] = useState(() => Math.random().toString(36).slice(2));

  if (!state) return null;
  if (!algorithms.length || !providers.length) {
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

  const prefs = state.settings.preferences;
  const summary = [
    `up to ${RATING_LABELS[prefs.maxRating ?? '16+']}`,
    prefs.topics?.length ? `favouring ${prefs.topics.slice(0, 3).join(', ')}` : null,
    state.settings.feedMode === 'blend' ? `blending ${algorithms.filter((n) => n.enabled).length} algorithm nodes` : 'from your first algorithm node',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Home</h1>
          <p>
            {summary} · <Link to="/settings" className="link">preferences</Link> · <Link to="/nodes" className="link"><Network size={13} /> nodes</Link>
          </p>
        </div>
      </div>
      <div style={{ marginBottom: 22 }}>
        <Chips
          options={['all', ...QUICK] as const}
          selected={[format ?? 'all']}
          labels={{ all: 'All', ...FORMAT_LABELS }}
          onToggle={(value) => setFormat(value === 'all' || value === format ? null : (value as Format))}
        />
      </div>
      <Feed
        deps={[format, seed, state.settings.preferences, state.settings.feedMode, algorithms.map((n) => `${n.id}${n.enabled}`).join()]}
        load={(cursor) => api<FeedResponse>('/api/feed', { body: { cursor, seed, formats: format ? [format] : undefined } })}
      />
    </div>
  );
}
