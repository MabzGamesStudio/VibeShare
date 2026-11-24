// The tracing GUI, shared by the client (Settings → Tracing) and the node admin
// consoles (a standalone Tracing tab): the settings form (on/off, expiration, the
// selectable levels, how much of a payload to keep) and the log view — keyword
// search, time span, level filters, paging like the other lists have (page by page,
// or lazy with a "Load more" button), and one timeline per user action or API start
// holding everything it caused. Rows are divided by hairlines and each row opens a
// modal with the whole event or timeline, copyable from there.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { TraceEvent, TraceLevel, TraceSettings, TraceTimeline } from '../../../src/shared/tracing.js';
import { TRACE_LEVELS } from '../../../src/shared/tracing.js';
import { CopyButton, Modal } from './ui';

const LEVEL_LABELS: Record<TraceLevel, string> = {
  basic: 'Basic — algorithms and functions',
  detail: 'Detailed — user actions, clicks, changes, function data',
  dependency: 'Dependency — APIs',
  error: 'Errors',
};

/** What every host of these widgets provides: its own backend's tracing endpoints. */
export interface TraceApi {
  settings(): Promise<{ settings: TraceSettings }>;
  updateSettings(patch: Partial<TraceSettings>): Promise<{ settings: TraceSettings }>;
  events(query: TraceQuery): Promise<{ events: TraceEvent[]; total: number }>;
  timelines(query: TraceQuery): Promise<{ timelines: TraceTimeline[]; total: number }>;
  clear(): Promise<{ cleared: number }>;
}

export interface TraceQuery {
  query?: string;
  from?: string;
  to?: string;
  levels?: string;
  traceId?: string;
  limit?: number;
  offset?: number;
}

/** Builds a TraceApi over any JSON API helper (the daemon's api() or the admin's admin()). */
export function traceApiOf(call: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>, base: string): TraceApi {
  return {
    settings: () => call(`${base}/settings`),
    updateSettings: (patch) => call(`${base}/settings`, { method: 'PUT', body: patch }),
    events: (query) => call(`${base}/events?${new URLSearchParams(clean(query))}`),
    timelines: (query) => call(`${base}/timelines?${new URLSearchParams(clean(query))}`),
    clear: () => call(`${base}/events`, { method: 'DELETE' }),
  };
}

function clean(query: TraceQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value) !== '') out[key] = String(value);
  }
  return out;
}

/** The settings form: trace logs on/off (off by default), expiration, level ticks. */
export function TraceSettingsForm({ settings, onChange }: { settings: TraceSettings; onChange: (patch: Partial<TraceSettings>) => void }) {
  return (
    <div className="form-stack">
      <label className="field">
        Trace logs
        <select value={String(settings.enabled)} onChange={(e) => onChange({ enabled: e.target.value === 'true' })}>
          <option value="false">Off (default)</option>
          <option value="true">On</option>
        </select>
        <span className="hint">Off by default: nothing at all is recorded until this is turned on.</span>
      </label>
      <label className="field">
        Expire logs after (hours)
        <input
          type="number"
          min={1}
          defaultValue={settings.expirationHours}
          key={settings.expirationHours}
          onBlur={(e) => {
            const hours = Math.max(1, Math.round(Number(e.target.value) || 24));
            if (hours !== settings.expirationHours) onChange({ expirationHours: hours });
          }}
        />
        <span className="hint">Trace events older than this are pruned (default 24).</span>
      </label>
      <label className="field">
        Record first N characters of request/response payloads
        <input
          type="number"
          min={0}
          max={20000}
          defaultValue={settings.payloadChars}
          key={settings.payloadChars}
          onBlur={(e) => {
            const chars = Math.max(0, Math.round(Number(e.target.value) || 256));
            if (chars !== settings.payloadChars) onChange({ payloadChars: chars });
          }}
        />
        <span className="hint">How much of a request or response body is kept in each trace line (default 256). 0 records nothing of the payload.</span>
      </label>
      <div className="field">
        Trace levels
        {TRACE_LEVELS.map((level) => (
          <label key={level} className="row small" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={settings.levels[level]}
              onChange={(e) => onChange({ levels: { ...settings.levels, [level]: e.target.checked } })}
            />
            {LEVEL_LABELS[level]}
          </label>
        ))}
        <span className="hint">Basic, dependency and error are pre-selected when tracing is first turned on.</span>
      </div>
    </div>
  );
}

/** One row in the log list: a hairline under every row, a modal on click. */
const ROW_DIVIDER: CSSProperties = { borderBottom: '1px solid var(--border)', paddingBottom: 6 };

/** How the log is read: one page at a time, or a page appended on request (lazy). */
type ShowAs = 'paged' | 'lazy';

/** The log view: search, time span, level filters, paging, and events / timelines. */
export function TracingView({ api }: { api: TraceApi }) {
  const [settings, setSettings] = useState<TraceSettings | null>(null);
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [levels, setLevels] = useState<TraceLevel[]>([]);
  const [mode, setMode] = useState<'events' | 'timelines'>('events');
  const [show, setShow] = useState<ShowAs>('paged');
  const [perPage, setPerPage] = useState(50);
  const [page, setPage] = useState(0);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [timelines, setTimelines] = useState<TraceTimeline[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ kind: 'event'; event: TraceEvent } | { kind: 'timeline'; timeline: TraceTimeline } | null>(null);
  // Only the newest request may touch what is shown: filter changes fire their own
  // fetch right away, so a slow older answer must never overwrite a newer one.
  const asked = useRef(0);

  useEffect(() => {
    api.settings().then((answer) => setSettings(answer.settings)).catch(() => undefined);
  }, [api]);

  /** One page of the current filters, from `offset` items in (appended when asked). */
  const load = (offset: number, append = false) => {
    const wanted = ++asked.current;
    setLoading(true);
    setError(null);
    const filter: TraceQuery = {
      query: query || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      levels: levels.length ? levels.join(',') : undefined,
      limit: perPage,
      offset,
    };
    const stale = () => asked.current !== wanted;
    if (mode === 'events') {
      api
        .events(filter)
        .then((answer) => {
          if (stale()) return;
          setEvents((current) => (append ? [...current, ...answer.events] : answer.events));
          setTotal(answer.total);
          setLoading(false);
        })
        .catch((e) => {
          if (stale()) return;
          setError((e as Error).message);
          setLoading(false);
        });
    } else {
      api
        .timelines(filter)
        .then((answer) => {
          if (stale()) return;
          setTimelines((current) => (append ? [...current, ...answer.timelines] : answer.timelines));
          setTotal(answer.total);
          setLoading(false);
        })
        .catch((e) => {
          if (stale()) return;
          setError((e as Error).message);
          setLoading(false);
        });
    }
  };

  // Anything that changes what is looked for — the filters, the mode, how much a page
  // holds, the paging style — starts over at the first page (offset 0).
  const levelKey = levels.join(',');
  useEffect(() => {
    setPage(0);
    load(0);
  }, [mode, show, perPage, query, from, to, levelKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = (patch: Partial<TraceSettings>) => {
    api
      .updateSettings(patch)
      .then((answer) => setSettings(answer.settings))
      .catch((e) => setError((e as Error).message));
  };

  const list = mode === 'events' ? events : timelines;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const shown = list.length;
  const pager = total > 0 && <Pager page={page} perPage={perPage} total={total} loading={loading} go={(next) => { setPage(next); load(next * perPage); }} />;

  return (
    <div className="form-stack">
      {settings && <TraceSettingsForm settings={settings} onChange={saveSettings} />}
      <div className="card form-stack">
        <h3>Traces</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input type="search" placeholder="Search keywords…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 2, minWidth: 160 }} />
          <label className="small muted">
            From <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="small muted">
            To <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'events' | 'timelines')}>
            <option value="events">Events</option>
            <option value="timelines">Timelines</option>
          </select>
          <span className="hint">Show as</span>
          <select value={show} style={{ width: 'auto' }} onChange={(e) => setShow(e.target.value as ShowAs)}>
            <option value="paged">Pagination</option>
            <option value="lazy">Lazy load</option>
          </select>
          <span className="hint">Items per page</span>
          <input
            key={perPage}
            type="number"
            min={1}
            max={500}
            style={{ maxWidth: 92 }}
            title="Rows per page (1–500)"
            defaultValue={perPage}
            onBlur={(e) => {
              const wanted = Math.round(Number(e.target.value));
              if (!e.target.value.trim() || !Number.isFinite(wanted) || wanted === perPage) return;
              setPerPage(Math.min(500, Math.max(1, wanted)));
            }}
          />
          <button
            className="primary small"
            onClick={() => {
              setPage(0);
              load(0);
            }}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Search'}
          </button>
          <button
            className="small danger"
            onClick={() => {
              if (window.confirm('Delete every stored trace event?')) {
                void api.clear().then(() => {
                  setPage(0);
                  load(0);
                });
              }
            }}
          >
            Clear
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {TRACE_LEVELS.map((level) => (
            <label key={level} className="row small" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={levels.includes(level)}
                onChange={(e) => setLevels((current) => (e.target.checked ? [...current, level] : current.filter((entry) => entry !== level)))}
              />
              {level}
            </label>
          ))}
          <span className="small muted">
            {total} {mode === 'events' ? 'event' : 'timeline'}
            {total === 1 ? '' : 's'}
          </span>
        </div>
        {error && <div className="banner danger small">{error}</div>}
        {show === 'paged' && pager}
        {mode === 'events' ? (
          <div className="trace-list">
            {events.map((event) => (
              <EventRow key={event.id} event={event} onOpen={() => setOpen({ kind: 'event', event })} />
            ))}
            {!events.length && !loading && <p className="small muted">Nothing recorded yet — tracing is off, or no events match.</p>}
          </div>
        ) : (
          <div className="trace-list">
            {timelines.map((timeline) => (
              <button
                key={timeline.traceId}
                type="button"
                className="trace-row"
                onClick={() => setOpen({ kind: 'timeline', timeline })}
                title="Open the whole timeline"
              >
                <span className="trace-head">
                  <span className="badge">timeline</span>
                  <span className="trace-time">{new Date(timeline.startedAt).toLocaleString()}</span>
                </span>
                <span className="trace-main">{timeline.initiator?.label ?? 'Timeline'}</span>
                <span className="trace-sub">
                  {timeline.initiator?.kind ?? 'event'} · {timeline.events.length} event{timeline.events.length === 1 ? '' : 's'}
                </span>
              </button>
            ))}
            {!timelines.length && !loading && <p className="small muted">No timelines yet — each user action or API call starts one.</p>}
          </div>
        )}
        {show === 'paged' ? (
          pager
        ) : (
          total > shown && (
            <button className="small" disabled={loading} onClick={() => load(shown, true)}>
              Load more ({total - shown} left)
            </button>
          )
        )}
      </div>
      {open?.kind === 'event' && <EventModal event={open.event} onClose={() => setOpen(null)} />}
      {open?.kind === 'timeline' && <TimelineModal timeline={open.timeline} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * One trace in the list: the level and its time on the first line (the time at the right
 * edge), the main text on the next, and a short subtext under it. Everything else — the
 * ids, the data payload, the error, the initiator — is in the modal this row opens.
 */
function EventRow({ event, onOpen }: { event: TraceEvent; onOpen: () => void }) {
  const subtext = [event.component, event.message, event.error].filter(Boolean).join(' · ');
  return (
    <button type="button" className="trace-row" onClick={onOpen} title="Open the full event">
      <span className="trace-head">
        <LevelBadge level={event.level} />
        <span className="trace-time">{new Date(event.at).toLocaleString()}</span>
      </span>
      <span className="trace-main">{event.action}</span>
      {subtext ? <span className="trace-sub">{subtext}</span> : null}
      <PayloadLines data={event.data} />
    </button>
  );
}

/** The captured request/response payload prefixes, as readable lines in the row. */
function PayloadLines({ data }: { data: unknown }) {
  const payloads = payloadsOf(data);
  const rows = [
    ['req', payloads.requestPayload],
    ['res', payloads.responsePayload],
  ] as const;
  const shown = rows.filter((entry): entry is readonly ['req' | 'res', string] => typeof entry[1] === 'string');
  if (!shown.length) return null;
  return (
    <span style={{ display: 'block' }}>
      {shown.map(([label, text]) => (
        <span key={label} className="tiny mono" style={{ display: 'block', opacity: 0.85, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '3.6em', overflow: 'hidden' }}>
          {label} › {text}
        </span>
      ))}
    </span>
  );
}

/** The captured payload prefixes of one event's data, when it has them. */
function payloadsOf(data: unknown): { requestPayload?: string; responsePayload?: string } {
  const record = data as { requestPayload?: unknown; responsePayload?: unknown } | undefined;
  if (!record || typeof record !== 'object') return {};
  return {
    requestPayload: typeof record.requestPayload === 'string' ? record.requestPayload : undefined,
    responsePayload: typeof record.responsePayload === 'string' ? record.responsePayload : undefined,
  };
}

function LevelBadge({ level }: { level: TraceLevel }) {
  return <span className={`badge ${level === 'error' ? 'danger' : level === 'dependency' ? 'ok' : ''}`}>{level}</span>;
}

/**
 * The Previous / Next row of a page-by-page list — the same controls the other lists of
 * these consoles use — with a skip-to-page jump right-aligned in the same row. Shown
 * above and below the list so the bottom of a page is as easy to page from as the top.
 */
function Pager({ page, perPage, total, loading, go }: { page: number; perPage: number; total: number; loading: boolean; go: (page: number) => void }) {
  const [wanted, setWanted] = useState('');
  const pages = Math.max(1, Math.ceil(total / perPage));
  // Skipping straight to a page: the typed number is clamped to the pages there are and
  // committed on Go or Enter. Re-sending the wanted page is cheap here, so nothing is
  // kept between the keystrokes.
  const skip = () => {
    const typed = Number(wanted);
    if (!wanted.trim() || !Number.isFinite(typed)) return;
    const target = Math.min(pages, Math.max(1, Math.round(typed))) - 1;
    setWanted('');
    if (target !== page) go(target);
  };
  return (
    <div className="row">
      <button className="small" disabled={page === 0 || loading} onClick={() => go(page - 1)}>
        Previous
      </button>
      <span className="small">
        page {page + 1} of {pages}
      </span>
      <button className="small" disabled={(page + 1) * perPage >= total || loading} onClick={() => go(page + 1)}>
        Next
      </button>
      {pages > 1 && (
        <>
          <div className="spacer" />
          <span className="hint">Skip to page</span>
          <input
            type="number"
            min={1}
            max={pages}
            placeholder="page"
            style={{ maxWidth: 72 }}
            value={wanted}
            disabled={loading}
            onChange={(e) => setWanted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') skip();
            }}
          />
          <button className="small" disabled={loading || !wanted.trim()} onClick={skip}>
            Go
          </button>
        </>
      )}
    </div>
  );
}

/** The modal for one event: every field of it, with copy buttons for its data. */
function EventModal({ event, onClose }: { event: TraceEvent; onClose: () => void }) {
  return (
    <Modal
      title="Trace event"
      onClose={onClose}
      wide
      actions={
        <>
          <CopyButton text={lineOfEvent(event)} label="Copy" />
          <CopyButton text={prettyJson(event)} label="Copy as JSON" />
        </>
      }
    >
      <EventFields event={event} />
    </Modal>
  );
}

/** The modal for one timeline: who started it and every event it caused, copyable. */
function TimelineModal({ timeline, onClose }: { timeline: TraceTimeline; onClose: () => void }) {
  return (
    <Modal
      title="Trace timeline"
      onClose={onClose}
      wide
      actions={
        <>
          <CopyButton text={textOfEvents(timeline.events)} label="Copy events" />
          <CopyButton text={prettyJson(timeline.events)} label="Copy as JSON" />
        </>
      }
    >
      <div className="form-stack">
        <Field label="traceId" value={<span className="mono tiny">{timeline.traceId}</span>} />
        <Field label="initiator" value={timeline.initiator ? `${timeline.initiator.kind} · ${timeline.initiator.label}` : '—'} />
        <Field label="started" value={new Date(timeline.startedAt).toLocaleString()} />
        <Field label="events" value={String(timeline.events.length)} />
        <div className="form-stack" style={{ gap: 8 }}>
          {timeline.events.map((event) => (
            <div key={event.id} style={ROW_DIVIDER}>
              <EventFields event={event} />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Every field of one event, labels in their own column, values beside them. */
function EventFields({ event }: { event: TraceEvent }) {
  const payloads = payloadsOf(event.data);
  return (
    <div className="form-stack" style={{ gap: 4 }}>
      <Field label="id" value={<span className="mono tiny">{event.id}</span>} />
      <Field label="traceId" value={<span className="mono tiny">{event.traceId}</span>} />
      <Field label="at" value={`${event.at} · ${new Date(event.at).toLocaleString()}`} />
      <Field label="level" value={<LevelBadge level={event.level} />} />
      <Field label="source" value={event.source} />
      <Field label="component" value={event.component} />
      <Field label="action" value={event.action} />
      <Field label="message" value={event.message ?? '—'} />
      <Field label="dependency" value={<DependencyLine data={event.data} />} />
      {payloads.requestPayload !== undefined && <Field label="requestPayload" value={<PayloadBlock text={payloads.requestPayload} />} />}
      {payloads.responsePayload !== undefined && <Field label="responsePayload" value={<PayloadBlock text={payloads.responsePayload} />} />}
      <Field label="data" value={event.data === undefined ? '—' : <pre className="mono tiny" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflow: 'auto' }}>{prettyJson(event.data)}</pre>} />
      <Field label="error" value={event.error ?? '—'} />
      <Field label="initiator" value={event.initiator ? `${event.initiator.kind} · ${event.initiator.label}` : '—'} />
    </div>
  );
}

/** One captured payload, decoded and wrapped: long lines break, tall ones scroll. */
function PayloadBlock({ text }: { text: string }) {
  return (
    <pre className="mono tiny" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflow: 'auto' }}>
      {text}
    </pre>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="row small" style={{ gap: 10, alignItems: 'baseline' }}>
      <span className="muted" style={{ width: 84, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

/**
 * The dependency details of an event (where the call went, how long it took, what the
 * answer was) rendered as their own readable line, on top of the raw payload below.
 */
function DependencyLine({ data }: { data: unknown }) {
  const record = data as { url?: unknown; method?: unknown; status?: unknown; ms?: unknown; bytes?: unknown } | undefined;
  if (!record || typeof record !== 'object') return <span className="muted">—</span>;
  const { url, method, status, ms, bytes } = record;
  if (url === undefined && ms === undefined && status === undefined) return <span className="muted">—</span>;
  return (
    <span className="tiny" style={{ display: 'block', opacity: 0.85 }}>
      {method !== undefined ? `${String(method)} ` : ''}
      {url !== undefined ? <span className="mono">{String(url)}</span> : null}
      {status !== undefined ? ` → ${String(status)}` : ''}
      {ms !== undefined ? ` · ${String(ms)} ms` : ''}
      {bytes !== undefined ? ` · ${String(bytes)} bytes` : ''}
    </span>
  );
}

/** The share format: one line per event as text, or the same events as JSON. */
function textOfEvents(events: TraceEvent[]): string {
  return events.map((event) => lineOfEvent(event)).join('\n');
}

function lineOfEvent(event: TraceEvent): string {
  const parts = [
    event.at,
    `[${event.level}]`,
    event.component,
    event.action,
    event.message ? `— ${event.message}` : '',
    event.error ? `— ${event.error}` : '',
    event.data !== undefined ? safeJson(event.data) : '',
    `(trace ${event.traceId})`,
  ];
  return parts.filter(Boolean).join(' ');
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
