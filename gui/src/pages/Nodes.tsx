import { ArrowDown, ArrowUp, Coins, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuthMode, NodeEntry } from '../../../src/shared/clientapi';
import { parseNodeRef } from '../../../src/shared/noderef';
import type { AlgorithmInfo, ProviderInfo } from '../../../src/shared/protocol';
import { api, errorMessage } from '../api';
import { AddNodes } from '../components/AddNodes';
import { CopyButton, Modal, StatusDot, Switch } from '../components/ui';
import { useApp } from '../state';
import { formatBytes, shortId } from '../util';

export const AUTH_LABELS: Record<AuthMode, { label: string; help: string }> = {
  pseudonym: {
    label: 'Private key for this node',
    help: 'A key made for this node only from your backup. Credits survive reinstalls; nodes cannot link you across nodes.',
  },
  identity: {
    label: 'My public identity',
    help: 'Your main public key. Credits follow you; every node using it sees the same identity.',
  },
  anonymous: {
    label: 'Anonymous token',
    help: 'A random token from the node. Nothing ties it to you — lose this device and the credits are gone.',
  },
};

function NodeFacts({ node }: { node: NodeEntry }) {
  const info = node.info;
  if (!info) return null;
  if (info.type === 'provider') {
    const p = (info as ProviderInfo).pricing;
    const services = (info as ProviderInfo).services;
    return (
      <div className="node-stats">
        <span>
          <strong>{p.perMiB}</strong> credit{p.perMiB === 1 ? '' : 's'}/MiB
        </span>
        <span>
          <strong>{p.freeMiBPerDay}</strong> MiB free/day
        </span>
        <span>{p.upload.mode === 'closed' ? 'No uploads' : p.upload.mode === 'paid' ? `Uploads ${p.upload.perMiB}/MiB` : 'Free uploads'}</span>
        <span>
          <strong>{(info as ProviderInfo).stats.contents}</strong> items · {formatBytes((info as ProviderInfo).stats.bytes)}
        </span>
        {services.storage.enabled && <span className="badge accent">Storage jobs: {services.storage.openJobs}</span>}
        <span>Signup {info.signup.grant} credits</span>
      </div>
    );
  }
  const a = info as AlgorithmInfo;
  const price = (n: number) => (n ? `${n} credits` : 'free');
  return (
    <div className="node-stats">
      <span>Feed {price(a.pricing.feed)}</span>
      <span>Search {price(a.pricing.search)}</span>
      <span title={a.ranking.description}>Ranking: {a.ranking.strategy}</span>
      <span>
        <strong>{a.stats.listed}</strong> listed · {a.stats.blocked} blocked
      </span>
      {a.rewards.vote > 0 && <span className="badge accent">+{a.rewards.vote} per vote</span>}
      {a.rewards.acceptedSuggestion > 0 && <span className="badge accent">+{a.rewards.acceptedSuggestion} per accepted tag</span>}
    </div>
  );
}

function NodeCard({
  node,
  rank,
  count,
  onMove,
  dragProps,
  dragging,
}: {
  node: NodeEntry;
  rank: number;
  count: number;
  onMove: (delta: number) => void;
  dragProps: React.HTMLAttributes<HTMLDivElement>;
  dragging: boolean;
}) {
  const { refresh, toast, state } = useApp();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [maxPrice, setMaxPrice] = useState(node.maxPrice === undefined ? '' : String(node.maxPrice));

  const patch = async (body: Partial<NodeEntry> | Record<string, unknown>) => {
    try {
      await api(`/api/nodes/${node.id}`, { method: 'PATCH', body });
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      await api(`/api/nodes/${node.id}/refresh`, { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api(`/api/nodes/${node.id}?release=1`, { method: 'DELETE' });
      toast(`Removed ${node.name}`);
      setConfirm(false);
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const known = new Set(state?.nodes.map((n) => n.id));
  const peers = (node.info?.peers ?? []).filter((ref) => {
    const parsed = parseNodeRef(ref);
    return parsed && !(parsed.id && known.has(parsed.id));
  });

  return (
    <div className={`node-card ${node.enabled ? '' : 'disabled'} ${dragging ? 'dragging' : ''}`} {...dragProps}>
      <div className="node-rank">
        <button className="ghost icon small" disabled={rank === 0} onClick={() => onMove(-1)} aria-label="Higher priority">
          <ArrowUp size={14} />
        </button>
        <div className="rank" title="Drag to reorder">
          {rank + 1}
        </div>
        <button className="ghost icon small" disabled={rank === count - 1} onClick={() => onMove(1)} aria-label="Lower priority">
          <ArrowDown size={14} />
        </button>
      </div>
      <div className="node-body">
        <div className="row">
          <StatusDot online={node.status.online} enabled={node.enabled} />
          <h3>{node.name}</h3>
          {node.status.latencyMs !== undefined && node.status.online && <span className="tiny faint">{node.status.latencyMs} ms</span>}
          {!node.status.online && node.status.error && <span className="badge danger">{node.status.error}</span>}
        </div>
        <div className="node-url">{node.url}</div>
        {node.description && <p className="small muted" style={{ marginTop: 6 }}>{node.description}</p>}
        <NodeFacts node={node} />
        <div className="node-controls">
          <label className="field">
            Account
            <select
              value={node.auth}
              onChange={(e) => {
                if (confirmAuthChange()) void patch({ auth: e.target.value as AuthMode });
              }}
              title={AUTH_LABELS[node.auth].help}
            >
              {(Object.keys(AUTH_LABELS) as AuthMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {AUTH_LABELS[mode].label}
                </option>
              ))}
            </select>
            <span className="hint">{AUTH_LABELS[node.auth].help}</span>
          </label>
          <label className="field">
            {node.type === 'provider' ? 'Max credits per MiB' : 'Max credits per request'}
            <input
              type="number"
              min={0}
              value={maxPrice}
              placeholder="No limit"
              onChange={(e) => setMaxPrice(e.target.value)}
              onBlur={() => void patch({ maxPrice: maxPrice === '' ? null : Number(maxPrice) })}
            />
            <span className="hint">Above this price the node is skipped and the next one is used.</span>
          </label>
        </div>
        {peers.length > 0 && <PeerSuggestions refs={peers} />}
      </div>
      <div className="node-side">
        <Switch checked={node.enabled} onChange={(enabled) => void patch({ enabled })} label={node.enabled ? 'On' : 'Off'} />
        <div className="balance">
          {node.balance ?? '–'} <small>credits</small>
        </div>
        {node.accountId && <div className="tiny faint mono" title={node.accountId}>{shortId(node.accountId, 12)}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Link className="button small" to={`/wallet?node=${node.id}`}>
            <Coins size={14} /> Top up
          </Link>
          <CopyButton text={node.ref} label="Reference" />
          <button className="small icon" onClick={reload} disabled={busy} aria-label="Refresh">
            <RefreshCw size={14} />
          </button>
          <button className="small icon danger" onClick={() => setConfirm(true)} aria-label="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {confirm && (
        <Modal
          title={`Remove ${node.name}?`}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <button onClick={() => setConfirm(false)}>Cancel</button>
              <button className="primary" onClick={remove}>
                Remove
              </button>
            </>
          }
        >
          <p className="muted">
            Your account and its {node.balance ?? 0} credits stay on the node; add the same reference again later to use them. Data you store
            for it as a service is released.
          </p>
        </Modal>
      )}
    </div>
  );
}

function confirmAuthChange(): boolean {
  return window.confirm(
    'Switching the account mode uses a different account on this node. Credits stay with the old account, which you get back by switching back. Continue?'
  );
}

function PeerSuggestions({ refs }: { refs: string[] }) {
  const { refresh, toast } = useApp();
  const add = async (ref: string) => {
    try {
      const result = await api<{ added: NodeEntry[]; errors: { error: string }[] }>('/api/nodes', { body: { text: ref } });
      if (result.errors.length) toast(result.errors[0].error, 'error');
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="hint">Recommended by this node:</div>
      {refs.slice(0, 5).map((ref) => (
        <div key={ref} className="row" style={{ marginTop: 6 }}>
          <code className="tiny">{ref.length > 60 ? ref.slice(0, 60) + '…' : ref}</code>
          <button className="small" onClick={() => add(ref)}>
            <Plus size={13} /> Add
          </button>
        </div>
      ))}
    </div>
  );
}

function NodeSection({ type, title, help }: { type: 'provider' | 'algorithm'; title: string; help: string }) {
  const { state, refresh, toast, updateSettings } = useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  if (!state) return null;
  const nodes = state.nodes.filter((n) => n.type === type);
  const ids = order ?? nodes.map((n) => n.id);
  const sorted = ids.map((id) => nodes.find((n) => n.id === id)).filter((n): n is NodeEntry => Boolean(n));

  const save = async (next: string[]) => {
    try {
      await api('/api/nodes/order', { body: { type, ids: next } });
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setOrder(null);
    }
  };

  const move = (id: string, delta: number) => {
    const next = [...ids];
    const index = next.indexOf(id);
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void save(next);
  };

  return (
    <div className="section">
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <h2>{title}</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            {help}
          </p>
        </div>
        {type === 'algorithm' && (
          <label className="field" style={{ minWidth: 220 }}>
            Home feed
            <select value={state.settings.feedMode} onChange={(e) => void updateSettings({ feedMode: e.target.value as 'blend' | 'primary' })}>
              <option value="blend">Blend all enabled nodes</option>
              <option value="primary">Only the first that answers</option>
            </select>
          </label>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="card muted small">No {type} nodes yet — paste a reference above.</div>
      ) : (
        <div className="node-list">
          {sorted.map((node, rank) => (
            <NodeCard
              key={node.id}
              node={node}
              rank={rank}
              count={sorted.length}
              onMove={(delta) => move(node.id, delta)}
              dragging={dragId === node.id}
              dragProps={{
                draggable: true,
                onDragStart: (e) => {
                  if ((e.target as HTMLElement).closest('input, select, textarea, button')) return;
                  setDragId(node.id);
                  e.dataTransfer.effectAllowed = 'move';
                },
                onDragOver: (e) => {
                  e.preventDefault();
                  if (!dragId || dragId === node.id) return;
                  const next = ids.filter((id) => id !== dragId);
                  next.splice(next.indexOf(node.id) + (ids.indexOf(dragId) < ids.indexOf(node.id) ? 1 : 0), 0, dragId);
                  setOrder(next);
                },
                onDragEnd: () => {
                  setDragId(null);
                  if (order) void save(order);
                },
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function NodesPage() {
  const { refresh } = useApp();
  const [exporting, setExporting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Nodes</h1>
          <p>
            You decide which nodes to use and in which order. Higher nodes are asked first; when one is offline, slow, too expensive or out of
            credits, the next one is used.
          </p>
        </div>
        <div className="row">
          <button
            onClick={async () => {
              setRefreshing(true);
              await api('/api/nodes/refresh', { method: 'POST' }).catch(() => undefined);
              await refresh();
              setRefreshing(false);
            }}
            disabled={refreshing}
          >
            <RefreshCw size={15} /> Check all
          </button>
          <button onClick={async () => setExporting((await api<{ text: string }>('/api/nodes/export')).text)}>
            <Share2 size={15} /> Share my list
          </button>
        </div>
      </div>
      <div className="card">
        <h3>Add nodes</h3>
        <p className="small" style={{ marginBottom: 12 }}>
          Paste references like <code>vs:provider:vk1…@https://…</code>, or a node's URL.
        </p>
        <AddNodes compact />
      </div>
      <NodeSection
        type="algorithm"
        title="Search algorithm nodes"
        help="Decide what you see: they rank content, filter it by your preferences and mark it listed, blocked or unknown."
      />
      <NodeSection type="provider" title="Content providers" help="Send you the content (and charge their own credits for it)." />
      {exporting !== null && (
        <Modal title="Your node list" onClose={() => setExporting(null)} actions={<CopyButton text={exporting} label="Copy all" small={false} />}>
          <p className="small muted" style={{ marginBottom: 10 }}>
            Share it with a friend: pasting it into Nodes → Add nodes gives them the same setup.
          </p>
          <textarea className="mono" readOnly value={exporting} rows={8} />
        </Modal>
      )}
    </div>
  );
}
