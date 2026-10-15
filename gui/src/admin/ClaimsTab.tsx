import { useCallback, useEffect, useState } from 'react';
import { claimSourceMetrics, type ClaimConfig, type ClaimSourceRule } from '../../../src/algorithm/metrics';
import { SOURCE_CATALOG } from '../../../src/algorithm/sources';
import { Loading } from '../components/ui';
import { admin, message } from './api';
import { useToast } from './AdminApp';

/**
 * The credit multipliers of client claims: one weight per popularity metric, per content
 * source (YouTube: views, likes, comments, subscribers; Reddit: upvotes, comments,
 * members…), plus the recency factor that decays to 1× as a post ages. Any metric can
 * be switched off; the multiplier itself is never below 1.
 */
export function Claims() {
  const [config, setConfig] = useState<ClaimConfig | null>(null);
  const [source, setSource] = useState('youtube');
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ claims: ClaimConfig }>('/v1/admin/config')
      .then((c) => setConfig(c.claims))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  if (!config) return <Loading />;

  const rule: ClaimSourceRule = config.sources[source] ?? {
    metrics: {},
    recency: { enabled: true, multiplier: 5, halfLifeDays: 30 },
  };
  // The source's own metrics plus any key the operator added by hand.
  const known = claimSourceMetrics(source);
  const extra = Object.keys(rule.metrics).filter((key) => !known.some((metric) => metric.key === key));
  const rows = [...known.map((metric) => ({ key: metric.key, label: metric.label })), ...extra.map((key) => ({ key, label: key }))];

  const save = async (next: ClaimConfig) => {
    setConfig(next);
    try {
      await admin('/v1/admin/config', { method: 'PUT', body: { claims: next } });
    } catch (e) {
      show(message(e));
      load();
    }
  };

  const patchRule = (patch: Partial<ClaimSourceRule>) => {
    const sources = { ...config.sources, [source]: { ...rule, ...patch } };
    void save({ ...config, sources });
  };

  const setMetric = (key: string, patch: { enabled?: boolean; coefficient?: number }) => {
    const metrics = {
      ...rule.metrics,
      [key]: { enabled: rule.metrics[key]?.enabled ?? true, coefficient: rule.metrics[key]?.coefficient ?? 0.01, ...patch },
    };
    patchRule({ metrics });
  };

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Claim rewards</h3>
        <p className="small muted">
          Clients report what a post's platform shows — views, likes, comments, subscribers, upvotes — and earn credits only for numbers
          this node did not have yet. The reward is the base below times the multiplier of the source's rules: each enabled metric adds its
          coefficient times its value, the recency factor multiplies the result (exponentially decaying to 1× as the post gets older), and
          the multiplier is never less than 1. Any metric can be switched off.
        </p>
        <div className="form-grid">
          <label className="field">
            Base credits per new claim
            <input type="number" min={0} value={config.base} onChange={(e) => void save({ ...config, base: Math.max(0, Number(e.target.value)) })} />
          </label>
          <label className="field">
            Rewarded claims per account per day
            <input type="number" min={0} value={config.dailyCap} onChange={(e) => void save({ ...config, dailyCap: Math.max(0, Number(e.target.value)) })} />
          </label>
        </div>
      </div>
      <div className="card form-stack">
        <div className="row between">
          <h3>Multipliers per source</h3>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ maxWidth: 260 }}>
            {[...SOURCE_CATALOG.map((s) => [s.key, s.name] as const), ['default', 'Default (sources without their own rules)'] as const].map(
              ([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              )
            )}
          </select>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Use</th>
              <th>Multiplier (credits per unit)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const metric = rule.metrics[row.key];
              return (
                <tr key={row.key}>
                  <td className="small">
                    <strong>{row.label}</strong>
                    <div className="tiny faint mono">{row.key}</div>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={metric?.enabled ?? true}
                      title="Switch this metric off to ignore it"
                      onChange={(e) => setMetric(row.key, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.0001"
                      min={0}
                      disabled={metric?.enabled === false}
                      value={metric?.coefficient ?? 0.01}
                      onChange={(e) => setMetric(row.key, { coefficient: Math.max(0, Number(e.target.value)) })}
                      style={{ maxWidth: 140 }}
                    />
                    <span className="tiny faint"> × {row.key}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="form-grid">
          <label className="row small" style={{ alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={rule.recency?.enabled ?? true}
              onChange={(e) => patchRule({ recency: { ...rule.recency, enabled: e.target.checked } })}
            />
            Recency factor (newer posts earn more)
          </label>
          <label className="field">
            Recency multiplier (when brand new)
            <input
              type="number"
              step="0.5"
              min={1}
              disabled={!rule.recency?.enabled}
              value={rule.recency?.multiplier ?? 5}
              onChange={(e) => patchRule({ recency: { ...rule.recency, multiplier: Math.max(1, Number(e.target.value)) } })}
            />
            <span className="hint">Decays exponentially to 1×; the multiplier is never below 1.</span>
          </label>
          <label className="field">
            Half-life (days)
            <input
              type="number"
              min={1}
              disabled={!rule.recency?.enabled}
              value={rule.recency?.halfLifeDays ?? 30}
              onChange={(e) => patchRule({ recency: { ...rule.recency, halfLifeDays: Math.max(1, Number(e.target.value)) } })}
            />
            <span className="hint">The age at which the recency factor is halfway down.</span>
          </label>
        </div>
        <p className="hint">
          Example: a YouTube claim with 0.001 × views + 0.001 × comments + 0.01 × subscribers + 0.01 × likes, times the recency decay.
        </p>
      </div>
    </div>
  );
}