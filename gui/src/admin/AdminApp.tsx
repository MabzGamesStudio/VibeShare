import { LogOut, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { NodeInfo } from '../../../src/shared/protocol';
import { CodeBox, Loading, Modal, Spinner } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, loadToken, message, setToken } from './api';
import { AlgorithmTabs } from './AlgorithmTabs';
import { ProviderTabs } from './ProviderTabs';

export interface Status {
  reference: string;
  info: NodeInfo;
  accounts: number;
  credits: { outstanding: number; earned: number; spent: number };
  content?: { contents: number; bytes: number; chunks: number };
  storageService?: { jobs: number; activeAssignments: number; onlineHolders: number };
  registry?: { listed: number; blocked: number; creators: number; pending?: number; discovered?: number };
  pending?: { suggestions: number; submissions: number };
}

export function useToast(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const show = useCallback((value: string) => {
    setText(value);
    setTimeout(() => setText(null), 4000);
  }, []);
  return [text, show];
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setToken(token.trim());
    try {
      await admin('/v1/admin/status');
      onLogin();
    } catch (e) {
      setError(message(e));
      setToken('');
    }
  };
  return (
    <div className="page page-narrow" style={{ maxWidth: 480, marginTop: '12vh' }}>
      <div className="brand">
        <div className="brand-logo">
          <Sparkles size={18} />
        </div>
        VibeShare node
      </div>
      <form className="card form-stack" onSubmit={submit}>
        <h2>Operator sign in</h2>
        <p className="small muted">
          The admin token is in the node's data directory (<code>admin-token</code>) and is printed when the node starts.
        </p>
        <input type="password" value={token} onChange={(e) => setValue(e.target.value)} placeholder="Admin token" autoFocus />
        {error && <div className="banner danger small">{error}</div>}
        <button className="primary" type="submit" disabled={!token.trim()}>
          Sign in
        </button>
      </form>
    </div>
  );
}

function Overview({ status }: { status: Status }) {
  const info = status.info;
  return (
    <div className="form-stack">
      <div className="card">
        <h3>Node reference</h3>
        <p className="small" style={{ margin: '4px 0 12px' }}>
          Share it: clients paste it into Nodes → Add nodes. Set <code>publicUrl</code> in Settings if clients reach this node under another address.
        </p>
        <CodeBox text={status.reference} />
      </div>
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Accounts</div>
          <div className="value">{status.accounts}</div>
        </div>
        <div className="stat">
          <div className="label">Credits held by users</div>
          <div className="value">{status.credits.outstanding.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Credits issued</div>
          <div className="value">{status.credits.earned.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Credits spent</div>
          <div className="value">{status.credits.spent.toLocaleString()}</div>
        </div>
        {status.content && (
          <>
            <div className="stat">
              <div className="label">Content</div>
              <div className="value">{status.content.contents}</div>
            </div>
            <div className="stat">
              <div className="label">Stored</div>
              <div className="value">{formatBytes(status.content.bytes)}</div>
            </div>
          </>
        )}
        {status.storageService && (
          <div className="stat">
            <div className="label">Client storage</div>
            <div className="value">{status.storageService.activeAssignments}</div>
            <div className="tiny faint">
              {status.storageService.onlineHolders} online · {status.storageService.jobs} open jobs
            </div>
          </div>
        )}
        {status.registry && (
          <>
            <div className="stat">
              <div className="label">Listed</div>
              <div className="value">{status.registry.listed}</div>
            </div>
            <div className="stat">
              <div className="label">Blocked</div>
              <div className="value">{status.registry.blocked}</div>
            </div>
          </>
        )}
        {status.pending && (
          <div className="stat">
            <div className="label">Waiting for review</div>
            <div className="value">{status.pending.submissions + status.pending.suggestions}</div>
            <div className="tiny faint">
              {status.pending.submissions} submissions · {status.pending.suggestions} suggestions
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <h3>What clients see</h3>
        <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>
          {JSON.stringify(info, null, 2)}
        </pre>
      </div>
    </div>
  );
}

interface AccountRow {
  id: string;
  kind: string;
  balance: number;
  earned: number;
  spent: number;
  createdAt: string;
  lastSeen?: string;
  note?: string;
}

function Accounts() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [adjusting, setAdjusting] = useState<AccountRow | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ accounts: AccountRow[] }>(`/v1/admin/accounts?q=${encodeURIComponent(q)}`)
      .then((r) => setRows(r.accounts))
      .catch((e) => show(message(e)));
  }, [q, show]);
  useEffect(load, [load]);

  return (
    <div className="form-stack">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts by id or note" />
      {toast && <div className="banner info small">{toast}</div>}
      {!rows ? (
        <Loading />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Kind</th>
                <th>Balance</th>
                <th>Earned</th>
                <th>Spent</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono tiny" title={row.id}>
                    {row.id.slice(0, 22)}…{row.note && <div className="faint">{row.note}</div>}
                  </td>
                  <td className="small">{row.kind}</td>
                  <td>
                    <strong>{row.balance}</strong>
                  </td>
                  <td className="small">{row.earned}</td>
                  <td className="small">{row.spent}</td>
                  <td className="tiny faint">{timeAgo(row.lastSeen ?? row.createdAt)}</td>
                  <td>
                    <button className="small" onClick={() => setAdjusting(row)}>
                      Adjust
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adjusting && (
        <Modal
          title="Adjust credits"
          onClose={() => setAdjusting(null)}
          actions={
            <button
              className="primary"
              onClick={async () => {
                try {
                  await admin(`/v1/admin/accounts/${encodeURIComponent(adjusting.id)}/adjust`, { body: { amount: Number(amount), reason } });
                  setAdjusting(null);
                  setAmount('');
                  load();
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Apply
            </button>
          }
        >
          <div className="form-stack">
            <p className="mono tiny">{adjusting.id}</p>
            <label className="field">
              Amount <span className="hint">Negative to remove credits</span>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="field">
              Reason
              <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Refund, prize, …" />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface InvoiceRow {
  id: string;
  method: string;
  credits: number;
  status: string;
  createdAt: string;
  accountId: string;
  note?: string;
  tx?: string;
}

function Payments() {
  const [credits, setCredits] = useState('1000');
  const [count, setCount] = useState('5');
  const [note, setNote] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [vouchers, setVouchers] = useState<{ total: number; redeemed: number } | null>(null);
  const [status, setStatus] = useState('pending-review');
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ total: number; redeemed: number }>('/v1/admin/vouchers').then(setVouchers).catch(() => undefined);
    admin<{ invoices: InvoiceRow[] }>(`/v1/admin/invoices?status=${status}`)
      .then((r) => setInvoices(r.invoices))
      .catch((e) => show(message(e)));
  }, [status, show]);
  useEffect(load, [load]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Vouchers</h3>
        <p className="small muted">
          Codes worth credits on this node — sell them in your shop, give them away, print them. {vouchers && `${vouchers.redeemed} of ${vouchers.total} redeemed.`}
        </p>
        <div className="form-grid">
          <label className="field">
            Credits each
            <input type="number" min={1} value={credits} onChange={(e) => setCredits(e.target.value)} />
          </label>
          <label className="field">
            How many
            <input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
          <label className="field">
            Note
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Launch giveaway" />
          </label>
        </div>
        <div>
          <button
            className="primary"
            onClick={async () => {
              try {
                const result = await admin<{ codes: string[] }>('/v1/admin/vouchers', { body: { credits: Number(credits), count: Number(count), note } });
                setCodes(result.codes);
                load();
              } catch (e) {
                show(message(e));
              }
            }}
          >
            Create vouchers
          </button>
        </div>
        {codes && <textarea className="mono" readOnly rows={Math.min(10, codes.length + 1)} value={codes.join('\n')} />}
      </div>
      <div className="card form-stack">
        <div className="row between">
          <h3>Invoices</h3>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
            <option value="pending-review">Waiting for approval</option>
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="expired">Expired</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        {invoices.length === 0 ? (
          <p className="small muted">None.</p>
        ) : (
          <table className="table">
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="small">
                    <strong>{invoice.credits}</strong> credits via {invoice.method}
                    <div className="tiny faint mono">{invoice.accountId.slice(0, 24)}…</div>
                    {invoice.note && <div className="small">“{invoice.note}”</div>}
                    {invoice.tx && <div className="tiny faint mono">{invoice.tx}</div>}
                  </td>
                  <td className="tiny faint">{timeAgo(invoice.createdAt)}</td>
                  <td>
                    {invoice.status !== 'paid' && invoice.status !== 'rejected' && (
                      <div className="row">
                        <button
                          className="small primary"
                          onClick={async () => {
                            await admin(`/v1/admin/invoices/${invoice.id}/approve`, { body: {} }).catch((e) => show(message(e)));
                            load();
                          }}
                        >
                          Approve
                        </button>
                        <button
                          className="small"
                          onClick={async () => {
                            await admin(`/v1/admin/invoices/${invoice.id}/reject`, { body: {} }).catch((e) => show(message(e)));
                            load();
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export interface FieldDef {
  path: string;
  label: string;
  type: 'number' | 'text' | 'bool' | 'select' | 'list';
  options?: readonly string[];
  hint?: string;
}

const COMMON_FIELDS: FieldDef[] = [
  { path: 'name', label: 'Name', type: 'text' },
  { path: 'description', label: 'Description', type: 'text' },
  { path: 'publicUrl', label: 'Public URL', type: 'text', hint: 'How clients reach this node (https://…). Used in the reference.' },
  { path: 'contact', label: 'Contact', type: 'text' },
  { path: 'signup.grant', label: 'Credits for new accounts', type: 'number' },
  { path: 'signup.powBits', label: 'Proof of work for new accounts (bits)', type: 'number', hint: '0 = none; 16–20 slows down account farming' },
  { path: 'signup.anonymous', label: 'Allow anonymous accounts', type: 'bool' },
  { path: 'peers', label: 'Recommended nodes', type: 'list', hint: 'Node references, comma separated' },
];

function get(config: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config);
}

function patchFor(path: string, value: unknown): Record<string, unknown> {
  return path
    .split('.')
    .reverse()
    .reduce<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
}

function SettingsTab({ fields }: { fields: FieldDef[] }) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [json, setJson] = useState('');
  const [toast, show] = useToast();
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    admin<Record<string, unknown>>('/v1/admin/config')
      .then((c) => {
        setConfig(c);
        setJson(JSON.stringify(c, null, 2));
      })
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (patch: Record<string, unknown>, replace = false) => {
    setSaving(true);
    try {
      const next = await admin<Record<string, unknown>>(`/v1/admin/config${replace ? '?replace=1' : ''}`, { method: 'PUT', body: patch });
      setConfig(next);
      setJson(JSON.stringify(next, null, 2));
      show('Saved. Address and port changes need a restart.');
    } catch (e) {
      show(message(e));
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <Loading />;
  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Quick settings</h3>
        <div className="form-grid">
          {[...COMMON_FIELDS, ...fields].map((field) => {
            const value = get(config, field.path);
            const commit = (next: unknown) => void save(patchFor(field.path, next));
            return (
              <label key={field.path} className="field">
                {field.label}
                {field.type === 'bool' ? (
                  <select value={String(Boolean(value))} onChange={(e) => commit(e.target.value === 'true')}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : field.type === 'select' ? (
                  <select value={String(value)} onChange={(e) => commit(e.target.value)}>
                    {field.options!.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    key={JSON.stringify(value)}
                    type={field.type === 'number' ? 'number' : 'text'}
                    defaultValue={field.type === 'list' ? ((value as string[]) ?? []).join(', ') : String(value ?? '')}
                    onBlur={(e) => {
                      const text = e.target.value;
                      const next =
                        field.type === 'number'
                          ? Number(text)
                          : field.type === 'list'
                            ? text.split(',').map((s) => s.trim()).filter(Boolean)
                            : text || undefined;
                      if (JSON.stringify(next) !== JSON.stringify(value)) commit(next);
                    }}
                  />
                )}
                {field.hint && <span className="hint">{field.hint}</span>}
              </label>
            );
          })}
        </div>
      </div>
      <div className="card form-stack">
        <h3>Full configuration</h3>
        <p className="small muted">
          Everything, including payment methods and storage backends. See docs/OPERATORS.md for every option. Saving replaces the whole
          configuration.
        </p>
        <textarea className="mono" rows={24} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
        <div className="row">
          <button
            className="primary"
            disabled={saving}
            onClick={() => {
              try {
                void save(JSON.parse(json), true);
              } catch {
                show('That is not valid JSON');
              }
            }}
          >
            {saving && <Spinner />} Save configuration
          </button>
          <button onClick={load}>Revert</button>
        </div>
      </div>
    </div>
  );
}

export function AdminApp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [needsLogin, setNeedsLogin] = useState(!loadToken());
  const [tab, setTab] = useState('overview');

  const load = useCallback(() => {
    admin<Status>('/v1/admin/status')
      .then((s) => {
        setStatus(s);
        setNeedsLogin(false);
      })
      .catch(() => setNeedsLogin(true));
  }, []);
  useEffect(() => {
    if (!needsLogin) load();
  }, [needsLogin, load]);

  if (needsLogin) return <Login onLogin={() => setNeedsLogin(false)} />;
  if (!status) return <Loading />;
  const provider = status.info.type === 'provider';
  const tabs: [string, string][] = [
    ['overview', 'Overview'],
    ...(provider
      ? ([
          ['content', 'Content'],
          ['storage', 'Storage'],
        ] as [string, string][])
      : ([
          ['review', `Review${status.pending ? ` (${status.pending.submissions + status.pending.suggestions})` : ''}`],
          ['catalog', 'Catalog'],
          ['crawler', 'Crawler'],
          ['creators', 'Creators'],
        ] as [string, string][])),
    ['accounts', 'Accounts'],
    ['payments', 'Payments'],
    ['settings', 'Settings'],
  ];

  return (
    <div className="page" style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div className="page-header">
        <div className="row">
          <div className="brand-logo">
            <Sparkles size={18} />
          </div>
          <div>
            <h1>{status.info.name}</h1>
            <p>
              {provider ? 'Content provider' : 'Search algorithm'} node · {status.info.software}
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setToken('');
            setNeedsLogin(true);
          }}
        >
          <LogOut size={15} /> Sign out
        </button>
      </div>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => (setTab(id), load())}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview status={status} />}
      {tab === 'accounts' && <Accounts />}
      {tab === 'payments' && <Payments />}
      {tab === 'settings' && <SettingsTab fields={provider ? PROVIDER_FIELDS : ALGORITHM_FIELDS} />}
      {provider ? <ProviderTabs tab={tab} /> : <AlgorithmTabs tab={tab} />}
    </div>
  );
}

const PROVIDER_FIELDS: FieldDef[] = [
  { path: 'pricing.perMiB', label: 'Credits per MiB downloaded', type: 'number' },
  { path: 'pricing.manifest', label: 'Credits per manifest', type: 'number' },
  { path: 'pricing.freeMiBPerDay', label: 'Free MiB per account per day', type: 'number' },
  { path: 'pricing.creatorShare', label: 'Share of download credits paid to uploaders (0–1)', type: 'number' },
  { path: 'pricing.upload.mode', label: 'Uploads', type: 'select', options: ['open', 'paid', 'closed'] },
  { path: 'pricing.upload.perMiB', label: 'Upload price per MiB (paid mode)', type: 'number' },
  { path: 'pricing.upload.maxBytes', label: 'Largest upload (bytes)', type: 'number' },
  { path: 'storage.replication', label: 'Copies of each chunk', type: 'number', hint: 'Across writable storage backends' },
  { path: 'storage.usePeers', label: 'Fetch missing chunks from client storage', type: 'bool' },
  { path: 'catalog', label: 'Publish catalog', type: 'bool' },
  { path: 'storageService.enabled', label: 'Storage service for clients', type: 'bool' },
  { path: 'storageService.auto.enabled', label: 'Storage job for every upload', type: 'bool' },
  { path: 'storageService.auto.replicas', label: 'Client copies per upload', type: 'number' },
  { path: 'storageService.auto.durationDays', label: 'Storage term (days)', type: 'number' },
];

const ALGORITHM_FIELDS: FieldDef[] = [
  { path: 'ranking.strategy', label: 'Ranking', type: 'select', options: ['balanced', 'hot', 'new', 'top', 'random', 'custom'] },
  { path: 'ranking.module', label: 'Custom ranking module', type: 'text', hint: 'Path to an ES module (strategy = custom)' },
  { path: 'ranking.description', label: 'Ranking description', type: 'text' },
  { path: 'ranking.weights.quality', label: 'Weight: approval', type: 'number' },
  { path: 'ranking.weights.recency', label: 'Weight: freshness', type: 'number' },
  { path: 'ranking.weights.preference', label: 'Weight: favourite topics', type: 'number' },
  { path: 'ranking.weights.discovery', label: 'Weight: discovery', type: 'number' },
  { path: 'pricing.feed', label: 'Credits per feed page', type: 'number' },
  { path: 'pricing.search', label: 'Credits per search', type: 'number' },
  { path: 'pricing.submission', label: 'Credits per submission', type: 'number' },
  { path: 'rewards.vote', label: 'Reward per vote', type: 'number' },
  { path: 'rewards.voteDailyCap', label: 'Rewarded votes per day', type: 'number' },
  { path: 'rewards.acceptedSuggestion', label: 'Reward per accepted suggestion', type: 'number' },
  { path: 'rewards.autoAcceptAgreement', label: 'Auto-accept after N agreeing accounts', type: 'number', hint: '0 = only by hand' },
  { path: 'rewards.requireIdentity', label: 'Only key accounts earn', type: 'bool' },
  { path: 'policy.maxRating', label: 'Highest rating served', type: 'select', options: ['all', '10+', '13+', '16+', '18+', 'nsfw'] },
  { path: 'policy.defaultMaxRating', label: 'Default rating limit', type: 'select', options: ['all', '10+', '13+', '16+', '18+', 'nsfw'] },
  { path: 'policy.autoListSubmissions', label: 'List submissions without review', type: 'bool' },
];
