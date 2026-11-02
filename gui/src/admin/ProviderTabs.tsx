import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { CopyButton, Loading, Modal, StatusDot, Switch } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, adminBytes, adminUpload, message } from './api';
import { parseVvshNode, type VvshFile, type VvshNode } from '../../../src/shared/vvsh.js';
import { base64url } from '../../../src/shared/encoding.js';
import { assembleVvshWebm, normalizeVvshWebmChunk } from '../../../src/shared/vvsh-encode.js';
import { useToast } from './AdminApp';

interface ContentRow {
  cid: string;
  name: string;
  mime: string;
  size: number;
  title?: string;
  uploader: string;
  createdAt: string;
  downloads: number;
  bytesServed: number;
  creditsEarned: number;
  /** Platform links added from client suggestions (one cid can carry several). */
  sources?: string[];
  /** Content ids clients reported as duplicates of this one. */
  duplicates?: string[];
}

type UploadItem = { file: Blob; name: string };

/** Files picked in the file/folder picker (a folder's files come with their relative path). */
function fromInput(list: FileList | null): UploadItem[] {
  return [...(list ?? [])].map((file) => ({
    file,
    name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

/** Walks a dropped folder (or takes one dropped file) and collects every file inside. */
async function collectDropped(entry: FileSystemEntry, out: UploadItem[], prefix = ''): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, name: `${prefix}${file.name}` });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await collectDropped(child, out, `${prefix}${entry.name}/`);
    }
  }
}

function Content() {
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [pageStart, setPageStart] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<'import' | 'suggestions' | null>(null);
  const [importPath, setImportPath] = useState('');
  const [uploading, setUploading] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [toast, show] = useToast();

  // One page at a time (Newer/Older), or lazy: Load more appends the next page below.
  const load = useCallback(
    (offset: number, append: boolean) => {
      admin<{ items: ContentRow[] }>(`/v1/admin/content?offset=${offset}&limit=${pageSize}${search ? `&q=${encodeURIComponent(search)}` : ''}`)
        .then((r) => {
          setRows((current) => (append && current ? [...current, ...r.items] : r.items));
          setNextOffset(offset + r.items.length);
          setHasMore(r.items.length >= pageSize);
        })
        .catch((e) => show(message(e)));
    },
    [pageSize, search, show]
  );
  useEffect(() => {
    setPageStart(0);
    load(0, false);
  }, [load]);

  // Files and folders dropped in (or picked by) the import panel, uploaded one by one.
  const upload = async (items: UploadItem[]) => {
    if (!items.length) return;
    try {
      for (let i = 0; i < items.length; i++) {
        setUploading(`Uploading ${items[i].name} (${i + 1} of ${items.length})…`);
        await adminUpload('/v1/admin/content/upload', items[i].file, items[i].name);
      }
      show(`Added ${items.length} file${items.length === 1 ? '' : 's'}`);
      load(pageStart, false);
    } catch (e) {
      show(message(e));
    } finally {
      setUploading('');
    }
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    const items: UploadItem[] = [];
    const entries = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .filter((entry): entry is FileSystemEntry => Boolean(entry));
    if (entries.length) {
      for (const entry of entries) await collectDropped(entry, items);
    } else {
      items.push(...fromInput(event.dataTransfer.files));
    }
    await upload(items);
  };

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="row">
        <input
          type="search"
          value={search}
          placeholder="Search content by name, content id or uploader"
          style={{ flex: 1 }}
          onChange={(e) => {
            setSearch(e.target.value);
            setPageStart(0);
          }}
        />
        <div style={{ position: 'relative' }}>
          <button className="primary" onClick={() => setMenu((open) => !open)}>
            Add ▾
          </button>
          {menu && (
            <div
              className="card form-stack"
              style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, minWidth: 250, padding: 8, gap: 4 }}
              onMouseLeave={() => setMenu(false)}
            >
              <button
                className="small"
                onClick={() => {
                  setMenu(false);
                  setPanel('import');
                }}
              >
                Add a file from this machine
              </button>
              <button
                className="small"
                onClick={() => {
                  setMenu(false);
                  setPanel('suggestions');
                }}
              >
                Client suggestions
              </button>
            </div>
          )}
        </div>
      </div>
      {panel === 'import' && (
        <Modal title="Add a file from this machine" onClose={() => setPanel(null)}>
          <div className="form-stack">
            <p className="small muted">
              Path of a file on the computer running the node — or drop files and folders here. Anyone can also upload through a VibeShare
              client (Publish).
            </p>
            <div className="row">
              <input
                type="text"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                placeholder="/srv/media/video.mp4"
                style={{ flex: 1 }}
              />
              <button
                className="primary"
                disabled={!importPath.trim()}
                onClick={async () => {
                  try {
                    const result = await admin<{ cid: string }>('/v1/admin/content/import', { body: { path: importPath.trim() } });
                    show(`Added ${result.cid}`);
                    setImportPath('');
                    load(pageStart, false);
                  } catch (e) {
                    show(message(e));
                  }
                }}
              >
                Import
              </button>
            </div>
            <div
              className="card"
              style={{ textAlign: 'center', padding: 24, border: '1px dashed var(--border)' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void onDrop(e)}
            >
              <p className="small muted" style={{ margin: 0 }}>
                Drop files or folders here
              </p>
              <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
                <button onClick={() => fileInput.current?.click()}>Upload files</button>
                <button onClick={() => folderInput.current?.click()}>Upload folder</button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void upload(fromInput(e.target.files));
                  e.target.value = '';
                }}
              />
              <input
                ref={folderInput}
                type="file"
                hidden
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                onChange={(e) => {
                  void upload(fromInput(e.target.files));
                  e.target.value = '';
                }}
              />
            </div>
            {uploading && <div className="small muted">{uploading}</div>}
          </div>
        </Modal>
      )}
      {panel === 'suggestions' && (
        <Modal title="Client suggestions" onClose={() => setPanel(null)} wide>
          <Suggestions />
        </Modal>
      )}
      {!rows ? (
        <Loading />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Size</th>
                <th>Downloads</th>
                <th>Credits</th>
                <th>Uploader</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="small muted">
                    No content matches.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.cid}>
                  <td style={{ cursor: 'pointer' }} title="Open details" onClick={() => setDetails(row.cid)}>
                    <strong>{row.title ?? row.name}</strong>
                    <div className="tiny faint">
                      {row.mime} · {timeAgo(row.createdAt)}
                    </div>
                    <div className="mono tiny faint" title={row.cid}>
                      {row.cid.slice(-8)}
                    </div>
                    {(row.sources?.length ?? 0) + (row.duplicates?.length ?? 0) > 0 && (
                      <div className="tiny faint">
                        {row.sources?.length ? `${row.sources.length} suggested source${row.sources.length === 1 ? '' : 's'}` : ''}
                        {row.sources?.length && row.duplicates?.length ? ' · ' : ''}
                        {row.duplicates?.length ? `${row.duplicates.length} duplicate${row.duplicates.length === 1 ? '' : 's'}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="small">{formatBytes(row.size)}</td>
                  <td className="small">
                    {row.downloads}
                    <div className="tiny faint">{formatBytes(row.bytesServed)} served</div>
                  </td>
                  <td className="small">{row.creditsEarned}</td>
                  <td className="mono tiny">{row.uploader.slice(0, 14)}</td>
                  <td>
                    <div className="row">
                      <CopyButton text={row.cid} label="Id" />
                      <button
                        className="small danger"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${row.title ?? row.name} and its chunks from every backend?`)) return;
                          await admin(`/v1/admin/content/${row.cid}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                          load(pageStart, false);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <label className="field" style={{ marginBottom: 0, maxWidth: 120 }}>
          Per page
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {[25, 50, 100, 200, 500].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={pageStart === 0}
          onClick={() => {
            const start = Math.max(0, pageStart - pageSize);
            setPageStart(start);
            load(start, false);
          }}
        >
          Newer
        </button>
        <button
          disabled={!hasMore}
          onClick={() => {
            const start = pageStart + pageSize;
            setPageStart(start);
            load(start, false);
          }}
        >
          Older
        </button>
        <button disabled={!hasMore} onClick={() => load(nextOffset, true)}>
          Load more
        </button>
      </div>
      {details && <ContentDetails cid={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

interface ContentDetailsData {
  record: ContentRow & { chunks: number };
  manifest?: {
    name: string;
    mime: string;
    size: number;
    chunkSize: number;
    createdAt: string;
    meta?: Record<string, unknown>;
    sources?: string[];
    creator?: { id: string; name?: string; kind?: string };
    vvsh?: VvshFile;
  };
  chunks?: { id: string; size: number; backends: string[] }[];
  tier?: {
    cid: string;
    tier: string;
    label: string;
    assignedAt: string;
    expiresAt?: string;
    daysLeft?: number;
    manual?: boolean;
    plan: { media: Record<string, number>; externalUrls: number };
    backups: { urls: number; domains: string[]; satisfied: boolean; note?: string };
    upgrades: { id: string; label: string; price: number; lifecycleDays: number; downgradeTo: string | null }[];
  };
  jobs?: {
    id: string;
    title?: string;
    bytes: number;
    replicas: number;
    durationSeconds: number;
    status: string;
    createdAt: string;
    managed?: boolean;
    rewards: { upfront: number; perRetrieval: number; perChallenge: number; completion: number };
    holders: {
      id: string;
      accountId: string;
      status: string;
      acceptedAt: string;
      earned: number;
      links: { id: string; cid?: string; url?: string; baseUrl?: string; status: string }[];
    }[];
  }[];
  media?: { id: string; type: string; medium?: string }[];
  suggestions?: SuggestionRow[];
}

/** Everything the node knows about one content, shown when its row is clicked. */
function ContentDetails({ cid, onClose }: { cid: string; onClose: () => void }) {
  const [data, setData] = useState<ContentDetailsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showVvsh, setShowVvsh] = useState(false);
  const [tierPick, setTierPick] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [configTiers, setConfigTiers] = useState<{ id: string; label: string }[]>([]);
  const [jobTests, setJobTests] = useState<Record<string, string>>({});
  const [linkTests, setLinkTests] = useState<Record<string, string>>({});
  const [endpoint, setEndpoint] = useState('');
  const [endpointResult, setEndpointResult] = useState('');
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<ContentDetailsData>(`/v1/admin/content/${encodeURIComponent(cid)}`)
      .then((answer) => {
        setData(answer);
        setTierPick(answer.tier?.tier || answer.tier?.upgrades[0]?.id || '');
      })
      .catch((e) => setError(message(e)));
    admin<{ config: { tiers: { id: string; label: string }[] } }>('/v1/admin/tiers')
      .then((answer) => setConfigTiers(answer.config.tiers ?? []))
      .catch(() => undefined);
  }, [cid]);
  useEffect(load, [load]);
  const meta = (data?.manifest?.meta ?? {}) as { title?: string; description?: string; tags?: string[]; topics?: string[]; format?: string; rating?: string; durationSeconds?: number };
  const sources = [...new Set([...(data?.manifest?.sources ?? []), ...(data?.record.sources ?? [])])];
  const tier = data?.tier;
  // The picker always has something to offer: the content's upgrade menu, or the node's
  // configured tiers — so a tier can be set even for content not on one yet.
  const tierOptions: { id: string; label: string }[] =
    tier?.upgrades?.length ? tier.upgrades : configTiers.length ? configTiers : [{ id: 'default', label: 'default' }];
  return (
    <Modal title="Content details" onClose={onClose} wide>
      {error ? (
        <div className="banner danger small">{error}</div>
      ) : !data ? (
        <Loading />
      ) : (
        <div className="form-stack" style={{ paddingBottom: 28 }}>
          {toast && <div className="banner info small">{toast}</div>}
          <div>
            <h3>{data.record.title ?? meta.title ?? data.record.name}</h3>
            <div className="mono tiny faint">{data.record.cid}</div>
          </div>
          <dl className="kv">
            <dt>File</dt>
            <dd>
              {data.record.name} · {data.record.mime} · {formatBytes(data.record.size)}
            </dd>
            <dt>Chunks</dt>
            <dd>
              {data.manifest?.vvsh ? (
                <>
                  {data.manifest.vvsh.meta.chunkCount} chunks × {data.manifest.vvsh.meta.bitrates.length} encodings, each stored as its own object under
                  the tree root — the .vvsh file is metadata and the root, so it lists no byte chunks.{' '}
                  <button className="small" onClick={() => setShowVvsh(true)}>
                    View .vvsh
                  </button>
                </>
              ) : (
                <>
                  {data.record.chunks} × {formatBytes(data.manifest?.chunkSize ?? 0)} on{' '}
                  {[...new Set((data.chunks ?? []).flatMap((chunk) => chunk.backends))].join(', ') || 'no backend'}
                </>
              )}
            </dd>
            <dt>Uploader</dt>
            <dd className="mono tiny">{data.record.uploader}</dd>
            <dt>Added</dt>
            <dd>
              {new Date(data.record.createdAt).toLocaleString()} <span className="faint">({timeAgo(data.record.createdAt)})</span>
            </dd>
            <dt>Downloads</dt>
            <dd>
              {data.record.downloads} ({formatBytes(data.record.bytesServed)} served, {data.record.creditsEarned} credits earned)
            </dd>
            {data.manifest?.creator && (
              <>
                <dt>Creator</dt>
                <dd>
                  {data.manifest.creator.name ?? data.manifest.creator.id}
                  {data.manifest.creator.name ? <span className="mono tiny faint"> · {data.manifest.creator.id}</span> : null}
                </dd>
              </>
            )}
            <dt>Sources</dt>
            <dd>{sources.length ? sources.join(' · ') : 'None'}</dd>
            <dt>Duplicates</dt>
            <dd>
              <textarea
                readOnly
                rows={3}
                className="mono tiny"
                style={{ width: '100%', resize: 'vertical' }}
                value={(data.record.duplicates ?? []).join('\n')}
                placeholder="None reported"
              />
            </dd>
          </dl>
          {meta.description && <p className="small">{meta.description}</p>}
          {showVvsh && data.manifest?.vvsh && <VvshModal vvsh={data.manifest.vvsh} onClose={() => setShowVvsh(false)} />}
          <div className="row">
            <button
              className="small"
              onClick={async () => {
                try {
                  const result = await admin<{ fetched: number; missing: number }>('/v1/admin/peers/fetch', { body: { cid: data.record.cid } });
                  show(`Pulled ${result.fetched} missing chunk${result.fetched === 1 ? '' : 's'} from peers${result.missing ? ` (${result.missing} still missing)` : ''}`);
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Fetch missing chunks from peers
            </button>
            <button
              className="small"
              onClick={async () => {
                try {
                  const result = await admin<{ results: { peer: string; sent: number; error?: string }[] }>('/v1/admin/peers/push', {
                    body: { cid: data.record.cid },
                  });
                  show(result.results.map((r) => `${r.peer.slice(0, 24)}: ${r.sent} sent${r.error ? ` (${r.error})` : ''}`).join(' · ') || 'No peer sent to');
                } catch (e) {
                  show(message(e));
                }
              }}
            >
              Send content to peers
            </button>
          </div>
          <div>
            <h3>Storage tier</h3>
            {tier && tier.tier ? (
              <>
                <div className="small" style={{ marginTop: 6 }}>
                  <strong>{tier.label}</strong>
                  <div className="muted">
                    {[
                      ...Object.entries(tier.plan.media)
                        .filter(([, count]) => count > 0)
                        .map(([medium, count]) => `${count}× ${medium}`),
                      ...(tier.plan.externalUrls > 0 ? [`${tier.plan.externalUrls} URL backups`] : []),
                    ].join(' · ') || 'no copies planned'}
                  </div>
                </div>
                <div className="small muted">
                  Lifecycle: {tier.expiresAt ? `${new Date(tier.expiresAt).toLocaleString()} (${timeAgo(tier.expiresAt)})` : 'no expiry'}
                  {tier.daysLeft !== undefined ? ` · ${tier.daysLeft} day${tier.daysLeft === 1 ? '' : 's'} left` : ''}
                </div>
                <div className="small muted">
                  URL backups: {tier.backups.urls} on {tier.backups.domains.length} domain
                  {tier.backups.domains.length === 1 ? '' : 's'} {tier.backups.satisfied ? '· satisfied' : '· still wanted'}
                  {tier.backups.note ? ` — ${tier.backups.note}` : ''}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="field" style={{ marginBottom: 0, maxWidth: 170 }}>
                    Tier
                    <select value={tierPick} onChange={(e) => setTierPick(e.target.value)}>
                      {tierOptions.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="small"
                    disabled={!tierPick}
                    onClick={async () => {
                      await admin(`/v1/admin/tiers/${encodeURIComponent(cid)}`, { body: { tier: tierPick } }).catch((e) => show(message(e)));
                      load();
                    }}
                  >
                    {tier.tier ? 'Set tier' : 'Add to tier'}
                  </button>
                  <label className="field" style={{ marginBottom: 0, maxWidth: 120 }}>
                    Extend (days)
                    <input type="number" min={0} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
                  </label>
                  <button
                    className="small"
                    disabled={!(Number(extendDays) > 0)}
                    onClick={async () => {
                      await admin(`/v1/admin/tiers/${encodeURIComponent(cid)}`, { body: { extendDays: Number(extendDays) } }).catch((e) =>
                        show(message(e))
                      );
                      load();
                    }}
                  >
                    Extend lifecycle
                  </button>
                  <button
                    className="small danger"
                    onClick={async () => {
                      if (!window.confirm('Delete this content and its tier assignment?')) return;
                      await admin(`/v1/admin/tiers/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                      load();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                <p className="small muted" style={{ width: '100%', margin: 0 }}>
                  This content is not on any tier yet — pick one and add it. The tier's plan decides the copies to keep and the content's
                  storage job.
                </p>
                <label className="field" style={{ marginBottom: 0, maxWidth: 170 }}>
                  Tier
                  <select value={tierPick} onChange={(e) => setTierPick(e.target.value)}>
                    {tierOptions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="small"
                  disabled={!tierPick}
                  onClick={async () => {
                    await admin(`/v1/admin/tiers/${encodeURIComponent(cid)}`, { body: { tier: tierPick } }).catch((e) => show(message(e)));
                    load();
                  }}
                >
                  Add to tier
                </button>
              </div>
            )}
          </div>
          <div>
            <h3>Storage media</h3>
            {(data.media ?? []).length === 0 ? (
              <p className="small muted" style={{ marginTop: 6 }}>
                No local bytes — downloads come from URL backups, holders or peers.
              </p>
            ) : (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {(data.media ?? []).map((entry) => (
                  <span key={entry.id} className="badge">
                    {entry.medium ? `${entry.medium} · ` : ''}
                    {entry.id} ({entry.type})
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3>Storage jobs</h3>
            <p className="small muted" style={{ marginTop: 6 }}>
              A storage job offers client nodes credits to keep copies of this content for its term. <strong>Retrieval</strong>: when a
              download needs a chunk this node does not have, a holder is asked for it and paid the per-retrieval reward — the bytes must
              hash to the chunk id exactly. <strong>Challenge</strong>: every so often a holder must prove it still keeps its copy (its own
              chunk bytes behind a random nonce) and is paid per passed challenge. Upfront pay follows the first pass and completion pay
              the end of the term; a holder that fails a retrieval or challenge is out of the job and the data is pulled from the other
              holders or their URLs. <strong>Test job</strong> runs one real retrieval against a holder and pays its account the reward.
            </p>
            {(data.jobs ?? []).length === 0 ? (
              <p className="small muted" style={{ marginTop: 6 }}>
                No storage jobs for this content yet.
              </p>
            ) : (
              (data.jobs ?? []).map((job) => (
                <div key={job.id} style={{ marginTop: 8 }}>
                  <div className="small">
                    <strong>{job.title ?? job.id.slice(0, 12) + '…'}</strong>
                    {job.managed ? <span className="badge ok" style={{ marginLeft: 8 }}>automatic</span> : null}
                    <div className="muted">
                      {formatBytes(job.bytes)} · {job.replicas} cop{job.replicas === 1 ? 'y' : 'ies'} · {Math.round(job.durationSeconds / 86400)} days ·{' '}
                      {job.status}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 4 }}>
                    <button
                      className="small"
                      title="Ask a holder for a real chunk and pay its account the reward when the bytes match"
                      onClick={async () => {
                        setJobTests((m) => ({ ...m, [job.id]: 'Testing…' }));
                        try {
                          const result = await admin<{ test: { ok: boolean; account?: string; chunkId: string; credited: number; error?: string } }>(
                            `/v1/admin/storage/jobs/${job.id}/test`,
                            { method: 'POST', body: {} }
                          );
                          const t = result.test;
                          setJobTests((m) => ({
                            ...m,
                            [job.id]: t.ok
                              ? `✓ holder ${t.account?.slice(0, 16)}… answered chunk ${t.chunkId.slice(0, 12)}… — paid ${t.credited} credits`
                              : `✗ ${t.error ?? 'no answer'}`,
                          }));
                        } catch (e) {
                          setJobTests((m) => ({ ...m, [job.id]: `✗ ${message(e)}` }));
                        }
                      }}
                    >
                      Test job
                    </button>
                    <button
                      className="small danger"
                      onClick={async () => {
                        if (!window.confirm('Delete this storage job and every assignment under it?')) return;
                        await admin(`/v1/admin/storage/jobs/${job.id}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                        load();
                      }}
                    >
                      Delete job
                    </button>
                  </div>
                  <div className="tiny faint">
                    {job.rewards.upfront} upfront · {job.rewards.perRetrieval}/retrieval · {job.rewards.perChallenge}/challenge ·{' '}
                    {job.rewards.completion} at completion · opened {timeAgo(job.createdAt)}
                  </div>
                  {jobTests[job.id] ? <div className="tiny" style={{ marginTop: 4 }}>{jobTests[job.id]}</div> : null}
                  {job.holders.length === 0 ? (
                    <div className="tiny faint" style={{ marginTop: 4 }}>
                      No client accepted this job yet.
                    </div>
                  ) : (
                    job.holders.map((holder) => (
                      <div key={holder.id} style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                        <div className="small">
                          <span className="mono tiny">{holder.accountId}</span>{' '}
                          <span className={`badge ${holder.status === 'active' ? 'ok' : holder.status === 'failed' ? 'danger' : ''}`}>{holder.status}</span>{' '}
                          <span className="tiny faint">
                            accepted {timeAgo(holder.acceptedAt)} · {holder.earned} credits earned
                          </span>
                        </div>
                        {holder.links.length === 0 ? (
                          <div className="tiny faint">No URLs or base URLs offered by this account.</div>
                        ) : (
                          holder.links.map((link) => (
                            <div key={link.id} className="tiny">
                              <span className={`badge ${link.status === 'accepted' ? 'ok' : link.status === 'rejected' ? 'danger' : ''}`}>{link.status}</span>{' '}
                              <span className="mono">{link.baseUrl ? `${link.baseUrl} (base URL)` : link.url}</span>
                              {link.cid ? <span className="faint"> · {link.cid.slice(0, 14)}…</span> : null}{' '}
                              <button
                                className="small"
                                onClick={async () => {
                                  const target = link.baseUrl ? `${link.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(cid)}` : link.url ?? '';
                                  setLinkTests((m) => ({ ...m, [link.id]: 'Checking…' }));
                                  try {
                                    const result = await admin<{ verify: { ok: boolean; url: string; bytes: number; error?: string } }>(
                                      `/v1/admin/content/${encodeURIComponent(cid)}/verify`,
                                      { method: 'POST', body: { url: target } }
                                    );
                                    setLinkTests((m) => ({
                                      ...m,
                                      [link.id]: result.verify.ok
                                        ? `✓ ${result.verify.url} serves ${formatBytes(result.verify.bytes)} matching the expected hash`
                                        : `✗ ${result.verify.url} — ${result.verify.error ?? 'does not match'}`,
                                    }));
                                  } catch (e) {
                                    setLinkTests((m) => ({ ...m, [link.id]: `✗ ${message(e)}` }));
                                  }
                                }}
                              >
                                Test
                              </button>
                              {linkTests[link.id] ? <div className="tiny faint">{linkTests[link.id]}</div> : null}
                            </div>
                          ))
                        )}
                      </div>
                    ))
                  )}
                </div>
              ))
            )}
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <input
                type="text"
                className="mono"
                style={{ flex: 1 }}
                placeholder="Check any endpoint for this content (https://host/… or a base URL)"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
              <button
                className="small"
                disabled={!endpoint.trim()}
                onClick={async () => {
                  setEndpointResult('Checking…');
                  try {
                    const result = await admin<{ verify: { ok: boolean; url: string; bytes: number; error?: string } }>(
                      `/v1/admin/content/${encodeURIComponent(cid)}/verify`,
                      { method: 'POST', body: { url: endpoint.trim() } }
                    );
                    setEndpointResult(
                      result.verify.ok
                        ? `✓ ${result.verify.url} is available and serves ${formatBytes(result.verify.bytes)} matching the expected hash`
                        : `✗ ${result.verify.url} — ${result.verify.error ?? 'does not match the expected hash'}`
                    );
                  } catch (e) {
                    setEndpointResult(`✗ ${message(e)}`);
                  }
                }}
              >
                Check endpoint
              </button>
            </div>
            {endpointResult ? <div className="tiny" style={{ marginTop: 4 }}>{endpointResult}</div> : null}
          </div>
          {data.suggestions && data.suggestions.length > 0 && (
            <div>
              <h3>Client suggestions</h3>
              {data.suggestions.map((suggestion) => (
                <div key={suggestion.id} className="small" style={{ marginTop: 6 }}>
                  <span className="badge">{suggestion.status}</span>{' '}
                  <strong>{suggestion.kind}</strong>{' '}
                  {suggestion.sources?.map((source) => `${source.platform}: ${source.url}`).join(', ') ?? suggestion.duplicateOf ?? suggestion.note ?? ''}
                  <div className="tiny faint">{timeAgo(suggestion.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

interface SuggestionRow {
  id: string;
  contentId: string;
  title?: string;
  kind: 'source' | 'duplicate' | 'missing';
  sources?: { platform: string; url: string }[];
  duplicateOf?: string;
  note?: string;
  status: string;
  createdAt: string;
}

/** What clients suggest this node is missing: sources, duplicates, absent data. */
function Suggestions() {
  const [rows, setRows] = useState<SuggestionRow[] | null>(null);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ suggestions: SuggestionRow[] }>('/v1/admin/suggestions')
      .then((r) => setRows(r.suggestions))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  return (
    <div className="card form-stack">
      <h3>Client suggestions</h3>
      <p className="small muted">
        What clients say this node is missing: links to the content on other platforms (one content id can carry several sources), other
        content ids it duplicates (helps dedupe and compression), or content data that is not here at all. Accepting merges the sources and
        duplicate ids into the content.
      </p>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="small faint">Nothing pending.</p>
      ) : (
        <table className="table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="small">
                  <strong>
                    {row.kind}: {row.title ?? row.contentId.slice(0, 24)}
                  </strong>
                  <div className="mono tiny faint">{row.contentId.slice(0, 40)}</div>
                  <div className="small">
                    {row.sources?.map((source) => (
                      <div key={source.url}>
                        {source.platform}: {source.url}
                      </div>
                    ))}
                    {row.duplicateOf && <div>duplicate of {row.duplicateOf}</div>}
                    {row.note && <div className="muted">{row.note}</div>}
                  </div>
                </td>
                <td className="tiny faint">{timeAgo(row.createdAt)}</td>
                <td>
                  <div className="row">
                    <button
                      className="small primary"
                      onClick={async () => {
                        await admin(`/v1/admin/suggestions/${row.id}/accept`, { body: {} }).catch((e) => show(message(e)));
                        load();
                      }}
                    >
                      Accept
                    </button>
                    <button
                      className="small"
                      onClick={async () => {
                        await admin(`/v1/admin/suggestions/${row.id}/reject`, { body: {} }).catch((e) => show(message(e)));
                        load();
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}

interface Backend {
  id: string;
  type: string;
  writable: boolean;
  priority: number;
  status: { ok: boolean; detail: string };
}

function Storage() {
  const [backends, setBackends] = useState<Backend[] | null>(null);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ backends: Backend[] }>('/v1/admin/storage/backends')
      .then((r) => setBackends(r.backends))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card">
        <h3>Storage backends</h3>
        <p className="small muted" style={{ marginBottom: 10 }}>
          Where chunks are kept, tried in priority order. Add S3-compatible buckets, WebDAV, IPFS, mirrors or other providers under Settings →
          storage.backends.
        </p>
        {!backends ? (
          <Loading />
        ) : (
          <table className="table">
            <tbody>
              {backends.map((backend) => (
                <tr key={backend.id}>
                  <td>
                    <StatusDot online={backend.status.ok} /> <strong>{backend.id}</strong>
                  </td>
                  <td className="small">{backend.type}</td>
                  <td className="small">priority {backend.priority}</td>
                  <td className="small">{backend.writable ? 'read/write' : 'read only'}</td>
                  <td className="small muted">{backend.status.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface PeerRow {
  ref: string;
  send: boolean;
  receive: boolean;
}

/** Automatic syncing of content bytes with peers: how often, and the share/receive rates. */
function SyncJob() {
  const [sync, setSync] = useState<{ enabled: boolean; intervalMs: number; sendRatePerMin: number; receiveRatePerMin: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [toast, show] = useToast();
  type Sync = { enabled: boolean; intervalMs: number; sendRatePerMin: number; receiveRatePerMin: number };
  const load = useCallback(() => {
    admin<{ sync: Sync }>('/v1/admin/peers')
      .then((r) => setSync(r.sync))
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (next: Sync) => {
    setSync(next);
    try {
      await admin('/v1/admin/peers/sync/config', { method: 'POST', body: next });
    } catch (e) {
      show(message(e));
      load();
    }
  };

  if (!sync) return <Loading />;
  return (
    <div className="card form-stack">
      <h3>Automatic content sync</h3>
      <p className="small muted">
        Periodically sync content bytes with peers: share chunks they are missing and pull chunks this node is missing. Set how often it runs
        and the most chunks shared and received per minute.
      </p>
      <Switch checked={sync.enabled} onChange={(enabled) => void save({ ...sync, enabled })} label="Run automatically" />
      <div className="form-grid">
        <label className="field">
          How often (minutes)
          <input type="number" min={1} defaultValue={Math.round(sync.intervalMs / 60000)} onBlur={(e) => void save({ ...sync, intervalMs: Math.round(Number(e.target.value) * 60000) })} />
        </label>
        <label className="field">
          Share rate (chunks/min)
          <input type="number" min={0} defaultValue={sync.sendRatePerMin} onBlur={(e) => void save({ ...sync, sendRatePerMin: Number(e.target.value) })} />
        </label>
        <label className="field">
          Receive rate (chunks/min)
          <input type="number" min={0} defaultValue={sync.receiveRatePerMin} onBlur={(e) => void save({ ...sync, receiveRatePerMin: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row">
        <button
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              const r = await admin<{ sent: number; received: number }>('/v1/admin/peers/sync', { method: 'POST', body: {} });
              show(`Synced: shared ${r.sent}, received ${r.received}`);
            } catch (e) {
              show(message(e));
            }
            setRunning(false);
          }}
        >
          {running ? 'Syncing…' : 'Run sync now'}
        </button>
        <span className="hint">It also runs on its own when enabled.</span>
      </div>
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}

/** Other content providers this node exchanges content bytes (chunks) with. */
function Peering() {
  const [peers, setPeers] = useState<PeerRow[] | null>(null);
  const [acceptPush, setAcceptPush] = useState(true);
  const [ref, setRef] = useState('');
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ peers: PeerRow[]; acceptPush: boolean }>('/v1/admin/peers')
      .then((r) => {
        setPeers(r.peers);
        setAcceptPush(r.acceptPush);
      })
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (next: PeerRow[], push = acceptPush) => {
    setPeers(next);
    setAcceptPush(push);
    try {
      await admin('/v1/admin/peers', { method: 'PUT', body: { peers: next, acceptPush: push } });
    } catch (e) {
      show(message(e));
      load();
    }
  };

  return (
    <div className="card form-stack">
      <h3>Peering with other providers</h3>
      <p className="small muted">
        Peer content providers exchange content bytes: every chunk is addressed by the hash of its bytes, so a peer can fetch what it is
        missing and send what the others lack. <strong>Send</strong> lets this node serve and push chunks to the peer; <strong>Receive</strong>{' '}
        lets it fetch missing chunks from the peer and accept the peer's pushes.
      </p>
      {!peers ? (
        <Loading />
      ) : (
        <>
          {peers.map((peer, index) => (
            <div key={peer.ref} className="row between small">
              <code className="tiny">{peer.ref.length > 60 ? peer.ref.slice(0, 60) + '…' : peer.ref}</code>
              <div className="row" style={{ gap: 10 }}>
                <label className="row small" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={peer.send}
                    onChange={(e) => void save(peers.map((p, i) => (i === index ? { ...p, send: e.target.checked } : p)))}
                  />
                  Send
                </label>
                <label className="row small" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={peer.receive}
                    onChange={(e) => void save(peers.map((p, i) => (i === index ? { ...p, receive: e.target.checked } : p)))}
                  />
                  Receive
                </label>
                <button className="small danger" onClick={() => void save(peers.filter((_, i) => i !== index))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="row">
            <input
              type="text"
              className="mono"
              placeholder="vs:provider:vk1…@https://other.example.org"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              disabled={!ref.trim()}
              onClick={async () => {
                await save([...peers, { ref: ref.trim(), send: true, receive: true }]);
                setRef('');
              }}
            >
              Add peer
            </button>
          </div>
          <Switch checked={acceptPush} onChange={(push) => void save(peers, push)} label="Accept chunks peers push to this node" />
        </>
      )}
      {toast && <div className="banner info small">{toast}</div>}
    </div>
  );
}

interface TierRow {
  id: string;
  label: string;
  media: Record<string, number>;
  externalUrls: number;
  pricePerMiB: number;
  lifecycleDays: number;
  downgradeTo: string | null;
}
interface TiersConfigRow {
  enabled: boolean;
  auto: boolean;
  defaultTier: string;
  media: { id: string; label: string; backends: string[] }[];
  tiers: TierRow[];
}
interface TierAssignmentRow {
  cid: string;
  title?: string;
  tier: string;
  bytes: number;
  expiresAt?: string;
  manual?: boolean;
}

/** Content storage tiers: the copy plans, their lifecycles, and every content's assignment. */
function Tiers() {
  const [config, setConfig] = useState<TiersConfigRow | null>(null);
  const [assignments, setAssignments] = useState<TierAssignmentRow[]>([]);
  const [backends, setBackends] = useState<string[]>([]);
  const [toast, show] = useToast();

  const load = useCallback(() => {
    admin<{ config: TiersConfigRow; assignments: TierAssignmentRow[]; backends: string[] }>('/v1/admin/tiers')
      .then((r) => {
        setConfig(r.config);
        setAssignments(r.assignments);
        setBackends(r.backends);
      })
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  const save = async (next: TiersConfigRow) => {
    setConfig(next);
    try {
      await admin('/v1/admin/config', { method: 'PUT', body: { tiers: next } });
    } catch (e) {
      show(message(e));
    }
  };

  if (!config) return <Loading />;

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Storage tiers</h3>
        <p className="small muted">
          Every upload is assigned the default tier — its plan says how many copies sit on which medium and how many external user URL
          backups it wants. Users pay credits to raise a content's tier or extend its lifecycle; expired assignments downgrade along
          their chain or are forgotten.
        </p>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={config.enabled} onChange={(e) => void save({ ...config, enabled: e.target.checked })} />
            Use storage tiers
          </label>
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={config.auto} onChange={(e) => void save({ ...config, auto: e.target.checked })} />
            Assign tiers automatically
          </label>
          <label className="field" style={{ marginBottom: 0, maxWidth: 180 }}>
            Default tier
            <select value={config.defaultTier} onChange={(e) => void save({ ...config, defaultTier: e.target.value })}>
              {config.tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="small"
            title="Restores the bronze/silver/gold plan with its media"
            onClick={() =>
              void save({
                ...config,
                enabled: true,
                auto: true,
                defaultTier: 'bronze',
                media: [
                  { id: 'hdd', label: 'HDD', backends: [] },
                  { id: 'ssd', label: 'SSD', backends: [] },
                ],
                tiers: [
                  { id: 'bronze', label: 'Bronze', media: {}, externalUrls: 2, pricePerMiB: 0, lifecycleDays: 90, downgradeTo: null },
                  { id: 'silver', label: 'Silver', media: { hdd: 1 }, externalUrls: 2, pricePerMiB: 1, lifecycleDays: 180, downgradeTo: 'bronze' },
                  { id: 'gold', label: 'Gold', media: { hdd: 1, ssd: 1 }, externalUrls: 3, pricePerMiB: 3, lifecycleDays: 365, downgradeTo: 'silver' },
                ],
              })
            }
          >
            Reset to defaults
          </button>
        </div>
        <div>
          <h4>Storage media</h4>
          <p className="small muted">
            The medium names a tier counts copies on; backends ({backends.join(', ') || 'none'}) whose bytes count as that medium, empty
            for the node's defaults.
          </p>
          {config.media.map((medium, index) => (
            <div className="row" key={index} style={{ gap: 8 }}>
              <input
                type="text"
                value={medium.label}
                placeholder="Label"
                style={{ maxWidth: 130 }}
                onChange={(e) => void save({ ...config, media: config.media.map((m, i) => (i === index ? { ...m, label: e.target.value } : m)) })}
              />
              <input
                type="text"
                className="mono"
                value={medium.backends.join(', ')}
                placeholder="backend ids (comma separated)"
                style={{ flex: 1 }}
                onChange={(e) =>
                  void save({
                    ...config,
                    media: config.media.map((m, i) =>
                      i === index ? { ...m, backends: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : m
                    ),
                  })
                }
              />
              <button
                className="small danger"
                onClick={() => void save({ ...config, media: config.media.filter((_, i) => i !== index), tiers: config.tiers.map((t) => ({ ...t, media: Object.fromEntries(Object.entries(t.media).filter(([id]) => id !== medium.id)) })) })}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="small"
            onClick={() =>
              void save({ ...config, media: [...config.media, { id: `medium${config.media.length + 1}`, label: `Medium ${config.media.length + 1}`, backends: [] }] })
            }
          >
            + Add medium
          </button>
        </div>
      </div>

      <div className="card form-stack">
        <h3>Tiers</h3>
        {config.tiers.map((tier, index) => (
          <div key={tier.id} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              value={tier.label}
              style={{ maxWidth: 120 }}
              onChange={(e) => void save({ ...config, tiers: config.tiers.map((t, i) => (i === index ? { ...t, label: e.target.value } : t)) })}
            />
            {config.media.map((medium) => (
              <label key={medium.id} className="row tiny" style={{ gap: 4 }}>
                {medium.label}
                <input
                  type="number"
                  min={0}
                  value={tier.media[medium.id] ?? 0}
                  style={{ width: 52 }}
                  onChange={(e) =>
                    void save({
                      ...config,
                      tiers: config.tiers.map((t, i) =>
                        i === index ? { ...t, media: { ...t.media, [medium.id]: Math.max(0, Number(e.target.value) || 0) } } : t
                      ),
                    })
                  }
                />
              </label>
            ))}
            <label className="row tiny" style={{ gap: 4 }}>
              URL backups
              <input
                type="number"
                min={0}
                value={tier.externalUrls}
                style={{ width: 52 }}
                onChange={(e) => void save({ ...config, tiers: config.tiers.map((t, i) => (i === index ? { ...t, externalUrls: Math.max(0, Number(e.target.value) || 0) } : t)) })}
              />
            </label>
            <label className="row tiny" style={{ gap: 4 }}>
              Credits/MiB
              <input
                type="number"
                min={0}
                value={tier.pricePerMiB}
                style={{ width: 60 }}
                onChange={(e) => void save({ ...config, tiers: config.tiers.map((t, i) => (i === index ? { ...t, pricePerMiB: Math.max(0, Number(e.target.value) || 0) } : t)) })}
              />
            </label>
            <label className="row tiny" style={{ gap: 4 }}>
              Lifecycle (days)
              <input
                type="number"
                min={0}
                value={tier.lifecycleDays}
                style={{ width: 60 }}
                onChange={(e) => void save({ ...config, tiers: config.tiers.map((t, i) => (i === index ? { ...t, lifecycleDays: Math.max(0, Number(e.target.value) || 0) } : t)) })}
              />
            </label>
            <label className="row tiny" style={{ gap: 4 }}>
              Expires to
              <select
                value={tier.downgradeTo ?? ''}
                onChange={(e) => void save({ ...config, tiers: config.tiers.map((t, i) => (i === index ? { ...t, downgradeTo: e.target.value || null } : t)) })}
              >
                <option value="">forgotten</option>
                {config.tiers
                  .filter((other) => other.id !== tier.id)
                  .map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.label}
                    </option>
                  ))}
              </select>
            </label>
            <button className="small danger" onClick={() => void save({ ...config, tiers: config.tiers.filter((_, i) => i !== index) })}>
              Remove
            </button>
          </div>
        ))}
        <button
          className="small"
          onClick={() =>
            void save({
              ...config,
              tiers: [
                ...config.tiers,
                {
                  id: `tier${config.tiers.length + 1}`,
                  label: `Tier ${config.tiers.length + 1}`,
                  media: {},
                  externalUrls: 1,
                  pricePerMiB: 1,
                  lifecycleDays: 90,
                  downgradeTo: config.defaultTier,
                },
              ],
            })
          }
        >
          + Add tier
        </button>
      </div>

      <div className="card form-stack">
        <h3>Assignments</h3>
        {assignments.length === 0 ? (
          <p className="small muted">No content assigned yet — every upload lands in the default tier automatically.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Size</th>
                <th>Tier</th>
                <th>Lifecycle ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={assignment.cid}>
                  <td className="small">
                    {assignment.title ?? assignment.cid.slice(0, 18) + '…'}
                    {assignment.manual && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        manual
                      </span>
                    )}
                  </td>
                  <td className="small">{formatBytes(assignment.bytes)}</td>
                  <td>
                    <select
                      value={assignment.tier}
                      onChange={async (e) => {
                        await admin(`/v1/admin/tiers/${encodeURIComponent(assignment.cid)}`, { body: { tier: e.target.value } }).catch((err) =>
                          show(message(err))
                        );
                        load();
                      }}
                    >
                      {config.tiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="small">{assignment.expiresAt ? new Date(assignment.expiresAt).toLocaleDateString() : 'never'}</td>
                  <td>
                    <button
                      className="small danger"
                      onClick={async () => {
                        await admin(`/v1/admin/tiers/${encodeURIComponent(assignment.cid)}`, { method: 'DELETE' }).catch((err) => show(message(err)));
                        load();
                      }}
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function ProviderTabs({ tab }: { tab: string }) {

  if (tab === 'content') return <Content />;
  if (tab === 'storage')
    return (
      <>
        <Storage />
        <Peering />
        <SyncJob />
      </>
    );
  if (tab === 'tiers') return <Tiers />;
  return null;
}

interface VvshChunkRow {
  index: number;
  node: string;
  path: string[];
  renditions: { id: string; hash: string; size: number; frames: { i: number; p: number; b: number } }[];
}

/** One .vvsh stream in full: its metadata, every chunk, and the merkle tree over them. */
function VvshModal({ vvsh, onClose }: { vvsh: VvshFile; onClose: () => void }) {
  const meta = vvsh.meta;
  const [chunkPlay, setChunkPlay] = useState<{ url: string; label: string; start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Plays one chunk's own bytes as a video — that block and nothing else. */
  const playChunk = async (index: number, renditionId: string) => {
    try {
      setError(null);
      const leaf = cursorNode?.kind === 'chunk' ? cursorNode.renditions.find((entry) => entry.id === renditionId) : undefined;
      if (!leaf) return;
      const start = index * meta.chunkSeconds;
      const end = Math.min(meta.totalSeconds, start + meta.chunkSeconds);
      if (meta.codec === 'vvsh-webm/1') {
        // A segmented block stands alone: its init part and the block itself.
        const rendition = meta.bitrates.find((entry) => entry.id === renditionId);
        const init = rendition?.initHash
          ? await adminBytes(`/v1/vvsh/objects/${encodeURIComponent(rendition.initHash)}`)
          : new Uint8Array(0);
        const storedPayload = await adminBytes(`/v1/vvsh/objects/${encodeURIComponent(leaf.hash)}`);
        const payload = normalizeVvshWebmChunk(storedPayload, index, meta.chunkSeconds);
        // A preview is a new one-chunk file: timestamps restart at zero and its Duration
        // is this block's few seconds, not the full source video's timeline.
        const out = assembleVvshWebm(init, [payload], { resetTimestamps: true, durationSeconds: end - start });
        const url = URL.createObjectURL(new Blob([Uint8Array.from(out)], { type: 'video/webm' }));
        setChunkPlay((old) => {
          if (old && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
          return { url, label: `chunk ${index} · ${renditionId} (${out.length} bytes)`, start: 0, end: Number.POSITIVE_INFINITY };
        });
        return;
      }
      // The simplest way to turn any block's bytes into playing video: stream exactly this
      // block's time span from this node's own range endpoint. The bytes that arrive are
      // this block's bytes — the browser decodes them like any video, in any browser.
      const rendition = meta.bitrates.find((entry) => entry.id === renditionId) ?? meta.bitrates[0];
      const spec = base64url(
        new TextEncoder().encode(JSON.stringify({ r: vvsh.root, c: meta.chunkCount, q: renditionId, d: rendition.decodedBytes ?? 0 }))
      );
      setChunkPlay((old) => {
        if (old && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
        return { url: `/v1/vvsh/stream/${spec}`, label: `chunk ${index} · ${renditionId}`, start, end };
      });
    } catch (e) {
      setError(message(e));
    }
  };
  // Exploring the stored tree by hand: a cursor on one node, moving left/right/down.
  const [cursor, setCursor] = useState<string[]>([vvsh.root]);
  const cursorHash = cursor[cursor.length - 1];
  const [cursorNode, setCursorNode] = useState<NonNullable<ReturnType<typeof parseVvshNode>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    setChunkPlay((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    setCursorNode(null);
    void adminBytes(`/v1/vvsh/objects/${encodeURIComponent(cursorHash)}`)
      .then((bytes) => {
        if (!cancelled) setCursorNode(parseVvshNode(bytes, cursorHash));
      })
      .catch((e) => {
        if (!cancelled) setError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cursorHash]);
  return (
    <Modal title={`Stream · ${meta.chunkCount} chunks · ${meta.bitrates.length} encodings`} onClose={onClose} wide>
      {error && <div className="banner danger small">{error}</div>}
      <dl className="kv">
        <dt>Version</dt>
        <dd>
          {meta.v} · {meta.codec}
          {meta.sourceMime ? ` · ${meta.sourceMime}` : ''}
        </dd>
        <dt>Chunks</dt>
        <dd>
          {meta.chunkCount} × {meta.chunkSeconds}s · {meta.totalSeconds}s total
          {meta.avgChunkBytes ? ` · ≈ ${(meta.avgChunkBytes / 1_048_576).toFixed(2)} MB per chunk (average)` : ''}
        </dd>
        <dt>Frames</dt>
        <dd>
          {meta.frames.gop} · {meta.frames.pattern}
        </dd>
        <dt>Previews</dt>
        <dd>
          {meta.previews
            ? `${meta.previews.images.length} × ${meta.previews.seconds.toFixed(2)}s` +
              (meta.previews.width ? ` · ${meta.previews.width}px` : '') +
              (meta.previews.quality ? ` · quality ${meta.previews.quality}` : '')
            : 'none'}
        </dd>
        <dt>Root</dt>
        <dd className="mono tiny">{vvsh.root}</dd>
      </dl>
      <details open>
        <summary>Explore the stored tree — one branch at a time</summary>
        <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
          {cursorNode?.kind === 'branch' ? (
            <>
              <button onClick={() => setCursor((path) => [...path, cursorNode.left])}>◀ left</button>
              <button onClick={() => setCursor((path) => [...path, cursorNode.right])}>right ▶</button>
            </>
          ) : null}
          {cursor.length > 1 ? <button onClick={() => setCursor((path) => path.slice(0, -1))}>↑ up</button> : null}
          <button onClick={() => setCursor([vvsh.root])}>reset to root</button>
        </div>
        <dl className="kv">
          <dt>Level</dt>
          <dd>
            {cursor.length - 1} of {meta.chunkCount > 1 ? Math.ceil(Math.log2(meta.chunkCount)) : 0}+ · at{' '}
            {cursorNode ? (cursorNode.kind === 'branch' ? 'a branch' : `chunk ${cursorNode.index}`) : 'loading…'}
          </dd>
          <dt>Hash</dt>
          <dd className="mono tiny">{cursorHash}</dd>
          {cursorNode?.kind === 'branch' && (
            <>
              <dt>Left child</dt>
              <dd className="mono tiny">{cursorNode.left}</dd>
              <dt>Right child</dt>
              <dd className="mono tiny">{cursorNode.right}</dd>
            </>
          )}
          {cursorNode?.kind === 'chunk' && (
            <>
              <dt>Leaves</dt>
              <dd>
                {cursorNode.renditions.map((leaf) => (
                  <div key={leaf.id} className="mono tiny">
                    {leaf.id} · {leaf.size} bytes · {leaf.frames.i} I / {leaf.frames.p} P / {leaf.frames.b} B · {leaf.hash}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
        {cursorNode?.kind === 'chunk' && (
          <div className="row">
            {cursorNode.renditions.map((leaf) => (
              <button key={leaf.id} onClick={() => void playChunk(cursorNode.index, leaf.id)}>
                ▶ play {leaf.id} (this block only)
              </button>
            ))}
          </div>
        )}
        {chunkPlay && (
          <div className="form-stack" style={{ marginTop: 8 }}>
            <div className="row between">
              <span className="small">
                Playing only {chunkPlay.label} — this block's own bytes, nothing before or after it
                {meta.codec === 'vvsh-frames/1' ? ' (a slice of the original file: it may not stand alone)' : ''}
              </span>
              <button
                className="small"
                onClick={() =>
                  setChunkPlay((old) => {
                    if (old) URL.revokeObjectURL(old.url);
                    return null;
                  })
                }
              >
                Close
              </button>
            </div>
            <video
              key={chunkPlay.url}
              src={chunkPlay.url}
              controls
              autoPlay
              playsInline
              style={{ width: '100%', borderRadius: 6 }}
              onLoadedMetadata={(e) => {
                if (chunkPlay.start > 0) e.currentTarget.currentTime = chunkPlay.start;
              }}
              onTimeUpdate={(e) => {
                if (e.currentTarget.currentTime >= chunkPlay.end) e.currentTarget.pause();
              }}
            />
          </div>
        )}
      </details>
    </Modal>
  );
}
