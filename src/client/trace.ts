// The trace log as client logic sees it. The daemon passes its TraceStore (which
// satisfies this shape exactly); the web client passes none and everything below stays
// a no-op. Keeping this as a tiny structural type lets the browser-safe client modules
// record trace events without ever importing the node-only trace store.
import type { TraceLevel } from '../shared/tracing.js';

export interface TraceCall {
  message?: string;
  /** Small JSON-serializable summary (ids, counts, statuses — never big blobs). */
  data?: unknown;
  error?: string;
  /** Joins an existing timeline instead of recording one of its own. */
  traceId?: string;
}

export interface TraceLog {
  /** Records one event in the timeline running right now (a no-op while tracing is off). */
  trace(level: TraceLevel, component: string, action: string, options?: TraceCall): void;
  /** For expensive detail payloads: only build them when they would be recorded. */
  readonly recorder: { shouldLog(level: TraceLevel): boolean };
}

/** What code that runs without a daemon (the web client) records into: nothing. */
export const NO_TRACES: TraceLog = {
  trace: () => undefined,
  recorder: { shouldLog: () => false },
};