import { Download, Link2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useApp } from '../state';

interface ContentUrlItem {
  id: string;
  cid?: string;
  url?: string;
  baseUrl?: string;
  status: string;
  downloads: number;
  earned: number;
}

/**
 * Offer a content provider downloadable copies of content: a URL with its cid, or a base
 * URL it can query any cid at. The provider pays credits each time it downloads from a
 * link and the bytes hash to the cid exactly.
 */
export function OfferLinksCard() {
  const { providers, toast } = useApp();
  const [nodeId, setNodeId] = useState('');
  const [urls, setUrls] = useState('');
  const [bases, setBases] = useState('');
  const [items, setItems] = useState<ContentUrlItem[]>([]);
  const [busy, setBusy] = useState(false);
  const target = providers.find((p) => p.id === nodeId) ?? providers[0];

  const load = useCallback(() => {
    if (!target) {
      setItems([]);
      return;
    }
    api<{ items: ContentUrlItem[] }>(`/api/nodes/${target.id}/content-urls`)
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]));
  }, [target]);
  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!target) return;
    const list: { cid?: string; url?: string; baseUrl?: string }[] = [];
    for (const line of urls.split('\n')) {
      const [cid, url] = line.trim().split(/\s+/);
      if (cid && url) list.push({ cid, url });
    }
    for (const line of bases.split('\n')) {
      const base = line.trim();
      if (base) list.push({ baseUrl: base });
    }
    if (!list.length) {
      toast('Add at least one content URL or base URL', 'error');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/nodes/${target.id}/content-urls`, { method: 'POST', body: { items: list } });
      setUrls('');
      setBases('');
      toast(`Offered ${list.length} link${list.length === 1 ? '' : 's'}`, 'success');
      load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    setBusy(false);
  };

  if (!providers.length) return null;

  return (
    <div className="card form-stack">
      <div className="row">
        <Link2 size={22} />
        <div>
          <h2>Offer download links</h2>
          <p className="small muted">
            Point a content provider at downloadable copies of content. It pays credits each time it downloads from your link and the bytes
            hash to the cid exactly. Give a URL with its cid, or a base URL it can query any cid at.
          </p>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          Content provider
          <select value={target?.id ?? ''} onChange={(e) => setNodeId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Content URLs <span className="hint">One per line (single or multiple): cid url — e.g. vs1… https://you.example/file.bin</span>
        <textarea rows={3} className="mono" value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="vs1… https://you.example/file.bin" />
      </label>
      <label className="field">
        Base URLs <span className="hint">One per line (single or multiple) — the provider queries &lt;base&gt;/&lt;cid&gt; for any cid</span>
        <textarea rows={2} className="mono" value={bases} onChange={(e) => setBases(e.target.value)} placeholder="https://you.example/base" />
      </label>
      <div className="row">
        <button className="primary" disabled={busy || !target} onClick={submit}>
          <Download size={16} /> Offer links
        </button>
        <span className="hint">Each accepted link can earn per download.</span>
      </div>
      {items.length > 0 && (
        <table className="table">
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="small mono">{item.baseUrl ? item.baseUrl : `${(item.cid ?? '').slice(0, 16)}… · ${item.url ?? ''}`}</td>
                <td>
                  <span className={`badge ${item.status === 'accepted' ? 'ok' : item.status === 'rejected' ? 'danger' : ''}`}>{item.status}</span>
                </td>
                <td className="small muted">
                  {item.downloads} download{item.downloads === 1 ? '' : 's'} · {item.earned} earned
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}