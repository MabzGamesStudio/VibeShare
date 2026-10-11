import {
  Coins,
  Compass,
  History,
  Home as HomeIcon,
  Menu,
  Network,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { StatusDot } from './components/ui';
import { CreatorPage } from './pages/Creator';
import { EarnPage } from './pages/Earn';
import { HomePage } from './pages/Home';
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

export function App() {
  const { state, error, providers, algorithms } = useApp();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  const onlineProviders = providers.filter((n) => n.enabled && n.status.online).length;
  const onlineAlgorithms = algorithms.filter((n) => n.enabled && n.status.online).length;
  const healthy = onlineProviders > 0 && onlineAlgorithms > 0;

  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">
            <Sparkles size={18} />
          </div>
          VibeShare
        </div>
        <NavItem to="/" icon={<HomeIcon size={19} />} label="Home" />
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
      <div className="main">
        <header className="topbar">
          <button className="ghost icon menu-button" onClick={() => setOpen(!open)} aria-label="Menu">
            <Menu size={20} />
          </button>
          <TopSearch />
          <NavLink to="/nodes" className="status-pill" title="Online nodes">
            <StatusDot online={healthy} />
            <span className="label">
              {onlineProviders} provider{onlineProviders === 1 ? '' : 's'} · {onlineAlgorithms} algorithm{onlineAlgorithms === 1 ? '' : 's'}
            </span>
          </NavLink>
        </header>
        {error && !state ? (
          <div className="page">
            <div className="banner danger">
              Cannot reach the VibeShare client daemon: {error}. Open the GUI from the address the client printed when it started.
            </div>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<HomePage />} />
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
            <Route path="*" element={<HomePage />} />
          </Routes>
        )}
      </div>
    </div>
  );
}
