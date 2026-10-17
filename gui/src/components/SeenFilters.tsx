// The seen-content bloom filters on the settings page: what was selected (opened), what
// was previewed on screen, and the copy whose bits go to search algorithm nodes. The
// sizes are exponential (1, 10, 100, … bits); each filter records a content by its cid
// and each of its links, hashed — the filters never carry the ids themselves.
import { Eye, MousePointerClick, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { BloomFilterStatus, BloomStatus, NodeEntry, Settings } from '../../../src/shared/clientapi';
import type { BloomStorageState } from '../../../src/shared/protocol';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import { formatBytes } from '../util';
import { Modal, Switch } from './ui';

/** The exponential size slider: one stop per decade, 1, 10, 100, … bits. */
function BitsSlider({ stops, value, onChange }: { stops: number; value: number; onChange: (bits: number) => void }) {
  const exponent = Math.max(0, Math.min(stops, Math.round(Math.log10(Math.max(1, value)))));
  const bits = 10 ** exponent;
  return (
    <label className="field">
      Filter size
      <input
        type="range"
        min={0}
        max={stops}
        step={1}
        value={exponent}
        aria-valuetext={`${bits.toLocaleString()} bits`}
        onChange={(e) => onChange(10 ** Number(e.target.value))}
      />
      <span className="hint">
        {bits.toLocaleString()} bits ({formatBytes(Math.ceil(bits / 8))}) — changing the size clears the filter.
      </span>
    </label>
  );
}

/** How many items the filter is made for: it sets the optimal number of hash functions. */
function ExpectedInput({ value, onChange }: { value: number; onChange: (expected: number) => void }) {
  return (
    <label className="field">
      Made for (items)
      <input
        key={value}
        type="number"
        min={1}
        max={10_000_000}
        step={100}
        defaultValue={value}
        onBlur={(e) => {
          const count = Math.round(Number(e.target.value));
          if (Number.isFinite(count) && count >= 1 && count !== value) onChange(Math.min(10_000_000, count));
        }}
      />
      <span className="hint">
        How many contents the filter is made for: it decides the optimal number of hash functions (more items → more hashes, fewer mistakes).
        Changing it clears the filter.
      </span>
    </label>
  );
}

/** What one filter knows: its optimal hash count, its bytes, and how much it recorded. */
function FilterStatus({ status }: { status: BloomFilterStatus | undefined }) {
  if (!status) return null;
  return (
    <span className="hint">
      {status.hashes} hash function{status.hashes === 1 ? '' : 's'} · {formatBytes(status.bytes)} · about {status.added.toLocaleString()} of{' '}
      {status.expected.toLocaleString()} items recorded
    </span>
  );
}

/** The reset button: forgetting what was seen is destructive, so it is confirmed. */
function ResetFilter({ scope, onDone }: { scope: 'selected' | 'preview' | 'node'; onDone: () => void }) {
  const { toast } = useApp();
  const [asking, setAsking] = useState(false);
  const reset = async () => {
    try {
      await api(`/api/bloom/reset`, { body: { scope } });
      setAsking(false);
      onDone();
      toast('Filter reset', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };
  return (
    <>
      <button className="small danger" onClick={() => setAsking(true)}>
        <Trash2 size={14} /> Reset filter
      </button>
      {asking && (
        <Modal
          title="Reset this filter?"
          onClose={() => setAsking(false)}
          actions={
            <>
              <button onClick={() => setAsking(false)}>Cancel</button>
              <button className="danger" onClick={() => void reset()}>
                <RotateCcw size={14} /> Reset and forget
              </button>
            </>
          }
        >
          <div className="banner warn small">
            <ShieldAlert size={16} />
            <div>
              <strong>Everything this filter recorded is lost.</strong> Content you have already seen will show again as if it were new — and
              when the filter is sent to search nodes, they will suggest it again too. This cannot be undone.
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function formatTerm(seconds: number): string {
  const units: [number, string][] = [
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3600, 'hour'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${name}${count > 1 ? 's' : ''}`;
    }
  }
  return `${Math.max(1, Math.round(seconds / 60))} minutes`;
}

/** One search node: the storage it sells for the filter it is sent, and the user's own. */
function StorageRow({ node }: { node: NodeEntry }) {
  const { toast, refresh, state } = useApp();
  const [offers, setOffers] = useState<BloomStorageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const balance = state?.nodes.find((n) => n.id === node.id)?.balance;
  const load = useCallback(async () => {
    try {
      setOffers(await api<BloomStorageState>(`/api/bloom/offers/${encodeURIComponent(node.id)}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [node.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const buy = async (tier: string) => {
    setBusy(true);
    try {
      setOffers(await api<BloomStorageState>(`/api/bloom/storage/${encodeURIComponent(node.id)}`, { body: { tier } }));
      toast(`Your filter is kept on ${node.name}`, 'success');
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const drop = async () => {
    setBusy(true);
    try {
      setOffers(await api<BloomStorageState>(`/api/bloom/storage/${encodeURIComponent(node.id)}`, { method: 'DELETE' }));
      toast(`${node.name} deleted your stored filter`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{node.name}</strong>
        <div className="tiny faint">
          {balance !== undefined && <span>{balance} credits · </span>}
          {offers?.expiresAt ? (
            <span>your filter is kept until {new Date(offers.expiresAt).toLocaleString()}</span>
          ) : (
            <span>no filter stored here</span>
          )}
        </div>
        {error && (
          <div className="tiny" style={{ color: 'var(--warn)' }}>
            {error}
          </div>
        )}
        {offers && (
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {offers.tiers.map((tier) => (
              <button
                key={tier.id}
                className="small"
                disabled={busy}
                onClick={() => void buy(tier.id)}
                title={`Up to ${tier.maxBits.toLocaleString()} bits for ${formatTerm(tier.durationSeconds)}`}
              >
                {tier.price} credits · {formatTerm(tier.durationSeconds)}
              </button>
            ))}
            {offers.filter && (
              <button className="small danger" disabled={busy} onClick={() => void drop()}>
                <Trash2 size={13} /> Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The three seen-content filters and the copy search algorithm nodes get. */
export function SeenFiltersSection() {
  const { state, updateSettings, algorithms } = useApp();
  const [status, setStatus] = useState<BloomStatus | null>(null);
  const load = useCallback(() => {
    void api<BloomStatus>('/api/bloom')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(load, [load, state?.settings.selectedBloom, state?.settings.previewBloom, state?.settings.nodeBloom]);

  if (!state) return null;
  const s = state.settings;
  const patchSelected = (patch: Partial<Settings['selectedBloom']>) => void updateSettings({ selectedBloom: { ...s.selectedBloom, ...patch } });
  const patchPreview = (patch: Partial<Settings['previewBloom']>) => void updateSettings({ previewBloom: { ...s.previewBloom, ...patch } });
  const patchNode = (patch: Partial<Settings['nodeBloom']>) => void updateSettings({ nodeBloom: { ...s.nodeBloom, ...patch } });

  return (
    <>
      <div className="card form-stack" id="seen-selected">
        <div className="row">
          <MousePointerClick size={20} />
          <h2>Content you have opened</h2>
        </div>
        <Switch
          checked={s.selectedBloom.enabled}
          onChange={(enabled) => patchSelected({ enabled })}
          label="Remember what you have opened, and stop showing it again"
        />
        <span className="hint">
          A bloom filter on this device records each content you select by its content id and each of its links, hashed — never the ids
          themselves. Content that collides with the filter counts as already seen and is left out of feeds and searches. Once a filter fills up
          it can mistake other content for seen.
        </span>
        <BitsSlider stops={8} value={s.selectedBloom.bits} onChange={(bits) => patchSelected({ bits })} />
        <ExpectedInput value={s.selectedBloom.expected} onChange={(expected) => patchSelected({ expected })} />
        <FilterStatus status={status?.selected} />
        <div>
          <ResetFilter scope="selected" onDone={load} />
        </div>
      </div>

      <div className="card form-stack" id="seen-preview">
        <div className="row">
          <Eye size={20} />
          <h2>Previews you have seen</h2>
        </div>
        <Switch
          checked={s.previewBloom.enabled}
          onChange={(enabled) => patchPreview({ enabled })}
          label="Remember the previews that came on screen"
        />
        <span className="hint">
          Kept apart from what you actually opened: this filter records every content whose preview you have seen while browsing, in its own
          filter with its own size.
        </span>
        <label className="field">
          When a preview has been seen before
          <select value={s.previewBloom.mode} onChange={(e) => patchPreview({ mode: e.target.value as Settings['previewBloom']['mode'] })}>
            <option value="hide">Hide that content completely</option>
            <option value="demote">Only push it down among the other previews</option>
          </select>
        </label>
        <BitsSlider stops={9} value={s.previewBloom.bits} onChange={(bits) => patchPreview({ bits })} />
        <ExpectedInput value={s.previewBloom.expected} onChange={(expected) => patchPreview({ expected })} />
        <FilterStatus status={status?.preview} />
        <div>
          <ResetFilter scope="preview" onDone={load} />
        </div>
      </div>

      <div className="card form-stack" id="seen-node">
        <div className="row">
          <ShieldAlert size={20} />
          <h2>Send what you have seen to search nodes</h2>
        </div>
        <div className="banner warn small">
          <ShieldAlert size={16} />
          <div>
            <strong>The more bits you send to an algorithm node, the more it can discover about your search history.</strong> A large, precise
            filter is close to a list of everything you have seen: a node can test guesses of known content against it. The ids are hashed, but
            the filter is still a fingerprint of what you looked at — send the smallest filter that is good enough for you.
          </div>
        </div>
        <Switch
          checked={s.nodeBloom.enabled}
          onChange={(enabled) => patchNode({ enabled })}
          label="Send my seen-content filter to algorithm nodes"
        />
        <Switch
          checked={s.nodeBloom.inline}
          onChange={(inline) => patchNode({ inline })}
          label="Include it in search requests while it is small enough (a few kilobytes)"
        />
        <span className="hint">
          This copy is filled with everything the filters above record — what you opened and the previews you have seen. A node that receives it
          stops suggesting any content whose id or links collide with it, at all. Nothing is sent until you turn this on.
        </span>
        <BitsSlider stops={9} value={s.nodeBloom.bits} onChange={(bits) => patchNode({ bits })} />
        <ExpectedInput value={s.nodeBloom.expected} onChange={(expected) => patchNode({ expected })} />
        <FilterStatus status={status?.node} />
        <div>
          <ResetFilter scope="node" onDone={load} />
        </div>
        {algorithms.length > 0 && (
          <>
            <h3>Keeping the filter on a node</h3>
            <span className="hint">
              Instead of (or besides) carrying the filter in every request, a search node can keep it for you for a while. Each node sets its own
              prices: how many bits it stores, for how long, for how many credits.
            </span>
            <div className="page-list">
              {algorithms.map((node) => (
                <StorageRow key={node.id} node={node} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
