// The tracing GUI, shared by the client (Settings → Tracing) and the node admin
// consoles (a standalone Tracing tab): the settings form (on/off, expiration, the
// selectable levels, how much of a payload to keep) and the log view — keyword
// search, time span, level filters, one expandable timeline per user action or API
// start holding everything it caused, plus copy/paste so traces can travel between
// machines and consoles.
import { useEffect, useMemo, useState } from 'react';
import type { TraceEvent, TraceLevel, TraceSettings, TraceTimeline } from '../../../src/shared/tracing.js';
import { TRACE_LEVELS } from '../../../src/shared/tracing.js';

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
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [pasted, setPasted] = useState<TraceEvent[] | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((answer) => setSettings(answer.settings)).catch(() => undefined);
  }, [api]);

  const load = () => {
    setLoading(true);
    setError(null);
    setPasted(null);
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

  const toggleSelected = (id: string) => setSelected((current) => ({ ...current, [id]: !current[id] }));
  const selectedEvents = useMemo(() => events.filter((event) => selected[event.id]), [events, selected]);
  const copied = (text: string, what: string) => copyText(text).then(() => setNotice(`${what} copied to the clipboard.`));

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
        {notice && <div className="banner info small">{notice}</div>}
        {error && <div className="banner danger small">{error}</div>}
        {mode === 'events' ? (
          <div className="form-stack" style={{ gap: 6, maxHeight: 480, overflowY: 'auto' }}>
            {events.map((event) => (
              <EventRow key={event.id} event={event} selected={Boolean(selected[event.id])} onToggle={() => toggleSelected(event.id)} />
            ))}
            {!events.length && !loading && <p className="small muted">Nothing recorded yet — tracing is off, or no events match.</p>}
          </div>
        ) : (
          <div className="form-stack" style={{ gap: 8, maxHeight: 480, overflowY: 'auto' }}>
            {timelines.map((timeline) => (
              <div key={timeline.traceId} className="card form-stack" style={{ padding: 10, margin: 0 }}>
                <button className="row between" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpenTrace(openTrace === timeline.traceId ? null : timeline.traceId)}>
                  <span className="small">
                    <strong>{timeline.initiator?.label ?? 'Timeline'}</strong>
                    <span className="faint"> · {timeline.initiator?.kind ?? 'event'} · started {new Date(timeline.startedAt).toLocaleString()}</span>
                  </span>
                  <span className="tiny faint">{timeline.events.length} events {openTrace === timeline.traceId ? '▾' : '▸'}</span>
                </button>
                <div className="row small" style={{ gap: 8, paddingLeft: 4 }}>
                  <button
                    className="tiny"
                    onClick={() => void copied(textOfEvents(timeline.events), 'Timeline')}
                    title="Copy every event of this timeline as text"
                  >
                    Copy timeline
                  </button>
                  <button
                    className="tiny"
                    onClick={() => void copied(textOfEvents(timeline.events, 'json'), 'Timeline (JSON)')}
                    title="Copy every event of this timeline as JSON"
                  >
                    Copy as JSON
                  </button>
                </div>
                {openTrace === timeline.traceId && (
                  <div className="form-stack" style={{ gap: 4, paddingLeft: 8 }}>
                    {timeline.events.map((event) => (
                      <EventRow key={event.id} event={event} selected={Boolean(selected[event.id])} onToggle={() => toggleSelected(event.id)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!timelines.length && !loading && <p className="small muted">No timelines yet — each user action or API call starts one.</p>}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button
            className="small"
            disabled={!selectedEvents.length}
            onClick={() => void copied(textOfEvents(selectedEvents), `${selectedEvents.length} selected event${selectedEvents.length === 1 ? '' : 's'}`)}
            title="Copy the ticked events as text"
          >
            Copy selected{selectedEvents.length ? ` (${selectedEvents.length})` : ''}
          </button>
          <button
            className="small"
            disabled={!selectedEvents.length}
            onClick={() => void copied(textOfEvents(selectedEvents, 'json'), `${selectedEvents.length} selected event${selectedEvents.length === 1 ? '' : 's'} (JSON)`)}
            title="Copy the ticked events as JSON"
          >
            Copy selected as JSON
          </button>
          <button className="small" onClick={() => setSelected({})} disabled={!Object.keys(selected).length}>
            Unselect all
          </button>
        </div>
      </div>
      <PastePanel
        text={pasteText}
        onText={setPasteText}
        parsed={pasted}
        onParsed={setPasted}
        notice={notice}
        onNotice={setNotice}
      />
      {pasted && (
        <div className="card form-stack">
          <h3>Pasted traces</h3>
          <p className="small muted">{pasted.length} event{pasted.length === 1 ? '' : 's'} from the clipboard — shown here only; nothing is recorded on this node.</p>
          <div className="form-stack" style={{ gap: 6, maxHeight: 480, overflowY: 'auto' }}>
            {pasted.map((event) => (
              <EventRow key={event.id} event={event} selected={false} onToggle={() => undefined} />
            ))}
          </div>
          <button className="small" onClick={() => setPasted(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Copy text to the clipboard: the browser API when it works, a textarea when not. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // clipboard access denied or unavailable: fall back to a hidden textarea.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
}

/** The share format: one line per event as text, or the same events as JSON. */
function textOfEvents(events: TraceEvent[], format: 'text' | 'json' = 'text'): string {
  if (format === 'json') return JSON.stringify(events, null, 2);
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

/** Parses the text/JSON format back into events (lenient: any shape of event counts). */
function parseTraceText(text: string): TraceEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.filter((entry): entry is TraceEvent => Boolean(entry) && typeof entry === 'object' && typeof (entry as TraceEvent).at === 'string');
    } catch {
      return [];
    }
  }
  // The one-line-per-event text format: `time [level] component action — message … (trace id)`.
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): TraceEvent | null => {
      const trace = /\(trace ([^)]+)\)\s*$/.exec(line);
      const at = /^\S+/.exec(line)?.[0] ?? '';
      const level = /\[(\w+)\]/.exec(line)?.[1] as TraceLevel | undefined;
      if (!at || !level) return null;
      const body = line.replace(at, '').replace(`[${level}]`, '').replace(/\(trace [^)]+\)\s*$/, '').trim();
      const [component, ...rest] = body.split(/\s+/);
      return {
        id: `pasted-${Math.random().toString(36).slice(2, 10)}`,
        traceId: trace?.[1] ?? 'pasted',
        at,
        level,
        source: 'pasted',
        component: component ?? 'pasted',
        action: rest.join(' ') || 'pasted',
      };
    })
    .filter((entry): entry is TraceEvent => Boolean(entry));
}

/** The paste box: pasted traces show up as a temporary local view below the log. */
function PastePanel({
  text,
  onText,
  parsed,
  onParsed,
  notice,
  onNotice,
}: {
  text: string;
  onText: (text: string) => void;
  parsed: TraceEvent[] | null;
  onParsed: (events: TraceEvent[] | null) => void;
  notice: string | null;
  onNotice: (notice: string | null) => void;
}) {
  return (
    <div className="card form-stack">
      <h3>Paste traces</h3>
      <p className="small muted">
        Paste events or timelines copied from another console here (text or JSON) to read them locally — nothing is recorded on this node.
      </p>
      <textarea
        className="mono"
        rows={4}
        placeholder="Paste trace text or JSON here…"
        value={text}
        onChange={(e) => onText(e.target.value)}
        spellCheck={false}
      />
      <div className="row" style={{ gap: 8 }}>
        <button
          className="small primary"
          disabled={!text.trim()}
          onClick={() => {
            const events = parseTraceText(text);
            onParsed(events.length ? events : null);
            onNotice(events.length ? `${events.length} pasted event${events.length === 1 ? '' : 's'} shown below.` : 'Nothing trace-like in that text.');
          }}
        >
          Show pasted traces
        </button>
        <button
          className="small"
          disabled={!text.trim()}
          onClick={() => {
            onText('');
            onParsed(null);
            onNotice(null);
          }}
        >
          Clear
        </button>
      </div>
      {notice && !parsed && <div className="banner info small">{notice}</div>}
    </div>
  );
}

function EventRow({ event, selected, onToggle }: { event: TraceEvent; selected: boolean; onToggle: () => void }) {
  return (
    <div className="row small" style={{ gap: 8, alignItems: 'baseline' }}>
      <input type="checkbox" checked={selected} onChange={onToggle} title="Select this event to copy" />
      <span className={`badge ${event.level === 'error' ? 'danger' : event.level === 'dependency' ? 'ok' : ''}`}>{event.level}</span>
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
