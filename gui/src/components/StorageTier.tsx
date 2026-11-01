// The storage tier of one content on a provider: where its copies are planned to live,
// when the lifecycle ends, and the paid ways to raise either. Shown on the content page
// where the cid is defined, with the provider picked from the user's provider nodes.
import { Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useApp } from '../state';

interface TierState {
  cid: string;
  tier: string;
  label: string;
  assignedAt: string;
  expiresAt?: string;
  daysLeft?: number;
  manual?: boolean;
  plan: { media: Record<string, number>; externalUrls: number };
  backups: { urls: number; domains: string[]; satisfied: boolean; note?: string };
  upgrades: { id: string; label: string; price: number; lifecycleDays: number; downgradeTo: string | null }[];
}

/** Tier and lifecycle of one content on the picked provider, with its paid upgrades. */
export function StorageTierCard({ cid, preferred }: { cid: string; preferred?: string }) {
  const { providers, toast, refresh } = useApp();
  const [nodeId, setNodeId] = useState('');
  const [state, setState] = useState<TierState | null>(null);
  const [status, setStatus] = useState<'loading' | 'none' | 'ready'>('loading');
  const [target, setTarget] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const chosen = nodeId || preferred || providers[0]?.id || '';

  useEffect(() => {
    setState(null);
    setStatus('loading');
    if (!chosen) return;
    api<{ tier: TierState }>(`/api/nodes/${chosen}/tier/${encodeURIComponent(cid)}`)
      .then((answer) => {
        setState(answer.tier);
        setTarget(answer.tier.tier);
        setStatus('ready');
      })
      .catch((e) => {
        // "no tier for that content" and older nodes both simply show the empty state.
        setStatus('none');
        void e;
      });
  }, [cid, chosen]);

  if (!providers.length) return null;

  const plan = state
    ? [
        ...Object.entries(state.plan.media)
          .filter(([, count]) => count > 0)
          .map(([medium, count]) => `${count}× ${medium}`),
        ...(state.plan.externalUrls > 0 ? [`${state.plan.externalUrls} URL backup${state.plan.externalUrls === 1 ? '' : 's'}`] : []),
      ].join(' · ')
    : '';
  const picked = state?.upgrades.find((entry) => entry.id === target);
  const extendPrice = picked?.price ? Math.max(1, Math.ceil((Number(extendDays) || 0) / 30) * picked.price) : 0;

  const upgrade = async (body: { tier?: string; extendDays?: number }) => {
    setBusy(true);
    try {
      const answer = await api<{ charged: number; state: TierState }>(`/api/nodes/${chosen}/tier/${encodeURIComponent(cid)}`, {
        method: 'POST',
        body,
      });
      setState(answer.state);
      setTarget(answer.state.tier);
      setStatus('ready');
      toast(answer.charged > 0 ? `Paid ${answer.charged} credits — tier and lifecycle updated` : 'Updated', 'success');
      void refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    setBusy(false);
  };

  return (
    <div className="card form-stack">
      <div className="row between">
        <h3>
          <Layers size={16} /> Storage tier
        </h3>
        {providers.length > 1 && (
          <select value={chosen} onChange={(e) => setNodeId(e.target.value)} aria-label="Provider" style={{ maxWidth: 190 }}>
            {providers.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {status === 'loading' ? (
        <span className="small muted">Looking up the tier…</span>
      ) : status === 'none' || !state ? (
        <span className="small muted">This provider keeps no tier for this content yet.</span>
      ) : (
        <>
          <div className="row between small">
            <strong>{state.label}</strong>
            <span className="muted">{plan || 'no copies planned'}</span>
          </div>
          <div className="small muted">
            Lifecycle: {state.expiresAt ? `ends ${new Date(state.expiresAt).toLocaleDateString()}` : 'no expiry'}
            {state.daysLeft !== undefined ? ` · ${state.daysLeft} day${state.daysLeft === 1 ? '' : 's'} left` : ''}
            {state.manual ? ' · set by hand' : ''}
          </div>
          <div className="small muted">
            Backups: {state.backups.urls} URL{state.backups.urls === 1 ? '' : 's'}
            {state.backups.domains.length ? ` on ${state.backups.domains.length} domain${state.backups.domains.length === 1 ? '' : 's'}` : ''}{' '}
            {state.backups.satisfied ? '· satisfied' : '· still wanted'}
            {state.backups.note ? ` — ${state.backups.note}` : ''}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="field" style={{ marginBottom: 0, maxWidth: 190 }}>
              Raise to
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {state.upgrades.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                    {entry.price > 0 ? ` — ${entry.price} credits` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ marginBottom: 0, maxWidth: 130 }}>
              Extend (days)
              <input type="number" min={1} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <button
              className="small"
              disabled={busy || !picked || (Boolean(state.tier) && picked.id === state.tier)}
              onClick={() => void upgrade({ tier: target })}
            >
              {picked && picked.id !== state.tier
                ? `${state.tier ? 'Raise tier' : 'Assign to tier'} (${picked.price} credits)`
                : 'Tier already set'}
            </button>
            <button className="small" disabled={busy || !(Number(extendDays) > 0)} onClick={() => void upgrade({ extendDays: Number(extendDays) })}>
              {`Extend lifecycle (~${extendPrice} credits)`}
            </button>
          </div>
          <span className="hint">
            Credits go to this provider; assigning or raising a tier starts its lifecycle. Content with no tier below its expiry is
            deleted from memory.
          </span>
        </>
      )}
    </div>
  );
}