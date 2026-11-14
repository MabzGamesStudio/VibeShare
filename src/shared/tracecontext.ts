// Trace context propagation for the node-side code (client daemon, provider node,
// algorithm node): one timeline follows one incoming API call (or one action a caller
// names) through every function it reaches, without threading a trace id by hand.
// Node-only: the GUI sends its user-action trace ids over HTTP instead.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/** The trace id of the timeline being recorded right now, if any. */
export function currentTraceId(): string | undefined {
  return storage.getStore();
}

/** Runs `fn` inside one timeline; every trace event it records joins that trace id. */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return storage.run(traceId, fn);
}