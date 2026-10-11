import { Eye, KeyRound, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { AuthMode, Settings } from '../../../src/shared/clientapi';
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
import { api, errorMessage } from '../api';
import { Chips, CodeBox, Modal, Switch, toggle } from '../components/ui';
import { useApp } from '../state';
import { splitList } from '../util';
import { AUTH_LABELS } from './Nodes';

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

export function SettingsPage() {
  const { state, updateSettings } = useApp();
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

      <div className="card form-stack">
        <h2>Content preferences</h2>
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
          <label className="field">
            Languages <span className="hint">Codes like en, es; empty = all</span>
            <ListInput value={prefs.languages ?? []} onChange={(languages) => setPrefs({ languages })} placeholder="en, es" />
          </label>
        </div>
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
          Home feed
          <select value={s.feedMode} onChange={(e) => void updateSettings({ feedMode: e.target.value as Settings['feedMode'] })}>
            <option value="blend">Blend every enabled algorithm node</option>
            <option value="primary">Only the first algorithm node that answers</option>
          </select>
        </label>
      </div>

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

      <div className="card form-stack">
        <h2>Playback and storage</h2>
        <Switch checked={s.autoplay} onChange={(autoplay) => void updateSettings({ autoplay })} label="Start playing reviewed content automatically" />
        <div className="form-grid">
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
            <select value={s.theme} onChange={(e) => void updateSettings({ theme: e.target.value as Settings['theme'] })}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>
      </div>

      <IdentityCard />
    </div>
  );
}
