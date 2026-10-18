import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CreatorView } from '../../../src/shared/clientapi';
import type { AccountLinkProposal, AlgorithmInfo, CreatorAccount, CreatorContentSuggestion, CreatorIconSuggestion, CreatorInfo } from '../../../src/shared/protocol';
import { CREATOR_KIND_LABELS } from '../../../src/shared/taxonomy';
import { SOURCE_LABELS } from '../../../src/shared/sources';
import { api, errorMessage } from '../api';
import { GridLayout } from '../components/feed/Cards';
import { compact } from '../components/feed/Fields';
import { CARD_PAGE } from '../components/Feed';
import { Avatar, CopyButton, Empty, Loading, Modal, Switch } from '../components/ui';
import { useApp } from '../state';
import { creatorPath } from '../util';

/**
 * The creator's related accounts: a horizontal scroll of fixed-width cards to click
 * through. Every card goes to a VibeShare page — the linked creator's page, or Explore
 * for its handle where VibeShare has no creator id yet. The external channel links
 * themselves live next to the page's main row instead.
 */
function RelatedAccounts({ accounts, creatorName }: { accounts: CreatorAccount[]; creatorName: string }) {
  if (!accounts.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="hint" style={{ marginBottom: 6 }}>Related accounts of {creatorName}</div>
      <div className="carousel">
        {accounts.map((account) => {
          const label = SOURCE_LABELS[account.platform as keyof typeof SOURCE_LABELS] ?? account.platform;
          const key = `${account.platform}:${account.handle}`;
          const handle = account.handle.startsWith('@') ? account.handle : `@${account.handle}`;
          const to = account.creator ? creatorPath(account.creator) : `/search?q=${encodeURIComponent(handle)}`;
          return (
            <Link key={key} to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card carousel-card">
                <Avatar name={account.handle} id={key} />
                <div className="carousel-handle" title={account.handle}>
                  {account.handle}
                </div>
                <div className="carousel-line" title={label}>
                  {label}
                </div>
                <div className="carousel-line">{account.subscribers !== undefined ? `${compact(account.subscribers)} subscribers` : 'Subscribers unknown'}</div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Accounts on other platforms: linked by the creator at once, or suggested by anyone. */
function LinkAccounts({ creator, nodeId, onSaved }: { creator: CreatorInfo; nodeId: string; onSaved: () => void }) {
  const { state, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<{ platform: string; handle: string; url?: string; creator?: string; subscribers?: number }[]>(() =>
    (creator.accounts ?? []).map((a) => ({ ...a }))
  );
  const [proposals, setProposals] = useState<AccountLinkProposal[]>([]);
  const [symmetric, setSymmetric] = useState(true);
  const node = state?.nodes.find((n) => n.id === nodeId);
  const max = ((node?.info as AlgorithmInfo | undefined)?.maxCreatorAccounts ?? 8);
  // Holding the creator's key signs the request (linked at once); anyone else may suggest.
  const identity = state?.identity.id;
  const isCreator = Boolean(identity && (creator.id === identity || creator.keys?.includes(identity)));
  useEffect(() => {
    setRows((creator.accounts ?? []).map((a) => ({ ...a })));
  }, [creator.id, creator.accounts?.length]);
  const load = useCallback(() => {
    api<{ proposals: AccountLinkProposal[] }>(`/api/account-links/${encodeURIComponent(nodeId)}`)
      .then((result) => setProposals(result.proposals.filter((p) => p.creatorId === creator.id)))
      .catch(() => setProposals([]));
  }, [nodeId, creator.id]);
  useEffect(load, [load]);

  const update = (index: number, patch: Partial<{ platform: string; handle: string; url?: string; creator?: string; subscribers?: number }>) =>
    setRows((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const save = async () => {
    setBusy(true);
    try {
      const accounts = rows.filter((row) => row.platform.trim() && row.handle.trim());
      const result = await api<{ linked: boolean }>('/api/creators/accounts', {
        method: 'PUT',
        body: { nodeId, creator: creator.id, accounts, sign: isCreator, symmetric },
      });
      toast(result.linked ? 'Accounts linked' : 'Sent to the node’s operator, who decides whether to link them', 'success');
      setOpen(false);
      onSaved();
      load();
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
          {open ? 'Close' : isCreator ? 'Link accounts' : 'Suggest accounts'}
        </button>
      </div>
      <span className="hint">
        {creator.name} can link up to {max} accounts here (YouTube, TikTok, Twitter…).{' '}
        {isCreator
          ? 'You hold this creator’s key: your signature links them at once.'
          : 'No creator key is needed to suggest external links: the node’s operator decides whether the accounts are linked. Every account must carry its link.'}
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
              <input
                type="url"
                placeholder={isCreator ? 'Link (optional)' : 'Link to the creator (required)'}
                value={row.url ?? ''}
                onChange={(e) => update(index, { url: e.target.value })}
              />
              <input
                type="text"
                placeholder="VibeShare creator id (optional)"
                value={row.creator ?? ''}
                onChange={(e) => update(index, { creator: e.target.value })}
              />
              <input
                type="number"
                placeholder="Subscribers"
                style={{ maxWidth: 110 }}
                value={row.subscribers ?? ''}
                onChange={(e) => update(index, { subscribers: e.target.value ? Number(e.target.value) : undefined })}
              />
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
              {busy ? 'Saving…' : isCreator ? 'Save accounts' : 'Suggest accounts'}
            </button>
          </div>
          <Switch
            checked={symmetric}
            onChange={setSymmetric}
            label="Two-way link: the linked creator's page shows this one back (off = one way)"
          />
        </div>
      )}
      {proposals.length > 0 && (
        <div className="page-list">
          {proposals.map((p) => (
            <div key={p.id} className="page-row">
              <div style={{ flex: 1, minWidth: 0 }}>{p.accounts.map((a) => a.url || `${a.platform}:${a.handle}`).join(' · ')}</div>
              <span className={`badge ${p.status === 'accepted' ? 'ok' : ''}`}>
                {p.status === 'accepted' ? 'linked' : 'waiting for the operator'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Content the user suggests for this creator: a modal for the link, title and numbers. */
function SuggestContent({ creator, nodeId }: { creator: CreatorInfo; nodeId: string }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState('');
  const [message, setMessage] = useState('');
  const [metrics, setMetrics] = useState<{ name: string; value: string }[]>([]);
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
      const numbers: Record<string, number> = {};
      for (const row of metrics) {
        const value = Number(row.value);
        if (row.name.trim() && Number.isFinite(value) && value >= 0) numbers[row.name.trim()] = value;
      }
      const result = await api<{ newInfo: boolean }>('/api/creator-suggestions', {
        body: {
          nodeId,
          creator: creator.id,
          id: id.trim(),
          title: title.trim() || undefined,
          platform: platform.trim() || undefined,
          message: message.trim() || undefined,
          metrics: Object.keys(numbers).length ? numbers : undefined,
        },
      });
      toast(result.newInfo ? 'Suggested — the node reviews it' : 'This is already suggested', 'success');
      setId('');
      setTitle('');
      setPlatform('');
      setMessage('');
      setMetrics([]);
      setOpen(false);
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <div className="row between">
        <h3>Suggest content for {creator.name}</h3>
        <button className="small" onClick={() => setOpen(true)}>
          + Suggest content
        </button>
      </div>
      <span className="hint">
        Know content that belongs to {creator.name}? Open the form to send its link with the title, platform and platform numbers you know.
        When the node accepts, it joins the creator and you earn credits.
      </span>
      {open && (
        <Modal
          title={`Suggest content for ${creator.name}`}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button onClick={() => setOpen(false)}>Cancel</button>
              <button className="primary" disabled={busy || !id.trim()} onClick={() => void submit()}>
                {busy ? 'Sending…' : 'Suggest'}
              </button>
            </>
          }
        >
          <div className="form-stack">
            <label className="field">
              Link (content id or URL)
              <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="vs1… or yt:…" autoFocus />
            </label>
            <div className="form-grid">
              <label className="field">
                Title
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">
                Platform
                <input type="text" value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="youtube, tiktok…" />
              </label>
            </div>
            <div className="field">
              <span>
                Platform metrics <span className="hint">What the page shows: views, likes, comments…</span>
              </span>
              {metrics.map((row, index) => (
                <div key={index} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <input
                    type="text"
                    placeholder="views"
                    value={row.name}
                    onChange={(e) => setMetrics(metrics.map((m, i) => (i === index ? { ...m, name: e.target.value } : m)))}
                  />
                  <input
                    type="number"
                    placeholder="0"
                    value={row.value}
                    onChange={(e) => setMetrics(metrics.map((m, i) => (i === index ? { ...m, value: e.target.value } : m)))}
                  />
                  <button className="small danger" onClick={() => setMetrics(metrics.filter((_, i) => i !== index))} aria-label="Remove">
                    ×
                  </button>
                </div>
              ))}
              <button className="small" onClick={() => setMetrics([...metrics, { name: '', value: '' }])}>
                + Add metric
              </button>
            </div>
            <label className="field">
              Message for the operator (optional)
              <input type="text" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Why this belongs to the creator" />
            </label>
          </div>
        </Modal>
      )}
      {mine.length > 0 && (
        <div className="page-list">
          {mine.map((s) => (
            <div key={s.id} className="page-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <code>{s.contentRef}</code>
                {s.title && <span> · {s.title}</span>}
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

/** An icon the user suggests for this creator (a small image, judged by the operator). */
function SuggestIcon({ creator, nodeId }: { creator: CreatorInfo; nodeId: string }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [icon, setIcon] = useState('');
  const [mine, setMine] = useState<CreatorIconSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ suggestions: CreatorIconSuggestion[] }>(`/api/creator-icons/${encodeURIComponent(nodeId)}`)
      .then((result) => setMine(result.suggestions.filter((s) => s.creatorId === creator.id)))
      .catch(() => setMine([]));
  }, [nodeId, creator.id]);
  useEffect(load, [load]);

  const pick = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  };
  const submit = async () => {
    if (!icon) return;
    setBusy(true);
    try {
      const result = await api<{ newInfo: boolean }>('/api/creator-icons', { body: { nodeId, creator: creator.id, icon } });
      toast(result.newInfo ? 'Icon suggested — the node reviews it' : 'An icon is already waiting for review', 'success');
      setIcon('');
      setOpen(false);
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <div className="row between">
        <h3>Creator icon</h3>
        <button className="small" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Suggest an icon'}
        </button>
      </div>
      <span className="hint">
        Suggest a picture for {creator.name} (png, jpeg, webp or gif, up to 200 kB). When the node's operator accepts it, it becomes the
        creator's icon and you earn credits.
      </span>
      {open && (
        <div className="form-stack">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => pick(e.target.files?.[0])} />
          {icon && <img src={icon} alt="Suggested icon" style={{ width: 96, height: 96, borderRadius: 12, objectFit: 'cover' }} />}
          <div>
            <button className="primary small" disabled={busy || !icon} onClick={() => void submit()}>
              {busy ? 'Sending…' : 'Suggest icon'}
            </button>
          </div>
        </div>
      )}
      {mine.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {mine.map((s) => (
            <span key={s.id} className={`badge ${s.status === 'accepted' ? 'ok' : ''}`}>
              <img src={s.icon} alt="" style={{ width: 18, height: 18, borderRadius: 4, verticalAlign: '-4px' }} />{' '}
              {s.status === 'accepted' ? 'accepted' : 'waiting for review'}
            </span>
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

  // Where the creator's channel lives off VibeShare. These external links sit next to
  // the page's main row; the related-accounts carousel below links inside VibeShare.
  const channelLinks: { url: string; label: string }[] = [];
  const seenUrls = new Set<string>();
  for (const account of creator.accounts ?? []) {
    if (account.url && !seenUrls.has(account.url)) {
      seenUrls.add(account.url);
      channelLinks.push({ url: account.url, label: SOURCE_LABELS[account.platform as keyof typeof SOURCE_LABELS] ?? account.platform });
    }
  }
  for (const url of creator.links ?? []) {
    if (/^https?:\/\//.test(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      let label = 'Channel';
      try {
        label = new URL(url).host.replace(/^www\./, '');
      } catch {
        // not a parseable URL: the plain label stands
      }
      channelLinks.push({ url, label });
    }
  }

  return (
    <div className="page">
      <div className="row" style={{ gap: 20, marginBottom: 12, alignItems: 'flex-start' }}>
        <Avatar name={creator.name} id={creator.id} large icon={creator.icon} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* In line with the icon: just the text link of the creator. */}
          <h1>
            <Link to={creatorPath(creator.id)} className="link">
              {creator.name}
            </Link>
          </h1>
          <div className="row small muted" style={{ marginTop: 6 }}>
            <span className="badge">{CREATOR_KIND_LABELS[creator.kind]}</span>
            {creator.keys?.length ? <span className="badge ok">Verified key</span> : <span className="badge">Name only</span>}
            <span>{view.items.length} item{view.items.length === 1 ? '' : 's'}</span>
          </div>
          {creator.description && <p className="muted" style={{ marginTop: 10 }}>{creator.description}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className={subscribed ? '' : 'primary'} onClick={toggle}>
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </button>
            <CopyButton text={creator.id} label="Copy creator id" small={false} />
          </div>
        </div>
        {channelLinks.length > 0 && (
          <div
            className="row"
            style={{ gap: 10, flexWrap: 'wrap', flexShrink: 0, justifyContent: 'flex-end', maxWidth: 240 }}
            aria-label="External channel links"
          >
            {channelLinks.map((link) => (
              <a key={link.url} className="link row small" href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                <ExternalLink size={13} /> {link.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <RelatedAccounts accounts={creator.accounts ?? []} creatorName={creator.name} />
      {view.via && (
        <>
          <LinkAccounts creator={creator} nodeId={view.via} onSaved={load} />
          <SuggestIcon creator={creator} nodeId={view.via} />
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
