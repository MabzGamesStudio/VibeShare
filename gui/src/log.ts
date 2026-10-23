// A small debug log the user can watch (Settings → Logs) to see what the app asks of the
// nodes while a .vvsh video plays: every chunk fetch (which index, which encoding, from
// which branch), what came back and the merkle path it verified. Off by default.
export interface LogLine {
  at: string;
  kind: string;
  text: string;
}

const lines: LogLine[] = [];
const listeners = new Set<() => void>();
let enabled = false;

export function setDebugLogs(on: boolean): void {
  enabled = on;
  emit();
}

export function debugLogging(): boolean {
  return enabled;
}

export function debugLog(kind: string, text: string): void {
  if (!enabled) return;
  lines.unshift({ at: new Date().toISOString().slice(11, 23), kind, text });
  if (lines.length > 500) lines.length = 500;
  emit();
}

export function clearLogs(): void {
  lines.length = 0;
  emit();
}

export function logLines(): LogLine[] {
  return [...lines];
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}
