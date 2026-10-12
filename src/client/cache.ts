import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isChunkId } from '../shared/sources.js';
import type { ChunkStore } from './model.js';

/**
 * Chunks already downloaded, kept on disk (or in memory) up to a size limit and
 * evicted least-recently-used first. Rewatching or seeking costs no credits.
 */
export class ChunkCache implements ChunkStore {
  private entries = new Map<string, number>();
  private memory = new Map<string, Buffer>();
  private used = 0;

  constructor(
    private readonly dir: string | null,
    private limitBytes: () => number
  ) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir)
      .filter(isChunkId)
      .map((name) => {
        const stats = statSync(join(dir, name));
        return { name, size: stats.size, time: stats.atimeMs };
      })
      .sort((a, b) => a.time - b.time);
    for (const file of files) {
      this.entries.set(file.name, file.size);
      this.used += file.size;
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  async get(id: string): Promise<Buffer | null> {
    const size = this.entries.get(id);
    if (size === undefined) return null;
    this.entries.delete(id);
    this.entries.set(id, size);
    if (!this.dir) return this.memory.get(id) ?? null;
    try {
      return await readFile(join(this.dir, id));
    } catch {
      this.entries.delete(id);
      this.used -= size;
      return null;
    }
  }

  async put(id: string, data: Buffer): Promise<void> {
    if (this.entries.has(id) || data.length > this.limitBytes()) return;
    if (this.dir) {
      const temp = join(this.dir, `${id}.tmp`);
      await writeFile(temp, data);
      await rename(temp, join(this.dir, id));
    } else this.memory.set(id, data);
    this.entries.set(id, data.length);
    this.used += data.length;
    await this.evict();
  }

  private async evict(): Promise<void> {
    const limit = this.limitBytes();
    for (const [id, size] of this.entries) {
      if (this.used <= limit) break;
      this.entries.delete(id);
      this.used -= size;
      if (this.dir) await rm(join(this.dir, id), { force: true });
      else this.memory.delete(id);
    }
  }

  usage(): { bytes: number; chunks: number } {
    return { bytes: this.used, chunks: this.entries.size };
  }

  async clear(): Promise<void> {
    for (const id of [...this.entries.keys()]) {
      if (this.dir) await rm(join(this.dir, id), { force: true });
    }
    this.entries.clear();
    this.memory.clear();
    this.used = 0;
  }
}
