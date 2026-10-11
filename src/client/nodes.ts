import type { AccountResponse, AuthMode, NodeEntry } from '../shared/clientapi.js';
import { RemoteError } from '../shared/http.js';
import { log } from '../shared/log.js';
import { NodeClient } from '../shared/nodeclient.js';
import { formatNodeRef, parseNodeRefs, type NodeType } from '../shared/noderef.js';
import type { ProviderInfo, AlgorithmInfo } from '../shared/protocol.js';
import type { ClientStore } from './state.js';

export function errorText(error: unknown): string {
  if (error instanceof RemoteError) return error.message;
  return (error as Error)?.message ?? String(error);
}

/**
 * The nodes a user chose to use, in priority order. Each node is one copy-pastable
 * reference; adding, removing, reordering and switching nodes never touches the
 * others, so a slow, offline, expensive or disliked node is swapped out in a click.
 */
export class NodeManager {
  private clients = new Map<string, { auth: AuthMode; client: NodeClient }>();

  constructor(private readonly store: ClientStore) {}

  private get nodes(): NodeEntry[] {
    return this.store.data.data.nodes;
  }

  list(type?: NodeType): NodeEntry[] {
    return this.nodes.filter((node) => !type || node.type === type);
  }

  /** Enabled nodes of a type in priority order; nodes known to be offline go last. */
  active(type: NodeType): NodeEntry[] {
    const enabled = this.list(type).filter((node) => node.enabled);
    return [...enabled.filter((node) => node.status.online !== false), ...enabled.filter((node) => node.status.online === false)];
  }

  get(id: string): NodeEntry | undefined {
    return this.nodes.find((node) => node.id === id);
  }

  require(id: string): NodeEntry {
    const node = this.get(id);
    if (!node) throw new RemoteError(404, 'not_found', 'Unknown node');
    return node;
  }

  client(node: NodeEntry): NodeClient {
    const cached = this.clients.get(node.id);
    if (cached && cached.auth === node.auth) {
      cached.client.options.identity = this.store.identity;
      return cached.client;
    }
    const accounts = this.store.accounts;
    const key = `${node.id}:${node.auth}`;
    const client = new NodeClient({
      url: node.url,
      expectedId: node.id,
      expectedType: node.type,
      auth: node.auth,
      identity: this.store.identity,
      account: node.auth === 'anonymous' ? accounts.data.accounts[key] : undefined,
      onAccount: (account) => {
        accounts.data.accounts[key] = account;
        accounts.changed();
      },
    });
    if (node.info) client.info = node.info;
    this.clients.set(node.id, { auth: node.auth, client });
    return client;
  }

  /** Forgets cached sessions (after the identity changed). */
  resetSessions(): void {
    this.clients.clear();
  }

  async add(text: string): Promise<{ added: NodeEntry[]; errors: { ref: string; error: string }[] }> {
    const { refs, invalid } = parseNodeRefs(text);
    const errors = invalid.map((ref) => ({ ref, error: 'Not a node reference or http(s) URL' }));
    // Nodes are checked in parallel but added in the pasted order, which is their priority.
    const results = await Promise.all(
      refs.map(async (ref) => {
        const label = ref.id ? formatNodeRef(ref as Required<typeof ref>) : ref.url;
        try {
          if (ref.id && this.get(ref.id)) throw new Error('Already added');
          const probe = new NodeClient({
            url: ref.url,
            expectedId: ref.id,
            expectedType: ref.type,
            auth: 'anonymous',
            identity: this.store.identity,
          });
          const started = Date.now();
          const info = await probe.fetchInfo();
          return { ok: true as const, ref, info, latencyMs: Date.now() - started };
        } catch (error) {
          return { ok: false as const, label, error: errorText(error) };
        }
      })
    );
    const added: NodeEntry[] = [];
    for (const result of results) {
      if (!result.ok) {
        errors.push({ ref: result.label, error: result.error });
        continue;
      }
      const { ref, info, latencyMs } = result;
      if (this.get(info.id)) {
        errors.push({ ref: formatNodeRef({ type: info.type, id: info.id, url: ref.url }), error: 'Already added' });
        continue;
      }
      const entry: NodeEntry = {
        id: info.id,
        type: info.type,
        url: ref.url,
        name: info.name,
        description: info.description,
        enabled: true,
        auth: this.store.data.data.settings.defaultAuth,
        addedAt: new Date().toISOString(),
        info,
        status: { online: true, latencyMs, checkedAt: new Date().toISOString() },
        ref: formatNodeRef({ type: info.type, id: info.id, url: ref.url }),
      };
      this.nodes.push(entry);
      added.push(entry);
    }
    this.store.changed();
    await Promise.all(added.map((node) => this.refreshBalance(node)));
    return { added, errors };
  }

  remove(id: string): void {
    const index = this.nodes.findIndex((node) => node.id === id);
    if (index < 0) return;
    this.nodes.splice(index, 1);
    this.clients.delete(id);
    this.store.changed();
  }

  update(id: string, patch: Partial<Pick<NodeEntry, 'enabled' | 'auth' | 'maxPrice' | 'name'>>): NodeEntry {
    const node = this.require(id);
    if (patch.enabled !== undefined) node.enabled = Boolean(patch.enabled);
    if (patch.name !== undefined) node.name = String(patch.name).slice(0, 80) || node.info?.name || node.name;
    if (patch.auth !== undefined && ['identity', 'pseudonym', 'anonymous'].includes(patch.auth)) {
      node.auth = patch.auth;
      node.balance = undefined;
      node.accountId = undefined;
    }
    if ('maxPrice' in patch) {
      const value = patch.maxPrice;
      node.maxPrice = value === null || value === undefined || Number.isNaN(Number(value)) ? undefined : Math.max(0, Number(value));
    }
    this.store.changed();
    return node;
  }

  /** Sets the priority order of one node type. */
  reorder(type: NodeType, ids: string[]): void {
    const ofType = this.list(type);
    const ordered = [
      ...ids.map((id) => ofType.find((node) => node.id === id)).filter((node): node is NodeEntry => Boolean(node)),
      ...ofType.filter((node) => !ids.includes(node.id)),
    ];
    const others = this.nodes.filter((node) => node.type !== type);
    this.store.data.data.nodes = type === 'provider' ? [...ordered, ...others] : [...others, ...ordered];
    this.store.changed();
  }

  async refresh(node: NodeEntry): Promise<NodeEntry> {
    const client = this.client(node);
    const started = Date.now();
    try {
      node.info = await client.fetchInfo();
      node.name = node.name || node.info.name;
      node.description = node.info.description;
      node.status = { online: true, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
      await this.refreshBalance(node);
    } catch (error) {
      node.status = { online: false, checkedAt: new Date().toISOString(), error: errorText(error) };
    }
    this.store.changed();
    return node;
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.nodes.map((node) => this.refresh(node)));
  }

  async refreshBalance(node: NodeEntry): Promise<void> {
    try {
      const response = await this.client(node).json<AccountResponse>('/v1/account');
      node.balance = response.account.balance;
      node.accountId = response.account.id;
      this.store.changed();
    } catch (error) {
      log.debug(`Balance of ${node.name}: ${errorText(error)}`);
    }
  }

  setBalance(nodeId: string, balance: number | undefined): void {
    const node = this.get(nodeId);
    if (node && balance !== undefined && node.balance !== balance) {
      node.balance = balance;
      this.store.changed();
    }
  }

  providerPrice(node: NodeEntry): number {
    return (node.info as ProviderInfo | undefined)?.pricing?.perMiB ?? 0;
  }

  /** Whether the user's spending limit allows this node. */
  affordable(node: NodeEntry, price: number): boolean {
    return node.maxPrice === undefined || price <= node.maxPrice;
  }

  algorithmPrice(node: NodeEntry, kind: 'feed' | 'search' | 'lookup' | 'submission'): number {
    return (node.info as AlgorithmInfo | undefined)?.pricing?.[kind] ?? 0;
  }

  exportRefs(type?: NodeType): string {
    return this.list(type)
      .map((node) => node.ref)
      .join('\n');
  }
}
