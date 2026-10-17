import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CreatorView } from '../../../src/shared/clientapi';
import type { AlgorithmInfo, CreatorContentSuggestion, CreatorInfo } from '../../../src/shared/protocol';
import { CREATOR_KIND_LABELS } from '../../../src/shared/taxonomy';
import { SOURCE_LABELS } from '../../../src/shared/sources';
import { api, errorMessage } from '../api';
import { GridLayout } from '../components/feed/Cards';
import { CARD_PAGE } from '../components/Feed';
import { Avatar, CopyButton, Empty, Loading } from '../components/ui';
import { useApp } from '../state';

/** The creator linking their accounts on other platforms (YouTube, TikTok, Twitter…). */
function LinkAccounts({ creator, nodeId, onSaved }: { creator: CreatorInfo; nodeId: string; onSaved: () => void }) {
  const { state, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<{ platform: string; handle: string; url?: string }[]>(() => (creator.accounts ?? []).map((a) => ({ ...a })));
  const node = state?.nodes.find((n) => n.id === nodeId);
  const max = ((node?.info as AlgorithmInfo | undefined)?.maxCreatorAccounts ?? 8);
  useEffect(() => {
    setRows((creator.accounts ?? []).map((a) => ({ ...a })));
  }, [creator.id, creator.accounts?.length]);

  const update = (index: number, patch: Partial<{ platform: string; handle: string; url?: string }>) =>
    setRows((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const save = async () => {
    setBusy(true);
    try {
      const accounts = rows.filter((row) => row.platform.trim() && row.handle.trim());
      await api('/api/creators/accounts', { method: 'PUT', body: { nodeId, creator: creator.id, accounts } });
      toast('Accounts linked', 'success');
      setOpen(false);
      onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <div className="row between">
        <h3>Accounts on other platforms</h3>
        <button className="small" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Link accounts'}
        </button>
      </div>
      <span className="hint">
        {creator.name} can link up to {max} accounts here (YouTube, TikTok, Twitter…). Only the creator can: the request is signed with the
        creator key, and this node decides the limit.
      </span>
      {open && (
        <div className="form-stack">
          {rows.map((row, index) => (
            <div key={index} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input
                type="text"
                placeholder="Platform (yt, tiktok, x…)"
                value={row.platform}
                onChange={(e) => update(index, { platform: e.target.value })}
              />
              <input type="text" placeholder="Handle" value={row.handle} onChange={(e) => update(index, { handle: e.target.value })} />
              <input type="url" placeholder="Link (optional)" value={row.url ?? ''} onChange={(e) => update(index, { url: e.target.value })} />
              <button className="small danger" onClick={() => setRows(rows.filter((_, i) => i !== index))} aria-label="Remove">
                ×
              </button>
            </div>
          ))}
          <div className="row">
            <button className="small" disabled={rows.length >= max} onClick={() => setRows([...rows, { platform: '', handle: '' }])}>
              + Add account
            </button>
            <button className="primary small" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save accounts'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Content the user suggests as related to this creator, with an optional message. */
function SuggestContent({ creator, nodeId }: { creator: CreatorInfo; nodeId: string }) {
  const { toast } = useApp();
  const [id, setId] = useState('');
  const [message, setMessage] = useState('');
  const [mine, setMine] = useState<CreatorContentSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ suggestions: CreatorContentSuggestion[] }>(`/api/creator-suggestions/${encodeURIComponent(nodeId)}`)
      .then((result) => setMine(result.suggestions.filter((s) => s.creatorId === creator.id)))
      .catch(() => setMine([]));
  }, [nodeId, creator.id]);
  useEffect(load, [load]);

  const submit = async () => {
    if (!id.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ newInfo: boolean }>('/api/creator-suggestions', {
        body: { nodeId, creator: creator.id, id: id.trim(), message: message.trim() || undefined },
      });
      toast(result.newInfo ? 'Suggested — the node reviews it' : 'This is already suggested', 'success');
      setId('');
      setMessage('');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <h3>Suggest content for {creator.name}</h3>
      <span className="hint">
        Know content that belongs to {creator.name}? Send its content id or link, with an optional message for the node's operator. When they
        accept, it joins the creator and you earn credits.
      </span>
      <div className="form-grid">
        <label className="field">
          Content id or link
          <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="vs1… or yt:…" />
        </label>
        <label className="field">
          Message (optional)
          <input type="text" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Why this belongs to the creator" />
        </label>
      </div>
      <div>
        <button className="primary small" disabled={busy || !id.trim()} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Suggest'}
        </button>
      </div>
      {mine.length > 0 && (
        <div className="page-list">
          {mine.map((s) => (
            <div key={s.id} className="page-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <code>{s.contentRef}</code>
                {s.message && <div className="tiny faint">{s.message}</div>}
              </div>
              <span className={`badge ${s.status === 'accepted' ? 'ok' : ''}`}>{s.status === 'accepted' ? 'accepted' : 'waiting for review'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CreatorPage() {
  const { id = '' } = useParams();
  const { state, refresh, toast } = useApp();
  const [view, setView] = useState<CreatorView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<CreatorView>(`/api/creators/${encodeURIComponent(id)}`)
      .then(setView)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(() => {
    setView(null);
    setError(null);
    load();
  }, [load]);

  if (error) return <div className="page"><div className="banner danger">{error}</div></div>;
  if (!view || !state) return <div className="page"><Loading /></div>;
  const { creator } = view;
  const subscribed = state.subscriptions.some((s) => s.id === creator.id);

  const toggle = async () => {
    try {
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(creator.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: creator.id, name: creator.name, kind: creator.kind } });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ gap: 20, marginBottom: 30 }}>
        <Avatar name={creator.name} id={creator.id} large />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{creator.name}</h1>
          <div className="row small muted" style={{ marginTop: 6 }}>
            <span className="badge">{CREATOR_KIND_LABELS[creator.kind]}</span>
            {creator.keys?.length ? <span className="badge ok">Verified key</span> : <span className="badge">Name only</span>}
            <span>{view.items.length} item{view.items.length === 1 ? '' : 's'}</span>
          </div>
          {creator.description && <p className="muted" style={{ marginTop: 10 }}>{creator.description}</p>}
          {creator.accounts && creator.accounts.length > 0 && (
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
              {creator.accounts.map((account) => {
                const label = SOURCE_LABELS[account.platform as keyof typeof SOURCE_LABELS] ?? account.platform;
                const href = account.url ?? (/^https?:/.test(account.handle) ? account.handle : undefined);
                const chip = (
                  <span className="badge">
                    {label}
                    {!/^https?:/.test(account.handle) && <> · @{account.handle}</>}
                  </span>
                );
                return href ? (
                  <a key={`${account.platform}:${account.handle}`} className="link" href={href} target="_blank" rel="noreferrer">
                    {chip}
                  </a>
                ) : (
                  <span key={`${account.platform}:${account.handle}`}>{chip}</span>
                );
              })}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className={subscribed ? '' : 'primary'} onClick={toggle}>
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </button>
            <CopyButton text={creator.id} label="Copy creator id" small={false} />
          </div>
        </div>
      </div>
      {view.via && (
        <>
          <LinkAccounts creator={creator} nodeId={view.via} onSaved={load} />
          <SuggestContent creator={creator} nodeId={view.via} />
        </>
      )}
      {view.items.length ? (
        <GridLayout items={view.items} page={CARD_PAGE} />
      ) : (
        <Empty title="No content listed">
          <p>None of your algorithm nodes lists content by this creator.</p>
        </Empty>
      )}
    </div>
  );
}
