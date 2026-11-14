// The trace log as client logic sees it. The daemon passes its TraceStore (which
// satisfies this shape exactly); the web client passes none and everything below stays
// a no-op. Keeping this as a tiny structural type lets the browser-safe client modules
// record trace events without ever importing the node-only trace store.
import { DEFAULT_PAYLOAD_CHARS, type TraceLevel } from '../shared/tracing.js';

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
  /** Shrinks a request/response payload to the capture limit the settings allow. */
  summarize(value: unknown): unknown;
}

/** What code that runs without a daemon (the web client) records into: nothing. */
export const NO_TRACES: TraceLog = {
  trace: () => undefined,
  recorder: { shouldLog: () => false },
  summarize: (value) => value,
};

/** For hosts that are not a TraceStore (tests, stubs): the same cap as the default. */
export function summarizeAt(value: unknown, maxChars: number = DEFAULT_PAYLOAD_CHARS): unknown {
  return typeof value === 'string' && value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}