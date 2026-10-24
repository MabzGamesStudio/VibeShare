import { LogOut, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
  pending?: { suggestions: number; submissions: number; creatorSuggestions?: number; iconSuggestions?: number; accountLinks?: number };
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
        {info.onion && (
          <p className="small" style={{ marginTop: 12 }}>
            Tor onion address: <code>{info.onion}</code>
            {status.reference.includes('.onion') ? '' : ' — clients with Tor on for every node use it automatically.'}
          </p>
        )}
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
            <div className="value">
              {status.pending.submissions +
                status.pending.suggestions +
                (status.pending.creatorSuggestions ?? 0) +
                (status.pending.iconSuggestions ?? 0) +
                (status.pending.accountLinks ?? 0)}
            </div>
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
                    <div className="row" style={{ gap: 4 }}>
                      <button className="small" onClick={() => setAdjusting(row)}>
                        Adjust
                      </button>
                      <button
                        className="small"
                        title="Ban this account for good"
                        onClick={async () => {
                          try {
                            await admin('/v1/admin/moderation', { body: { subject: 'account', target: row.id, action: 'permaban', reason: 'banned by operator' } });
                            show(`Banned ${row.id.slice(0, 16)}…`);
                          } catch (e) {
                            show(message(e));
                          }
                        }}
                      >
                        Ban
                      </button>
                      <button
                        className="small"
                        title="Hold this account to 30 requests a minute"
                        onClick={async () => {
                          try {
                            await admin('/v1/admin/moderation', { body: { subject: 'account', target: row.id, action: 'ratelimit', perMinute: 30, reason: 'rate limited by operator' } });
                            show(`Rate limited ${row.id.slice(0, 16)}… to 30/min`);
                          } catch (e) {
                            show(message(e));
                          }
                        }}
                      >
                        Limit
                      </button>
                    </div>
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

interface ModRow {
  id: string;
  subject: string;
  target: string;
  action: string;
  until?: string;
  perMinute?: number;
  reason?: string;
  by: string;
}

/** Bans, suspensions and rate limits for accounts, IPs and node peers — kept and shared. */
function ModerationPanel() {
  const [rows, setRows] = useState<ModRow[] | null>(null);
  const [subject, setSubject] = useState('account');
  const [target, setTarget] = useState('');
  const [action, setAction] = useState('permaban');
  const [until, setUntil] = useState('');
  const [perMinute, setPerMinute] = useState('30');
  const [reason, setReason] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ entries: ModRow[] }>('/v1/admin/moderation')
      .then((r) => setRows(r.entries))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);
  const add = async () => {
    if (!target) return show('Give the account id, IP address or peer node id to moderate');
    try {
      await admin('/v1/admin/moderation', {
        body: {
          subject,
          target,
          action,
          reason,
          ...(action === 'tempban' ? { until: until ? new Date(until).toISOString() : undefined } : {}),
          ...(action === 'ratelimit' ? { perMinute: Number(perMinute) || 30 } : {}),
        },
      });
      setTarget('');
      load();
    } catch (e) {
      show(message(e));
    }
  };
  return (
    <div className="card form-stack">
      <h3>Moderation</h3>
      <p className="small muted">
        Ban for good, suspend for a while, or hold to so many requests a minute — accounts, whole IP addresses and node peers alike. Entries live on this
        node and travel to its peers when they sync, so a ban here reaches the rest of the network.
      </p>
      {toast && <div className="banner info small">{toast}</div>}
      <div className="form-grid">
        <label className="field">
          Subject
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="account">Account</option>
            <option value="ip">IP address</option>
            <option value="peer">Node peer</option>
          </select>
        </label>
        <label className="field">
          Target
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={subject === 'ip' ? '203.0.113.5' : 'vk1… or account id'} />
        </label>
        <label className="field">
          Action
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="permaban">Ban for good</option>
            <option value="tempban">Suspend for a while</option>
            <option value="ratelimit">Rate limit</option>
          </select>
        </label>
        {action === 'tempban' && (
          <label className="field">
            Until
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        {action === 'ratelimit' && (
          <label className="field">
            Requests / minute
            <input type="number" min={1} value={perMinute} onChange={(e) => setPerMinute(e.target.value)} />
          </label>
        )}
        <label className="field">
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="spam, abuse, flooding…" />
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={() => void add()}>
          Apply
        </button>
        <button
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            try {
              const answer = await admin<{ peers: number; accepted: number }>('/v1/admin/moderation/sync', { method: 'POST', body: {} });
              show(`Synced with ${answer.peers} peer${answer.peers === 1 ? '' : 's'} — took in ${answer.accepted}`);
              load();
            } catch (e) {
              show(message(e));
            }
            setSyncing(false);
          }}
        >
          {syncing ? 'Syncing…' : 'Sync with peers'}
        </button>
      </div>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="small muted">Nothing moderated right now.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Target</th>
              <th>Action</th>
              <th>Reason</th>
              <th>By</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="small">{row.subject}</td>
                <td className="mono tiny" title={row.target}>
                  {row.target.length > 26 ? `${row.target.slice(0, 26)}…` : row.target}
                </td>
                <td className="small">
                  {row.action === 'permaban'
                    ? 'banned for good'
                    : row.action === 'tempban'
                      ? `suspended until ${new Date(row.until ?? '').toLocaleString()}`
                      : `${row.perMinute ?? 30}/min`}
                </td>
                <td className="small">{row.reason ?? '—'}</td>
                <td className="tiny faint">{row.by}</td>
                <td>
                  <button
                    className="small"
                    onClick={async () => {
                      await admin(`/v1/admin/moderation/${row.id}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                      load();
                    }}
                  >
                    Lift
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
  { path: 'host', label: 'Listen address', type: 'text', hint: 'Address and port take effect after a restart' },
  { path: 'port', label: 'Listen port', type: 'number' },
  { path: 'trustProxy', label: 'Behind a reverse proxy', type: 'bool', hint: 'Trust X-Forwarded-For headers when counting signups per address' },
  { path: 'publicUrl', label: 'Public URL', type: 'text', hint: 'How clients reach this node (https://…). Used in the reference.' },
  { path: 'contact', label: 'Contact', type: 'text' },
  { path: 'signup.grant', label: 'Credits for new accounts', type: 'number' },
  { path: 'signup.powBits', label: 'Proof of work for new accounts (bits)', type: 'number', hint: '0 = none; 16–20 slows down account farming' },
  { path: 'signup.anonymous', label: 'Allow anonymous accounts', type: 'bool' },
  { path: 'signup.perIpPerHour', label: 'New accounts per address per hour', type: 'number', hint: '0 = unlimited' },
  { path: 'peers', label: 'Recommended nodes', type: 'list', hint: 'Node references, comma separated' },
  {
    path: 'tor.onionService',
    label: 'Publish as a Tor onion service',
    type: 'bool',
    hint: 'Needs Tor running with a ControlPort. Reachable without a public address or open port.',
  },
  { path: 'tor.controlPort', label: 'Tor control port', type: 'text', hint: 'ControlPort in torrc, e.g. 127.0.0.1:9051' },
  { path: 'tor.controlPassword', label: 'Tor control password', type: 'text', hint: 'For HashedControlPassword; empty = cookie authentication' },
  {
    path: 'tor.outbound',
    label: 'Outgoing requests through Tor',
    type: 'select',
    options: ['onion', 'all', 'off'],
    hint: 'onion: only to .onion nodes; all: every request to other nodes and the crawler',
  },
  { path: 'tor.proxy', label: 'Tor SOCKS address', type: 'text', hint: 'Empty: 127.0.0.1:9050, or Tor Browser on 9150' },
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

function SettingsTab({ groups }: { groups: FieldGroup[] }) {
  const [group, setGroup] = useState(() => groups[0]?.id ?? '');
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
  const active = groups.find((g) => g.id === group) ?? groups[0];
  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="tabs">
        {groups.map((g) => (
          <button key={g.id} className={`tab ${active.id === g.id ? 'on' : ''}`} onClick={() => setGroup(g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="card form-stack">
        <h3>{active.label}</h3>
        <div className="form-grid">
          {active.fields.map((field) => {
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
      {active.extra?.(config, save)}
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

/** One price for keeping a client's seen-content filter here. */
interface Tier {
  id: string;
  label?: string;
  maxBits: number;
  durationSeconds: number;
  price: number;
}

interface StoredFilter {
  account: string;
  bits: number;
  expected: number;
  hashes: number;
  expiresAt: string;
}

/** An account's own long-term filter kept here (no expiry), refreshed by hand or by its job. */
interface AccountFilterRow {
  account: string;
  bits: number;
  expected: number;
  hashes: number;
  updatedAt: string;
}

/** The storage tiers the operator sells, and the client filters kept here right now. */
function BloomStorage({ config, save }: { config: Record<string, unknown>; save: (patch: Record<string, unknown>) => Promise<void> }) {
  const tiers = ((get(config, 'bloom.storage.tiers') as Tier[] | undefined) ?? []).map((tier) => ({ ...tier }));
  const [stored, setStored] = useState<StoredFilter[] | null>(null);
  const [accountFilters, setAccountFilters] = useState<AccountFilterRow[] | null>(null);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ stored: StoredFilter[]; accountFilters: AccountFilterRow[] }>('/v1/admin/bloom')
      .then((result) => {
        setStored(result.stored);
        setAccountFilters(result.accountFilters ?? []);
      })
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const commit = (next: Tier[]) => void save({ bloom: { storage: { tiers: next } } });

  return (
    <div className="card form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <h3>Storage tiers</h3>
      <p className="small muted">
        Clients pay to keep their seen-content filter on this node; whatever collides with it is never suggested again to them. Each tier is one
        price: how big a filter may be, for how long, at what cost in credits.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Id</th>
            <th>Biggest filter (bits)</th>
            <th>Duration (seconds)</th>
            <th>Credits</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier, index) => {
            const change = (patch: Partial<Tier>) => commit(tiers.map((t, i) => (i === index ? { ...t, ...patch } : t)));
            return (
              <tr key={`${index}:${JSON.stringify(tier)}`}>
                <td>
                  <input type="text" defaultValue={tier.label ?? ''} onBlur={(e) => change({ label: e.target.value })} />
                </td>
                <td>
                  <input type="text" className="mono" defaultValue={tier.id} onBlur={(e) => change({ id: e.target.value })} />
                </td>
                <td>
                  <input type="number" min={1} defaultValue={tier.maxBits} onBlur={(e) => change({ maxBits: Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" min={0} defaultValue={tier.durationSeconds} onBlur={(e) => change({ durationSeconds: Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" min={0} defaultValue={tier.price} onBlur={(e) => change({ price: Number(e.target.value) })} />
                </td>
                <td>
                  <button className="small" onClick={() => commit(tiers.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <button onClick={() => commit([...tiers, { id: `tier${tiers.length + 1}`, maxBits: 32_768, durationSeconds: 86_400, price: 1 }])}>
          Add tier
        </button>
      </div>
      <h3>Filters kept right now</h3>
      {!stored ? (
        <Loading />
      ) : stored.length === 0 ? (
        <p className="small muted">None.</p>
      ) : (
        <table className="table">
          <tbody>
            {stored.map((entry) => (
              <tr key={entry.account}>
                <td>
                  <div className="mono tiny">{entry.account}</div>
                </td>
                <td className="small">
                  {entry.bits} bits · made for {entry.expected} items · {entry.hashes} hashes
                </td>
                <td className="tiny faint">until {new Date(entry.expiresAt).toLocaleString()}</td>
                <td>
                  <button
                    className="small"
                    onClick={async () => {
                      await admin(`/v1/admin/bloom/${encodeURIComponent(entry.account)}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                      load();
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Account filters kept long term</h3>
      <p className="small muted">
        Each account's own much larger filter, kept until it is dropped: refreshed by hand in the client's settings, or by its resubmission
        job. Whatever collides with it is never suggested again to that account.
      </p>
      {!accountFilters ? (
        <Loading />
      ) : accountFilters.length === 0 ? (
        <p className="small muted">None.</p>
      ) : (
        <table className="table">
          <tbody>
            {accountFilters.map((entry) => (
              <tr key={entry.account}>
                <td>
                  <div className="mono tiny">{entry.account}</div>
                </td>
                <td className="small">
                  {entry.bits} bits · made for {entry.expected} items · {entry.hashes} hashes
                </td>
                <td className="tiny faint">updated {new Date(entry.updatedAt).toLocaleString()}</td>
                <td>
                  <button
                    className="small"
                    onClick={async () => {
                      await admin(`/v1/admin/account-filters/${encodeURIComponent(entry.account)}`, { method: 'DELETE' }).catch((e) =>
                        show(message(e))
                      );
                      load();
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
          [
            'review',
            `Review${status.pending ? ` (${status.pending.submissions + status.pending.suggestions + (status.pending.creatorSuggestions ?? 0) + (status.pending.iconSuggestions ?? 0) + (status.pending.accountLinks ?? 0)})` : ''}`,
          ],
          ['catalog', 'Catalog'],
          ['claims', 'Claims'],
          ['peers', 'Peers'],
          ['crawler', 'Crawler'],
          ['apis', 'API keys'],
          ['sources', 'Sources'],
          ['creators', 'Creators'],
          ['comments', 'Comments'],
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
              {provider ? 'Content provider' : 'Search algorithm'} node · {status.info.software} · page built {__VS_BUILD__}
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
      {tab === 'accounts' && (
        <>
          <Accounts />
          <ModerationPanel />
        </>
      )}
      {tab === 'payments' && <Payments />}
      {tab === 'settings' && <SettingsTab groups={provider ? PROVIDER_GROUPS : ALGORITHM_GROUPS} />}
      {provider ? <ProviderTabs tab={tab} /> : <AlgorithmTabs tab={tab} />}
    </div>
  );
}

/** The node's settings, grouped into tab categories on the settings page. */
export interface FieldGroup {
  id: string;
  label: string;
  fields: FieldDef[];
  /** A panel of its own under the fields, for settings that are more than one field. */
  extra?: (config: Record<string, unknown>, save: (patch: Record<string, unknown>) => Promise<void>) => ReactNode;
}

const PROVIDER_GROUPS: FieldGroup[] = [
  { id: 'general', label: 'General', fields: COMMON_FIELDS },
  {
    id: 'prices',
    label: 'Prices and storage',
    fields: [
      { path: 'pricing.perMiB', label: 'Credits per MiB downloaded', type: 'number' },
      { path: 'pricing.manifest', label: 'Credits per manifest', type: 'number' },
      { path: 'pricing.freeMiBPerDay', label: 'Free MiB per account per day', type: 'number' },
      { path: 'pricing.creatorShare', label: 'Share of download credits paid to uploaders (0–1)', type: 'number' },
      { path: 'pricing.upload.mode', label: 'Uploads', type: 'select', options: ['open', 'paid', 'closed'] },
      { path: 'pricing.upload.perMiB', label: 'Upload price per MiB (paid mode)', type: 'number' },
      { path: 'pricing.upload.maxBytes', label: 'Largest upload (bytes)', type: 'number' },
      { path: 'storage.replication', label: 'Copies of each chunk', type: 'number', hint: 'Across writable storage backends' },
      { path: 'storage.cacheMiB', label: 'Chunk cache (MiB)', type: 'number', hint: 'Hot chunks kept in memory' },
      { path: 'storage.cacheFetched', label: 'Keep chunks fetched from others', type: 'bool', hint: 'Copy chunks read from read-only backends or peers into writable backends' },
      { path: 'storage.usePeers', label: 'Fetch missing chunks from client storage', type: 'bool' },
      { path: 'catalog', label: 'Publish catalog', type: 'bool' },
    ],
  },
  {
    id: 'rewards',
    label: 'Rewards',
    fields: [
      { path: 'rewards.report', label: 'Reward per reported content id', type: 'number' },
      { path: 'rewards.reportDailyCap', label: 'Rewarded reports per day', type: 'number' },
      { path: 'rewards.suggestion', label: 'Reward per accepted suggestion', type: 'number' },
      { path: 'rewards.suggestionDailyCap', label: 'Rewarded suggestions per day', type: 'number' },
    ],
  },
  {
    id: 'links',
    label: 'Content URLs',
    fields: [
      { path: 'contentUrls.autoAccept', label: 'Accept client URLs without review', type: 'bool', hint: 'Otherwise the operator reviews each link in Content' },
      { path: 'contentUrls.maxUrlsPerClient', label: 'Single URLs per client', type: 'number' },
      { path: 'contentUrls.maxBaseUrlsPerClient', label: 'Base URLs per client', type: 'number' },
      { path: 'contentUrls.creditPerDownload', label: 'Credits per verified download', type: 'number' },
    ],
  },
  {
    id: 'storage-service',
    label: 'Storage service',
    fields: [
      { path: 'storageService.enabled', label: 'Storage service for clients', type: 'bool' },
      { path: 'storageService.challengeIntervalSeconds', label: 'Seconds between challenges', type: 'number' },
      { path: 'storageService.minPassRatio', label: 'Passing answers needed (0–1)', type: 'number' },
      { path: 'storageService.offlineGraceSeconds', label: 'Seconds before a holder counts offline', type: 'number' },
      { path: 'storageService.taskTimeoutSeconds', label: 'Seconds until a storage task expires', type: 'number' },
      { path: 'storageService.auto.enabled', label: 'Storage job for every upload', type: 'bool' },
      { path: 'storageService.auto.replicas', label: 'Client copies per upload', type: 'number' },
      { path: 'storageService.auto.durationDays', label: 'Storage term (days)', type: 'number' },
      { path: 'storageService.auto.requireIdentity', label: 'Only key accounts may hold data', type: 'bool' },
      { path: 'storageService.auto.rewards.upfront', label: 'Credits when hired', type: 'number' },
      { path: 'storageService.auto.rewards.perRetrieval', label: 'Credits per retrieval', type: 'number' },
      { path: 'storageService.auto.rewards.perChallenge', label: 'Credits per passed challenge', type: 'number' },
      { path: 'storageService.auto.rewards.completion', label: 'Credits at the end of the term', type: 'number' },
    ],
  },
];

const ALGORITHM_GROUPS: FieldGroup[] = [
  { id: 'general', label: 'General', fields: COMMON_FIELDS },
  {
    id: 'ranking',
    label: 'Ranking',
    fields: [
      { path: 'ranking.strategy', label: 'Ranking', type: 'select', options: ['balanced', 'hot', 'new', 'top', 'random', 'custom'] },
      { path: 'ranking.module', label: 'Custom ranking module', type: 'text', hint: 'Path to an ES module (strategy = custom)' },
      { path: 'ranking.description', label: 'Ranking description', type: 'text' },
      { path: 'ranking.weights.quality', label: 'Weight: approval', type: 'number' },
      { path: 'ranking.weights.recency', label: 'Weight: freshness', type: 'number' },
      { path: 'ranking.weights.preference', label: 'Weight: favourite topics', type: 'number' },
      { path: 'ranking.weights.discovery', label: 'Weight: discovery', type: 'number' },
      { path: 'ranking.halfLifeHours', label: 'Freshness half-life (hours)', type: 'number', hint: 'After this long a new item is worth half as much for being new' },
      { path: 'ranking.gravity', label: 'Gravity (hot ranking)', type: 'number', hint: 'How steeply older items fall in the hot ranking' },
    ],
  },
  {
    id: 'prices',
    label: 'Prices',
    fields: [
      { path: 'pricing.feed', label: 'Credits per feed page', type: 'number' },
      { path: 'pricing.search', label: 'Credits per search', type: 'number' },
      { path: 'pricing.lookup', label: 'Credits per lookup', type: 'number' },
      { path: 'pricing.submission', label: 'Credits per submission', type: 'number' },
    ],
  },
  {
    id: 'rewards',
    label: 'Rewards',
    fields: [
      { path: 'rewards.vote', label: 'Reward per vote', type: 'number' },
      { path: 'rewards.voteDailyCap', label: 'Rewarded votes per day', type: 'number' },
      { path: 'rewards.acceptedSuggestion', label: 'Reward per accepted suggestion', type: 'number' },
      { path: 'rewards.autoAcceptAgreement', label: 'Auto-accept after N agreeing accounts', type: 'number', hint: '0 = only by hand' },
      { path: 'rewards.report', label: 'Reward per report', type: 'number' },
      { path: 'rewards.reportDailyCap', label: 'Rewarded reports per day', type: 'number' },
      { path: 'rewards.requireIdentity', label: 'Only key accounts earn', type: 'bool' },
    ],
  },
  {
    id: 'policy',
    label: 'Policy and creators',
    fields: [
      { path: 'policy.maxRating', label: 'Highest rating served', type: 'select', options: ['all', '10+', '13+', '16+', '18+', 'nsfw'] },
      { path: 'policy.defaultMaxRating', label: 'Default rating limit', type: 'select', options: ['all', '10+', '13+', '16+', '18+', 'nsfw'] },
      { path: 'policy.autoListSubmissions', label: 'List submissions without review', type: 'bool' },
      {
        path: 'maxCreatorAccounts',
        label: 'Accounts a creator may link',
        type: 'number',
        hint: 'YouTube, TikTok, Twitter… accounts one creator may link together here',
      },
      {
        path: 'allowUnsignedAccountLinks',
        label: 'Allow account links without the creator key',
        type: 'bool',
        hint: 'Anyone may propose external links to a creator; you decide in Review whether they are linked',
      },
      { path: 'pageSize', label: 'Items per page', type: 'number' },
      { path: 'topics', label: 'Topics offered to clients', type: 'list', hint: 'Comma separated' },
    ],
  },
  {
    id: 'discovery',
    label: 'Discovery',
    fields: [
      { path: 'crawler.enabled', label: 'Find content by itself', type: 'bool' },
      { path: 'crawler.searchPlatforms', label: 'Search platforms for queries', type: 'bool' },
      { path: 'crawler.maxEntries', label: 'Most contents kept', type: 'number' },
      { path: 'crawler.defaultRating', label: 'Rating for finds without one', type: 'select', options: ['all', '10+', '13+', '16+', '18+', 'nsfw'] },
    ],
  },
  {
    id: 'peering',
    label: 'Peering',
    fields: [
      { path: 'peering.bootstrap', label: 'Bootstrap nodes', type: 'list', hint: 'Seed node references a new node peers with first, comma separated' },
      { path: 'peering.maxPeers', label: 'Most peers kept', type: 'number', hint: 'The widest reach this node holds at once' },
    ],
  },
  {
    id: 'seen',
    label: 'Seen-content filters',
    fields: [
      {
        path: 'bloom.inlineMaxBits',
        label: 'Largest filter inside a request (bits)',
        type: 'number',
        hint: 'Clients may also pay to keep their filter here — the prices are the storage tiers below. Whatever collides is never suggested again',
      },
    ],
    extra: (config, save) => <BloomStorage config={config} save={save} />,
  },
  {
    id: 'comments',
    label: 'Comments',
    fields: [
      { path: 'comments.maxPerHour', label: 'Comments per account per hour', type: 'number', hint: 'The rate limit for one account (0 = unlimited)' },
      { path: 'comments.maxLength', label: 'Longest comment (characters)', type: 'number' },
      {
        path: 'comments.storage',
        label: 'Where comment data is kept',
        type: 'select',
        options: ['node', 'provider'],
        hint: 'The block headers always stay here. "provider" sends the comment data to a content provider instead',
      },
      { path: 'comments.provider.url', label: 'Content provider for comment data', type: 'text', hint: 'The provider node reference or URL; needed when comment data is kept on a provider' },
    ],
  },
  {
    id: 'console',
    label: 'Console',
    fields: [
      { path: 'console.catalog.paging', label: 'Catalog: lazy loading or pagination', type: 'select', options: ['lazy', 'pages'] },
      { path: 'console.catalog.perPage', label: 'Catalog: items per page', type: 'number', hint: '5–500' },
      { path: 'console.creators.paging', label: 'Creators: lazy loading or pagination', type: 'select', options: ['lazy', 'pages'] },
      { path: 'console.creators.perPage', label: 'Creators: items per page', type: 'number', hint: '5–500' },
    ],
  },
];
