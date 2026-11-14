// Tracing and logging core, shared by the client daemon, the provider node and the
// search algorithm node. Every node records trace events locally and shows them in a
// tracing view (search, time span, levels, and one timeline per user action or API
// start, holding every log line that action caused).
//
// Tracing is OFF by default — nothing is recorded, and every call below is a cheap
// no-op, until the operator (or the user) turns it on. The levels are picked one by
// one: basic (algorithms and functions), detail (user actions, button clicks,
// changes, function detail and data), dependency (APIs) and error. Basic,
// dependency and error are pre-selected when tracing is first turned on.

/** What a trace event is about. Detail is the chatty one and is not pre-selected. */
export type TraceLevel = 'basic' | 'detail' | 'dependency' | 'error';

export const TRACE_LEVELS: readonly TraceLevel[] = ['basic', 'detail', 'dependency', 'error'];

export interface TraceSettings {
  /** Master switch: nothing at all is recorded while this is false. Off by default. */
  enabled: boolean;
  /** Hours a trace event is kept before it is pruned (default 24). */
  expirationHours: number;
  /** The levels that are recorded at all (toggle-able one by one). */
  levels: Record<TraceLevel, boolean>;
}

/** Off by default; when first enabled the useful levels are already picked. */
export function defaultTraceSettings(): TraceSettings {
  return {
    enabled: false,
    expirationHours: 24,
    levels: { basic: true, detail: false, dependency: true, error: true },
  };
}

/** Lenient: anything odd or missing in saved settings snaps back to the defaults. */
export function normalizeTraceSettings(saved: unknown): TraceSettings {
  const defaults = defaultTraceSettings();
  const value = (saved ?? {}) as Partial<TraceSettings> & { levels?: Partial<Record<TraceLevel, unknown>> };
  const levels: Partial<Record<TraceLevel, unknown>> = value.levels ?? {};
  return {
    enabled: value.enabled === true,
    expirationHours: Number.isFinite(Number(value.expirationHours)) && Number(value.expirationHours) > 0 ? Math.round(Number(value.expirationHours)) : defaults.expirationHours,
    levels: {
      basic: levels.basic === true,
      detail: levels.detail === true,
      dependency: levels.dependency === true,
      error: levels.error === true,
    },
  };
}

/** Who started a timeline: a user action in a GUI, or an incoming API call. */
export interface TraceInitiator {
  kind: 'user-action' | 'api';
  /** "button:Check this step", "GET /api/feed", "change:theme", … */
  label: string;
}

export interface TraceEvent {
  id: string;
  /** Groups the events of one timeline: from the initiator through all it caused. */
  traceId: string;
  /** ISO timestamp. */
  at: string;
  level: TraceLevel;
  /** Which node recorded this: 'client' | 'provider' | 'algorithm'. */
  source: string;
  /** Where in the code: 'core.feed', 'provider.service', 'daemon.api', 'gui', … */
  component: string;
  /** What happened: 'GET /api/feed', 'button:Save', 'function:fetchPage', … */
  action: string;
  message?: string;
  /** Small JSON-serializable detail (function data, request/response shape, …). */
  data?: unknown;
  error?: string;
  /** Set on the first event of a timeline only. */
  initiator?: TraceInitiator;
}

export interface TraceFilter {
  /** Case-insensitive substring over action, message, component and error. */
  query?: string;
  /** ISO timestamps bounding the time span (inclusive). */
  from?: string;
  to?: string;
  /** Only these levels (empty/undefined = all). */
  levels?: TraceLevel[];
  /** Only events of one timeline. */
  traceId?: string;
}

export interface TraceTimeline {
  traceId: string;
  initiator?: TraceInitiator;
  startedAt: string;
  /** Every event of the timeline in recording order. */
  events: TraceEvent[];
}

export function matchesFilter(event: TraceEvent, filter: TraceFilter): boolean {
  if (filter.traceId && event.traceId !== filter.traceId) return false;
  if (filter.levels?.length && !filter.levels.includes(event.level)) return false;
  if (filter.from && event.at < filter.from) return false;
  if (filter.to && event.at > filter.to) return false;
  if (filter.query) {
    const needle = filter.query.toLowerCase();
    const haystack = `${event.component} ${event.action} ${event.message ?? ''} ${event.error ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function filterEvents(events: TraceEvent[], filter: TraceFilter): TraceEvent[] {
  return events.filter((event) => matchesFilter(event, filter));
}

/** Groups events by timeline, newest timeline first, events in recording order. */
export function buildTimelines(events: TraceEvent[]): TraceTimeline[] {
  const byTrace = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const list = byTrace.get(event.traceId);
    if (list) list.push(event);
    else byTrace.set(event.traceId, [event]);
  }
  return [...byTrace.values()]
    .map((list) => {
      const first = list[0];
      return {
        traceId: first.traceId,
        initiator: list.find((event) => event.initiator)?.initiator ?? first.initiator,
        startedAt: first.at,
        events: list,
      };
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

let counter = 0;
function nextId(): string {
  counter = (counter + 1) % 0xffffff;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return random;
}

export interface RecorderOptions {
  /** 'client' | 'provider' | 'algorithm'. */
  source: string;
  /** Read fresh on every call, so flipping the setting takes effect immediately. */
  settings: () => TraceSettings;
  /** Persists each recorded event (e.g. append to a local JSON-lines file). */
  sink?: (event: TraceEvent) => void;
  /** In-memory cap; the oldest events are dropped first (default 50,000). */
  maxEvents?: number;
}

/**
 * The recorder every node keeps one of. With tracing off (or the level unticked)
 * `event()` returns immediately — instrumentation through the codebase stays cheap.
 */
export class TraceRecorder {
  private events: TraceEvent[] = [];

  constructor(private readonly options: RecorderOptions) {}

  /** Whether a level would be recorded right now (for expensive detail payloads). */
  shouldLog(level: TraceLevel): boolean {
    const settings = this.options.settings();
    return settings.enabled && Boolean(settings.levels[level]);
  }

  /** Starts a timeline and returns its id. `parentTraceId` joins an existing one. */
  start(initiator: TraceInitiator, parentTraceId?: string): string {
    const traceId = parentTraceId || nextId();
    this.event('detail', this.options.source, `initiator:${initiator.label}`, {
      traceId,
      initiator: parentTraceId ? undefined : initiator,
    });
    return traceId;
  }

  /** Records one event. A no-op unless tracing is on and the level is picked. */
  event(
    level: TraceLevel,
    component: string,
    action: string,
    options: { message?: string; data?: unknown; error?: string; traceId?: string; initiator?: TraceInitiator } = {}
  ): void {
    if (!this.shouldLog(level)) return;
    const settings = this.options.settings();
    const event: TraceEvent = {
      id: nextId(),
      traceId: options.traceId ?? nextId(),
      at: new Date().toISOString(),
      level,
      source: this.options.source,
      component,
      action,
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.data !== undefined ? { data: options.data } : {}),
      ...(options.error !== undefined ? { error: options.error } : {}),
      ...(options.initiator ? { initiator: options.initiator } : {}),
    };
    this.events.push(event);
    if (this.events.length > (this.options.maxEvents ?? 50_000)) this.events.splice(0, this.events.length - (this.options.maxEvents ?? 50_000));
    this.options.sink?.(event);
    void settings; // expiry is applied by prune(); keeping the read here documents the gate
  }

  /** Drops events older than the configured expiration. */
  prune(): void {
    const hours = this.options.settings().expirationHours;
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    this.events = this.events.filter((event) => event.at >= cutoff);
  }

  /** The recorded events (already pruned against the current expiration). */
  all(): TraceEvent[] {
    this.prune();
    return [...this.events];
  }

  /** Replaces the in-memory list (used when loading a log file at startup). */
  load(events: TraceEvent[]): void {
    this.events = [...events];
    this.prune();
  }

  query(filter: TraceFilter = {}, limit = 200, offset = 0): { events: TraceEvent[]; total: number } {
    const found = filterEvents(this.all(), filter).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return { events: found.slice(offset, offset + limit), total: found.length };
  }

  /** Timelines over the filtered events, newest first, each with its full event list. */
  timelines(filter: TraceFilter = {}, limit = 50, offset = 0): { timelines: TraceTimeline[]; total: number } {
    // A timeline shows every event it caused even when a level filter hides some:
    // only the query/trace/time filters pick the timelines themselves.
    const scoped = filterEvents(this.all(), { ...filter, levels: undefined });
    const timelines = buildTimelines(scoped);
    return { timelines: timelines.slice(offset, offset + limit), total: timelines.length };
  }

  clear(): number {
    const count = this.events.length;
    this.events = [];
    return count;
  }
}

/**
 * Parses a `levels=a,b,c` style query value (comma separated TraceLevel names).
 * Unknown names are ignored.
 */
export function parseLevels(value: unknown): TraceLevel[] | undefined {
  const list = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is TraceLevel => (TRACE_LEVELS as readonly string[]).includes(entry));
  return list.length ? list : undefined;
}

/** Parses an ISO timestamp query value; invalid input becomes undefined. */
export function parseTime(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
