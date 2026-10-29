import { ArrowDown, ArrowUp, Copy, Eye, KeyRound, Lock, Pencil, Plus, RotateCcw, Share2, Shield, ShieldAlert, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PAGE_LAYOUT_LABELS, type AuthMode, type PageConfig, type ProfileSummary, type Settings, type TorSettings } from '../../../src/shared/clientapi';
import { DEFAULT_SHARE_BASE_URL, newPageId, presetPage, shareLink } from '../../../src/shared/clientdefaults';
import { LANGUAGES } from '../../../src/shared/language';
import {
  CREATOR_KIND_LABELS,
  CREATOR_KINDS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATINGS,
  TOPICS,
  type CreatorKind,
  type Rating,
} from '../../../src/shared/taxonomy';
import { api, errorMessage, IS_STATIC } from '../api';
import { PageIconView } from '../components/feed/icons';
import { PageEditor } from '../components/feed/PageEditor';
import { SeenFiltersSection } from '../components/SeenFilters';
import { Chips, CodeBox, Modal, Switch, toggle } from '../components/ui';
import { useApp } from '../state';
import { chooseConsent, loadConsent } from '../consent';
import { clearLogs, logLines, setDebugLogs, subscribeLogs } from '../log';
import { HistorySection } from './History';
import { splitList } from '../util';
import { AUTH_LABELS } from './Nodes';

const SOURCE_SHORT: Record<PageConfig['source'], string> = {
  feed: 'recommendations',
  search: 'search',
  subscriptions: 'subscriptions',
};

function PagesCard() {
  const { state, updateSettings } = useApp();
  const [editing, setEditing] = useState<{ page: PageConfig; isNew: boolean } | null>(null);
  if (!state) return null;
  const pages = state.settings.pages;
  const save = (next: PageConfig[]) => void updateSettings({ pages: next });
  const move = (index: number, delta: number) => {
    const next = [...pages];
    const [page] = next.splice(index, 1);
    next.splice(index + delta, 0, page);
    save(next);
  };
  const update = (id: string, patch: Partial<PageConfig>) => save(pages.map((page) => (page.id === id ? { ...page, ...patch } : page)));
  const duplicate = (index: number) => {
    const copy: PageConfig = { ...structuredClone(pages[index]), id: newPageId(), preset: undefined, title: `${pages[index].title} (copy)`.slice(0, 40) };
    save([...pages.slice(0, index + 1), copy, ...pages.slice(index + 1)]);
  };
  const reset = (page: PageConfig) => {
    if (page.preset && confirm(`Reset “${page.title}” to how it came?`)) update(page.id, { ...presetPage(page.preset), sidebar: page.sidebar });
  };
  const remove = (page: PageConfig) => {
    if (confirm(`Delete the page “${page.title}”?`)) save(pages.filter((p) => p.id !== page.id));
  };

  return (
    <div className="card form-stack" id="pages">
      <div className="row between">
        <h2>Pages</h2>
        <button
          className="primary small"
          onClick={() => setEditing({ page: { ...presetPage('videos'), filters: { ...presetPage('videos').filters, formats: [] }, id: newPageId(), preset: undefined, title: 'My page', icon: 'star' }, isNew: true })}
        >
          <Plus size={15} /> New page
        </button>
      </div>
      <p className="small muted">
        The pages of the left panel, in order. Each shows content from your algorithm nodes its own way: choose the formats, the layout
        and what is shown with each item. Home is the page the client opens with.
      </p>
      <div className="page-list">
        {pages.map((page, index) => (
          <div key={page.id} className="page-row">
            <div className="page-row-move">
              <button className="ghost icon small" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${page.title} up`}>
                <ArrowUp size={14} />
              </button>
              <button
                className="ghost icon small"
                disabled={index === pages.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`Move ${page.title} down`}
              >
                <ArrowDown size={14} />
              </button>
            </div>
            <div className="page-row-icon">
              <PageIconView icon={page.icon} />
            </div>
            <div className="page-row-body">
              <div className="page-row-title">
                {page.title} {page.id === 'home' && <span className="badge accent">Start page</span>}
              </div>
              <div className="tiny faint">
                {PAGE_LAYOUT_LABELS[page.layout].replace(/ \(.*\)$/, '')} · {page.filters.formats.length ? page.filters.formats.map((f) => FORMAT_LABELS[f]).join(', ') : 'all formats'} ·{' '}
                {SOURCE_SHORT[page.source]}
                {page.query ? ` “${page.query}”` : ''}
              </div>
            </div>
            <Switch checked={page.sidebar} onChange={(sidebar) => update(page.id, { sidebar })} label={<span className="tiny">Left panel</span>} />
            <div className="row" style={{ gap: 4 }}>
              <button className="small" onClick={() => setEditing({ page, isNew: false })}>
                <Pencil size={14} /> Edit
              </button>
              <button className="ghost icon small" title="Duplicate" aria-label={`Duplicate ${page.title}`} onClick={() => duplicate(index)}>
                <Copy size={14} />
              </button>
              {page.preset ? (
                <button className="ghost icon small" title="Reset to default" aria-label={`Reset ${page.title}`} onClick={() => reset(page)}>
                  <RotateCcw size={14} />
                </button>
              ) : (
                <button className="ghost icon small danger" title="Delete" aria-label={`Delete ${page.title}`} onClick={() => remove(page)}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && <PageEditor page={editing.page} isNew={editing.isNew} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SharingCard() {
  const { state, updateSettings } = useApp();
  const current = state?.settings.shareBaseUrl ?? DEFAULT_SHARE_BASE_URL;
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current]);
  if (!state) return null;
  const apply = async (next: string) => {
    if (next.trim() === current) return;
    if (!(await updateSettings({ shareBaseUrl: next.trim() }))) setValue(current);
  };
  return (
    <div className="card form-stack" id="sharing">
      <div className="row">
        <Share2 size={20} />
        <h2>Sharing</h2>
      </div>
      <p className="small muted">
        Shared links and QR codes open a hosted copy of the VibeShare web client, which plays the content from the nodes it is set up with.
        Point them at your own copy if you host one.
      </p>
      <label className="field">
        Web client address
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input type="url" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => void apply(value)} onKeyDown={(e) => e.key === 'Enter' && void apply(value)} />
          {current !== DEFAULT_SHARE_BASE_URL && (
            <button className="small" onClick={() => void apply(DEFAULT_SHARE_BASE_URL)} title={DEFAULT_SHARE_BASE_URL}>
              <RotateCcw size={14} /> Default
            </button>
          )}
        </div>
        <span className="hint">A link looks like {decodeURIComponent(shareLink(current, 'vs1…'))}</span>
      </label>
    </div>
  );
}

const TOR_MODES: Record<TorSettings['mode'], { label: string; help: string }> = {
  onion: {
    label: 'Only for nodes at .onion addresses',
    help: 'Nodes that are Tor onion services are reached through Tor; the others directly.',
  },
  all: {
    label: 'For every node',
    help: 'Nodes do not see your IP address. Requests go through the onion address of a node when it has one, and take longer.',
  },
  off: { label: 'Off', help: 'Nodes at .onion addresses cannot be reached.' },
};

function TorCard() {
  const { state, updateSettings } = useApp();
  const current = state?.settings.tor ?? { mode: 'onion' as const, proxy: '' };
  const [proxy, setProxy] = useState(current.proxy);
  const [check, setCheck] = useState<{ busy?: boolean; ok?: boolean; text?: string } | null>(null);
  useEffect(() => setProxy(current.proxy), [current.proxy]);
  if (!state) return null;
  if (IS_STATIC) {
    return (
      <div className="card form-stack" id="tor">
        <div className="row">
          <Shield size={20} />
          <h2>Tor</h2>
        </div>
        <p className="small muted">
          To use VibeShare over Tor in a browser, open this page in Tor Browser: everything, including nodes at .onion addresses, then goes
          through Tor. In the iPhone and iPad app, Orbot (in its VPN mode) sends the app's traffic through Tor. The desktop app and{' '}
          <code>vibeshare client</code> can use Tor themselves.
        </p>
      </div>
    );
  }
  const run = async () => {
    setCheck({ busy: true });
    try {
      const result = await api<{ ok: boolean; proxy?: string; isTor?: boolean; ip?: string; error?: string }>('/api/tor/check', { method: 'POST' });
      setCheck(
        result.ok
          ? { ok: true, text: `Connected through Tor at ${result.proxy} (exit address ${result.ip}).` }
          : { ok: false, text: result.error ?? (result.proxy ? `${result.proxy} answers, but traffic does not leave through Tor.` : 'Tor was not found.') }
      );
    } catch (e) {
      setCheck({ ok: false, text: errorMessage(e) });
    }
  };
  return (
    <div className="card form-stack" id="tor">
      <div className="row">
        <Shield size={20} />
        <h2>Tor</h2>
      </div>
      <p className="small muted">
        Send requests to nodes through <a className="link" href="https://www.torproject.org/download/" target="_blank" rel="noreferrer">Tor</a>{' '}
        (the Tor service, or Tor Browser while it is open). Players and pictures from other platforms load in this window: in the desktop
        app they go through Tor too when Tor is on for every node; in a browser, open VibeShare in Tor Browser for that.
      </p>
      <div className="form-grid">
        <label className="field">
          Use Tor
          <select value={current.mode} onChange={(e) => void updateSettings({ tor: { ...current, mode: e.target.value as TorSettings['mode'] } })}>
            {(['onion', 'all', 'off'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {TOR_MODES[mode].label}
              </option>
            ))}
          </select>
          <span className="hint">{TOR_MODES[current.mode].help}</span>
        </label>
        <label className="field">
          Tor address <span className="hint">Empty: found automatically (9050, or Tor Browser's 9150)</span>
          <input
            type="text"
            value={proxy}
            placeholder="127.0.0.1:9050"
            spellCheck={false}
            onChange={(e) => setProxy(e.target.value)}
            onBlur={async () => {
              if (proxy.trim() !== current.proxy && !(await updateSettings({ tor: { ...current, proxy: proxy.trim() } }))) setProxy(current.proxy);
            }}
          />
        </label>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <button className="small" disabled={check?.busy} onClick={() => void run()}>
          {check?.busy ? 'Checking…' : 'Test Tor'}
        </button>
        {check?.text && (
          <span className="small" style={{ color: check.ok ? 'var(--ok)' : 'var(--warn)' }}>
            {check.text}
          </span>
        )}
      </div>
    </div>
  );
}

/** The most common choices; the rest show on request (selected ones always show). */
const COMMON_LANGUAGES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'ru', 'ar', 'hi', 'zh', 'ja', 'ko'];

function LanguagePicker({ selected, onChange }: { selected: string[]; onChange: (languages: string[]) => void }) {
  const [all, setAll] = useState(false);
  const shown = LANGUAGES.filter((language) => all || COMMON_LANGUAGES.includes(language.code) || selected.includes(language.code));
  return (
    <div className="field">
      <span>
        Languages{' '}
        <span className="hint">
          Titles are checked by the letters they use: content shows when its title could be in one of these languages. None selected = all.
        </span>
      </span>
      <Chips
        options={shown.map((language) => language.code)}
        selected={selected}
        labels={Object.fromEntries(LANGUAGES.map((language) => [language.code, language.name]))}
        onToggle={(code) => onChange(toggle(selected, code))}
      />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="small" onClick={() => setAll(!all)}>
          {all ? 'Fewer languages' : `All ${LANGUAGES.length} languages`}
        </button>
        {selected.length > 0 && (
          <button type="button" className="small" onClick={() => onChange([])}>
            Allow every language
          </button>
        )}
      </div>
    </div>
  );
}

function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (list: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input type="text" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(splitList(text))} />
  );
}

function IdentityCard() {
  const { state, refresh, toast } = useApp();
  const [seed, setSeed] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [backup, setBackup] = useState('');
  if (!state) return null;
  return (
    <div className="card form-stack">
      <div className="row">
        <KeyRound size={20} />
        <h2>Identity</h2>
      </div>
      <p className="small muted">
        Your public key identifies you as a creator and, depending on each node's account mode, holds your credits. Everything is derived
        from one secret backup.
        {IS_STATIC &&
          ' The web client keeps it in this browser, for this site only: clearing the site data deletes it, so keep the backup somewhere safe.'}
      </p>
      <div>
        <div className="hint">Public key</div>
        <CodeBox text={state.identity.id} />
      </div>
      {seed ? (
        <div className="banner warn">
          <ShieldAlert size={18} />
          <div style={{ flex: 1 }}>
            <strong>Secret backup — anyone with it controls your identity and credits.</strong>
            <div style={{ marginTop: 8 }}>
              <CodeBox text={seed} />
            </div>
          </div>
        </div>
      ) : null}
      <div className="row">
        <button onClick={async () => setSeed(seed ? null : (await api<{ seed: string }>('/api/identity/export')).seed)}>
          <Eye size={15} /> {seed ? 'Hide backup' : 'Show backup'}
        </button>
        <button onClick={() => setRestoring(true)}>Restore from backup</button>
      </div>
      {restoring && (
        <Modal
          title="Restore identity"
          onClose={() => setRestoring(false)}
          actions={
            <>
              <button onClick={() => setRestoring(false)}>Cancel</button>
              <button
                className="primary"
                disabled={!backup.trim()}
                onClick={async () => {
                  try {
                    await api('/api/identity/import', { body: { seed: backup } });
                    toast('Identity restored', 'success');
                    setRestoring(false);
                    setBackup('');
                    await refresh();
                  } catch (error) {
                    toast(errorMessage(error), 'error');
                  }
                }}
              >
                Restore
              </button>
            </>
          }
        >
          <p className="small muted" style={{ marginBottom: 12 }}>
            This replaces the identity of this client. Accounts using your identity or private per-node keys switch to the restored ones.
            Write down the current backup first if you want to keep it.
          </p>
          <textarea className="mono" value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="vibeshare-seed-…" />
        </Modal>
      )}
    </div>
  );
}

/**
 * Profiles: several people (or personas) sharing this client. Each profile keeps its
 * own nodes, settings, history and client id. A profile is public (anyone using the
 * client can switch to it) or locked with a username and a password.
 */
function ProfilesCard() {
  const { state, refresh, toast } = useApp();
  const profiles = state?.profiles ?? [];
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hidden, setHidden] = useState(false);
  const [unlockingHidden, setUnlockingHidden] = useState(false);
  const [unlocking, setUnlocking] = useState<ProfileSummary | null>(null);
  const [unlockUser, setUnlockUser] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [protecting, setProtecting] = useState<ProfileSummary | null>(null);
  const [protectUser, setProtectUser] = useState('');
  const [protectPassword, setProtectPassword] = useState('');
  const [deleting, setDeleting] = useState<ProfileSummary | null>(null);
  const [deleteUser, setDeleteUser] = useState('');
  const [deletePassword, setDeletePassword] = useState('');

  // A hidden profile that is active but sealed: the client is locked until it opens.
  useEffect(() => {
    if (state?.locked) setUnlockingHidden(true);
  }, [state?.locked]);

  const create = async () => {
    try {
      await api('/api/profiles', {
        body: { name, username: username || undefined, password: password || undefined, hidden: hidden || undefined },
      });
      setCreating(false);
      setName('');
      setUsername('');
      setPassword('');
      setHidden(false);
      toast(hidden ? 'Hidden profile created — unlock it with its username and password' : 'Profile created', 'success');
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const switchTo = async (profile: ProfileSummary, creds?: { username: string; password: string }) => {
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.id)}/switch`, { body: creds ?? {} });
      toast(`Switched to ${profile.name}`, 'success');
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const protect = async () => {
    if (!protecting) return;
    try {
      await api(`/api/profiles/${encodeURIComponent(protecting.id)}`, {
        method: 'PATCH',
        body: protectPassword ? { username: protectUser || protecting.username, password: protectPassword } : { makePublic: true },
      });
      setProtecting(null);
      setProtectUser('');
      setProtectPassword('');
      toast('Profile updated', 'success');
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  // Deleting a profile is destructive: it is confirmed with the profile's username and
  // password (a public profile has none of its own, so its name is typed as the username).
  const remove = async () => {
    if (!deleting) return;
    try {
      await api(`/api/profiles/${encodeURIComponent(deleting.id)}`, {
        method: 'DELETE',
        body: { username: deleteUser.trim(), password: deletePassword },
      });
      setDeleting(null);
      setDeleteUser('');
      setDeletePassword('');
      toast('Profile deleted', 'success');
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  return (
    <div className="card form-stack" id="profiles">
      <div className="row between">
        <div className="row">
          <UserRound size={20} />
          <h2>Profiles</h2>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="small" title="Open a hidden profile with its username and password" onClick={() => setUnlockingHidden(true)}>
            <Lock size={14} /> Unlock hidden
          </button>
          <button className="primary small" onClick={() => setCreating(true)}>
            <Plus size={15} /> New profile
          </button>
        </div>
      </div>
      {state?.locked && (
        <div className="banner warn small">
          <Lock size={16} />
          <div>
            <strong>A hidden profile is locked.</strong> Its data is encrypted on this device — unlock it with its username and password.
          </div>
        </div>
      )}
      <p className="small muted">
        Each profile has its own nodes, settings, history and client id — like a separate account on this device. Public profiles open for
        anyone; protected ones need their username and password to switch to.
      </p>
      <div className="page-list">
        {profiles.map((profile) => (
          <div key={profile.id} className="page-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                {profile.name} {profile.active && <span className="badge accent">active</span>}
              </strong>
              <div className="tiny faint">
                {profile.access === 'protected' ? (
                  <>
                    <Lock size={11} /> {profile.username} · password protected
                  </>
                ) : (
                  'Public'
                )}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              {!profile.active && (
                <button
                  className="small"
                  onClick={() => {
                    if (profile.access === 'protected') {
                      setUnlocking(profile);
                      setUnlockUser(profile.username ?? '');
                      setUnlockPassword('');
                    } else void switchTo(profile);
                  }}
                >
                  Switch
                </button>
              )}
              {!profile.hidden && (
                <>
                  <button
                    className="small"
                    title="Rename"
                    onClick={async () => {
                      const next = window.prompt('Profile name', profile.name);
                      if (next === null || !next.trim()) return;
                      try {
                        await api(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'PATCH', body: { name: next.trim() } });
                        await refresh();
                      } catch (error) {
                        toast(errorMessage(error), 'error');
                      }
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="small"
                    title={profile.access === 'protected' ? 'Change password or make public' : 'Protect with a username and password'}
                    onClick={() => {
                      setProtecting(profile);
                      setProtectUser(profile.username ?? '');
                      setProtectPassword('');
                    }}
                  >
                    <Lock size={14} />
                  </button>
                </>
              )}
              <button
                className="small danger"
                title="Delete"
                onClick={() => {
                  setDeleting(profile);
                  setDeleteUser(profile.access === 'protected' ? (profile.username ?? '') : profile.name);
                  setDeletePassword('');
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {creating && (
        <Modal
          title="New profile"
          onClose={() => setCreating(false)}
          actions={
            <>
              <button onClick={() => setCreating(false)}>Cancel</button>
              <button className="primary" disabled={!name.trim() || (hidden && (!username.trim() || !password))} onClick={create}>
                Create
              </button>
            </>
          }
        >
          <div className="form-stack">
            <label className="field">
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, Family, Anonymous…" autoFocus />
            </label>
            <Switch
              checked={hidden}
              onChange={setHidden}
              label="Hidden"
            />
            <p className="small muted">
              {hidden
                ? 'A hidden profile does not appear anywhere — not even that it exists. Its name, client id and all of its data are encrypted with the password, and it only opens with its username and password.'
                : 'Leave the username and password empty for a public profile. A protected profile only opens with its username and password.'}
            </p>
            <div className="form-grid">
              <label className="field">
                Username{hidden ? '' : ' (for a protected profile)'}
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </label>
              <label className="field">
                Password
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
          </div>
        </Modal>
      )}
      {unlockingHidden && (
        <Modal
          title="Unlock a hidden profile"
          onClose={() => setUnlockingHidden(false)}
          actions={
            <>
              <button onClick={() => setUnlockingHidden(false)}>Cancel</button>
              <button
                className="primary"
                disabled={!unlockUser.trim() || !unlockPassword}
                onClick={async () => {
                  try {
                    await api('/api/profiles/unlock', { body: { username: unlockUser.trim(), password: unlockPassword } });
                    setUnlockingHidden(false);
                    setUnlockUser('');
                    setUnlockPassword('');
                    toast('Hidden profile unlocked', 'success');
                    await refresh();
                  } catch (error) {
                    toast(errorMessage(error), 'error');
                  }
                }}
              >
                Unlock
              </button>
            </>
          }
        >
          <div className="form-stack">
            <p className="small muted">
              Hidden profiles do not appear anywhere — not even that they exist. Their data is encrypted on this device and only opens
              with its username and password.
            </p>
            <label className="field">
              Username
              <input type="text" value={unlockUser} onChange={(e) => setUnlockUser(e.target.value)} autoFocus />
            </label>
            <label className="field">
              Password
              <input type="password" value={unlockPassword} onChange={(e) => setUnlockPassword(e.target.value)} autoComplete="current-password" />
            </label>
          </div>
        </Modal>
      )}
      {unlocking && (
        <Modal
          title={`Switch to ${unlocking.name}`}
          onClose={() => setUnlocking(null)}
          actions={
            <>
              <button onClick={() => setUnlocking(null)}>Cancel</button>
              <button
                className="primary"
                onClick={async () => {
                  await switchTo(unlocking, { username: unlockUser, password: unlockPassword });
                  setUnlocking(null);
                }}
              >
                Unlock
              </button>
            </>
          }
        >
          <div className="form-stack">
            <label className="field">
              Username
              <input type="text" value={unlockUser} onChange={(e) => setUnlockUser(e.target.value)} autoFocus />
            </label>
            <label className="field">
              Password
              <input type="password" value={unlockPassword} onChange={(e) => setUnlockPassword(e.target.value)} autoComplete="current-password" />
            </label>
          </div>
        </Modal>
      )}
      {protecting && (
        <Modal
          title={`Protection of ${protecting.name}`}
          onClose={() => setProtecting(null)}
          actions={
            <>
              <button onClick={() => setProtecting(null)}>Cancel</button>
              <button className="primary" onClick={protect}>
                {protectPassword ? 'Protect' : 'Make public'}
              </button>
            </>
          }
        >
          <div className="form-stack">
            {protecting.access === 'protected' && (
              <button
                onClick={async () => {
                  try {
                    await api(`/api/profiles/${encodeURIComponent(protecting.id)}`, { method: 'PATCH', body: { makePublic: true } });
                    setProtecting(null);
                    await refresh();
                  } catch (error) {
                    toast(errorMessage(error), 'error');
                  }
                }}
              >
                Remove the password (make it public)
              </button>
            )}
            <p className="small muted">Or set a username and password: the profile then only opens with them.</p>
            <div className="form-grid">
              <label className="field">
                Username
                <input type="text" value={protectUser} onChange={(e) => setProtectUser(e.target.value)} autoComplete="off" />
              </label>
              <label className="field">
                New password
                <input type="password" value={protectPassword} onChange={(e) => setProtectPassword(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}`}
          onClose={() => setDeleting(null)}
          actions={
            <>
              <button onClick={() => setDeleting(null)}>Cancel</button>
              <button className="danger" disabled={!deleteUser.trim() || !deletePassword} onClick={remove}>
                Delete profile
              </button>
            </>
          }
        >
          <div className="form-stack">
            <p className="small muted">
              This permanently removes <strong>{deleting.name}</strong> and all of its data (nodes, settings, history and client id) from this
              device. Confirm with the profile's username and password.
              {deleting.access !== 'protected' && ' This profile is public and has no password of its own — type its name as the username.'}
            </p>
            <div className="form-grid">
              <label className="field">
                Username
                <input type="text" value={deleteUser} onChange={(e) => setDeleteUser(e.target.value)} autoComplete="off" autoFocus />
              </label>
              <label className="field">
                Password
                <input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" />
              </label>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The settings grouped into tabs: similar settings live together. */
const SETTINGS_TABS: [string, string][] = [
  ['feed', 'Feed'],
  ['seen', 'Seen content'],
  ['media', 'Media controls'],
  ['privacy', 'Privacy'],
  ['profiles', 'Profiles'],
  ['history', 'History'],
  ['logs', 'Logs'],
];

/** Which tab a deep link (settings#profiles…) lands on. */
function tabForHash(hash: string): string {
  const groups: Record<string, string> = {
    pages: 'feed',
    feed: 'feed',
    storage: 'media',
    media: 'media',
    playback: 'media',
    video: 'media',
    history: 'history',
    seen: 'seen',
    'seen-mode': 'seen',
    'seen-selected': 'seen',
    'seen-preview': 'seen',
    'seen-node': 'seen',
    tor: 'privacy',
    sharing: 'profiles',
    privacy: 'privacy',
    profiles: 'profiles',
    identity: 'profiles',
    logs: 'logs',
    log: 'logs',
    debug: 'logs',
  };
  return groups[hash.slice(1)] ?? 'feed';
}

/** Debug logs: a live view of what the app asks of the nodes (Settings → Logs). */
function LogsCard() {
  const { state, updateSettings } = useApp();
  const [, setTick] = useState(0);
  useEffect(() => subscribeLogs(() => setTick((n) => n + 1)), []);
  const on = Boolean(state?.settings.debugLogs);
  useEffect(() => {
    setDebugLogs(on);
  }, [on]);
  const lines = logLines();
  return (
    <div className="card form-stack">
      <h2>Debug logs</h2>
      <Switch
        checked={on}
        onChange={(debugLogs) => void updateSettings({ debugLogs })}
        label="Keep debug logs (off by default)"
      />
      <p className="hint">
        When on, the app records what it asks of the nodes while a .vvsh video plays: every chunk fetch (which index, which encoding, from which
        branch), what came back, the merkle path it verified, and what the player decided to load. That is how to check that a 10-second-chunk
        video with a 60-second window loads chunks 0–6 first, and only 100–106 after skipping to chunk 100.
      </p>
      {lines.length > 0 && (
        <div className="row">
          <button className="small" onClick={clearLogs}>
            <Trash2 size={14} /> Clear
          </button>
        </div>
      )}
      <div className="mono tiny" style={{ maxHeight: 460, overflowY: 'auto' }}>
        {lines.length === 0 ? (
          <p className="hint">{on ? 'Nothing logged yet — play a .vvsh video.' : 'Turn logging on, then play a .vvsh video.'}</p>
        ) : (
          lines.map((line, index) => (
            <div key={index} style={{ padding: '3px 0', borderBottom: '1px solid var(--border, #eee)' }}>
              <span className="faint">{line.at}</span> <strong>[{line.kind}]</strong> {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Third-party embeds and their tracking cookies: the consent choice, as easy to
 *  withdraw as it was to make. */
function EmbedsCard() {
  const { updateSettings } = useApp();
  const [choice, setChoice] = useState(() => loadConsent()?.choice ?? null);
  const record = loadConsent();
  return (
    <div className="card form-stack">
      <h2>Third-party embeds and cookies</h2>
      <p className="small muted">
        Embedded players from other platforms (YouTube, Vimeo, the Internet Archive, …) load <strong>third-party tracking cookies</strong> that follow
        you across sites. Nothing from another platform loads until you allow it here — and withdrawing this choice is exactly as easy as making it.
        Your choice is stored on this device only.
      </p>
      <Switch
        checked={choice === 'accepted'}
        onChange={(allow) => {
          chooseConsent(allow ? 'accepted' : 'rejected');
          setChoice(loadConsent()?.choice ?? null);
          void updateSettings?.({ blockExternalEmbeds: !allow });
        }}
        label="Allow third-party embeds (they carry third-party tracking cookies)"
      />
      <span className="hint">
        {record
          ? `Chosen ${new Date(record.at).toLocaleString()} — change it here at any time.`
          : 'No choice made yet: embeds stay off until you choose.'}
      </span>
    </div>
  );
}

/** How often the GUI may re-read the client state on its own (navigation, refocus). */
function StateRefreshCard() {
  const { state, updateSettings } = useApp();
  const [value, setValue] = useState(String(state?.settings.stateRefreshSeconds ?? 0));
  useEffect(() => setValue(String(state?.settings.stateRefreshSeconds ?? 0)), [state?.settings.stateRefreshSeconds]);
  return (
    <div className="card form-stack">
      <h2>Automatic state refresh</h2>
      <p className="small muted">
        The GUI reads the client state (<code>/api/state</code>) once when it opens, and can re-read it when you navigate or come back to
        the window. Choose how often that may happen, in seconds — <strong>0 turns it off</strong>. Credits and node status stay live
        either way: they arrive over the events stream, and the app re-reads after its own changes (saving a setting, adding a node). What
        an automatic re-read adds is settings, pages and nodes changed elsewhere — another window or the daemon itself.
      </p>
      <label className="field">
        Seconds between automatic re-reads (0 = never)
        <input
          type="number"
          min={0}
          max={86400}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            const seconds = Number(e.target.value);
            if (Number.isFinite(seconds) && seconds >= 0) void updateSettings({ stateRefreshSeconds: Math.round(seconds) });
          }}
        />
        <span className="hint">Navigating and refocusing the window count as one; each actual re-read starts the wait again.</span>
      </label>
    </div>
  );
}

export function SettingsPage() {
  const { state, updateSettings } = useApp();
  const location = useLocation();
  const [tab, setTab] = useState(() => tabForHash(location.hash));
  useEffect(() => {
    const target = tabForHash(location.hash);
    if (target) setTab(target);
  }, [location.hash]);
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id && state) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [location.hash, Boolean(state), tab]);
  if (!state) return null;
  const s = state.settings;
  const prefs = s.preferences;
  const setPrefs = (patch: Partial<Settings['preferences']>) => void updateSettings({ preferences: { ...prefs, ...patch } });

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Your preferences are sent to algorithm nodes with every request; they filter and rank content by them.</p>
        </div>
      </div>

      <div className="tabs">
        {SETTINGS_TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'feed' && (
        <>
          <PagesCard />

      <div className="card form-stack">
        <h2>Content preferences</h2>
        <Switch
          checked={s.showContentPreviews}
          onChange={(showContentPreviews) => void updateSettings({ showContentPreviews })}
          label="Show content previews"
        />
        <span className="hint">Off asks algorithm nodes not to send preview images and hides previews already on the page. Opening and playing content still works.</span>
        <div className="form-grid">
          <label className="field">
            Highest age rating
            <select value={prefs.maxRating ?? '16+'} onChange={(e) => setPrefs({ maxRating: e.target.value as Rating })}>
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {RATING_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <LanguagePicker selected={prefs.languages ?? []} onChange={(languages) => setPrefs({ languages })} />
        <div className="field">
          <span>
            Formats <span className="hint">None selected = all</span>
          </span>
          <Chips options={FORMATS} selected={prefs.formats ?? []} labels={FORMAT_LABELS} onToggle={(f) => setPrefs({ formats: toggle(prefs.formats, f) })} />
        </div>
        <div className="field">
          <span>Favourite topics</span>
          <Chips options={TOPICS} selected={prefs.topics ?? []} onToggle={(t) => setPrefs({ topics: toggle(prefs.topics, t) })} />
          <Switch checked={Boolean(prefs.onlyTopics)} onChange={(onlyTopics) => setPrefs({ onlyTopics })} label="Only show these topics" />
        </div>
        <div className="field">
          <span>
            Creators <span className="hint">None selected = all</span>
          </span>
          <Chips
            options={CREATOR_KINDS.filter((k) => k !== 'unknown')}
            selected={prefs.creatorKinds ?? []}
            labels={CREATOR_KIND_LABELS}
            onToggle={(k) => setPrefs({ creatorKinds: toggle(prefs.creatorKinds, k as CreatorKind) })}
          />
        </div>
        <label className="field">
          Hide tags
          <ListInput value={prefs.blockedTags ?? []} onChange={(blockedTags) => setPrefs({ blockedTags })} placeholder="spoilers, jump-scares" />
        </label>
        <label className="field">
          Hide creators <span className="hint">Creator ids, comma separated</span>
          <ListInput value={prefs.blockedCreators ?? []} onChange={(blockedCreators) => setPrefs({ blockedCreators })} />
        </label>
        <label className="field">
          Content no algorithm node has reviewed
          <select value={s.unknownContent} onChange={(e) => void updateSettings({ unknownContent: e.target.value as Settings['unknownContent'] })}>
            <option value="warn">Show it with a warning</option>
            <option value="hide">Hide it until I choose to see it</option>
            <option value="allow">Show it normally</option>
          </select>
        </label>
      </div>

      <div className="card form-stack">
        <h2>Nodes and accounts</h2>
        <label className="field">
          Account for new nodes
          <select value={s.defaultAuth} onChange={(e) => void updateSettings({ defaultAuth: e.target.value as AuthMode })}>
            {(Object.keys(AUTH_LABELS) as AuthMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {AUTH_LABELS[mode].label}
              </option>
            ))}
          </select>
          <span className="hint">{AUTH_LABELS[s.defaultAuth].help}</span>
        </label>
        <label className="field">
          Feeds
          <select value={s.feedMode} onChange={(e) => void updateSettings({ feedMode: e.target.value as Settings['feedMode'] })}>
            <option value="blend">Blend every enabled algorithm node</option>
            <option value="primary">Only the first algorithm node that answers</option>
          </select>
        </label>
      </div>

          <div className="card form-stack">
            <h2>Playback and storage</h2>
            <Switch checked={s.autoplay} onChange={(autoplay) => void updateSettings({ autoplay })} label="Start playing reviewed content automatically" />
            <span className="hint">
              When third-party embeds are off (Settings → Privacy), only content hosted on the network (its cid) plays and only its metadata shows —
              external platform players and previews are replaced by a placeholder.
            </span>
            <div className="form-grid">
              <label className="field">
                Pause before loading more (seconds)
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  defaultValue={s.loadPauseMs / 1000}
                  onBlur={(e) => void updateSettings({ loadPauseMs: Math.round(Number(e.target.value) * 1000) })}
                />
                <span className="hint">A little friction at the end of each list, so fast scrolling does not spend credits on content you skip.</span>
              </label>
              <label className="field">
                Cache size (MiB)
                <input type="number" min={16} defaultValue={s.cacheMiB} onBlur={(e) => void updateSettings({ cacheMiB: Number(e.target.value) })} />
              </label>
              <label className="field">
                IPFS gateway
                <input type="url" defaultValue={s.ipfsGateway} onBlur={(e) => void updateSettings({ ipfsGateway: e.target.value })} />
              </label>
              <label className="field">
                Theme
                <select
                  value={s.theme}
                  onChange={(e) => {
                    const picked = e.target.value;
                    if (picked === 'system' || picked === 'dark' || picked === 'light') void updateSettings({ theme: picked });
                  }}
                >
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
            </div>
          </div>
        </>
      )}

      {tab === 'media' && (
        <div className="card form-stack">
          <h2>Video streams</h2>
          <p className="small muted">How the player handles .vvsh video streams.</p>
          <div className="form-grid">
            <label className="field">
              Default quality
              <select value={s.vvshDefaultQuality} onChange={(e) => void updateSettings({ vvshDefaultQuality: e.target.value })}>
                <option value="auto">Auto (fits your network)</option>
                <option value="highest">Highest available</option>
                <option value="lowest">Lowest available</option>
              </select>
              <span className="hint">What the player starts on for a .vvsh video.</span>
            </label>
            <label className="field">
              Prefetch ahead (seconds)
              <input
                type="number"
                min={0}
                max={3600}
                defaultValue={s.vvshPrefetchSeconds}
                onBlur={(e) => void updateSettings({ vvshPrefetchSeconds: Number(e.target.value) })}
              />
              <span className="hint">
                While a video plays, its chunks keep downloading this far ahead (a minute by default). 0 fetches only what is playing.
              </span>
            </label>
            <label className="field">
              Arrow-key skip (seconds)
              <input
                type="number"
                min={1}
                max={120}
                defaultValue={s.vvshSkipSeconds}
                onBlur={(e) => void updateSettings({ vvshSkipSeconds: Number(e.target.value) })}
              />
              <span className="hint">How far the left and right arrows jump (10 by default · 1–120).</span>
            </label>
            <label className="field">
              Scrub preview size (pixels)
              <input
                type="number"
                min={80}
                max={640}
                step={20}
                defaultValue={s.vvshScrubWidth}
                onBlur={(e) => void updateSettings({ vvshScrubWidth: Number(e.target.value) })}
              />
              <span className="hint">
                How wide the floating preview shows while scrubbing (80–640). The images themselves are captured and sized by whoever published
                the video — that is recorded in the file.
              </span>
            </label>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="card form-stack">
          <h2>History</h2>
          <HistorySection />
        </div>
      )}

      {tab === 'logs' && <LogsCard />}

      {tab === 'seen' && <SeenFiltersSection />}

      {tab === 'privacy' && (
        <>
          <EmbedsCard />
          <StateRefreshCard />
          <TorCard />
        </>
      )}

      {tab === 'profiles' && (
        <>
          <ProfilesCard />
          <SharingCard />

      <div className="card form-stack">
        <h2>Creator profile</h2>
        <div className="form-grid">
          <label className="field">
            Name
            <input
              type="text"
              defaultValue={s.profile.name}
              onBlur={(e) => void updateSettings({ profile: { ...s.profile, name: e.target.value } })}
            />
          </label>
          <label className="field">
            You are a
            <select value={s.profile.kind} onChange={(e) => void updateSettings({ profile: { ...s.profile, kind: e.target.value as CreatorKind } })}>
              {CREATOR_KINDS.filter((k) => k !== 'unknown').map((k) => (
                <option key={k} value={k}>
                  {CREATOR_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

          <IdentityCard />
        </>
      )}
      <p className="tiny faint" style={{ marginTop: 16 }}>
        Page built {__VS_BUILD__}
      </p>
    </div>
  );
}
