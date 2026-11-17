import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from './log.js';

/**
 * A JSON document kept in memory and written back atomically (temp file + rename)
 * shortly after each change. `path: null` keeps it in memory only (tests).
 */
export class JsonFile<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;
  /** Applied to the copy that is written out (e.g. to seal hidden profiles at rest). */
  prepare?: (data: T) => T;

  constructor(
    private readonly path: string | null,
    defaults: () => T,
    private readonly delayMs = 250
  ) {
    this.data = defaults();
    if (path && existsSync(path)) {
      try {
        this.data = { ...this.data, ...JSON.parse(readFileSync(path, 'utf8')) };
      } catch (error) {
        const backup = `${path}.corrupt-${Date.now()}`;
        log.error(`Could not read ${path} (${(error as Error).message}); keeping a copy at ${backup}`);
        renameSync(path, backup);
      }
    }
  }

  changed(): void {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, this.delayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeNow();
  }

  private writeNow(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.prepare ? this.prepare(this.data) : this.data));
    renameSync(temp, this.path);
  }
}

/** Append-only JSON lines, for audit trails (credits in and out). */
export class AppendLog {
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: unknown): void {
    if (!this.path) return;
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }
}

/** Where a node keeps its data when no --data directory is given. */
export function defaultDataDir(kind: string): string {
  if (process.env.VIBESHARE_HOME) return join(process.env.VIBESHARE_HOME, kind);
  const home = homedir();
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'VibeShare', kind);
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'VibeShare', kind);
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'vibeshare', kind);
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
