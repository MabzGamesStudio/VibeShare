// Tiny leveled logger. VIBESHARE_LOG=debug|info|warn|error|silent (default info).
const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
type Level = (typeof LEVELS)[number];

// (Also runs in browsers, which have no process.)
const configured = typeof process !== 'undefined' ? process.env?.VIBESHARE_LOG : undefined;
let current: Level = (LEVELS as readonly string[]).includes(configured ?? '') ? (configured as Level) : 'info';

function enabled(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(current);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  setLevel(level: Level) {
    current = level;
  },
  debug(...args: unknown[]) {
    if (enabled('debug')) console.debug(stamp(), ...args);
  },
  info(...args: unknown[]) {
    if (enabled('info')) console.log(stamp(), ...args);
  },
  warn(...args: unknown[]) {
    if (enabled('warn')) console.warn(stamp(), ...args);
  },
  error(...args: unknown[]) {
    if (enabled('error')) console.error(stamp(), ...args);
  },
};
