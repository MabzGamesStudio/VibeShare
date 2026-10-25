import { BookMarked, Coins, Columns2, Compass, History, Lock, Menu, Network, Plus, Search as SearchIcon, Server, Settings as SettingsIcon, Sparkles, Upload, Users } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { NodeEntry, SearchHistoryItem } from '../../src/shared/clientapi';
import { newPageId, presetPage } from '../../src/shared/clientdefaults';
import { api } from './api';
import { PageIconView } from './components/feed/icons';
import { PageEditor, pagePath } from './components/feed/PageEditor';
import { PageView } from './components/feed/PageView';
import { ShareProvider } from './components/Share';
import { CookieConsent } from './components/CookieConsent';
import { Empty, StatusDot } from './components/ui';
import { CreatorPage } from './pages/Creator';
import { DualPage } from './pages/Dual';
import { DevDataPage } from './pages/DevData';
import { EarnPage } from './pages/Earn';
import { HistoryPage } from './pages/History';
import { LibraryPage } from './pages/Library';
import { NodesPage } from './pages/Nodes';
import { PublishPage } from './pages/Publish';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { SubscriptionsPage } from './pages/Subscriptions';
import { AllSubscriptionsPage } from './pages/SubscriptionsAll';
import { WalletPage } from './pages/Wallet';
import { WatchPage } from './pages/Watch';
import { useApp } from './state';
import { parseContentId } from '../../src/shared/sources';
import { watchPath } from './util';

function NavItem({ to, icon, label, count }: { to: string; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      {icon}
      {label}
      {count !== undefined && <span className="nav-count">{count}</span>}
    </NavLink>
  );
}

function TopSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state } = useApp();
  const [query, setQuery] = useState('');
  const [past, setPast] = useState<SearchHistoryItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const suggest = Boolean(state?.settings.searchSuggestions);
  useEffect(() => {
    if (location.pathname === '/search') setQuery(new URLSearchParams(location.search).get('q') ?? '');
  }, [location]);
  useEffect(() => {
    if (!suggest) return setPast([]);
    api<{ items: SearchHistoryItem[] }>('/api/search-history')
      .then((answer) => setPast(answer.items))
      .catch(() => setPast([]));
  }, [location.pathname, location.search, suggest]);

  // Matching past searches under the search box, most relevant first (recent ones lead).
  const needle = query.trim().toLowerCase();
  const shown = (needle ? past.filter((item) => item.query.toLowerCase().includes(needle)) : past).slice(0, 8);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const picked = open && active >= 0 ? shown[active]?.query : undefined;
    const text = (picked ?? query).trim();
    setOpen(false);
    // Pasting a content id or link opens it directly.
    if (parseContentId(text)) navigate(watchPath(text));
    else navigate(`/search?q=${encodeURIComponent(text)}`);
  };
  return (
    <div className="searchbox-wrap">
      <form className="searchbox" onSubmit={submit} role="search">
        <SearchIcon size={18} className="faint" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (!open || !shown.length) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((at) => (at + 1) % shown.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((at) => (at <= 0 ? shown.length - 1 : at - 1));
            }
          }}
          placeholder="Search, or paste a content id"
          aria-label="Search"
        />
        <button type="submit" className="ghost small round">
          Search
        </button>
      </form>
      {suggest && open && shown.length > 0 && (
        <div className="search-suggest" role="listbox" aria-label="Past searches">
          {shown.map((item, index) => (
            <button
              key={item.query}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : ''}
              title={item.query}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery(item.query);
                setOpen(false);
                navigate(`/search?q=${encodeURIComponent(item.query)}`);
              }}
            >
              <SearchIcon size={13} className="faint" /> {item.query}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Credits on the nodes of one kind: the balance on the first enabled node (the one used
 * first), with every node's balance in the tooltip. Credits never move between nodes.
 */
/** The last change of a balance, shown for a moment next to it. */
function useBalanceDelta(nodeId: string | undefined, balance: number | undefined): { amount: number; key: number } | null {
  const previous = useRef<{ nodeId?: string; balance?: number }>({ nodeId, balance });
  const [delta, setDelta] = useState<{ amount: number; key: number } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { nodeId, balance };
    if (before.nodeId !== nodeId || before.balance === undefined || balance === undefined || before.balance === balance) return;
    setDelta({ amount: balance - before.balance, key: Date.now() });
    const timer = setTimeout(() => setDelta(null), 1800);
    return () => clearTimeout(timer);
  }, [nodeId, balance]);
  return delta;
}

function CreditChip({ nodes, label, icon }: { nodes: NodeEntry[]; label: string; icon: React.ReactNode }) {
  const enabled = nodes.filter((node) => node.enabled);
  const primary = enabled[0];
  const title = enabled.length
    ? `${label} credits\n${enabled.map((node) => `${node.name}: ${node.balance ?? '–'}${node.status.online === false ? ' (offline)' : ''}`).join('\n')}`
    : `No ${label.toLowerCase()} node: add one on the Nodes page`;
  const delta = useBalanceDelta(primary?.id, primary?.balance);
  return (
    <NavLink to={enabled.length ? '/wallet' : '/nodes'} className="credit-chip" title={title}>
      <StatusDot online={primary ? primary.status.online : undefined} enabled={Boolean(primary)} />
      {icon}
      <span className="credit-label">{label}</span>
      <strong className={delta ? (delta.amount < 0 ? 'spent' : 'earned') : undefined}>{primary?.balance ?? '–'}</strong>
      {delta && (
        <span key={delta.key} className={`credit-delta ${delta.amount < 0 ? 'spent' : 'earned'}`} aria-hidden>
          {delta.amount > 0 ? '+' : '−'}
          {Math.abs(delta.amount)}
        </span>
      )}
      {enabled.length > 1 && <span className="credit-more">+{enabled.length - 1}</span>}
    </NavLink>
  );
}

/** A page of the user's page configuration: "/" is the video home page, "/p/<id>" the others. */
function PageRoute({ id }: { id?: string }) {
  const params = useParams();
  const { state } = useApp();
  if (!state) return null;
  const pageId = id ?? params.id;
  const page = state.settings.pages.find((p) => p.id === pageId);
  if (!page) {
    return (
      <div className="page">
        <Empty icon={<Compass size={42} />} title="This page does not exist">
          <p>
            It may have been deleted. <Link to="/settings#pages" className="link">Manage your pages</Link>
          </p>
        </Empty>
      </div>
    );
  }
  return <PageView key={page.id} page={page} />;
}

export function App() {
  const { state, error, providers, algorithms } = useApp();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  // The local static data host page exists in developer builds only.
  const [devBuild, setDevBuild] = useState(false);
  useEffect(() => {
    api<{ dev: boolean }>('/api/dev/info')
      .then((answer) => setDevBuild(answer.dev))
      .catch(() => setDevBuild(false));
  }, []);

  const pages = state?.settings.pages.filter((page) => page.sidebar) ?? [];

  return (
    <ShareProvider>
      <CookieConsent />
      <div className="app">
        <aside className={`sidebar ${open ? 'open' : ''}`}>
          <div className="brand">
            <div className="brand-logo">
              <Sparkles size={18} />
            </div>
            VibeShare
          </div>
          {pages.map((page) => (
            <NavItem key={page.id} to={pagePath(page)} icon={<PageIconView icon={page.icon} />} label={page.title} />
          ))}
          <button className="nav-link nav-add" onClick={() => setCreating(true)}>
            <Plus size={19} /> New page
          </button>
          <NavItem to="/dual" icon={<Columns2 size={19} />} label="Dual" />
          <div className="nav-divider" />
          <NavItem to="/search" icon={<Compass size={19} />} label="Explore" />
          <NavItem to="/subscriptions" icon={<Users size={19} />} label="Subscriptions" count={state?.subscriptions.length} />
          <NavItem to="/library" icon={<BookMarked size={19} />} label="Library" />
          <NavItem to="/history" icon={<History size={19} />} label="History" />
          <NavItem to="/publish" icon={<Upload size={19} />} label="Publish" />
          {devBuild && <NavItem to="/devdata" icon={<Server size={19} />} label="Dev data" />}
          <div className="nav-section">Network</div>
          <NavItem to="/nodes" icon={<Network size={19} />} label="Nodes" count={state?.nodes.length} />
          <NavItem to="/wallet" icon={<Coins size={19} />} label="Credits" />
          <NavItem to="/earn" icon={<Sparkles size={19} />} label="Earn" />
          <NavItem to="/settings" icon={<SettingsIcon size={19} />} label="Settings" />
          <div className="sidebar-footer">
            {state ? (
              <>
                <div>{state.version}</div>
                <div className="mono" title={state.identity.id}>
                  {state.identity.id.slice(0, 14)}…
                </div>
              </>
            ) : null}
          </div>
        </aside>
        {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} />}
        <div className="main">
          <header className="topbar">
            <button className="ghost icon menu-button" onClick={() => setOpen(!open)} aria-label="Menu">
              <Menu size={20} />
            </button>
            <TopSearch />
            <div className="credit-chips">
              <CreditChip nodes={providers} label="Provider" icon={<Server size={15} />} />
              <CreditChip nodes={algorithms} label="Search" icon={<SearchIcon size={15} />} />
            </div>
          </header>
          {error && !state ? (
            <div className="page">
              <div className="banner danger">
                Cannot reach the VibeShare client daemon: {error}. Open the GUI from the address the client printed when it started.
              </div>
            </div>
          ) : (
            <>
              {state?.locked && (
                <div className="banner warn" style={{ margin: '12px 16px 0' }}>
                  <Lock size={18} />
                  <div>
                    <strong>A hidden profile is locked.</strong>{' '}
                    <span className="small">
                      Its data is encrypted on this device — unlock it in{' '}
                      <Link className="link" to="/settings#profiles">
                        Settings → Profiles
                      </Link>{' '}
                      with its username and password.
                    </span>
                  </div>
                </div>
              )}
              <Routes>
              <Route path="/" element={<PageRoute id="videos" />} />
              <Route path="/p/:id" element={<PageRoute />} />
              <Route path="/dual" element={<DualPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/subscriptions" element={<SubscriptionsPage />} />
              <Route path="/subscriptions/all" element={<AllSubscriptionsPage />} />
              <Route path="/watch/:id" element={<WatchPage />} />
              <Route path="/creator/:id" element={<CreatorPage />} />
              <Route path="/publish" element={<PublishPage />} />
              <Route path="/devdata" element={<DevDataPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/nodes" element={<NodesPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/earn" element={<EarnPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<PageRoute id="videos" />} />
            </Routes>
            </>
          )}
        </div>
        {creating && (
          <PageEditor
            isNew
            page={{ ...presetPage('videos'), filters: { ...presetPage('videos').filters, formats: [] }, id: newPageId(), preset: undefined, title: 'My page', icon: 'star' }}
            onClose={() => setCreating(false)}
          />
        )}
      </div>
    </ShareProvider>
  );
}
