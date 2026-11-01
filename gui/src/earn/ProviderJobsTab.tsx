import { Download, ExternalLink, Globe, Save, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, streamUrl } from '../api';
import { OfferLinksCard } from '../components/OfferLinks';
import { CodeBox, Switch } from '../components/ui';
import { useApp } from '../state';
import {
  HOSTING_PLATFORMS,
  contentUrl,
  hostingPlatform,
  loadDrafts,
  loadHosts,
  newHostId,
  pushHostedContent,
  saveDrafts,
  saveHosts,
  type HostConfig,
  type HostDraft,
} from './hosting';

/** The platform setup as a guided flow: one step per screen instead of all at once. */
const PLATFORM_STEPS: [string, string][] = [
  ['account', '1. Account & site'],
  ['access', '2. Access details'],
  ['url', '3. Base URL & content ids'],
  ['save', '4. Save & offer'],
];

/**
 * The provider jobs tab: configure base URLs on free static hosting platforms. Each
 * platform is a guided flow — account setup, access details, the base URL with content
 * ids appended, then saving and offering it — and job data is pushed to the site so
 * providers can download from `<base>/<cid>` and pay for it.
 */
export function ProviderJobsTab() {
  const { providers, toast } = useApp();
  const [hosts, setHosts] = useState<HostConfig[]>(() => loadHosts());
  const [platformId, setPlatformId] = useState(HOSTING_PLATFORMS[0].id);
  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [platformId]);
  // Every field auto-saves as it is typed, per platform — moving between steps or
  // closing the page keeps all of it.
  const [drafts, setDrafts] = useState<Record<string, HostDraft>>(() => loadDrafts());
  useEffect(() => saveDrafts(drafts), [drafts]);
  const [pushHostId, setPushHostId] = useState('');
  const [pushCid, setPushCid] = useState('');
  const [pushFile, setPushFile] = useState<File | null>(null);
  const [pushing, setPushing] = useState(false);
  // Provider jobs to host: the wizard fetches a job's content id from a provider here.
  const [jobNode, setJobNode] = useState('');
  const [jobItems, setJobItems] = useState<{ cid: string; title?: string; source: string }[]>([]);

  const platform = hostingPlatform(platformId);
  const draft: HostDraft = drafts[platformId] ?? { values: {}, baseUrl: '', label: '', cid: '' };
  const update = (patch: Partial<HostDraft>) =>
    setDrafts((current) => ({ ...current, [platformId]: { ...draft, ...patch } }));
  const values = {
    ...Object.fromEntries(platform.fields.map((field) => [field.id, field.default ?? ''])),
    ...draft.values,
  };
  const edited = Boolean(draft.baseUrl);
  const baseUrl = (draft.baseUrl || platform.buildBaseUrl(values)).trim();

  const commit = (list: HostConfig[]) => {
    setHosts(list);
    saveHosts(list);
  };

  const save = (): HostConfig | null => {
    if (!/^https?:\/\//.test(baseUrl)) {
      toast('Fill in the fields so a base URL can be built (or type one)', 'error');
      return null;
    }
    const host: HostConfig = {
      id: newHostId(),
      platform: platform.id,
      label: draft.label.trim() || platform.name,
      baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
      values,
      autoPush: false,
      createdAt: new Date().toISOString(),
    };
    commit([...hosts, host]);
    update({ label: '' });
    toast(`Saved ${host.label}`, 'success');
    return host;
  };

  const offer = async (host: HostConfig) => {
    if (!providers.length) {
      toast('Add a provider node first', 'error');
      return;
    }
    try {
      for (const node of providers) {
        await api(`/api/nodes/${node.id}/content-urls`, { method: 'POST', body: { items: [{ baseUrl: host.baseUrl }] } });
      }
      toast(`Offered ${host.baseUrl} to ${providers.length} provider node${providers.length === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const push = async () => {
    const host = hosts.find((h) => h.id === pushHostId) ?? hosts[0];
    if (!host) {
      toast('Save a host first', 'error');
      return;
    }
    const id = pushCid.trim();
    if (!id && !pushFile) {
      toast('Give a content id or pick a file', 'error');
      return;
    }
    setPushing(true);
    try {
      let data: Uint8Array;
      if (pushFile) data = new Uint8Array(await pushFile.arrayBuffer());
      else {
        const response = await fetch(streamUrl(id, true));
        if (!response.ok) throw new Error(`Could not download ${id} from your providers`);
        data = new Uint8Array(await response.arrayBuffer());
      }
      const result = await pushHostedContent(host, id || pushFile!.name, data);
      toast(result.message, result.ok ? 'success' : 'info');
      if (result.ok) {
        setPushCid('');
        setPushFile(null);
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    setPushing(false);
  };

  /** Saves the host and pushes the fetched job's content id to it with the access key. */
  const publishJob = async () => {
    const cid = draft.cid.trim();
    if (!cid) {
      toast('Fetch a job content id first', 'error');
      return;
    }
    const host = save();
    if (!host) return;
    try {
      setPushing(true);
      const response = await fetch(streamUrl(cid, true));
      if (!response.ok) throw new Error(`Could not download ${cid} from your providers`);
      const data = new Uint8Array(await response.arrayBuffer());
      const result = await pushHostedContent(host, cid, data);
      toast(result.message, result.ok ? 'success' : 'info');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setPushing(false);
    }
  };

  return (
    <>
      <div className="card form-stack">
        <div className="row">
          <Globe size={22} />
          <div>
            <h2>Provider jobs on free hosting</h2>
            <p className="small muted">
              Providers pay credits each time they download a copy of content from a link you offer — the bytes must hash to the content
              id exactly. Free static hosts give you a base URL; the tabs below walk through the account setup of each platform, build
              that base URL with you and push job data to the site, so the site serves <code>&lt;base&gt;/&lt;cid&gt;</code> and every
              content id is just the base URL with the id appended.
            </p>
          </div>
        </div>
      </div>

      <div className="tabs">
        {HOSTING_PLATFORMS.map((entry) => (
          <button key={entry.id} className={`tab ${platformId === entry.id ? 'on' : ''}`} onClick={() => setPlatformId(entry.id)}>
            {entry.name}
          </button>
        ))}
      </div>

      <div className="card form-stack">
        <div className="row between">
          <div className="row">
            <Globe size={22} />
            <h2>{platform.name}</h2>
          </div>
          <span className="hint">
            Step {step + 1} of {PLATFORM_STEPS.length}
          </span>
        </div>

        <div className="tabs">
          {PLATFORM_STEPS.map(([id, label], index) => (
            <button key={id} className={`tab ${step === index ? 'on' : ''}`} onClick={() => setStep(index)}>
              {label}
            </button>
          ))}
        </div>

        {step === 0 && (
          <>
            <p className="small muted">{platform.about}</p>
            <div className="row">
              <a className="link small" href={platform.signup} target="_blank" rel="noreferrer">
                Sign up <ExternalLink size={12} />
              </a>
              <a className="link small" href={platform.docs} target="_blank" rel="noreferrer">
                Docs <ExternalLink size={12} />
              </a>
            </div>
            <ol className="small muted">
              {platform.steps.map((instruction, i) => (
                <li key={i}>{instruction}</li>
              ))}
            </ol>
          </>
        )}

        {step === 1 && (
        <div className="form-grid">
          {platform.fields.map((field) => (
            <label key={field.id} className="field">
              {field.label}
              <input
                type={field.secret ? 'password' : 'text'}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder}
                autoComplete={field.secret ? 'off' : undefined}
                onChange={(e) => update({ values: { ...values, [field.id]: e.target.value } })}
              />
              {field.hint && <span className="hint">{field.hint}</span>}
            </label>
          ))}
        </div>
        )}

        {step === 2 && (
          <>
        <label className="field">
          Base URL
          <input
            type="text"
            className="mono"
            value={baseUrl}
            placeholder="https://you.example/baseUrl/"
            onChange={(e) => update({ baseUrl: e.target.value })}
          />
          <span className="hint">
            Built from the fields above; edit it if the platform shows a different URL.{' '}
            {edited && (
              <button type="button" className="small" onClick={() => update({ baseUrl: '' })}>
                Suggest from fields
              </button>
            )}
          </span>
        </label>

        {/^https?:\/\//.test(baseUrl) && (
          <label className="field">
            Content id
            <input type="text" className="mono" value={draft.cid} placeholder="vs1… or a source id" onChange={(e) => update({ cid: e.target.value })} />
            <span className="hint">Appended to the base URL automatically — this is the URL providers download from.</span>
            <CodeBox text={contentUrl(baseUrl, draft.cid.trim() || '<content-id>')} />
          </label>
        )}

        <div className="field">
          <span>From a provider job — fetch a content id to host</span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="field" style={{ marginBottom: 0, maxWidth: 220 }}>
              Content provider
              <select value={jobNode || providers[0]?.id || ''} onChange={(e) => setJobNode(e.target.value)}>
                {providers.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="small"
              disabled={!providers.length}
              onClick={async () => {
                const node = jobNode || providers[0]?.id;
                if (!node) return;
                try {
                  const answer = await api<{ items: { cid: string; title?: string; source: string }[] }>(`/api/nodes/${node}/storage-jobs`);
                  setJobItems(answer.items ?? []);
                  if (answer.items?.length) update({ cid: answer.items[0].cid });
                  toast(answer.items?.length ? `Found ${answer.items.length} job content id${answer.items.length === 1 ? '' : 's'}` : 'No jobs found on that provider', answer.items?.length ? 'success' : 'info');
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              <Download size={13} /> Fetch job content ids
            </button>
            {jobItems.length > 0 && (
              <label className="field" style={{ marginBottom: 0, minWidth: 220 }}>
                Job content id
                <select value={draft.cid} onChange={(e) => update({ cid: e.target.value })}>
                  {jobItems.map((item) => (
                    <option key={item.cid} value={item.cid}>
                      {(item.title ?? item.cid.slice(0, 20) + '…') + ` — ${item.source}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <span className="hint">
            The provider's jobs name the content they want hosted — fetch one and its content id fills in above. "Publish" then pushes
            those bytes to this host with the access key and saves it.
          </span>
        </div>
          </>
        )}

        {step === 3 && (
          <>
            <label className="field">
              Name this host
              <input type="text" value={draft.label} placeholder={platform.name} onChange={(e) => update({ label: e.target.value })} />
            </label>
            <p className="small muted">
              Saving keeps the base URL and its access details on this device. Then offer it to your provider nodes — they query{' '}
              <code>&lt;base&gt;/&lt;cid&gt;</code> for any content id and pay per download from it. Pushing job data to the site is in
              “Push job data to a host” below.
            </p>
            {/^https?:\/\//.test(baseUrl) && <CodeBox text={baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`} />}
            <div className="row">
              <button className="primary small" disabled={pushing || !draft.cid.trim()} onClick={() => void publishJob()}>
                <Upload size={14} /> Publish the job's content id to this host & save
              </button>
              <span className="hint">Downloads the content id from your providers and pushes it to the site with the access key.</span>
            </div>
          </>
        )}

        <div className="row">
          <button className="small" disabled={step === 0} onClick={() => setStep(Math.max(0, step - 1))}>
            ← Back
          </button>
          {step < PLATFORM_STEPS.length - 1 ? (
            <button className="primary small" onClick={() => setStep(step + 1)}>
              Next →
            </button>
          ) : (
            <button className="primary" onClick={save}>
              <Save size={16} /> Save host
            </button>
          )}
          <span className="hint">Access tokens stay on this device only.</span>
        </div>
      </div>

      <div className="card form-stack">
        <div className="row">
          <Download size={22} />
          <div>
            <h2>Your base URLs</h2>
            <p className="small muted">
              Saved hosts offer their base URL to your provider nodes — the nodes then query <code>&lt;base&gt;/&lt;cid&gt;</code> for any
              content id and pay per download from it.
            </p>
          </div>
        </div>
        {hosts.length === 0 ? (
          <p className="small muted">Nothing saved yet — configure a platform above and save it.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Base URL</th>
                <th>Auto-push</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => (
                <tr key={host.id}>
                  <td className="small">
                    {host.label}
                    <div className="tiny faint">{hostingPlatform(host.platform).name}</div>
                  </td>
                  <td className="small mono">{host.baseUrl}</td>
                  <td>
                    <Switch
                      checked={host.autoPush}
                      onChange={(autoPush) => commit(hosts.map((h) => (h.id === host.id ? { ...h, autoPush } : h)))}
                      label={<span className="tiny">skeleton</span>}
                    />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="small" onClick={() => void offer(host)}>
                        Offer to providers
                      </button>
                      <button
                        className="small"
                        onClick={() => {
                          setPushHostId(host.id);
                          setPushCid(draft.cid.trim());
                        }}
                      >
                        <Upload size={13} /> Push content
                      </button>
                      <button
                        className="small"
                        aria-label={`Remove ${host.label}`}
                        onClick={() => commit(hosts.filter((h) => h.id !== host.id))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card form-stack">
        <div className="row">
          <Upload size={22} />
          <div>
            <h2>Push job data to a host</h2>
            <p className="small muted">
              Takes a content id (downloaded from your providers) or a picked file and pushes it to the host at{' '}
              <code>&lt;folder&gt;/&lt;cid&gt;</code>, so the site serves it under the base URL. GitHub Pages is wired up end to end; the
              other platforms are skeletons whose tabs say which call their pipeline makes. Automatically taking every provider job and
              pushing it runs in the client daemon and is a skeleton here.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            Host
            <select value={pushHostId || hosts[0]?.id || ''} onChange={(e) => setPushHostId(e.target.value)}>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Content id
            <input type="text" className="mono" value={pushCid} placeholder="vs1…" onChange={(e) => setPushCid(e.target.value)} />
          </label>
          <label className="field">
            Or a file to push
            <input
              type="file"
              onChange={(e) => {
                setPushFile(e.target.files?.[0] ?? null);
                if (e.target.files?.[0]) setPushCid('');
              }}
            />
          </label>
        </div>
        <div className="row">
          <button className="primary" disabled={pushing || hosts.length === 0} onClick={() => void push()}>
            <Upload size={16} /> {pushing ? 'Pushing…' : 'Push now'}
          </button>
          <span className="hint">Each pushed id becomes &lt;base&gt;/&lt;cid&gt; on the site.</span>
        </div>
      </div>

      <div style={{ height: 16 }} />
      <OfferLinksCard />
    </>
  );
}

