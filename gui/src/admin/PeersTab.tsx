import { useCallback, useEffect, useState } from 'react';
import { SOURCE_CATALOG } from '../../../src/algorithm/sources';
import type { PeerEntry } from '../../../src/shared/protocol';
import { FORMAT_LABELS, FORMATS, RATING_LABELS, RATINGS, type Format, type Rating } from '../../../src/shared/taxonomy';
import { Loading } from '../components/ui';
import { admin, message } from './api';
import { useToast } from './AdminApp';

interface PeerRow {
  ref: string;
  fetch: boolean;
  serve: boolean;
}

interface MetaResult {
  peer: string;
  entry?: PeerEntry;
  error?: string;
}

interface DiscoverResult {
  peer: string;
  items: PeerEntry[];
  error?: string;
}

/** Adds one entry a peer shared to this node's catalog, as pending. */
async function adopt(item: PeerEntry) {
  await admin('/v1/admin/content', {
    method: 'PUT',
    body: {
      id: item.id,
      status: 'pending',
      origin: 'peer',
      title: item.title,
      description: item.description,
      format: item.format,
      rating: item.rating,
      topics: item.topics,
      tags: item.tags,
      language: item.language,
      durationSeconds: item.durationSeconds,
      publishedAt: item.publishedAt,
      pageUrl: item.pageUrl,
    },
  });
}

/**
 * Peers: other nodes this node exchanges content metadata with. It can ask a peer for
 * the metadata of a cid or a link, and for new cids and links matching some criteria —
 * by platform, by whether the content has a cid, a link or both, by its platform
 * numbers, by content filters — with the peer picking its newest, most popular or a
 * random mix.
 */
export function Peers() {
  const [peers, setPeers] = useState<PeerRow[] | null>(null);
  const [ref, setRef] = useState('');
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ peers: PeerRow[] }>('/v1/admin/peers')
      .then((r) => setPeers(r.peers))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (next: PeerRow[]) => {
    setPeers(next);
    try {
      await admin('/v1/admin/peers', { method: 'PUT', body: { peers: next } });
    } catch (e) {
      show(message(e));
      load();
    }
  };

  return (
    <div className="form-stack">
      <div className="card form-stack">
        <h3>Peers</h3>
        <p className="small muted">
          Other nodes — usually other algorithm nodes — this node exchanges content metadata and discoveries with. <strong>Fetch</strong>:
          this node may ask the peer for metadata and discoveries. <strong>Serve</strong>: the peer may ask this node.
        </p>
        {!peers ? (
          <Loading />
        ) : (
          <>
            {peers.map((peer, index) => (
              <div key={peer.ref} className="row between small">
                <code className="tiny">{peer.ref.length > 60 ? peer.ref.slice(0, 60) + '…' : peer.ref}</code>
                <div className="row" style={{ gap: 10 }}>
                  <label className="row small" style={{ gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={peer.fetch}
                      onChange={(e) => void save(peers.map((p, i) => (i === index ? { ...p, fetch: e.target.checked } : p)))}
                    />
                    Fetch
                  </label>
                  <label className="row small" style={{ gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={peer.serve}
                      onChange={(e) => void save(peers.map((p, i) => (i === index ? { ...p, serve: e.target.checked } : p)))}
                    />
                    Serve
                  </label>
                  <button className="small danger" onClick={() => void save(peers.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <div className="row">
              <input
                type="text"
                className="mono"
                placeholder="vs:algorithm:vk1…@https://feed.example.org"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                disabled={!ref.trim()}
                onClick={async () => {
                  await save([...peers, { ref: ref.trim(), fetch: true, serve: true }]);
                  setRef('');
                }}
              >
                Add peer
              </button>
            </div>
          </>
        )}
      </div>
      <PeersAsk peers={peers ?? []} />
    </div>
  );
}

/** Asks peers for the metadata of one cid or link, and for discoveries by criteria. */
function PeersAsk({ peers }: { peers: PeerRow[] }) {
  const [toast, show] = useToast();
  const askable = peers.filter((peer) => peer.fetch);
  const [peer, setPeer] = useState('');
  const [busy, setBusy] = useState(false);
  const [metaRef, setMetaRef] = useState('');
  const [meta, setMeta] = useState<MetaResult[] | null>(null);

  const lookUp = async (adoptOne: boolean) => {
    if (!metaRef.trim()) return;
    setBusy(true);
    try {
      const answer = await admin<{ results: MetaResult[] }>('/v1/admin/peers/metadata', {
        body: { peer: peer || undefined, id: metaRef.trim(), adopt: adoptOne },
      });
      setMeta(answer.results);
      if (adoptOne && answer.results.some((result) => result.entry)) show('Added to the catalog as pending — review it in Review');
    } catch (e) {
      show(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-stack">
      <div className="card form-stack">
        <h3>Metadata of a cid or a link</h3>
        <p className="small muted">Ask a peer what it knows about one content — a content id or a link.</p>
        <div className="form-grid">
          <label className="field">
            Peer
            <select value={peer} onChange={(e) => setPeer(e.target.value)}>
              <option value="">Every peer set to fetch</option>
              {askable.map((entry) => (
                <option key={entry.ref} value={entry.ref}>
                  {entry.ref.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Content id or link
            <input
              type="text"
              className="mono"
              value={metaRef}
              onChange={(e) => setMetaRef(e.target.value)}
              placeholder="vs1… or yt:… or https://…"
            />
          </label>
        </div>
        <div className="row">
          <button disabled={busy || !metaRef.trim()} onClick={() => void lookUp(false)}>
            Ask peers
          </button>
          <button disabled={busy || !metaRef.trim()} onClick={() => void lookUp(true)}>
            Ask and add as pending
          </button>
          {toast && <span className="small">{toast}</span>}
        </div>
        {meta && (
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <tbody>
                {meta.map((result) => (
                  <tr key={result.peer}>
                    <td className="mono tiny">{result.peer.slice(0, 28)}…</td>
                    <td className="small">
                      {result.error ? (
                        <span style={{ color: 'var(--danger)' }}>{result.error}</span>
                      ) : result.entry ? (
                        <>
                          <strong>{result.entry.title}</strong> · {result.entry.status} · {result.entry.format} ·{' '}
                          {Object.entries(result.entry.platformStats ?? {})
                            .map(([key, value]) => `${key} ${value}`)
                            .join(' · ') || 'no platform numbers'}
                        </>
                      ) : (
                        'Does not know it'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Discovery peers={askable} peer={peer} setPeer={setPeer} />
    </div>
  );
}

/** The discovery form: ask a peer for new cids and links by criteria. */
function Discovery({
  peers,
  peer,
  setPeer,
}: {
  peers: PeerRow[];
  peer: string;
  setPeer: (value: string) => void;
}) {
  const [toast, show] = useToast();
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState('');
  const [has, setHas] = useState<'any' | 'cid' | 'link' | 'both'>('any');
  const [algorithm, setAlgorithm] = useState<'new' | 'popular' | 'random'>('popular');
  const [metricKey, setMetricKey] = useState('views');
  const [metricMin, setMetricMin] = useState('');
  const [format, setFormat] = useState<Format | ''>('');
  const [maxRating, setMaxRating] = useState<Rating | ''>('');
  const [limit, setLimit] = useState('50');
  const [found, setFound] = useState<DiscoverResult[] | null>(null);

  const discover = async (adoptAll: boolean) => {
    setBusy(true);
    try {
      const answer = await admin<{ results: DiscoverResult[] }>('/v1/admin/peers/discover', {
        body: {
          peer: peer || undefined,
          adopt: adoptAll,
          criteria: {
            platform: platform || undefined,
            has,
            algorithm,
            metrics: metricMin.trim() ? [{ key: metricKey.trim() || 'views', min: Number(metricMin) }] : undefined,
            filters: { formats: format ? [format] : undefined, maxRating: maxRating || undefined },
            limit: Number(limit) || 50,
          },
        },
      });
      setFound(answer.results);
      const total = answer.results.reduce((sum, result) => sum + result.items.length, 0);
      if (adoptAll && total) show(`Added ${total} item${total === 1 ? '' : 's'} to the catalog as pending`);
    } catch (e) {
      show(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <h3>Discover new cids and links</h3>
      <p className="small muted">
        Ask a peer for content matching some criteria: its platform, whether it has a content id, a link or both, its platform numbers and
        content filters — with the peer picking its newest, its most popular or a random mix.
      </p>
      <div className="form-grid">
        <label className="field">
          Peer
          <select value={peer} onChange={(e) => setPeer(e.target.value)}>
            <option value="">Every peer set to fetch</option>
            {peers.map((entry) => (
              <option key={entry.ref} value={entry.ref}>
                {entry.ref.slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Platform
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">Any</option>
            {SOURCE_CATALOG.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Has
          <select value={has} onChange={(e) => setHas(e.target.value as 'any' | 'cid' | 'link' | 'both')}>
            <option value="any">A cid, a link, or both</option>
            <option value="cid">A content id</option>
            <option value="link">A link</option>
            <option value="both">Both a cid and a link</option>
          </select>
        </label>
        <label className="field">
          Ask the peer for its
          <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as 'new' | 'popular' | 'random')}>
            <option value="popular">Most popular (by platform numbers)</option>
            <option value="new">Newest</option>
            <option value="random">Random mix</option>
          </select>
        </label>
        <label className="field">
          Metric at least
          <div className="row" style={{ gap: 6 }}>
            <input type="text" value={metricKey} onChange={(e) => setMetricKey(e.target.value)} placeholder="views" style={{ maxWidth: 110 }} />
            <input type="number" min={0} value={metricMin} onChange={(e) => setMetricMin(e.target.value)} placeholder="any" style={{ maxWidth: 110 }} />
          </div>
          <span className="hint">views, likes, comments, upvotes… — leave empty for any</span>
        </label>
        <label className="field">
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as Format | '')}>
            <option value="">Any</option>
            {FORMATS.map((value) => (
              <option key={value} value={value}>
                {FORMAT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Rating ceiling
          <select value={maxRating} onChange={(e) => setMaxRating(e.target.value as Rating | '')}>
            <option value="">Any</option>
            {RATINGS.map((value) => (
              <option key={value} value={value}>
                {RATING_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Up to
          <input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void discover(false)}>
          Ask peers
        </button>
        <button disabled={busy} onClick={() => void discover(true)}>
          Ask and add all as pending
        </button>
        {toast && <span className="small">{toast}</span>}
      </div>
      {found && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Source</th>
                <th>Platform numbers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {found.flatMap((result) =>
                result.error
                  ? [
                      <tr key={result.peer}>
                        <td className="mono tiny">{result.peer.slice(0, 28)}…</td>
                        <td className="small" colSpan={3} style={{ color: 'var(--danger)' }}>
                          {result.error}
                        </td>
                      </tr>,
                    ]
                  : result.items.map((item) => (
                      <tr key={item.id}>
                        <td className="small">
                          <strong>{item.title}</strong>
                          <div className="mono tiny faint">{item.id}</div>
                        </td>
                        <td className="small">
                          {item.link ?? item.contentId ?? item.id}
                          <div className="tiny faint">from {result.peer.slice(0, 24)}…</div>
                        </td>
                        <td className="tiny">
                          {Object.entries(item.platformStats ?? {})
                            .map(([key, value]) => `${key} ${value}`)
                            .join(' · ') || '—'}
                        </td>
                        <td>
                          <button
                            className="small"
                            onClick={async () => {
                              try {
                                await adopt(item);
                                show('Added as pending');
                              } catch (e) {
                                show(message(e));
                              }
                            }}
                          >
                            Add
                          </button>
                        </td>
                      </tr>
                    ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}