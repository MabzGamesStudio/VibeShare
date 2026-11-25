import { ArrowDown, ArrowUp, Copy, Eye, KeyRound, Lock, Pencil, Plus, RotateCcw, Share2, Shield, ShieldAlert, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { PAGE_LAYOUT_LABELS, type AuthMode, type PageConfig, type ProfileSummary, type Settings, type ToastMessage, type TorSettings } from '../../../src/shared/clientapi';
import { DEFAULT_SHARE_BASE_URL, newPageId, presetPage, shareLink } from '../../../src/shared/clientdefaults';
import { LANGUAGES } from '../../../src/shared/language';
import { AGE_RATING_SYSTEMS, ageRatingSystem } from '../../../src/shared/age-rating';
import {
  FORMAT_LABELS,
  FORMATS,
  TOPICS,
  type Format,
  type Rating,
} from '../../../src/shared/taxonomy';
import { api, errorMessage, IS_STATIC } from '../api';
import { PageIconView } from '../components/feed/icons';
import { AddPickRow, LevelSlider, PageEditor, PickButtons, type PickEntry } from '../components/feed/PageEditor';
import { SeenFiltersSection } from '../components/SeenFilters';
import { pageShareBase } from '../components/Share';
import { TraceSettingsForm } from '../components/Tracing';
import { CodeBox, Modal, Switch } from '../components/ui';
import { HOSTING_PLATFORMS } from '../earn/hosting';
import { useApp } from '../state';
import { chooseConsent, choosePlatform, loadConsent, platformChoices } from '../consent';
import { clearLogs, logLines, setDebugLogs, subscribeLogs } from '../log';
import { HistorySection } from './History';
import { TracingSection } from './Tracing';
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
        <span className="hint">
          Leave empty to share from the page you are on. A link looks like {decodeURIComponent(shareLink(pageShareBase(current), 'vs1…'))}
        </span>
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

/**
 * One pick list in the tri-state look of the customization modal: selected (active),
 * off (no effect), or excluded (red); each click cycles to the next state, and an input
 * adds one more entry. The two stored lists are "kept" and "excluded"; entries the user
 * deselected stay visible (dimmed) so a click can still cycle them.
 */
function PickList({
  title,
  hint,
  kind,
  labelOf,
  fillers = [],
  on,
  block,
  set,
  twoState = false,
  addAs = 'on',
  addPlaceholder,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** How the add row takes a typed entry: a topic name, a creator id, or a plain id. */
  kind: 'topic' | 'creator' | 'code';
  labelOf: (id: string) => string;
  /** Entries shown unselected after the picked ones (a catalogue to pick from). */
  fillers?: string[];
  /** Kept (active) and excluded (red) entries — the two lists this writes. */
  on: string[];
  block: string[];
  set: (next: { on: string[]; block: string[] }) => void;
  /** Some lists have no excluded state (languages): they cycle kept/off only. */
  twoState?: boolean;
  /** Where a freshly added entry starts: kept (active) or excluded (red). */
  addAs?: 'on' | 'block';
  addPlaceholder?: string;
}) {
  const [dropped, setDropped] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const label = (id: string) => names[id] ?? labelOf(id);
  const stateOf = (id: string): PickEntry['state'] => (on.includes(id) ? 'on' : block.includes(id) ? 'block' : 'off');
  const entries: PickEntry[] = [
    ...on.map((id) => ({ id, label: label(id), state: 'on' as const })),
    ...dropped.filter((id) => !on.includes(id) && !block.includes(id)).map((id) => ({ id, label: label(id), state: 'off' as const })),
    ...block.map((id) => ({ id, label: label(id), state: 'block' as const })),
    ...fillers.filter((id) => !on.includes(id) && !block.includes(id) && !dropped.includes(id)).map((id) => ({ id, label: label(id), state: 'off' as const })),
  ];
  // One click cycles: selected → deselected → excluded → selected (kept → kept when the
  // list has no excluded state).
  const cycle = (id: string) => {
    const remove = (list: string[]) => list.filter((value) => value !== id);
    const now = stateOf(id);
    if (now === 'on') {
      setDropped((current) => [...new Set([...current, id])]);
      set({ on: remove(on), block });
    } else if (now === 'off') {
      setDropped((current) => remove(current));
      set(twoState ? { on: [...new Set([...on, id])], block } : { on, block: [...new Set([...block, id])] });
    } else {
      set({ on: [...new Set([...on, id])], block: remove(block) });
    }
  };
  const add = (pick: { id: string; name: string }) => {
    // Topics are stored by name (what the node matches), creators and codes by id.
    const value = kind === 'topic' ? pick.name : pick.id;
    setNames((current) => ({ ...current, [value]: pick.name }));
    setDropped((current) => current.filter((entry) => entry !== value));
    if (addAs === 'block') set({ on: on.filter((entry) => entry !== value), block: [...new Set([...block, value])] });
    else set({ on: [...new Set([...on, value])], block: block.filter((entry) => entry !== value) });
  };
  return (
    <div className="field">
      <span>
        {title} <span className="hint">{hint}</span>
      </span>
      <PickButtons entries={entries} onCycle={cycle} />
      {kind === 'code' ? (
        <div className="row" style={{ gap: 6, marginTop: 10, alignSelf: 'flex-start' }}>
          <input
            type="text"
            placeholder={addPlaceholder}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const code = e.currentTarget.value.trim().toLowerCase();
              if (code) add({ id: code, name: code });
              e.currentTarget.value = '';
            }}
          />
        </div>
      ) : (
        <AddPickRow kind={kind} onAdd={add} />
      )}
    </div>
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

/** Saved toast messages: whether to keep them at all, the bell icon, and what is kept. */
function ToastMessagesSection() {
  const { state, updateSettings } = useApp();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ToastMessage[]>([]);
  const saving = Boolean(state?.settings.toastHistory);
  const load = () => {
    api<{ items: ToastMessage[] }>(`/api/toasts${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
      .then((answer) => setItems(answer.items))
      .catch(() => setItems([]));
  };
  useEffect(load, [query, saving]);
  return (
    <div className="card form-stack" id="toasts">
      <h2>Toast messages</h2>
      <p className="small muted">
        Messages pop up at the bottom right, and the bell button keeps them for this session. Nothing is saved on this device by
        default — turn on saving to keep them. Saved messages search and clear exactly like the watch and search history.
      </p>
      <Switch checked={saving} onChange={(toastHistory) => void updateSettings({ toastHistory })} label="Save toast messages on this device" />
      <Switch
        checked={state?.settings.toastIcon !== false}
        onChange={(toastIcon) => void updateSettings({ toastIcon })}
        label="Show the bell icon on every page"
      />
      {saving && (
        <>
          <label className="field">
            Search messages
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words in the message" />
          </label>
          {items.length > 0 && (
            <div className="row">
              <button
                className="small"
                onClick={async () => {
                  await api('/api/toasts', { method: 'DELETE' });
                  load();
                }}
              >
                <Trash2 size={14} /> Clear all saved messages
              </button>
            </div>
          )}
          <div className="form-stack" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <p className="hint">{query.trim() ? 'Nothing matches.' : 'Nothing saved yet.'}</p>
            ) : (
              items.map((item) => (
                <div key={item.id} className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <div className="small">
                    <span className="faint tiny">{new Date(item.at).toLocaleString()}</span>{' '}
                    <span style={item.kind === 'error' ? { color: 'var(--danger)' } : undefined}>{item.text}</span>
                  </div>
                  <button
                    className="small ghost"
                    title="Delete"
                    onClick={async () => {
                      await api(`/api/toasts/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Which hosting platform tabs the provider jobs instructions show (Settings → Nodes). */
function NodesSection() {
  const { state, updateSettings } = useApp();
  const shown = state?.settings.hostingTabs ?? [];
  const toggleTab = (id: string) =>
    void updateSettings({ hostingTabs: shown.includes(id) ? shown.filter((entry) => entry !== id) : [...shown, id] });
  if (!state) return null;
  const s = state.settings;
  return (
    <>
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
        <h2>Provider node</h2>
      <p className="instructions muted">
        The hosting platforms the provider jobs instructions walk through. A ticked platform shows as a tab under Earn → Provider
        jobs; the others stay hidden until you tick them here.
      </p>
      <div className="check-list">
        {HOSTING_PLATFORMS.map((entry) => (
          <label key={entry.id} className="check-item">
            <input type="checkbox" checked={shown.includes(entry.id)} onChange={() => toggleTab(entry.id)} />
            <div>
              <div style={{ fontWeight: 600 }}>{entry.name}</div>
            </div>
          </label>
        ))}
      </div>
      </div>
    </>
  );
}

/** The settings grouped into tabs: similar settings live together. */
const SETTINGS_TABS: [string, string][] = [
  ['feed', 'Feed'],
  ['seen', 'Seen content'],
  ['media', 'Media controls'],
  ['nodes', 'Nodes'],
  ['privacy', 'Privacy'],
  ['profiles', 'Profiles'],
  ['history', 'History'],
  ['logs', 'Logs'],
  ['tracing', 'Tracing'],
];

/** Which tab a deep link (settings?tab=profiles…; the old #profiles links too) lands on. */
function tabForTarget(target: string): string {
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
    tracing: 'tracing',
    trace: 'tracing',
    traces: 'tracing',
    toasts: 'history',
    toast: 'history',
  };
  const key = target.replace(/^#/, '').replace(/^\?tab=/, '');
  return groups[key] ?? (SETTINGS_TABS.some(([id]) => id === key) ? key : 'feed');
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
  const tracing = state?.settings.tracing;
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
      {tracing && (
        <TraceSettingsForm
          settings={tracing}
          onChange={(patch) => void updateSettings({ tracing: { ...tracing, ...patch } })}
        />
      )}
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
 *  withdraw as it was to make — whole, or one platform at a time. */
function EmbedsCard() {
  const { updateSettings } = useApp();
  const [choice, setChoice] = useState(() => loadConsent()?.choice ?? null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => loadConsent()?.platforms ?? {});
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
          setOverrides({});
          void updateSettings?.({ blockExternalEmbeds: !allow });
        }}
        label="Allow third-party embeds (they carry third-party tracking cookies)"
      />
      <span className="hint">
        {record
          ? `Chosen ${new Date(record.at).toLocaleString()} — change it here at any time.`
          : 'No choice made yet: embeds stay off until you choose.'}
      </span>
      <div className="field">
        <span>Per platform</span>
        {platformChoices().map((platform) => (
          <div key={platform.id} className="platform-choice">
            <span>{platform.label}</span>
            <Switch
              checked={overrides[platform.id] ?? choice === 'accepted'}
              onChange={(allow) => {
                choosePlatform(platform.id, allow);
                setOverrides(loadConsent()?.platforms ?? {});
              }}
            />
          </div>
        ))}
      </div>
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
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(() => tabForTarget(params.get('tab') ?? location.hash));
  const [historyTab, setHistoryTab] = useState<'history' | 'toasts'>(() => (params.get('tab') === 'toasts' ? 'toasts' : 'history'));
  useEffect(() => {
    const target = tabForTarget(params.get('tab') ?? location.hash);
    if (target) setTab(target);
  }, [params, location.hash]);
  useEffect(() => {
    // The tab id doubles as the anchor of its first card (`?tab=sharing` scrolls there).
    const id = params.get('tab') ?? location.hash.slice(1);
    if (id && state) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [params, location.hash, Boolean(state), tab]);
  // A handful of creators the creators list offers as picks (the customization modal
  // looks them up the same way): shown unhighlighted until the user clicks one.
  const [suggested, setSuggested] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    api<{ creators: { id: string; name: string }[] }>('/api/creators?q=')
      .then((result) => {
        if (!live) return;
        setSuggested(Object.fromEntries(result.creators.slice(0, 5).map((creator) => [creator.id, creator.name])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
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
          <button
            key={id}
            className={`tab ${tab === id ? 'on' : ''}`}
            onClick={() => {
              setTab(id);
              setParams((current) => {
                current.set('tab', id);
                return current;
              }, { replace: true });
            }}
          >
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
        <div className="field">
          <span>Age rating maximums</span>
          {(prefs.ageRatingMaxima ?? []).map((row, at) => {
            const system = ageRatingSystem(row.system);
            const custom = !system;
            const update = (patch: { system?: string; category?: string }) =>
              setPrefs({ ageRatingMaxima: (prefs.ageRatingMaxima ?? []).map((entry, index) => (index === at ? { ...entry, ...patch } : entry)) });
            return (
              <div key={at} className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  aria-label="Age-rating system"
                  value={custom ? 'custom' : row.system}
                  onChange={(e) => update({ system: e.target.value === 'custom' ? '' : e.target.value, category: '' })}
                >
                  {AGE_RATING_SYSTEMS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {custom ? (
                  <>
                    <input type="text" placeholder="System name" value={row.system} onChange={(e) => update({ system: e.target.value })} />
                    <input type="text" placeholder="Maximum category" value={row.category} onChange={(e) => update({ category: e.target.value })} />
                  </>
                ) : system.categories.length ? (
                  <select aria-label="Maximum category" value={row.category} onChange={(e) => update({ category: e.target.value })}>
                    <option value="">Choose…</option>
                    {system.categories.map((entry) => (
                      <option key={entry.slug} value={entry.slug}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder="Maximum category (free text)"
                    value={row.category}
                    onChange={(e) => update({ category: e.target.value })}
                  />
                )}
                <button
                  className="small danger"
                  onClick={() => setPrefs({ ageRatingMaxima: (prefs.ageRatingMaxima ?? []).filter((_, index) => index !== at) })}
                >
                  Remove
                </button>
              </div>
            );
          })}
          <button
            className="small"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setPrefs({ ageRatingMaxima: [...(prefs.ageRatingMaxima ?? []), { system: AGE_RATING_SYSTEMS[0]?.id ?? 'mpa', category: '' }] })}
          >
            Add age rating maximum
          </button>
          <span className="hint">
            The highest category to show per rating system — content rated above it in its own system is hidden. Content with no rating
            for that system is kept, like every unknown rating.
          </span>
        </div>
        <PickList
          title="Languages"
          hint="Active = content in these languages shows (with none active, all do); off = no effect. Languages have no excluded list, so they cycle kept/off."
          kind="code"
          labelOf={(code) => LANGUAGES.find((language) => language.code === code)?.name ?? code}
          fillers={LANGUAGES.map((language) => language.code)}
          on={prefs.languages ?? []}
          block={[]}
          twoState
          set={({ on: languages }) => setPrefs({ languages })}
          addPlaceholder="Language code (fr, de, …) — Enter to add"
        />
        <LevelSlider
          label="Weigh the chosen languages"
          value={prefs.languageLevel ?? 'only'}
          onChange={(languageLevel) => setPrefs({ languageLevel })}
        />
        <PickList
          title="Formats"
          hint="Active = favoured in your feed, red = never shown, off = no effect."
          kind="code"
          labelOf={(id) => FORMAT_LABELS[id as keyof typeof FORMAT_LABELS] ?? id}
          fillers={[...FORMATS]}
          on={prefs.formats ?? []}
          block={prefs.blockedFormats ?? []}
          set={({ on, block }) => setPrefs({ formats: on as Format[], preferredFormats: on as Format[], blockedFormats: block as Format[] })}
          addPlaceholder="A format (music, video, …) — Enter to add"
        />
        <PickList
          title="Topics"
          hint="Active = favoured in your feed, red = never shown, off = no effect."
          kind="topic"
          labelOf={(id) => id}
          fillers={[...TOPICS]}
          on={prefs.topics ?? []}
          block={prefs.blockedTopics ?? []}
          set={({ on: topics, block: blockedTopics }) => setPrefs({ topics, preferredTopics: topics, blockedTopics })}
          addPlaceholder="A topic name"
        />
        <LevelSlider label="Weigh the chosen topics" value={prefs.topicLevel ?? 'strongly'} onChange={(topicLevel) => setPrefs({ topicLevel })} />
        <PickList
          title="Creators"
          hint="Active = your creators, red = never shown, off = no effect. 'Only show' turns the active ones into the only creators."
          kind="creator"
          labelOf={(id) => suggested[id] ?? id}
          fillers={Object.keys(suggested)}
          on={prefs.creatorIds ?? []}
          block={prefs.blockedCreators ?? []}
          set={({ on: creatorIds, block: blockedCreators }) => setPrefs({ creatorIds, preferredCreators: creatorIds, blockedCreators })}
          addPlaceholder="A creator name or id"
        />
        <LevelSlider label="Weigh the chosen creators" value={prefs.creatorLevel ?? 'ignore'} onChange={(creatorLevel) => setPrefs({ creatorLevel })} />
        <label className="field">
          Subscriptions carousel order
          <select
            value={s.subscriptionOrder}
            onChange={(e) => void updateSettings({ subscriptionOrder: e.target.value as Settings['subscriptionOrder'] })}
          >
            <option value="subscribed">Subscribed date (newest first)</option>
            <option value="random">Random</option>
            <option value="az">Alphabetical (A–Z)</option>
            <option value="za">Alphabetical (Z–A)</option>
            <option value="recent">Most recent posting</option>
          </select>
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
        <>
          <div className="segmented" role="tablist" aria-label="History sections">
            <button
              role="tab"
              aria-selected={historyTab === 'history'}
              className={historyTab === 'history' ? 'on' : ''}
              onClick={() => setHistoryTab('history')}
            >
              Watch and search history
            </button>
            <button
              role="tab"
              aria-selected={historyTab === 'toasts'}
              className={historyTab === 'toasts' ? 'on' : ''}
              onClick={() => setHistoryTab('toasts')}
            >
              Toast messages
            </button>
          </div>
          {historyTab === 'history' ? (
            <div className="card form-stack">
              <h2>History</h2>
              <HistorySection />
              <Switch
                checked={Boolean(state?.settings.logContributions)}
                onChange={(logContributions) => void updateSettings({ logContributions })}
                label="Keep a log of my contributions to algorithm nodes (Earn → Algorithm nodes)"
              />
              <p className="hint">
                Off by default — nothing is collected. Suggestions and submissions of yours are listed on the Earn page when this is on.
              </p>
            </div>
          ) : (
            <ToastMessagesSection />
          )}
        </>
      )}

      {tab === 'logs' && <LogsCard />}

      {tab === 'tracing' && <TracingSection />}

      {tab === 'nodes' && <NodesSection />}

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
