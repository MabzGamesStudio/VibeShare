import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256hex } from '../shared/crypto.js';
import { chunkIdOf } from '../shared/content.js';
import type { NodeEntry, ServiceStatus } from '../shared/clientapi.js';
import { log } from '../shared/log.js';
import type { ProviderInfo, StorageAssignment, StorageOffer, StorageTask } from '../shared/protocol.js';
import { isChunkId } from '../shared/sources.js';
import { errorText, type NodeManager } from './nodes.js';
import type { ClientStore } from './state.js';

const GiB = 1024 ** 3;

interface ProviderState {
  assignments: StorageAssignment[];
  polling: boolean;
  error?: string;
  online: boolean;
}

/**
 * The client's side of the storage service: it accepts storage jobs from providers
 * (within the user's quota), keeps the chunks on disk and answers the providers'
 * retrievals and proof-of-storage challenges — which is how it earns credits.
 */
export class StorageWorker {
  private readonly dir: string;
  private state = new Map<string, ProviderState>();
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private stopped = false;
  private messages: { at: string; message: string }[] = [];

  constructor(
    private readonly store: ClientStore,
    private readonly nodes: NodeManager,
    dataDir: string | null,
    private readonly intervalMs = 60_000
  ) {
    this.dir = join(dataDir ?? join(tmpdir(), 'vibeshare-client'), 'service');
    mkdirSync(this.dir, { recursive: true });
  }

  private get settings() {
    return this.store.data.data.settings.storageService;
  }

  /** Disk offered to one provider node: its own setting, or the shared default. */
  private quotaFor(nodeId: string): number {
    return (this.settings.perProvider?.[nodeId] ?? this.settings.quotaGiB) * GiB;
  }

  /** Bytes of job data a provider's live assignments take. */
  private usedFor(assignments: StorageAssignment[]): number {
    return assignments.filter((a) => a.status === 'active' || a.status === 'downloading').reduce((sum, a) => sum + a.bytes, 0);
  }

  private note(message: string): void {
    this.messages.unshift({ at: new Date().toISOString(), message });
    this.messages.length = Math.min(this.messages.length, 60);
    log.info(`[storage service] ${message}`);
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
    this.timer.unref();
    void this.sync();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private eligible(): NodeEntry[] {
    const chosen = this.settings.providers;
    return this.nodes
      .list('provider')
      .filter((node) => node.enabled && (node.info as ProviderInfo | undefined)?.services?.storage?.enabled)
      .filter((node) => !chosen.length || chosen.includes(node.id));
  }

  usedBytes(): number {
    let total = 0;
    for (const name of readdirSync(this.dir)) if (isChunkId(name)) total += statSync(join(this.dir, name)).size;
    return total;
  }

  /** Accepts offers, finishes downloads, starts task polling and removes data no longer needed. */
  async sync(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      if (!this.settings.enabled) return;
      let complete = true;
      for (const provider of this.eligible()) {
        const state = this.state.get(provider.id) ?? { assignments: [], polling: false, online: false };
        this.state.set(provider.id, state);
        try {
          const client = this.nodes.client(provider);
          state.assignments = (await client.json<{ assignments: StorageAssignment[] }>('/v1/services/storage/assignments')).assignments;
          state.online = true;
          state.error = undefined;
          for (const assignment of state.assignments.filter((a) => a.status === 'downloading')) {
            await this.download(provider, assignment);
          }
          const { offers } = await client.json<{ offers: StorageOffer[] }>('/v1/services/storage/offers');
          const value = (offer: StorageOffer) =>
            (offer.rewards.upfront + offer.rewards.completion + offer.rewards.perChallenge * 10 + offer.rewards.perRetrieval * 10) /
            Math.max(offer.bytes / GiB, 0.001);
          const quota = this.quotaFor(provider.id);
          let offered = this.usedFor(state.assignments);
          for (const offer of offers.sort((a, b) => value(b) - value(a))) {
            if (offer.requireIdentity && provider.auth === 'anonymous') continue;
            if (offered + offer.bytes > quota) continue;
            const assignment = await client.json<StorageAssignment>(`/v1/services/storage/offers/${offer.id}/accept`, { method: 'POST' });
            this.note(`Accepted "${offer.title ?? offer.id}" from ${provider.name} (${(offer.bytes / 1024 ** 2).toFixed(1)} MiB)`);
            offered += offer.bytes;
            state.assignments.push(assignment);
            await this.download(provider, assignment);
          }
          if (!state.polling && state.assignments.some((a) => a.status === 'active' || a.status === 'downloading')) {
            void this.poll(provider);
          }
        } catch (error) {
          complete = false;
          state.online = false;
          state.error = errorText(error);
        }
      }
      if (complete) await this.cleanup();
    } finally {
      this.syncing = false;
    }
  }

  private async download(provider: NodeEntry, assignment: StorageAssignment): Promise<void> {
    const client = this.nodes.client(provider);
    for (const chunkId of assignment.chunkIds) {
      const file = join(this.dir, chunkId);
      if (existsSync(file)) continue;
      const response = await client.fetch(`/v1/services/storage/assignments/${assignment.id}/chunks/${chunkId}`, { timeoutMs: 120000 });
      const data = Buffer.from(await response.arrayBuffer());
      if (chunkIdOf(data) !== chunkId) throw new Error('The provider sent a corrupt chunk');
      await writeFile(file, data);
    }
    const ready = await client.json<StorageAssignment>(`/v1/services/storage/assignments/${assignment.id}/ready`, { method: 'POST' });
    Object.assign(assignment, ready);
  }

  /** Long-polls a provider for tasks while there is anything to answer for. */
  private async poll(provider: NodeEntry): Promise<void> {
    const state = this.state.get(provider.id);
    if (!state || state.polling) return;
    state.polling = true;
    try {
      while (!this.stopped && this.settings.enabled && this.nodes.get(provider.id)?.enabled) {
        if (!state.assignments.some((a) => a.status === 'active' || a.status === 'downloading')) break;
        try {
          const client = this.nodes.client(provider);
          const { tasks } = await client.json<{ tasks: StorageTask[] }>('/v1/services/storage/tasks?wait=25', { timeoutMs: 40000 });
          state.online = true;
          for (const task of tasks) await this.answer(provider, task);
        } catch (error) {
          state.online = false;
          state.error = errorText(error);
          await new Promise((resolve) => setTimeout(resolve, 10_000).unref());
        }
      }
    } finally {
      state.polling = false;
    }
  }

  private async answer(provider: NodeEntry, task: StorageTask): Promise<void> {
    let data: Buffer;
    try {
      data = await readFile(join(this.dir, task.chunkId));
    } catch {
      this.note(`Missing chunk ${task.chunkId.slice(0, 12)}… asked by ${provider.name}`);
      return;
    }
    const body = task.type === 'challenge' && task.nonce ? Buffer.from(sha256hex(Buffer.concat([Buffer.from(task.nonce), data]))) : data;
    try {
      const result = await this.nodes
        .client(provider)
        .json<{ credited: number; balance?: number }>(`/v1/services/storage/tasks/${task.id}`, { method: 'POST', raw: body });
      if (result.balance !== undefined) this.nodes.setBalance(provider.id, result.balance);
      if (result.credited) this.note(`Earned ${result.credited} credits from ${provider.name} (${task.type})`);
    } catch (error) {
      this.note(`Task from ${provider.name} failed: ${errorText(error)}`);
    }
  }

  /** Deletes chunks that no live assignment (on any provider) needs any more. */
  private async cleanup(): Promise<void> {
    const keep = new Set<string>();
    for (const state of this.state.values()) {
      for (const assignment of state.assignments) {
        if (assignment.status === 'active' || assignment.status === 'downloading') for (const id of assignment.chunkIds) keep.add(id);
      }
    }
    for (const name of readdirSync(this.dir)) {
      if (isChunkId(name) && !keep.has(name)) await rm(join(this.dir, name), { force: true });
    }
  }

  /** Gives back every assignment of a provider (or all) and deletes the data. */
  async releaseAll(providerId?: string): Promise<void> {
    for (const [id, state] of this.state) {
      if (providerId && id !== providerId) continue;
      const node = this.nodes.get(id);
      if (!node) continue;
      for (const assignment of state.assignments.filter((a) => a.status === 'active' || a.status === 'downloading')) {
        try {
          Object.assign(assignment, await this.nodes.client(node).json(`/v1/services/storage/assignments/${assignment.id}/release`, { method: 'POST' }));
        } catch (error) {
          this.note(`Could not release ${assignment.id}: ${errorText(error)}`);
        }
      }
    }
    await this.cleanup();
  }

  status(): ServiceStatus {
    const providers = this.eligible().map((node) => {
      const state = this.state.get(node.id);
      const assignments = state?.assignments ?? [];
      return {
        id: node.id,
        name: node.name,
        online: state?.online ?? false,
        quotaBytes: this.quotaFor(node.id),
        usedBytes: this.usedFor(assignments),
        assignments,
        earned: assignments.reduce((sum, a) => sum + a.earned, 0),
        error: state?.error,
      };
    });
    return {
      enabled: this.settings.enabled,
      quotaBytes: providers.reduce((sum, provider) => sum + provider.quotaBytes, 0),
      usedBytes: this.usedBytes(),
      providers,
      log: this.messages,
    };
  }
}
