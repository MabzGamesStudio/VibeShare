import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { Loading } from '../components/ui';
import { splitList, timeAgo } from '../util';
import { admin, message } from './api';
import { useToast } from './AdminApp';

interface ApiAdapter {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  blocked: boolean;
  stats: { found: number; added: number; errors: number; lastRun?: string; lastError?: string };
  api?: {
    signupUrl: string;
    credentials: { key: string; label: string; secret?: boolean }[];
    note: string;
    optional?: boolean;
    configured: boolean;
    dailyLimit: number;
    searchShare: number;
    usedToday: { crawl: number; search: number };
    pausedUntil?: string;
  };
}

type AdapterSettings = Record<string, Record<string, unknown>>;

async function saveCrawler(patch: Record<string, unknown>) {
  await admin('/v1/admin/config', { method: 'PUT', body: { crawler: patch } });
}

/** A credential field: secrets are hidden until the operator asks to see them. */
function Credential({ label, value, secret, onSave }: { label: string; value: string; secret?: boolean; onSave: (value: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <label className="field">
      {label}
      <div className="row" style={{ gap: 6 }}>
        <input
          type={secret && !shown ? 'password' : 'text'}
          key={value}
          defaultValue={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="Not set"
          style={{ flex: 1 }}
          onBlur={(e) => e.target.value.trim() !== value && onSave(e.target.value.trim())}
        />
        {secret && (
          <button type="button" className="icon" title={shown ? 'Hide' : 'Show'} onClick={() => setShown(!shown)}>
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
    </label>
  );
}

function ApiCard({ adapter, settings, save }: { adapter: ApiAdapter; settings: Record<string, unknown>; save: (patch: Record<string, unknown>) => void }) {
  const api = adapter.api!;
  const crawlBudget = Math.floor(api.dailyLimit * (1 - api.searchShare));
  const used = api.usedToday.crawl + api.usedToday.search;
  const state = adapter.blocked
    ? { text: 'Source blocked', tone: 'var(--warn)' }
    : api.pausedUntil
      ? { text: `Rate limited until ${new Date(api.pausedUntil).toLocaleTimeString()}`, tone: 'var(--warn)' }
      : !api.configured
        ? { text: api.optional ? 'Works without a key' : 'Needs credentials', tone: 'var(--text-faint)' }
        : !adapter.enabled
          ? { text: 'Off', tone: 'var(--text-faint)' }
          : { text: 'Active', tone: 'var(--ok)' };
  return (
    <details className="card api-card">
      <summary className="row between">
        <div className="row" style={{ gap: 10 }}>
          <input
            type="checkbox"
            checked={adapter.enabled}
            title="Use this API"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          <div>
            <strong>{adapter.label}</strong>
            <div className="tiny faint">{adapter.description}</div>
          </div>
        </div>
        <div className="api-summary small">
          <span style={{ color: state.tone }}>{state.text}</span>
          <span className="faint">
            {used.toLocaleString()} / {api.dailyLimit.toLocaleString()} today
          </span>
        </div>
      </summary>
      <div className="form-stack" style={{ marginTop: 12 }}>
        <p className="small muted">
          {api.note}{' '}
          <a href={api.signupUrl} target="_blank" rel="noreferrer">
            Get credentials <ExternalLink size={12} />
          </a>
        </p>
        <div className="form-grid">
          {api.credentials.map((field) => (
            <Credential
              key={field.key}
              label={field.label}
              secret={field.secret}
              value={typeof settings[field.key] === 'string' ? (settings[field.key] as string) : ''}
              onSave={(value) => save({ [field.key]: value })}
            />
          ))}
        </div>
        <div className="form-grid">
          <label className="field">
            Daily request budget <span className="hint">Calls (or API units) per day; set it within the platform's own limit.</span>
            <input
              type="number"
              min={0}
              key={api.dailyLimit}
              defaultValue={api.dailyLimit}
              onBlur={(e) => {
                const value = Math.max(0, Math.floor(Number(e.target.value) || 0));
                if (value !== api.dailyLimit) save({ dailyLimit: value });
              }}
            />
          </label>
          <label className="field">
            Kept for client searches <span className="hint">The crawler only uses the rest; searches can use the whole budget.</span>
            <select value={String(Math.round(api.searchShare * 100))} onChange={(e) => save({ searchShare: Number(e.target.value) / 100 })}>
              {[0, 10, 25, 50, 75, 90, 100].map((share) => (
                <option key={share} value={share}>
                  {share}%
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="small muted">
          Today: {api.usedToday.crawl.toLocaleString()} used crawling (up to {crawlBudget.toLocaleString()}), {api.usedToday.search.toLocaleString()} answering
          searches · {adapter.stats.found} found, {adapter.stats.added} new
          {adapter.stats.lastRun && ` · last run ${timeAgo(adapter.stats.lastRun)}`}
        </div>
        {adapter.stats.lastError && (
          <div className="tiny" style={{ color: 'var(--warn)' }}>
            {adapter.stats.lastError}
          </div>
        )}
      </div>
    </details>
  );
}

export function ApiKeys() {
  const [adapters, setAdapters] = useState<ApiAdapter[] | null>(null);
  const [settings, setSettings] = useState<AdapterSettings>({});
  const [searchPlatforms, setSearchPlatforms] = useState(true);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ adapters: ApiAdapter[]; searchPlatforms: boolean }>('/v1/admin/crawler')
      .then((status) => {
        setAdapters(status.adapters.filter((adapter) => adapter.api));
        setSearchPlatforms(status.searchPlatforms);
      })
      .catch((e) => show(message(e)));
    admin<{ crawler: { adapters: AdapterSettings } }>('/v1/admin/config')
      .then((config) => setSettings(config.crawler.adapters))
      .catch(() => undefined);
  }, [show]);
  useEffect(load, [load]);

  const save = (id: string) => async (patch: Record<string, unknown>) => {
    try {
      await saveCrawler({ adapters: { [id]: patch } });
      load();
    } catch (e) {
      show(message(e));
    }
  };

  if (!adapters) return <Loading />;
  const ready = adapters.filter((adapter) => adapter.enabled && adapter.api!.configured && !adapter.blocked).length;
  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Platform APIs</h3>
        <p className="small muted">
          Many platforms only allow automated access through their official API. Fill in credentials from your own developer account and the crawler
          uses that API to find content for your catalog, within the daily budget you set. The part of the budget kept for searches is used when
          clients search this node{searchPlatforms ? '' : ' (turned off: Crawler → "When clients search")'}: if there is budget left, the platform is
          searched too and the results are listed. Credentials stay on this node and are only sent to the platform they belong to.
        </p>
        <div className="small">
          {ready} of {adapters.length} APIs in use. Budgets reset every day (UTC).
        </div>
      </div>
      {adapters.map((adapter) => (
        <ApiCard key={adapter.id} adapter={adapter} settings={settings[adapter.id] ?? {}} save={save(adapter.id)} />
      ))}
    </div>
  );
}

interface SourceRow {
  key: string;
  name: string;
  priority: number;
  crawled: boolean;
  blocked: boolean;
  listed: number;
  pending: number;
}

/** A 0–10 slider that saves when the operator lets go. */
function Priority({ name, value, onSave }: { name: string; value: number; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onSave(draft);
  return (
    <div className="row" style={{ gap: 8 }}>
      <input
        type="range"
        min={0}
        max={10}
        step={1}
        value={draft}
        aria-label={`${name} priority`}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="small" style={{ width: 52 }}>
        {draft === 0 ? 'hidden' : draft}
      </span>
    </div>
  );
}

function SiteList({ title, hint, sites, onSave }: { title: string; hint: string; sites: string[]; onSave: (sites: string[]) => void }) {
  return (
    <label className="field">
      {title} <span className="hint">{hint}</span>
      <textarea
        rows={4}
        key={sites.join('\n')}
        defaultValue={sites.join('\n')}
        placeholder="example.org"
        spellCheck={false}
        onBlur={(e) => {
          const next = splitList(e.target.value.replace(/\n/g, ','))
            .map((site) => site.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase())
            .filter(Boolean);
          if (next.join('\n') !== sites.join('\n')) onSave(next);
        }}
      />
    </label>
  );
}

export function Sources() {
  const [data, setData] = useState<{ sources: SourceRow[]; sites: { allow: string[]; block: string[] } } | null>(null);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<NonNullable<typeof data>>('/v1/admin/sources').then(setData).catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const put = async (body: Record<string, unknown>) => {
    try {
      await admin('/v1/admin/config', { method: 'PUT', body });
      load();
    } catch (e) {
      show(message(e));
    }
  };

  if (!data) return <Loading />;
  const blocked = data.sources.filter((source) => source.blocked).map((source) => source.key);
  const setBlocked = (key: string, block: boolean) => {
    setData({ ...data, sources: data.sources.map((source) => (source.key === key ? { ...source, blocked: block } : source)) });
    return put({ crawler: { blockedSources: block ? [...blocked, key] : blocked.filter((other) => other !== key) } });
  };
  const setPriority = (key: string, priority: number) => put({ sources: { priorities: { [key]: priority } } });

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Sources</h3>
        <p className="small muted">
          Where content comes from. Untick a source to stop crawling it: the crawler no longer visits it or keeps what it finds there, and what it
          listed before is hidden from feeds and search. The priority decides how strongly a source is favoured in feeds and search results: 10
          comes first, 5 is neutral, 1 goes last and 0 hides it (content of a source at 0 is never shown). Content published on VibeShare
          providers starts at 10.
        </p>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Crawl</th>
              <th>Priority</th>
              <th>Listed</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => (
              <tr key={source.key}>
                <td className="small">
                  <strong>{source.name}</strong>
                  {!source.crawled && source.key !== 'vibeshare' && <div className="tiny faint">Found through links on other pages</div>}
                </td>
                <td>
                  {source.key === 'vibeshare' ? (
                    <span className="tiny faint">Not crawled</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={!source.blocked}
                      title={source.blocked ? 'Blocked: never crawled' : 'Allowed'}
                      onChange={(e) => setBlocked(source.key, !e.target.checked)}
                    />
                  )}
                </td>
                <td>
                  <Priority name={source.name} value={source.priority} onSave={(priority) => setPriority(source.key, priority)} />
                </td>
                <td className="small">{source.listed}</td>
                <td className="small">{source.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card form-stack">
        <h3>Sites</h3>
        <p className="small muted">
          Website names for the web crawler, one per line. A name also covers its subdomains (<code>example.org</code> covers{' '}
          <code>www.example.org</code>).
        </p>
        <div className="form-grid">
          <SiteList
            title="Only crawl these sites"
            hint="Leave empty to follow links to any site."
            sites={data.sites.allow}
            onSave={(allow) => put({ crawler: { sites: { allow } } })}
          />
          <SiteList title="Never crawl these sites" hint="Not even through a platform's API." sites={data.sites.block} onSave={(block) => put({ crawler: { sites: { block } } })} />
        </div>
      </div>
    </div>
  );
}
