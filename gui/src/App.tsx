import { Coins, Compass, History, Menu, Network, Plus, Search as SearchIcon, Server, Settings as SettingsIcon, Sparkles, Upload, Users } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { NodeEntry } from '../../src/shared/clientapi';
import { newPageId, presetPage } from '../../src/shared/clientdefaults';
import { PageIconView } from './components/feed/icons';
import { PageEditor, pagePath } from './components/feed/PageEditor';
import { PageView } from './components/feed/PageView';
import { ShareProvider } from './components/Share';
import { Empty, StatusDot } from './components/ui';
import { CreatorPage } from './pages/Creator';
import { EarnPage } from './pages/Earn';
import { LibraryPage } from './pages/Library';
import { NodesPage } from './pages/Nodes';
import { PublishPage } from './pages/Publish';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { SubscriptionsPage } from './pages/Subscriptions';
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
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (location.pathname === '/search') setQuery(new URLSearchParams(location.search).get('q') ?? '');
  }, [location]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    // Pasting a content id or link opens it directly.
    if (parseContentId(text)) navigate(watchPath(text));
    else navigate(`/search?q=${encodeURIComponent(text)}`);
  };
  return (
    <form className="searchbox" onSubmit={submit} role="search">
      <SearchIcon size={18} className="faint" />
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, or paste a content id" aria-label="Search" />
      <button type="submit" className="ghost small round">
        Search
      </button>
    </form>
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

/** A page of the user's page configuration: "/" is the home page, "/p/<id>" the others. */
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

  const pages = state?.settings.pages.filter((page) => page.sidebar) ?? [];

  return (
    <ShareProvider>
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
          <div className="nav-divider" />
          <NavItem to="/search" icon={<Compass size={19} />} label="Explore" />
          <NavItem to="/subscriptions" icon={<Users size={19} />} label="Subscriptions" count={state?.subscriptions.length} />
          <NavItem to="/library" icon={<History size={19} />} label="Library" />
          <NavItem to="/publish" icon={<Upload size={19} />} label="Publish" />
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
            <Routes>
              <Route path="/" element={<PageRoute id="home" />} />
              <Route path="/p/:id" element={<PageRoute />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/subscriptions" element={<SubscriptionsPage />} />
              <Route path="/watch/:id" element={<WatchPage />} />
              <Route path="/creator/:id" element={<CreatorPage />} />
              <Route path="/publish" element={<PublishPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/nodes" element={<NodesPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/earn" element={<EarnPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<PageRoute id="home" />} />
            </Routes>
          )}
        </div>
        {creating && (
          <PageEditor
            isNew
            page={{ ...presetPage('home'), id: newPageId(), preset: undefined, title: 'My page', icon: 'star' }}
            onClose={() => setCreating(false)}
          />
        )}
      </div>
    </ShareProvider>
  );
}
