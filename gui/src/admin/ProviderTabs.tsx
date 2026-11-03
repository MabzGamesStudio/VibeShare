import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import { CopyButton, Loading, Modal, StatusDot, Switch } from '../components/ui';
import { formatBytes, timeAgo } from '../util';
import { admin, adminBytes, adminUpload, message } from './api';
import { ListControls, Pager, Sentinel, useConsoleList } from './paging';
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

/** Adding a file from this machine: drop or pick files and folders, or type a path. */
function AddLocal() {
  const [importPath, setImportPath] = useState('');
  const [uploading, setUploading] = useState('');
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [toast, show] = useToast();

  // Files and folders dropped in (or picked), uploaded to the node one by one.
  const upload = async (items: UploadItem[]) => {
    if (!items.length) return;
    try {
      for (let i = 0; i < items.length; i++) {
        setUploading(`Uploading ${items[i].name} (${i + 1} of ${items.length})…`);
        await adminUpload('/v1/admin/content/upload', items[i].file, items[i].name);
      }
      show(`Added ${items.length} file${items.length === 1 ? '' : 's'}`);
    } catch (e) {
      show(message(e));
    } finally {
      setUploading('');
    }
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
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
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <UploadCloud size={44} />
        <h2 style={{ margin: '12px 0 6px', color: 'var(--text)' }}>Drop a file or folder, or click to choose</h2>
        <p>Each file becomes its own content on this node. Anyone can also upload through a VibeShare client (Publish).</p>
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
      <div className="card form-stack">
        <h3>Or set a path on this machine</h3>
        <p className="small muted">Path of a file on the computer running the node.</p>
        <div className="row">
          <input type="text" value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/srv/media/video.mp4" style={{ flex: 1 }} />
          <button
            className="primary"
            disabled={!importPath.trim()}
            onClick={async () => {
              try {
                const result = await admin<{ cid: string }>('/v1/admin/content/import', { body: { path: importPath.trim() } });
                show(`Added ${result.cid}`);
                setImportPath('');
              } catch (e) {
                show(message(e));
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
/** The content list: search, lazy loading or pagination, and the details modal. */
function Content() {
  const [items, setItems] = useState<ContentRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const [toast, show] = useToast();
  const { prefs, save: savePaging } = useConsoleList('content');

  // Lazy loading appends the next page as you scroll; pagination takes one page at a time.
  const fetchAt = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true);
      try {
        const r = await admin<{ items: ContentRow[]; total: number }>(
          `/v1/admin/content?offset=${offset}&limit=${prefs.perPage}${search ? `&q=${encodeURIComponent(search)}` : ''}`
        );
        setItems((current) => (append && current ? [...current, ...r.items] : r.items));
        setTotal(r.total ?? 0);
      } catch (e) {
        show(message(e));
      } finally {
        setLoading(false);
      }
    },
    [prefs.perPage, search, show]
  );
  useEffect(() => {
    setPage(0);
    void fetchAt(0, false);
  }, [fetchAt]);

  const pager =
    items &&
    prefs.paging === 'pages' && (
      <Pager
        page={page}
        perPage={prefs.perPage}
        total={total}
        loading={loading}
        go={(next) => {
          setPage(next);
          void fetchAt(next * prefs.perPage, false);
        }}
      />
    );

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
            setPage(0);
          }}
        />
        <ListControls prefs={prefs} save={savePaging} />
      </div>
      {pager}
      {!items ? (
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
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="small muted">
                    No content matches.
                  </td>
                </tr>
              )}
              {items.map((row) => (
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
                          void fetchAt(prefs.paging === 'pages' ? page * prefs.perPage : 0, false);
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
      {items && prefs.paging === 'lazy' && (
        <>
          <Sentinel onMore={() => !loading && void fetchAt(items.length, true)} done={items.length >= total} />
          {items.length < total && (
            <p className="hint">
              Scroll for more ({items.length} of {total})
            </p>
          )}
        </>
      )}
      {pager}
      {details && <ContentDetails cid={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

interface ContentDetailsData {
  record: ContentRow & { chunks: number; creatorEdit?: { id: string; name?: string } };
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
    challengeIntervalSeconds?: number;
    retrievalIntervalSeconds?: number;
    rewards: { upfront: number; perRetrieval: number; perChallenge: number; completion: number };
    holders: {
      id: string;
      accountId: string;
      status: string;
      acceptedAt: string;
      earned: number;
      links: { id: string; cid?: string; url?: string; baseUrl?: string; status: string; fails?: number; location?: string }[];
    }[];
  }[];
  media?: { id: string; type: string; medium?: string; location?: string }[];
  /** Accepted URL backups offered for this content (or by base URL for any content). */
  urls?: { id: string; cid?: string; url?: string; baseUrl?: string; status: string; account: string; fails?: number; location?: string }[];
  suggestions?: SuggestionRow[];
}

/** Where each copy of one content should live by its tier plan: media and URL slots. */
function StorageMediaRows({ data }: { data: ContentDetailsData }) {
  const plan = data.tier?.plan;
  const wanted: { kind: string; label: string }[] = [];
  for (const [medium, count] of Object.entries(plan?.media ?? {})) {
    for (let i = 0; i < (count ?? 0); i++) wanted.push({ kind: 'medium', label: medium });
  }
  for (let i = 0; i < (plan?.externalUrls ?? 0); i++) wanted.push({ kind: 'url', label: 'url' });
  const media = data.media ?? [];
  // Accepted URL backups (and links holders of the job offer) fill the url slots.
  const links = [
    ...(data.urls ?? []).filter((entry) => entry.status === 'accepted'),
    ...(data.jobs ?? []).flatMap((job) => job.holders.flatMap((holder) => holder.links.filter((link) => link.status === 'accepted'))),
  ];
  let urlSlot = 0;
  const rows: { name: string; active: boolean; location: string }[] = wanted.map((slot) => {
    if (slot.kind === 'url') {
      const link = links[urlSlot++];
      const location = link?.location ?? (link ? (link.url ?? `${link.baseUrl ?? ''}/${encodeURIComponent(data.record.cid)}`) : '');
      return { name: 'url', active: Boolean(link), location };
    }
    const backend = media.find((entry) => (entry.medium ?? '').toLowerCase() === slot.label.toLowerCase() || entry.id === slot.label);
    return { name: slot.label, active: Boolean(backend), location: backend?.location ?? backend?.id ?? '' };
  });
  // Anything actually stored outside the plan still shows up.
  for (const entry of media) {
    if (!rows.some((row) => row.location === (entry.location ?? entry.id))) {
      rows.push({ name: entry.medium ?? entry.id, active: true, location: entry.location ?? entry.id });
    }
  }
  if (!rows.length) {
    return (
      <p className="small muted" style={{ marginTop: 6 }}>
        No local bytes — downloads come from URL backups, holders or peers.
      </p>
    );
  }
  return (
    <table className="table" style={{ marginTop: 6 }}>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.name}-${index}`}>
            <td className="small">
              <strong>{row.name}</strong>
            </td>
            <td>
              <span className={`badge ${row.active ? 'ok' : ''}`}>{row.active ? 'active' : 'not stored'}</span>
            </td>
            <td className="mono tiny" style={{ overflowWrap: 'anywhere' }}>
              {row.location || '—'}
            </td>
            <td>{row.location ? <CopyButton text={row.location} label="Location" /> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The storage jobs tab: one row per job (active or not), holders and their ordered endpoints. */
function StorageJobsTab({ data, cid, reload }: { data: ContentDetailsData; cid: string; reload: () => void }) {
  const [jobTests, setJobTests] = useState<Record<string, string>>({});
  const [linkTests, setLinkTests] = useState<Record<string, string>>({});
  const [toast, show] = useToast();

  const testJob = async (job: NonNullable<ContentDetailsData['jobs']>[number]) => {
    setJobTests((m) => ({ ...m, [job.id]: 'Testing…' }));
    try {
      const result = await admin<{
        test: { ok: boolean; account?: string; chunkId: string; chunkIndex: number; chunkCount: number; credited: number; error?: string };
      }>(`/v1/admin/storage/jobs/${job.id}/test`, { method: 'POST', body: {} });
      const t = result.test;
      setJobTests((m) => ({
        ...m,
        [job.id]: t.ok
          ? `✓ holder ${t.account?.slice(0, 16)}… returned chunk ${t.chunkIndex + 1} of ${t.chunkCount} — hash matches (chunks have their own hashes, not the content id) — paid ${t.credited} credits`
          : `✗ ${t.error ?? 'no answer'}`,
      }));
    } catch (e) {
      setJobTests((m) => ({ ...m, [job.id]: `✗ ${message(e)}` }));
    }
  };

  if (!(data.jobs ?? []).length) {
    return (
      <p className="small muted" style={{ marginTop: 6 }}>
        No storage jobs for this content yet.
      </p>
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Opened</th>
          <th>Copies</th>
          <th>Term</th>
          <th>Rewards &amp; schedule</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {(data.jobs ?? []).map((job) => (
          <Fragment key={job.id}>
            <tr>
              <td>
                <span className={`badge ${job.status === 'failed' ? 'warn' : job.status === 'open' ? 'accent' : ''}`}>{job.status}</span>
                {job.managed ? (
                  <span className="badge ok" style={{ marginLeft: 6 }}>
                    automatic
                  </span>
                ) : null}
              </td>
              <td className="small">{timeAgo(job.createdAt)}</td>
              <td className="small">{job.replicas}</td>
              <td className="small">{Math.round(job.durationSeconds / 86400)} days</td>
              <td className="tiny faint">
                {job.rewards.upfront} upfront · {job.rewards.perRetrieval}/retrieval · {job.rewards.perChallenge}/challenge ·{' '}
                {job.rewards.completion} end · challenge every {Math.round((job.challengeIntervalSeconds ?? 900) / 60)}m · test retrieval every{' '}
                {Math.round((job.retrievalIntervalSeconds ?? 0) / 60)}m
              </td>
              <td>
                <div className="row">
                  {job.holders.some((holder) => holder.status === 'active') && (
                    <button
                      className="small"
                      title="Ask a holder for a real chunk and pay its account the reward when the bytes match"
                      onClick={() => void testJob(job)}
                    >
                      Test job
                    </button>
                  )}
                  <button
                    className="small danger"
                    onClick={async () => {
                      if (!window.confirm('Delete this storage job and every assignment under it?')) return;
                      await admin(`/v1/admin/storage/jobs/${job.id}`, { method: 'DELETE' }).catch((e) => show(message(e)));
                      reload();
                    }}
                  >
                    Delete job
                  </button>
                </div>
                {jobTests[job.id] ? (
                  <div className="tiny" style={{ marginTop: 4 }}>
                    {jobTests[job.id]}
                  </div>
                ) : null}
              </td>
            </tr>

            {job.holders.map((holder) => {
              const links = [...holder.links].sort((a, b) => (a.fails ?? 0) - (b.fails ?? 0));
              const allFailed = links.length > 0 && links.every((link) => (link.fails ?? 0) > 0);
              const failed = holder.status === 'failed' || allFailed;
              return (
                <tr key={holder.id}>
                  <td colSpan={6}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className={`badge ${failed ? 'warn' : holder.status === 'active' ? 'ok' : ''}`}>
                        {failed ? 'failed' : holder.status}
                      </span>
                      <span className="mono tiny">{holder.accountId}</span>
                      <span className="tiny faint">{holder.earned} credits earned</span>
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {links.map((link, index) => {
                        const location = link.location ?? link.url ?? `${link.baseUrl ?? ''}/${encodeURIComponent(cid)}`;
                        const bad = (link.fails ?? 0) > 0;
                        return (
                          <div key={link.id} className="tiny" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="faint">#{index + 1}</span>
                            <span className={`badge ${bad ? 'warn' : 'ok'}`}>{bad ? 'failed' : 'accepted'}</span>
                            <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                              {location}
                            </span>
                            <button
                              className="small"
                              onClick={async () => {
                                setLinkTests((m) => ({ ...m, [link.id]: 'Checking…' }));
                                try {
                                  const result = await admin<{ verify: { ok: boolean; url: string; bytes: number; error?: string } }>(
                                    `/v1/admin/content/${encodeURIComponent(cid)}/verify`,
                                    { method: 'POST', body: { url: location, linkId: link.id } }
                                  );
                                  setLinkTests((m) => ({
                                    ...m,
                                    [link.id]: result.verify.ok ? `✓ ${result.verify.url} serves the content` : `✗ ${result.verify.error ?? 'does not match'}`,
                                  }));
                                  reload();
                                } catch (e) {
                                  setLinkTests((m) => ({ ...m, [link.id]: `✗ ${message(e)}` }));
                                }
                              }}
                            >
                              Test
                            </button>
                            <CopyButton text={location} label="Location" />
                            {linkTests[link.id] ? <span className="faint">{linkTests[link.id]}</span> : null}
                          </div>
                        );
                      })}
                      {links.length === 0 ? <div className="tiny faint">No endpoints offered by this account.</div> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** The content details tab: what the content is, with editable creator, sources, duplicates. */
function ContentDetailsTab({ data, cid, reload }: { data: ContentDetailsData; cid: string; reload: () => void }) {
  const meta = (data.manifest?.meta ?? {}) as {
    title?: string;
    description?: string;
    tags?: string[];
    topics?: string[];
    format?: string;
    rating?: string;
    durationSeconds?: number;
  };
  const sources = [...new Set([...(data.manifest?.sources ?? []), ...(data.record.sources ?? [])])];
  const creator = data.record.creatorEdit ?? data.manifest?.creator;
  const [editing, setEditing] = useState(false);
  const [creatorName, setCreatorName] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [editSources, setEditSources] = useState('');
  const [editDuplicates, setEditDuplicates] = useState('');
  const [showVvsh, setShowVvsh] = useState(false);
  const [toast, show] = useToast();

  const startEdit = () => {
    setCreatorName(creator?.name ?? '');
    setCreatorId(creator?.id ?? '');
    setEditSources(sources.join('\n'));
    setEditDuplicates((data.record.duplicates ?? []).join('\n'));
    setEditing(true);
  };
  const save = async () => {
    try {
      await admin(`/v1/admin/content/${encodeURIComponent(cid)}/details`, {
        body: {
          creator: creatorId.trim() || creatorName.trim() ? { id: creatorId.trim(), name: creatorName.trim() || undefined } : undefined,
          sources: editSources
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          duplicates: editDuplicates
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        },
      });
      setEditing(false);
      reload();
    } catch (e) {
      show(message(e));
    }
  };

  return (
    <div className="form-stack">
      <div className="row between">
        <strong>Content details</strong>
        {editing ? (
          <div className="row">
            <button className="small primary" onClick={() => void save()}>
              Save
            </button>
            <button className="small" onClick={() => setEditing(false)}>
              Discard
            </button>
          </div>
        ) : (
          <button className="small" onClick={startEdit}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="form-stack">
          <div className="form-grid">
            <label className="field">
              Creator name
              <input value={creatorName} onChange={(e) => setCreatorName(e.target.value)} />
            </label>
            <label className="field">
              Creator id
              <input className="mono" value={creatorId} onChange={(e) => setCreatorId(e.target.value)} />
            </label>
          </div>
          <label className="field">
            Sources (one per line)
            <textarea rows={3} style={{ resize: 'vertical' }} value={editSources} onChange={(e) => setEditSources(e.target.value)} />
          </label>
          <label className="field">
            Duplicates (one per line)
            <textarea rows={3} style={{ resize: 'vertical' }} value={editDuplicates} onChange={(e) => setEditDuplicates(e.target.value)} />
          </label>
          <p className="hint">Clear a field to delete it — an empty creator shows none, empty lists show “None reported”.</p>
        </div>

      ) : (
        <dl className="kv">
          <dt>File</dt>
          <dd>
            {data.record.name} · {data.record.mime} · {formatBytes(data.record.size)}
          </dd>
          <dt>Chunks</dt>
          <dd>
            {data.manifest?.vvsh ? (
              <>
                {data.manifest.vvsh.meta.chunkCount} chunks × {data.manifest.vvsh.meta.bitrates.length} encodings, each stored as its own object
                under the tree root — the .vvsh file is metadata and the root, so it lists no byte chunks.{' '}
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
          <dt>Creator</dt>
          <dd>
            {creator?.id || creator?.name ? (
              <>
                {creator.name ?? creator.id}
                {creator.name ? <span className="mono tiny faint"> · {creator.id}</span> : null}
              </>
            ) : (
              <span className="muted">None</span>
            )}
          </dd>
          <dt>Sources</dt>
          <dd>{sources.length ? sources.join(' · ') : 'None'}</dd>
          <dt>Duplicates</dt>
          <dd>
            {(data.record.duplicates ?? []).length === 0 ? (
              <span className="muted">None reported</span>
            ) : (
              <textarea
                readOnly
                className="mono tiny"
                style={{
                  width: '100%',
                  resize: 'vertical',
                  height: `${((data.record.duplicates ?? []).length >= 3 ? 2.5 : (data.record.duplicates ?? []).length) * 1.5}em`,
                }}
                value={(data.record.duplicates ?? []).join('\n')}
              />
            )}
          </dd>
        </dl>
      )}
      {meta.description && <p className="small">{meta.description}</p>}
      {showVvsh && data.manifest?.vvsh && <VvshModal vvsh={data.manifest.vvsh} onClose={() => setShowVvsh(false)} />}
      <div className="row">
        <button
          className="small"
          onClick={async () => {
            try {
              const result = await admin<{ fetched: number; missing: number }>('/v1/admin/peers/fetch', { body: { cid } });
              show(
                `Pulled ${result.fetched} missing chunk${result.fetched === 1 ? '' : 's'} from peers${result.missing ? ` (${result.missing} still missing)` : ''}`
              );
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
                body: { cid },
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
    </div>
  );
}

/** Everything the node knows about one content, shown when its row is clicked. */
function ContentDetails({ cid, onClose }: { cid: string; onClose: () => void }) {
  const [data, setData] = useState<ContentDetailsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'tier' | 'media' | 'suggestions' | 'jobs'>('details');
  const [tierPick, setTierPick] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [configTiers, setConfigTiers] = useState<{ id: string; label: string }[]>([]);
  const [, show] = useToast();
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
          <div>
            <h3>{data.record.title ?? (data.manifest?.meta as { title?: string } | undefined)?.title ?? data.record.name}</h3>
            <div className="mono tiny faint">{data.record.cid}</div>
          </div>
          <div className="tabs">
            {(
              [
                ['details', 'Content details'],
                ['tier', 'Storage tier'],
                ['media', 'Storage media'],
                ['suggestions', 'Client suggestions'],
                ['jobs', 'Storage jobs'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'details' && <ContentDetailsTab data={data} cid={cid} reload={load} />}
          {tab === 'media' && (
            <div>
              <h3>Storage media</h3>
              <StorageMediaRows data={data} />
            </div>
          )}
          {tab === 'jobs' && <StorageJobsTab data={data} cid={cid} reload={load} />}
          {tab === 'tier' && (
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
          )}
          {tab === 'suggestions' && (
            <div>
              <h3>Client suggestions</h3>
              {data.suggestions && data.suggestions.length > 0 ? (
                data.suggestions.map((suggestion) => (
                  <div key={suggestion.id} className="small" style={{ marginTop: 6 }}>
                    <span className="badge">{suggestion.status}</span>{' '}
                    <strong>{suggestion.kind}</strong>{' '}
                    {suggestion.sources?.map((source) => `${source.platform}: ${source.url}`).join(', ') ?? suggestion.duplicateOf ?? suggestion.note ?? ''}
                    <div className="tiny faint">{timeAgo(suggestion.createdAt)}</div>
                  </div>
                ))
              ) : (
                <p className="small muted" style={{ marginTop: 6 }}>
                  None.
                </p>
              )}
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
  items: number;
  bytes: number;
}

/**
 * The storage page's backend section: the groups a node stores things in — the media
 * the tiers plan counts (HDD, SSD), local storage, cloud storage, IPFS and the URL
 * backups of user jobs — each with its total capacity and item count.
 */
function Storage() {
  const [data, setData] = useState<{
    backends: Backend[];
    media: { id: string; label: string; backends: string[] }[];
    urls: { items: number; bytes: number };
  } | null>(null);
  const [toast, show] = useToast();
  const load = useCallback(() => {
    admin<{ backends: Backend[]; media: { id: string; label: string; backends: string[] }[]; urls: { items: number; bytes: number } }>(
      '/v1/admin/storage/backends'
    )
      .then(setData)
      .catch((e) => show(message(e)));
  }, [show]);
  useEffect(load, [load]);

  if (!data) return <Loading />;
  const claimed = new Set(data.media.flatMap((medium) => medium.backends ?? []));
  const unclaimed = (types: string[]) => data.backends.filter((backend) => !claimed.has(backend.id) && types.includes(backend.type));
  const groups: { label: string; rows: Backend[] }[] = [
    ...data.media.map((medium) => ({
      label: medium.label,
      rows: data.backends.filter((backend) => (medium.backends ?? []).includes(backend.id)),
    })),
    { label: 'Local storage', rows: unclaimed(['local', 'memory']) },
    { label: 'Cloud storage', rows: unclaimed(['s3', 'webdav', 'http', 'provider']) },
    { label: 'IPFS', rows: unclaimed(['ipfs']) },
    {
      label: 'User job urls',
      rows: [],
    },
  ];
  // Anything the sections above did not claim still gets a home.
  const leftover = data.backends.filter((backend) => !groups.some((group) => group.rows.includes(backend)));
  if (leftover.length) groups[1].rows.push(...leftover);

  return (
    <div className="form-stack">
      {toast && <div className="banner info small">{toast}</div>}
      <div className="card form-stack">
        <h3>Storage backends</h3>
        <p className="small muted">
          Where chunks are kept, tried in priority order. Add S3-compatible buckets, WebDAV, IPFS, mirrors or other providers under
          Settings → storage.backends.
        </p>
        {groups.map((group) => {
          const bytes = group.rows.reduce((sum, row) => sum + row.bytes, 0) + (group.label === 'User job urls' ? data.urls.bytes : 0);
          const items = group.rows.reduce((sum, row) => sum + row.items, 0) + (group.label === 'User job urls' ? data.urls.items : 0);
          return (
            <div key={group.label}>
              <div className="row between small" style={{ marginBottom: 4 }}>
                <strong>{group.label}</strong>
                <span className="muted">
                  {formatBytes(bytes)} · {items} item{items === 1 ? '' : 's'}
                </span>
              </div>
              {group.rows.length === 0 ? (
                <div className="tiny faint" style={{ marginBottom: 6 }}>
                  {group.label === 'User job urls'
                    ? 'Accepted content URLs and base URLs offered by accounts — copies kept outside any backend.'
                    : 'Nothing here yet.'}
                </div>
              ) : (
                <table className="table">
                  <tbody>
                    {group.rows.map((backend) => (
                      <tr key={backend.id}>
                        <td>
                          <StatusDot online={backend.status.ok} /> <strong>{backend.id}</strong>
                        </td>
                        <td className="small">{backend.type}</td>
                        <td className="small">
                          {formatBytes(backend.bytes)} · {backend.items} item{backend.items === 1 ? '' : 's'}
                        </td>
                        <td className="small">priority {backend.priority}</td>
                        <td className="small">{backend.writable ? 'read/write' : 'read only'}</td>
                        <td className="small muted">{backend.status.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
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

  // The rewards and schedule of the storage jobs this node opens for tiered content.
  const [jobDefaults, setJobDefaults] = useState<{
    rewards: { upfront: number; perRetrieval: number; perChallenge: number; completion: number };
    challengeIntervalSeconds: number;
    retrievalIntervalSeconds: number;
  } | null>(null);
  useEffect(() => {
    admin<{
      storageService: {
        auto: {
          rewards: { upfront: number; perRetrieval: number; perChallenge: number; completion: number };
          challengeIntervalSeconds?: number;
          retrievalIntervalSeconds?: number;
        };
      };
    }>('/v1/admin/config')
      .then((c) =>
        setJobDefaults({
          rewards: c.storageService.auto.rewards,
          challengeIntervalSeconds: c.storageService.auto.challengeIntervalSeconds ?? 900,
          retrievalIntervalSeconds: c.storageService.auto.retrievalIntervalSeconds ?? 0,
        })
      )
      .catch(() => undefined);
  }, []);
  const saveJobDefaults = async (patch: Partial<NonNullable<typeof jobDefaults>>) => {
    const next = { ...(jobDefaults as NonNullable<typeof jobDefaults>), ...patch };
    setJobDefaults(next);
    try {
      await admin('/v1/admin/config', { method: 'PUT', body: { storageService: { auto: next } } });
    } catch (e) {
      show(message(e));
    }
  };

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
      <div className="card form-stack">
        <h3>Storage job defaults</h3>
        <p className="small muted">
          The rewards and the challenge / retrieval schedule of the storage jobs this node opens for content on a tier. Individual jobs can
          still set their own in the content details.
        </p>
        {jobDefaults && (
          <div className="form-grid">
            <label className="field">
              Upfront credits
              <input
                type="number"
                min={0}
                key="jd-upfront"
                defaultValue={jobDefaults.rewards.upfront}
                onBlur={(e) => void saveJobDefaults({ rewards: { ...jobDefaults.rewards, upfront: Number(e.target.value) } })}
              />
            </label>
            <label className="field">
              Per retrieval
              <input
                type="number"
                min={0}
                key="jd-perRetrieval"
                defaultValue={jobDefaults.rewards.perRetrieval}
                onBlur={(e) => void saveJobDefaults({ rewards: { ...jobDefaults.rewards, perRetrieval: Number(e.target.value) } })}
              />
            </label>
            <label className="field">
              Per challenge
              <input
                type="number"
                min={0}
                key="jd-perChallenge"
                defaultValue={jobDefaults.rewards.perChallenge}
                onBlur={(e) => void saveJobDefaults({ rewards: { ...jobDefaults.rewards, perChallenge: Number(e.target.value) } })}
              />
            </label>
            <label className="field">
              End of term
              <input
                type="number"
                min={0}
                key="jd-completion"
                defaultValue={jobDefaults.rewards.completion}
                onBlur={(e) => void saveJobDefaults({ rewards: { ...jobDefaults.rewards, completion: Number(e.target.value) } })}
              />
            </label>
            <label className="field">
              Challenge every (minutes)
              <input
                type="number"
                min={1}
                key="jd-challenge"
                defaultValue={Math.max(1, Math.round(jobDefaults.challengeIntervalSeconds / 60))}
                onBlur={(e) => void saveJobDefaults({ challengeIntervalSeconds: Math.round(Number(e.target.value) * 60) })}
              />
            </label>
            <label className="field">
              Retrieval test every (minutes, 0 = off)
              <input
                type="number"
                min={0}
                key="jd-retrieval"
                defaultValue={Math.round(jobDefaults.retrievalIntervalSeconds / 60)}
                onBlur={(e) => void saveJobDefaults({ retrievalIntervalSeconds: Math.round(Number(e.target.value) * 60) })}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProviderTabs({ tab }: { tab: string }) {

  if (tab === 'content') return <Content />;
  if (tab === 'add-local') return <AddLocal />;
  if (tab === 'suggestions') return <Suggestions />;
  if (tab === 'storage')
    return (
      <div className="form-stack">
        <Storage />
        <Peering />
        <SyncJob />
      </div>
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
