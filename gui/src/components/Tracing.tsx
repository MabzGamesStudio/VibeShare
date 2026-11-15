// The tracing GUI, shared by the client (Settings → Tracing) and the node admin
// consoles (a standalone Tracing tab): the settings form (on/off, expiration, the
// selectable levels, how much of a payload to keep) and the log view — keyword
// search, time span, level filters, and one timeline per user action or API start
// holding everything it caused. Rows are divided by hairlines and each row opens a
// modal with the whole event or timeline, copyable from there.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
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

/** The log view: search, time span, level filters, and events / timelines. */
export function TracingView({ api }: { api: TraceApi }) {
  const [settings, setSettings] = useState<TraceSettings | null>(null);
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [levels, setLevels] = useState<TraceLevel[]>([]);
  const [mode, setMode] = useState<'events' | 'timelines'>('events');
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [timelines, setTimelines] = useState<TraceTimeline[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ kind: 'event'; event: TraceEvent } | { kind: 'timeline'; timeline: TraceTimeline } | null>(null);

  useEffect(() => {
    api.settings().then((answer) => setSettings(answer.settings)).catch(() => undefined);
  }, [api]);

  const load = () => {
    setLoading(true);
    setError(null);
    const filter: TraceQuery = {
      query: query || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      levels: levels.length ? levels.join(',') : undefined,
    };
    const done = () => setLoading(false);
    if (mode === 'events') {
      api
        .events(filter)
        .then((answer) => {
          setEvents(answer.events);
          setTotal(answer.total);
        })
        .catch((e) => setError((e as Error).message))
        .finally(done);
    } else {
      api
        .timelines(filter)
        .then((answer) => {
          setTimelines(answer.timelines);
          setTotal(answer.total);
        })
        .catch((e) => setError((e as Error).message))
        .finally(done);
    }
  };

  useEffect(load, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = (patch: Partial<TraceSettings>) => {
    api
      .updateSettings(patch)
      .then((answer) => setSettings(answer.settings))
      .catch((e) => setError((e as Error).message));
  };

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
          <button className="primary small" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Search'}
          </button>
          <button
            className="small danger"
            onClick={() => {
              if (window.confirm('Delete every stored trace event?')) void api.clear().then(load);
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
        {mode === 'events' ? (
          <div className="form-stack" style={{ gap: 6, maxHeight: 480, overflowY: 'auto' }}>
            {events.map((event) => (
              <EventRow key={event.id} event={event} onOpen={() => setOpen({ kind: 'event', event })} />
            ))}
            {!events.length && !loading && <p className="small muted">Nothing recorded yet — tracing is off, or no events match.</p>}
          </div>
        ) : (
          <div className="form-stack" style={{ gap: 6, maxHeight: 480, overflowY: 'auto' }}>
            {timelines.map((timeline) => (
              <button
                key={timeline.traceId}
                className="row between small"
                style={{ background: 'none', border: 0, ...ROW_DIVIDER, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setOpen({ kind: 'timeline', timeline })}
                title="Open the whole timeline"
              >
                <span>
                  <strong>{timeline.initiator?.label ?? 'Timeline'}</strong>
                  <span className="faint"> · {timeline.initiator?.kind ?? 'event'} · started {new Date(timeline.startedAt).toLocaleString()}</span>
                </span>
                <span className="tiny faint">{timeline.events.length} events</span>
              </button>
            ))}
            {!timelines.length && !loading && <p className="small muted">No timelines yet — each user action or API call starts one.</p>}
          </div>
        )}
      </div>
      {open?.kind === 'event' && <EventModal event={open.event} onClose={() => setOpen(null)} />}
      {open?.kind === 'timeline' && <TimelineModal timeline={open.timeline} onClose={() => setOpen(null)} />}
    </div>
  );
}

function EventRow({ event, onOpen }: { event: TraceEvent; onOpen: () => void }) {
  return (
    <button
      className="row small"
      style={{ background: 'none', border: 0, ...ROW_DIVIDER, gap: 8, alignItems: 'baseline', textAlign: 'left', cursor: 'pointer' }}
      onClick={onOpen}
      title="Open the full event"
    >
      <LevelBadge level={event.level} />
      <span className="tiny faint" style={{ whiteSpace: 'nowrap' }}>
        {new Date(event.at).toLocaleTimeString()}
      </span>
      <span className="tiny faint">{event.component}</span>
      <span>
        {event.action}
        {event.message ? <span className="muted"> — {event.message}</span> : null}
        {event.error ? <span className="faint"> — {event.error}</span> : null}
        <DependencyLine data={event.data} />
        {event.data !== undefined ? <span className="mono tiny faint"> {safeJson(event.data)}</span> : null}
      </span>
    </button>
  );
}

function LevelBadge({ level }: { level: TraceLevel }) {
  return <span className={`badge ${level === 'error' ? 'danger' : level === 'dependency' ? 'ok' : ''}`}>{level}</span>;
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
        <div className="form-stack" style={{ gap: 8, maxHeight: 420, overflowY: 'auto' }}>
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
      <Field label="data" value={event.data === undefined ? '—' : <pre className="mono tiny" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{prettyJson(event.data)}</pre>} />
      <Field label="error" value={event.error ?? '—'} />
      <Field label="initiator" value={event.initiator ? `${event.initiator.kind} · ${event.initiator.label}` : '—'} />
    </div>
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
  if (!record || typeof record !== 'object') return null;
  const { url, method, status, ms, bytes } = record;
  if (url === undefined && ms === undefined && status === undefined) return null;
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
