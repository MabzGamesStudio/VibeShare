import { Coins, ExternalLink, Gift, Wallet } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AccountResponse, NodeEntry } from '../../../src/shared/clientapi';
import type { Invoice, PaymentMethodInfo } from '../../../src/shared/protocol';
import type { StoredReceipt } from '../../../src/client/receipts';
import { api, errorMessage } from '../api';
import { CodeBox, Empty, Loading, Spinner, StatusDot } from '../components/ui';
import { CryptoSafetyNotice } from '../components/CryptoSafetyNotice';
import { useApp } from '../state';
import { timeAgo } from '../util';
import { AUTH_LABELS } from './Nodes';

/** How many receipts one page shows. */
const PAGE = 25;

interface Pager {
  mode: 'pages' | 'lazy';
  setMode: (mode: 'pages' | 'lazy') => void;
  page: number;
  setPage: (update: (page: number) => number) => void;
  setShown: (update: (shown: number) => number) => void;
  sentinel: React.RefObject<HTMLDivElement | null>;
  pages: number;
  start: number;
  end: number;
}

/** How the list loads: a page at a time, or as the inner card is scrolled. */
function usePager(total: number): Pager {
  const [mode, setMode] = useState<'pages' | 'lazy'>('pages');
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (mode !== 'lazy') return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((n) => n + PAGE);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [mode, total]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const start = mode === 'pages' ? Math.min(page, pages - 1) * PAGE : 0;
  const end = mode === 'pages' ? start + PAGE : Math.min(total, shown);
  return { mode, setMode, page, setPage, setShown, sentinel, pages, start, end };
}

function PagerBar({ pager, total }: { pager: Pager; total: number }) {
  return (
    <div className="row between" style={{ marginBottom: 8 }}>
      <span className="tiny faint">
        {total} items{pager.mode === 'pages' ? ` · page ${Math.min(pager.page, pager.pages - 1) + 1} of ${pager.pages}` : ''}
      </span>
      <select
        className="small"
        value={pager.mode}
        aria-label="How the list loads"
        onChange={(e) => {
          pager.setMode(e.target.value as 'pages' | 'lazy');
          pager.setPage(() => 0);
          pager.setShown(() => PAGE);
        }}
      >
        <option value="pages">By page</option>
        <option value="lazy">As I scroll</option>
      </select>
    </div>
  );
}

function PagerNav({ pager }: { pager: Pager }) {
  if (pager.mode !== 'pages' || pager.pages <= 1) return null;
  return (
    <div className="row" style={{ marginTop: 8, gap: 8 }}>
      <button className="small" disabled={pager.page <= 0} onClick={() => pager.setPage((p) => Math.max(0, p - 1))}>
        Previous
      </button>
      <button className="small" disabled={pager.page >= pager.pages - 1} onClick={() => pager.setPage((p) => Math.min(pager.pages - 1, p + 1))}>
        Next
      </button>
    </div>
  );
}

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

  // Crypto methods always mean a transfer made outside the app; the node says whether it
  // needs the payer's proof (a transaction id or payment hash) for that transfer.
  const crypto = ['evm', 'bitcoin', 'monero', 'solana', 'lightning'].includes(method.type);
  const needsProof = method.needsProof ?? crypto;

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
        {crypto && <CryptoSafetyNotice compact />}
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

  return (
    <div className="form-stack">
      {crypto && <CryptoSafetyNotice compact />}
      <div className="row between">
        <strong>{invoice.credits.toLocaleString()} credits</strong>
        <span className={`badge ${invoice.status === 'paid' ? 'ok' : invoice.status === 'open' ? 'accent' : 'warn'}`}>{invoice.status}</span>
      </div>
      {invoice.pay.instructions && <p className="small">{invoice.pay.instructions}</p>}
      {method.review && (
        <p className="hint">This node has no way to check the transfer itself: the operator confirms it in their own wallet before the credits land.</p>
      )}
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
      {needsProof && invoice.status !== 'paid' && (
        <label className="field">
          {method.type === 'lightning' ? 'Payment hash or preimage' : method.type === 'monero' ? 'Monero transaction id' : 'Transaction id'}
          <input
            type="text"
            className="mono"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            placeholder={method.type === 'lightning' ? 'your wallet shows this after paying' : '0x… / txid / signature'}
          />
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
          disabled={busy || (needsProof && !proof.trim())}
          onClick={() => claim({ invoiceId: invoice.id, txHash: needsProof ? proof.trim() : undefined, note: method.type === 'manual' ? proof : undefined })}
        >
          {busy && <Spinner />}{' '}
          {needsProof
            ? method.review
              ? 'I paid — send for review'
              : 'I paid — check it'
            : method.type === 'manual'
              ? 'Send for approval'
              : 'Check payment'}
        </button>
      )}
    </div>
  );
}

/**
 * Receipts this device saved automatically: for every payment request a node issued and
 * every transfer made, what was asked, what was paid (with the transaction id) and what
 * the node granted — signed by the node, kept locally, never uploaded. Only the receipts
 * of the node being looked at show up here.
 */
function Receipts({ node }: { node: NodeEntry }) {
  const [all, setAll] = useState<StoredReceipt[]>([]);
  const load = useCallback(() => {
    api<{ receipts: StoredReceipt[] }>('/api/receipts')
      .then((r) => setAll(r.receipts ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  // A receipt belongs to the node that signed it: it only ever shows on that node's wallet.
  const receipts = all.filter((receipt) => receipt.nodeId === node.id);
  const pager = usePager(receipts.length);
  if (!receipts.length) return null;

  return (
    <div className="card form-stack">
      <h3>Receipts</h3>
      <p className="small muted">
        Signed by the node and saved on this device only: the payment request, the transfer you made and the credits it bought. Keep them as
        proof of what each node owes you or has already credited.
      </p>
      <PagerBar pager={pager} total={receipts.length} />
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {receipts.slice(pager.start, pager.end).map((receipt) => (
          <div key={receipt.id} className="card form-stack">
          <div className="row between">
            <strong>
              {receipt.credits.toLocaleString()} credits · {receipt.method}
            </strong>
            <span className="row" style={{ gap: 8 }}>
              <span
                className={`badge ${
                  receipt.status === 'paid' ? 'ok' : receipt.status === 'pending-review' ? 'warn' : receipt.status === 'rejected' ? 'danger' : ''
                }`}
              >
                {receipt.status}
              </span>
              <button
                className="small danger"
                onClick={async () => {
                  await api(`/api/receipts/${receipt.id}`, { method: 'DELETE' }).catch(() => undefined);
                  load();
                }}
              >
                Delete
              </button>
            </span>
          </div>
          <div className="small muted">
            {receipt.nodeName ? `${receipt.nodeName} · ` : ''}
            {receipt.type} · requested {timeAgo(receipt.request.createdAt)}
            {receipt.settledAt ? ` · settled ${timeAgo(receipt.settledAt)}` : ''} ·{' '}
            {receipt.verified ? 'signature verified' : 'signature not verified'}
          </div>
          {receipt.request.address && (
            <div>
              <div className="hint">{receipt.type === 'lightning' ? 'Lightning invoice' : 'Paid to'}</div>
              <CodeBox text={receipt.request.address} />
            </div>
          )}
          {receipt.request.amount && (
            <div>
              <div className="hint">Amount</div>
              <CodeBox text={`${receipt.request.amount}${receipt.request.currency ? ' ' + receipt.request.currency : ''}`} />
            </div>
          )}
          {receipt.tx && (
            <div>
              <div className="hint">Your proof of the transfer</div>
              <CodeBox text={receipt.tx} />
            </div>
          )}
          </div>
        ))}
        {pager.mode === 'lazy' && pager.end < receipts.length && <div ref={pager.sentinel} />}
      </div>
      <PagerNav pager={pager} />
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
    </div>
  );
}

export function WalletPage() {
  const { state, providers, algorithms } = useApp();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'provider' | 'algorithm'>('provider');
  if (!state) return null;
  const nodes = tab === 'provider' ? providers : algorithms;
  const selected = nodes.find((n) => n.id === params.get('node')) ?? nodes[0];
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Credits</h1>
          <p>Every node runs its own credits. Balances here are separate and only spendable on the node that issued them.</p>
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${tab === 'provider' ? 'on' : ''}`} onClick={() => setTab('provider')}>
          Content provider nodes
        </button>
        <button className={`tab ${tab === 'algorithm' ? 'on' : ''}`} onClick={() => setTab('algorithm')}>
          Algorithm search nodes
        </button>
      </div>
      {!nodes.length ? (
        <Empty icon={<Coins size={40} />} title={tab === 'provider' ? 'No content provider nodes' : 'No algorithm search nodes'}>
          <p>
            Add one on the <Link to="/nodes" className="link">Nodes page</Link>.
          </p>
        </Empty>
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
      <div style={{ height: 16 }} />
      {selected && <Receipts key={`receipts-${selected.id}`} node={selected} />}
    </div>
  );
}
