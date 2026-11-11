import { Download, Eye, EyeOff, ExternalLink, Globe, Save, Upload } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { api, errorMessage, streamUrl } from '../api';
import { CodeBox } from '../components/ui';
import { downloadBlob } from '../qr';
import { useApp } from '../state';
import { baseKey, checkAccess, checkCids, checkFilled, checkIndex, checkSite, offerHost, type CheckResult } from './checks';
import { buildZip, DUMMY_CID, HOSTING_PLATFORMS, contentUrl, hostingPlatform, loadDrafts, loadHosts, newHostId, platformGuide, pushHostedContent, recordUrlJobs, saveDrafts, saveHosts, type HostConfig, type HostDraft, type HostingField, type HostingStep } from './hosting';

/** The platform setup as a guided flow: one step per screen instead of all at once. */
const PLATFORM_STEPS: [string, string][] = [
  ['account', '1. Account & site'],
  ['access', '2. Access details'],
  ['url', '3. Base URL & content ids'],
  ['save', '4. Save & offer'],
  ['review', '5. Review'],
];

/** Copy values may name a field (`<site>`): the current answer shows instead of the token. */
function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/<([a-zA-Z][\w-]*)>/g, (whole, id: string) => (values[id] ?? '').trim() || whole);
}

/** One platform field: its label, its input — and an eye to show or hide a secret value. */
function FieldInput({ field, value, onChange }: { field: HostingField; value: string; onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <label className="field" style={{ marginBottom: 0 }}>
      {field.label}
      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
        <input
          type={field.secret && !shown ? 'password' : 'text'}
          value={value}
          placeholder={field.placeholder}
          autoComplete={field.secret ? 'off' : undefined}
          style={{ flex: 1 }}
          onChange={(event) => onChange(event.target.value)}
        />
        {field.secret && (
          <button
            type="button"
            className="small"
            title={shown ? 'Hide the token' : 'Show the token'}
            aria-label={shown ? 'Hide the token' : 'Show the token'}
            onClick={() => setShown((on) => !on)}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </span>
      {field.hint && <span className="hint">{field.hint}</span>}
    </label>
  );
}

/** Downloads the starter a step hands out: a zip of its files, or the single file itself. */
function downloadZip(action: { zip: string; entries: { path: string; text: string }[] }) {
  if (action.entries.length === 1 && !action.zip.endsWith('.zip')) {
    downloadBlob(new Blob([action.entries[0].text], { type: 'text/plain' }), action.zip);
    return;
  }
  const zip = buildZip(action.entries);
  downloadBlob(new Blob([zip as unknown as BlobPart], { type: 'application/zip' }), action.zip);
}

/**
 * One setup step as a card: the ordered lines, the values to copy, the links, the field
 * inputs this step fills in — and the check the reader ticks off at the end.
 */
function StepCard({
  step,
  number,
  total,
  done,
  onToggle,
  fields,
  values,
  onField,
}: {
  step: HostingStep;
  number: number;
  total: number;
  done: boolean;
  onToggle: () => void;
  fields: HostingField[];
  values: Record<string, string>;
  onField: (id: string, value: string) => void;
}) {
  const mine = (step.fields ?? [])
    .map((id) => fields.find((field) => field.id === id))
    .filter((field): field is HostingField => Boolean(field));
  const action = step.download;
  return (
    <div className="card form-stack" style={{ padding: 12 }}>
      <div className="row between">
        <strong className="step-heading">
          {number}. {step.title}
        </strong>
        <span className="hint">{done ? '✓ Done' : `Step ${number} of ${total}`}</span>
      </div>
      <ol className="instructions muted" style={{ margin: 0, paddingLeft: 18 }}>
        {step.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
      {step.links?.map((link) => (
        <a key={link.url} className="link small" href={link.url} target="_blank" rel="noreferrer">
          {link.label} <ExternalLink size={12} />
        </a>
      ))}
      {step.copies?.map((copy) => (
        <div key={copy.label} className="field" style={{ marginBottom: 0 }}>
          <span className="hint">{copy.label}</span>
          <CodeBox text={substitute(copy.value, values)} />
        </div>
      ))}
      {action && (
        <div className="row">
          <button className="small" onClick={() => downloadZip(action)}>
            <Download size={13} /> {action.label}
          </button>
        </div>
      )}
      {mine.map((field) => (
        <FieldInput key={field.id} field={field} value={values[field.id] ?? ''} onChange={(value) => onField(field.id, value)} />
      ))}
      <label className="row instructions" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" checked={done} onChange={onToggle} />
        <span>
          {done ? '✓ You have: ' : 'Check: '}
          {step.check}
        </span>
      </label>
    </div>
  );
}

/**
 * The provider jobs tab: configure base URLs on free static hosting platforms. Each
 * platform is a guided flow — account setup, access details, the base URL with content
 * ids appended, then saving and offering it — and job data is pushed to the site so
 * providers can download from `<base>/<cid>` and pay for it.
 */
export function ProviderJobsTab() {
  const { providers, state, toast } = useApp();
  const [hosts, setHosts] = useState<HostConfig[]>(() => loadHosts());
  const [platformId, setPlatformId] = useState(HOSTING_PLATFORMS[0].id);
  // The tabs the instructions show are ticked in Settings → Nodes; only those appear here.
  const shown = HOSTING_PLATFORMS.filter((entry) => (state?.settings.hostingTabs ?? []).includes(entry.id));
  const activeId = shown.some((entry) => entry.id === platformId) ? platformId : (shown[0]?.id ?? platformId);
  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [activeId]);
  // Every field auto-saves as it is typed, per platform — moving between steps or
  // closing the page keeps all of it.
  const [drafts, setDrafts] = useState<Record<string, HostDraft>>(() => loadDrafts());
  useEffect(() => saveDrafts(drafts), [drafts]);
  const [pushing, setPushing] = useState(false);
  // Provider jobs to host: the wizard fetches a job's content id from a provider here.
  const [jobNode, setJobNode] = useState('');
  const [jobItems, setJobItems] = useState<{ cid: string; title?: string; source: string }[]>([]);
  // The "No job handy" fold stays closed until a fetch finds nothing — then it opens itself.
  const [noJob, setNoJob] = useState(false);

  const platform = hostingPlatform(activeId);
  const draft: HostDraft = drafts[activeId] ?? { values: {}, baseUrl: '', label: '', cid: '' };
  const update = (patch: Partial<HostDraft>) =>
    setDrafts((current) => ({ ...current, [activeId]: { ...draft, ...patch } }));
  const values = {
    ...Object.fromEntries(platform.fields.map((field) => [field.id, field.default ?? ''])),
    ...draft.values,
  };
  const edited = Boolean(draft.baseUrl);
  const baseUrl = (draft.baseUrl || platform.buildBaseUrl(values)).trim();
  // The steps behind tabs 2–4: where the access details come from, how this platform
  // serves <base>/<cid>, and what saving and offering it does.
  const guide = platformGuide(platform.id);
  /** The name to give the access token — shown right above the field its value goes in. */
  const tokenName = guide.access.flatMap((instruction) => instruction.copies ?? []).find((copy) => copy.label === 'Token name');
  const firstSecret = platform.fields.findIndex((field) => field.secret);
  /** Fields no step asks for, so nothing of the platform disappears from the form. */
  const covered = new Set([...platform.steps, ...guide.access].flatMap((instruction) => instruction.fields ?? []));
  const leftoverFields = platform.fields.filter((field) => !covered.has(field.id));
  /**
   * Which steps of a group are ticked. Older saved drafts hold a plain array (the
   * account steps only), so both shapes are read.
   */
  const ticked = (group: string, index: number): boolean => {
    const stored: unknown = draft.done;
    if (Array.isArray(stored)) return group === 'account' && Boolean(stored[index]);
    return Boolean((stored as Record<string, boolean[]> | undefined)?.[group]?.[index]);
  };
  const toggle = (group: string, index: number) => {
    const stored: unknown = draft.done;
    const legacy = Array.isArray(stored) ? { account: stored as boolean[] } : (stored as Record<string, boolean[]> | undefined);
    const current = [...(legacy?.[group] ?? [])];
    current[index] = !current[index];
    update({ done: { ...legacy, [group]: current } });
  };
  /** A group of steps as cards, each with its own check, in one list. */
  const stepCards = (group: string, steps: HostingStep[], after?: (index: number) => React.ReactNode) => (
    <div className="form-stack">
      {steps.map((instruction, index) => (
        <Fragment key={index}>
          <StepCard
            step={instruction}
            number={index + 1}
            total={steps.length}
            done={ticked(group, index)}
            onToggle={() => toggle(group, index)}
            fields={platform.fields}
            values={values}
            onField={(id, value) => update({ values: { ...values, [id]: value } })}
          />
          {after?.(index)}
        </Fragment>
      ))}
      {steps.every((_, index) => ticked(group, index)) && <p className="small">✓ Every step in this tab is ticked — you have what it asks for.</p>}
    </div>
  );
  // "Check this step": what each panel promises, verified for real. The reachability
  // checks go through the daemon; the write test talks to the platform itself.
  const [checking, setChecking] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  useEffect(() => {
    setResult(null);
    setChecking(null);
  }, [step, activeId]);
  // Panel 1 promises the starter page is served — an index.html at the site address, even
  // before the content folder exists.
  const siteUrl = platform.buildSiteUrl ? platform.buildSiteUrl(values) : baseUrl;
  const stepsOf = (group: string): HostingStep[] =>
    group === 'account' ? platform.steps : group === 'access' ? guide.access : group === 'url' ? guide.url : guide.save;
  // "Next" stays disabled until every step of the current tab is ticked off (hover it to
  // see why); the step tabs at the top still let the reader jump ahead by hand.
  const currentGroup = PLATFORM_STEPS[step][0];
  const allChecked = currentGroup === 'review' || stepsOf(currentGroup).every((_, index) => ticked(currentGroup, index));
  const runCheck = async (kind: 'site' | 'access' | 'filled' | 'final') => {
    setChecking(kind);
    setResult(null);
    try {
      const cids = [draft.cid, ...jobItems.map((item) => item.cid)];
      const answer =
        kind === 'site'
          ? await checkIndex(siteUrl)
          : kind === 'access'
            ? await checkAccess(platform.id, values)
            : kind === 'filled'
              ? checkFilled(platform.fields, values, baseUrl, draft.cid)
              : (await checkSite(baseUrl)).ok
                ? await checkCids(baseUrl, cids)
                : await checkSite(baseUrl);
      setResult(answer);
    } finally {
      setChecking(null);
    }
  };
  /** The button every panel ends with, and the answer it printed — below it, green or red. */
  const checkRow = (kind: 'site' | 'access' | 'filled' | 'final', label = 'Check this step') => (
    <div className="form-stack" style={{ gap: 6 }}>
      <div className="row">
        <button className="primary small" disabled={checking !== null} onClick={() => void runCheck(kind)}>
          {checking === kind ? 'Checking…' : label}
        </button>
      </div>
      {result && <span className={`small ${result.ok ? 'check-ok' : 'check-bad'}`}>{result.message}</span>}
    </div>
  );
  /** Shown at the top of a panel whose own steps are all ticked off. */
  const completeBanner = (group: string) =>
    platform.steps.length > 0 &&
    (group === 'account' ? platform.steps : group === 'access' ? guide.access : group === 'url' ? guide.url : guide.save).every((_, index) =>
      ticked(group, index)
    ) ? (
      <div className="banner info small">This step appears to be complete — move on to the next step unless you want to change anything.</div>
    ) : null;

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
    // The same base URL is saved once: saving it again updates that entry in place.
    const key = baseKey(host.baseUrl);
    const existing = hosts.find((entry) => baseKey(entry.baseUrl) === key);
    commit(existing ? hosts.map((entry) => (entry.id === existing.id ? { ...host, id: entry.id, createdAt: entry.createdAt } : entry)) : [...hosts, host]);
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
      // The node's own list is asked first, so the same base URL is never offered twice.
      const who = await offerHost(providers, host);
      toast(who ? `Offered ${host.baseUrl} to ${who}` : `${host.baseUrl} was already offered — nothing to offer twice`, who ? 'success' : 'info');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
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
      if (result.ok) {
        // The job is now a URL job: created here by hand, hosted at this URL, nothing local.
        recordUrlJobs([
          {
            id: `j-${Math.random().toString(36).slice(2, 10)}`,
            cid,
            title: jobItems.find((entry) => entry.cid === cid)?.title,
            source: providers.find((node) => node.id === jobNode)?.name ?? 'your provider',
            hosts: [host.label],
            url: contentUrl(host.baseUrl, cid),
            at: new Date().toISOString(),
          },
        ]);
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setPushing(false);
    }
  };

  // The same fields and buttons in several places — under their own step, in the review
  // tab, and at the bottom of the page. One state backs them all, so every copy of a
  // field or a button is always in sync with the others.
  const baseUrlField = (
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
  );
  const nameField = (
    <label className="field">
      Name this host
      {/* Filled in with the hosting name already: skipping this step still leaves a name. */}
      <input type="text" value={draft.label || platform.name} placeholder={platform.name} onChange={(e) => update({ label: e.target.value })} />
    </label>
  );
  const saveOfferButton = (
    <div className="row">
      <button
        className="primary small"
        disabled={!/^https?:\/\//.test(baseUrl)}
        onClick={() => {
          const host = save();
          if (host) void offer(host);
        }}
      >
        <Save size={14} /> Save this host and offer it to your provider nodes
      </button>
      <span className="hint">Saves the host on this device and gives its base URL to every provider node you have.</span>
    </div>
  );
  const publishButton = (
    <div className="form-stack" style={{ gap: 6 }}>
      <div className="row">
        <button className="primary small" disabled={pushing || !draft.cid.trim()} onClick={() => void publishJob()}>
          <Upload size={14} /> Publish the job's content id to this host & save
        </button>
        <span className="hint">Downloads the content id from your providers and pushes it to the site with the access key.</span>
      </div>
      <span className="hint">It might take a few minutes for the content to become available.</span>
    </div>
  );
  const cidBlock = (
    <>
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
        {/* The provider picker and the button share one baseline. */}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
            className="primary small"
            disabled={!providers.length}
            onClick={async () => {
              const node = jobNode || providers[0]?.id;
              if (!node) return;
              try {
                const answer = await api<{ items: { cid: string; title?: string; source: string }[] }>(`/api/nodes/${node}/storage-jobs`);
                // A job's content id is only accepted when an algorithm search node knows it.
                const ids = (answer.items ?? []).map((item) => item.cid);
                const { known } = ids.length
                  ? await api<{ known: Record<string, boolean> }>('/api/lookup', { body: { ids } })
                  : { known: {} as Record<string, boolean> };
                const items = (answer.items ?? []).filter((item) => known[item.cid]);
                setJobItems(items);
                if (items.length) update({ cid: items[0].cid });
                // No jobs on that node is not a dead end: the default article's id is always
                // here — the fold that says so opens itself when a fetch finds nothing.
                else {
                  update({ cid: DUMMY_CID });
                  setNoJob(true);
                }
                toast(
                  items.length
                    ? `Found ${items.length} job content id${items.length === 1 ? '' : 's'} the search nodes know`
                    : answer.items?.length
                      ? 'That provider has open jobs, but no algorithm search node knows their content ids — none of them accepted'
                      : 'No jobs found on that provider — using the default article describing VibeShare instead',
                  items.length ? 'success' : 'info'
                );
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
          The provider's jobs name the content they want hosted — fetch one and its content id fills in above. "Publish" then pushes those
          bytes to this host with the access key and saves it.
        </span>
      </div>

      <details open={noJob} onToggle={(event) => setNoJob(event.currentTarget.open)}>
        <summary className="small" style={{ cursor: 'pointer' }}>
          No job handy?
        </summary>
        <div className="field" style={{ marginTop: 8 }}>
          <span className="hint">
            Use the default article describing VibeShare — its content id is stored in this app, so there is nothing to find:
          </span>
          <CodeBox text={DUMMY_CID} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="small" onClick={() => update({ cid: DUMMY_CID })}>
              Use this content id
            </button>
          </div>
        </div>
      </details>
    </>
  );
  // Nothing ticked under Settings → Nodes: say so instead of showing an empty tab row.
  if (!shown.length) {
    return (
      <div className="card form-stack">
        <div className="row">
          <Globe size={22} />
          <div>
            <h2>Provider jobs on free hosting</h2>
            <p className="instructions muted">
              No hosting platform is shown here yet — tick the ones to walk through under Settings → Nodes.
            </p>
          </div>
        </div>
        <a className="link small" href="/settings?tab=nodes">
          Open Settings → Nodes
        </a>
      </div>
    );
  }
  return (
    <>
      <div className="card form-stack">
        <div className="row">
          <Globe size={22} />
          <div>
            <h2>Provider jobs on free hosting</h2>
            <p className="instructions muted">
              Providers pay credits each time they download a copy of content from a link you offer — the bytes must hash to the content
              id exactly. Free static hosts give you a base URL; the tabs below walk through the account setup of each platform, build
              that base URL with you and push job data to the site, so the site serves <code>&lt;base&gt;/&lt;cid&gt;</code> and every
              content id is just the base URL with the id appended.
            </p>
          </div>
        </div>
      </div>

      <div className="tabs">
        {shown.map((entry) => (
          <button key={entry.id} className={`tab ${activeId === entry.id ? 'on' : ''}`} onClick={() => setPlatformId(entry.id)}>
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
            {completeBanner('account')}
            <p className="instructions muted">{platform.about}</p>
            <div className="row">
              <a className="link small" href={platform.signup} target="_blank" rel="noreferrer">
                Sign up <ExternalLink size={12} />
              </a>
              <a className="link small" href={platform.docs} target="_blank" rel="noreferrer">
                Docs <ExternalLink size={12} />
              </a>
              <button className="small" title="Forget which steps are ticked" onClick={() => update({ done: {} })}>
                Reset checks
              </button>
            </div>
            <p className="hint">
              One step at a time: read it, click or copy what it says, then tick the check at the end. When every check is ticked, the site is
              serving files and you can go to the next step of this panel.
            </p>
            {stepCards('account', platform.steps)}
            {checkRow('site')}
          </>
        )}

        {step === 1 && (
          <>
            {completeBanner('access')}
            <p className="hint">
              Copy what a step gives you and paste it into the field inside that same step: every answer this platform needs sits in one of the
              steps below — nothing to hunt for.
            </p>
            {stepCards('access', guide.access)}
            {leftoverFields.length > 0 && (
              <div className="form-grid">
                {leftoverFields.map((field) => (
                  <FieldInput
                    key={field.id}
                    field={field}
                    value={values[field.id] ?? ''}
                    onChange={(value) => update({ values: { ...values, [field.id]: value } })}
                  />
                ))}
              </div>
            )}
            {checkRow('access')}
          </>
        )}

        {step === 2 && (
          <>
            {completeBanner('url')}
            {stepCards('url', guide.url, (index) => (index === 0 ? baseUrlField : null))}
            {cidBlock}
            {checkRow('filled')}
          </>
        )}

        {step === 3 && (
          <>
            {completeBanner('save')}
            {stepCards('save', guide.save, (index) =>
              index === 0 ? (
                <>
                  {nameField}
                  {saveOfferButton}
                </>
              ) : (
                publishButton
              )
            )}
            <p className="instructions muted">
              Saving keeps the base URL and its access details on this device. Then offer it to your provider nodes — they query{' '}
              <code>&lt;base&gt;/&lt;cid&gt;</code> for any content id and pay per download from it. Pushing more content later lives in
              <em> the URL jobs card under Provider nodes</em>.
            </p>
            {checkRow('final')}
          </>
        )}

        {step === 4 && (
          <>
            <p className="hint">
              Everything this platform needs on one screen — the same fields and buttons as the tabs before, in one place.
            </p>
            <div className="form-stack">
              {guide.access
                .flatMap((instruction) => instruction.copies ?? [])
                .filter((copy) => copy.label !== 'Token name')
                .map((copy) => (
                  <div key={copy.label} className="field" style={{ marginBottom: 0 }}>
                    <span className="hint">{copy.label}</span>
                    <CodeBox text={substitute(copy.value, values)} />
                  </div>
                ))}
              {platform.fields.map((field, index) => (
                <Fragment key={field.id}>
                  {/* The access token's name sits right above the field its value goes in. */}
                  {tokenName && index === firstSecret && (
                    <div className="field" style={{ marginBottom: 0 }}>
                      <span className="hint">Access token name</span>
                      <CodeBox text={substitute(tokenName.value, values)} />
                    </div>
                  )}
                  <FieldInput
                    field={field}
                    value={values[field.id] ?? ''}
                    onChange={(value) => update({ values: { ...values, [field.id]: value } })}
                  />
                </Fragment>
              ))}
              <div className="field" style={{ marginBottom: 0 }}>
                <span className="hint">Site url</span>
                <CodeBox text={siteUrl} />
              </div>
              {baseUrlField}
              {cidBlock}
              {nameField}
              {saveOfferButton}
              {publishButton}
            </div>
            {checkRow('final', 'Check the file hosting status')}
          </>
        )}

        <div className="row">
          <button className="small" disabled={step === 0} onClick={() => setStep(Math.max(0, step - 1))}>
            ← Back
          </button>
          {step < PLATFORM_STEPS.length - 1 && (
            <button
              className="primary small"
              disabled={!allChecked}
              title={allChecked ? undefined : 'All steps must be checked to continue'}
              onClick={() => setStep(step + 1)}
            >
              Next →
            </button>
          )}
          <span className="hint">Access tokens stay on this device only.</span>
        </div>

      </div>

    </>
  );
}

