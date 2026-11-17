// The node-side half of tracing: one local trace store per node (client daemon,
// provider, search algorithm), persisted as JSON lines on disk, with the HTTP routes
// every node serves in the same shape — so the tracing view talks to a provider node,
// an algorithm node or the client daemon the same way.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeType } from '../noderef.js';
import { readJson, type Ctx, type Router } from './http.js';
import { AppendLog, ensureDir } from './store.js';
import {
  TraceRecorder,
  parseLevels,
  parseTime,
  normalizeTraceSettings,
  summarize,
  type TraceEvent,
  type TraceFilter,
  type TraceSettings,
  type TraceTimeline,
} from '../tracing.js';
import { runWithTrace, currentTraceId } from './tracecontext.js';

export interface TraceQuery {
  query?: string;
  from?: string;
  to?: string;
  levels?: string;
  traceId?: string;
  limit?: number | string;
  offset?: number | string;
}

/** One node's local trace log: the recorder plus its JSON-lines file. */
export class TraceStore {
  readonly recorder: TraceRecorder;
  private readonly file: AppendLog;

  constructor(
    /** 'client', or any registered node kind ('provider', 'algorithm', or a fork's). */
    private readonly source: 'client' | NodeType,
    private readonly dir: string | null,
    private readonly settings: () => TraceSettings,
    private readonly saveSettings?: (settings: TraceSettings) => void | Promise<void>
  ) {
    this.file = new AppendLog(dir ? join(dir, 'traces.jsonl') : null);
    this.recorder = new TraceRecorder({
      source,
      settings: () => this.settings(),
      sink: (event) => this.file.append(event),
    });
    this.load();
  }

  /** Reads the persisted events back (a fresh run keeps the timeline history). */
  private load(): void {
    if (!this.dir) return;
    try {
      const text = readFileSync(join(this.dir, 'traces.jsonl'), 'utf8');
      const events = text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as TraceEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is TraceEvent => Boolean(event));
      this.recorder.load(events);
    } catch {
      // No file yet: the log starts empty.
    }
  }

  /** Records one event in the timeline currently running (or one of its own). */
  trace(level: TraceEvent['level'], component: string, action: string, options: { message?: string; data?: unknown; error?: string; traceId?: string } = {}): void {
    this.recorder.event(level, component, action, { ...options, traceId: options.traceId ?? currentTraceId() });
  }

  /**
   * Shrinks a request/response payload to what the settings let be recorded —
   * the capture limit the operator picks in the tracing settings.
   */
  summarize(value: unknown): unknown {
    return summarize(value, this.settingsView().payloadChars);
  }

  /** Wraps an API handler: one timeline per call, dependency-logged, errors caught. */
  async api<T>(label: string, body: unknown, fn: (traceId: string) => Promise<T>): Promise<T> {
    const traceId = this.recorder.start({ kind: 'api', label });
    this.trace('dependency', 'api', label, { traceId, data: this.summarize(body) });
    try {
      const result = await runWithTrace(traceId, () => fn(traceId));
      this.trace('dependency', 'api', `${label} → ok`, { traceId });
      return result;
    } catch (error) {
      this.trace('error', 'api', `${label} → failed`, { traceId, error: (error as Error).message });
      throw error;
    }
  }

  /** Called when the settings changed elsewhere (config reload). */
  settingsView(): TraceSettings {
    return normalizeTraceSettings(this.settings());
  }

  async updateSettings(patch: Partial<TraceSettings>): Promise<TraceSettings> {
    const merged = normalizeTraceSettings({
      ...this.settingsView(),
      ...patch,
      levels: { ...this.settingsView().levels, ...(patch.levels ?? {}) },
    });
    await this.saveSettings?.(merged);
    return merged;
  }

  query(input: TraceQuery): { events: TraceEvent[]; total: number } {
    const filter = filterOf(input);
    return this.recorder.query(filter, clamp(input.limit, 200), clamp(input.offset, 0));
  }

  timelines(input: TraceQuery): { timelines: TraceTimeline[]; total: number } {
    const filter = filterOf(input);
    return this.recorder.timelines(filter, clamp(input.limit, 50), clamp(input.offset, 0));
  }

  clear(): number {
    return this.recorder.clear();
  }

  /** For the node info endpoint: what this node's tracing keeps. */
  info(): { enabled: boolean; expirationHours: number } {
    const settings = this.settingsView();
    return { enabled: settings.enabled, expirationHours: settings.expirationHours };
  }
}

function filterOf(input: TraceQuery): TraceFilter {
  return {
    query: input.query?.trim() || undefined,
    from: parseTime(input.from),
    to: parseTime(input.to),
    levels: parseLevels(input.levels),
    traceId: input.traceId?.trim() || undefined,
  };
}

function clamp(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1000) : fallback;
}

/** Registers the same tracing API on any router, behind the caller's own auth. */
export function tracingRoutes(router: Router, store: TraceStore, base: string, guard: (ctx: Ctx) => void): void {
  const queryOf = (ctx: Ctx): TraceQuery => ({
    query: ctx.query.get('query') ?? undefined,
    from: ctx.query.get('from') ?? undefined,
    to: ctx.query.get('to') ?? undefined,
    levels: ctx.query.get('levels') ?? undefined,
    traceId: ctx.query.get('traceId') ?? undefined,
    limit: ctx.query.get('limit') ?? undefined,
    offset: ctx.query.get('offset') ?? undefined,
  });
  router.get(`${base}/settings`, (ctx) => {
    guard(ctx);
    return { settings: store.settingsView() };
  });
  router.put(`${base}/settings`, async (ctx) => {
    guard(ctx);
    const body = await readJson<Partial<TraceSettings>>(ctx.req);
    return { settings: await store.updateSettings(body ?? {}) };
  });
  router.get(`${base}/events`, (ctx) => {
    guard(ctx);
    return store.query(queryOf(ctx));
  });
  router.get(`${base}/timelines`, (ctx) => {
    guard(ctx);
    return store.timelines(queryOf(ctx));
  });
  router.delete(`${base}/events`, (ctx) => {
    guard(ctx);
    return { cleared: store.clear() };
  });
}

/** Ensures a node's data directory exists for the trace file. */
export function traceDir(dir: string): string {
  return ensureDir(dir);
}