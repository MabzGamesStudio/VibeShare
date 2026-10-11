import { Coins, ExternalLink, Gift, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AccountResponse, NodeEntry } from '../../../src/shared/clientapi';
import type { Invoice, PaymentMethodInfo } from '../../../src/shared/protocol';
import { api, errorMessage } from '../api';
import { CodeBox, Empty, Loading, Spinner, StatusDot } from '../components/ui';
import { useApp } from '../state';
import { timeAgo } from '../util';
import { AUTH_LABELS } from './Nodes';

function TopUp({ node, method, onPaid }: { node: NodeEntry; method: PaymentMethodInfo; onPaid: () => void }) {
  const { toast } = useApp();
  const [credits, setCredits] = useState(String(method.minCredits ?? 1000));
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInvoice(null);
    setProof('');
  }, [method.id]);

  const claim = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await api<{ credited: number; balance: number; invoice?: Invoice }>(`/api/nodes/${node.id}/claim`, {
        body: { method: method.id, ...body },
      });
      if (result.invoice) setInvoice(result.invoice);
      if (result.credited) {
        toast(`+${result.credited} credits on ${node.name}`, 'success');
        setProof('');
        onPaid();
      } else if (result.invoice?.status === 'pending-review') toast('Sent to the operator for approval');
      else if (result.invoice?.status === 'paid') onPaid();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      setInvoice(await api<Invoice>(`/api/nodes/${node.id}/invoices`, { body: { method: method.id, credits: Number(credits) } }));
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (method.type === 'voucher') {
    return (
      <div className="form-stack">
        <label className="field">
          Voucher code
          <input type="text" className="mono" value={proof} onChange={(e) => setProof(e.target.value)} placeholder="VS-XXXX-XXXX-XXXX-XXXX" />
        </label>
        <button className="primary" disabled={!proof.trim() || busy} onClick={() => claim({ code: proof })}>
          {busy ? <Spinner /> : <Gift size={16} />} Redeem
        </button>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="form-stack">
        {method.rate && (
          <p className="small muted">
            {method.rate.credits.toLocaleString()} credits per {method.rate.per}
          </p>
        )}
        <label className="field">
          Credits
          <input type="number" min={method.minCredits ?? 1} max={method.maxCredits} value={credits} onChange={(e) => setCredits(e.target.value)} />
        </label>
        <button className="primary" onClick={create} disabled={busy || !(Number(credits) > 0)}>
          {busy ? <Spinner /> : <Coins size={16} />} Continue
        </button>
      </div>
    );
  }

  const crypto = ['evm', 'bitcoin', 'solana'].includes(method.type);
  return (
    <div className="form-stack">
      <div className="row between">
        <strong>{invoice.credits.toLocaleString()} credits</strong>
        <span className={`badge ${invoice.status === 'paid' ? 'ok' : invoice.status === 'open' ? 'accent' : 'warn'}`}>{invoice.status}</span>
      </div>
      {invoice.pay.instructions && <p className="small">{invoice.pay.instructions}</p>}
      {invoice.pay.amount && (
        <div>
          <div className="hint">Amount</div>
          <CodeBox text={`${invoice.pay.amount}${invoice.pay.currency ? ' ' + invoice.pay.currency : ''}`} />
        </div>
      )}
      {invoice.pay.address && (
        <div>
          <div className="hint">{method.type === 'lightning' ? 'Lightning invoice' : 'Pay to'}</div>
          <CodeBox text={invoice.pay.address} />
        </div>
      )}
      <div className="row">
        {invoice.pay.uri && (
          <a className="button" href={invoice.pay.uri}>
            <Wallet size={15} /> Open in wallet
          </a>
        )}
        {invoice.pay.checkoutUrl && (
          <a className="button primary" href={invoice.pay.checkoutUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> Pay
          </a>
        )}
      </div>
      {invoice.expiresAt && invoice.status === 'open' && <p className="hint">Expires {new Date(invoice.expiresAt).toLocaleString()}</p>}
      {crypto && invoice.status !== 'paid' && (
        <label className="field">
          Transaction id
          <input type="text" className="mono" value={proof} onChange={(e) => setProof(e.target.value)} placeholder="0x… / txid / signature" />
        </label>
      )}
      {method.type === 'manual' && invoice.status === 'open' && (
        <label className="field">
          Note for the operator
          <textarea value={proof} onChange={(e) => setProof(e.target.value)} placeholder="How and when you paid" rows={2} />
        </label>
      )}
      {invoice.status !== 'paid' && invoice.status !== 'rejected' && (
        <button
          className="primary"
          disabled={busy || (crypto && !proof.trim())}
          onClick={() => claim({ invoiceId: invoice.id, txHash: crypto ? proof.trim() : undefined, note: method.type === 'manual' ? proof : undefined })}
        >
          {busy && <Spinner />} {crypto ? 'I paid — check it' : method.type === 'manual' ? 'Send for approval' : 'Check payment'}
        </button>
      )}
    </div>
  );
}

function NodeWallet({ node }: { node: NodeEntry }) {
  const { refresh } = useApp();
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api<AccountResponse>(`/api/nodes/${node.id}/account`)
      .then(setAccount)
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [node.id]);

  const methods = node.info?.payments ?? [];
  const current = methods.find((m) => m.id === method) ?? methods[0];

  return (
    <div className="form-stack">
      <div className="card">
        <div className="row between">
          <div>
            <h2>{node.name}</h2>
            <p className="small muted">{AUTH_LABELS[node.auth].label}</p>
          </div>
          <div className="balance" style={{ fontSize: 32 }}>
            {account?.account.balance ?? node.balance ?? '–'} <small>credits</small>
          </div>
        </div>
        {error && <div className="banner danger small" style={{ marginTop: 12 }}>{error}</div>}
        {account && (
          <div className="row small muted" style={{ marginTop: 10 }}>
            <span>Earned {account.account.earned}</span>
            <span>Spent {account.account.spent}</span>
            <span className="mono tiny">{account.account.id}</span>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Get credits</h3>
        <p className="small" style={{ marginBottom: 14 }}>
          Credits only work on {node.name}. The operator decides the prices and how to pay. You can also earn them on the{' '}
          <a className="link" href="/earn">
            Earn
          </a>{' '}
          page.
        </p>
        {methods.length === 0 ? (
          <p className="muted small">This node does not sell credits.</p>
        ) : (
          <>
            <div className="chips" style={{ marginBottom: 16 }}>
              {methods.map((m) => (
                <button key={m.id} className={`chip ${current?.id === m.id ? 'on' : ''}`} onClick={() => setMethod(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
            {current && (
              <TopUp
                node={node}
                method={current}
                onPaid={() => {
                  load();
                  void refresh();
                }}
              />
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3>History</h3>
        {!account ? (
          <Loading />
        ) : account.history.length === 0 ? (
          <p className="muted small">No activity yet.</p>
        ) : (
          <table className="table" style={{ marginTop: 10 }}>
            <tbody>
              {account.history.map((entry, i) => (
                <tr key={i}>
                  <td className="small">{entry.reason}</td>
                  <td className="tiny faint">{timeAgo(entry.at)}</td>
                  <td style={{ textAlign: 'right', color: entry.amount > 0 ? 'var(--ok)' : undefined, fontWeight: 600 }}>
                    {entry.amount > 0 ? '+' : ''}
                    {entry.amount}
                  </td>
                  <td className="tiny faint" style={{ textAlign: 'right' }}>
                    {entry.balance}
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

export function WalletPage() {
  const { state } = useApp();
  const [params, setParams] = useSearchParams();
  if (!state) return null;
  const nodes = state.nodes;
  const selected = nodes.find((n) => n.id === params.get('node')) ?? nodes[0];
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Credits</h1>
          <p>Every node runs its own credits. Balances here are separate and only spendable on the node that issued them.</p>
        </div>
      </div>
      {!nodes.length ? (
        <Empty icon={<Coins size={40} />} title="No nodes yet" />
      ) : (
        <div className="wallet-layout">
          <div className="check-list">
            {nodes.map((node) => (
              <button
                key={node.id}
                className="check-item"
                style={{ justifyContent: 'space-between', background: node.id === selected?.id ? 'var(--accent-soft)' : undefined }}
                onClick={() => setParams({ node: node.id })}
              >
                <span className="row" style={{ gap: 8 }}>
                  <StatusDot online={node.status.online} enabled={node.enabled} />
                  <span style={{ textAlign: 'left' }}>
                    <div>{node.name}</div>
                    <div className="tiny faint">{node.type}</div>
                  </span>
                </span>
                <strong>{node.balance ?? '–'}</strong>
              </button>
            ))}
          </div>
          {selected && <NodeWallet key={selected.id} node={selected} />}
        </div>
      )}
    </div>
  );
}
