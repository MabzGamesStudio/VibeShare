// The client's local API (what the GUI calls), as a table of routes on top of
// ClientCore. The daemon mounts it on its HTTP server; the web client answers the same
// routes in a service worker. Browser-safe.
import type { ExternalPublishRequest, NodeEntry, PublishRequest, Settings } from '../shared/clientapi.js';
import { MiB } from '../shared/content.js';
import { badRequest, notFound } from '../shared/errors.js';
import type { Invoice, Preferences } from '../shared/protocol.js';
import type { ClientCore } from './core.js';
import { formatSeed, parseSeed } from './model.js';

export interface ApiRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  /** The JSON body ({} when empty); larger bodies than `limit` bytes are refused. */
  json<T = Record<string, unknown>>(limit?: number): Promise<T>;
}

export interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: (request: ApiRequest) => unknown;
}

export function clientRoutes(core: ClientCore): ApiRoute[] {
  const { nodes } = core;
  const routes: ApiRoute[] = [];
  const on = (method: ApiRoute['method'], path: string, handler: ApiRoute['handler']) => routes.push({ method, path, handler });
  const node = (request: ApiRequest) => nodes.require(request.params.id);

  on('GET', '/api/state', () => core.state());

  // Nodes: add by pasting references, remove, reorder, enable/disable, account mode, price limit.
  on('POST', '/api/nodes', async (request) => {
    const body = await request.json<{ text?: string }>();
    if (!body.text?.trim()) throw badRequest('Paste one or more node references');
    return nodes.add(body.text);
  });
  on('GET', '/api/nodes/export', (request) => ({ text: nodes.exportRefs((request.query.get('type') as 'provider') ?? undefined) }));
  on('PATCH', '/api/nodes/:id', async (request) => {
    const body = await request.json<Partial<NodeEntry>>();
    const updated = nodes.update(request.params.id, body);
    if (body.auth) void nodes.refreshBalance(updated);
    return updated;
  });
  on('DELETE', '/api/nodes/:id', async (request) => {
    await core.removeNode(request.params.id, request.query.get('release') === '1');
    return { ok: true };
  });
  on('POST', '/api/nodes/order', async (request) => {
    const body = await request.json<{ type?: 'provider' | 'algorithm'; ids?: string[] }>();
    if (body.type !== 'provider' && body.type !== 'algorithm') throw badRequest('type is provider or algorithm');
    nodes.reorder(body.type, (body.ids ?? []).map(String));
    return { nodes: nodes.list() };
  });
  on('POST', '/api/nodes/:id/refresh', (request) => nodes.refresh(node(request)));
  on('POST', '/api/nodes/refresh', async () => {
    await nodes.refreshAll();
    return { nodes: nodes.list() };
  });
  on('GET', '/api/nodes/:id/account', async (request) => {
    const entry = node(request);
    const result = await nodes.client(entry).json<{ account: { balance: number; id: string } }>('/v1/account');
    nodes.setBalance(entry.id, result.account.balance);
    return result;
  });
  on('GET', '/api/nodes/:id/payments', (request) => nodes.client(node(request)).json('/v1/payments', { auth: false }));
  on('POST', '/api/nodes/:id/invoices', async (request) => {
    const body = await request.json<{ method?: string; credits?: number }>();
    return nodes.client(node(request)).json<Invoice>(`/v1/payments/${encodeURIComponent(String(body.method))}/invoices`, {
      body: { credits: body.credits },
    });
  });
  on('GET', '/api/nodes/:id/invoices/:invoice', (request) =>
    nodes.client(node(request)).json<Invoice>(`/v1/payments/invoices/${encodeURIComponent(request.params.invoice)}`)
  );
  on('POST', '/api/nodes/:id/claim', async (request) => {
    const entry = node(request);
    const { method, ...rest } = await request.json<Record<string, unknown> & { method?: string }>();
    const result = await nodes.client(entry).json<{ balance: number }>(`/v1/payments/${encodeURIComponent(String(method))}/claim`, {
      body: rest,
      timeoutMs: 30000,
    });
    nodes.setBalance(entry.id, result.balance);
    return result;
  });

  // Discovery
  on('POST', '/api/feed', async (request) => {
    const body = await request.json<{ cursor?: string; seed?: string; formats?: Preferences['formats'] }>();
    const preferences = body.formats?.length ? { ...core.settings.preferences, formats: body.formats } : core.settings.preferences;
    return core.collect('feed', { preferences, seed: body.seed }, body.cursor);
  });
  on('POST', '/api/search', async (request) => {
    const body = await request.json<{ query?: string; filters?: Preferences & { creator?: string }; sort?: string; cursor?: string }>();
    const given = Object.entries(body.filters ?? {}).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length));
    const filters = { ...core.settings.preferences, ...Object.fromEntries(given) };
    return core.collect('search', { query: String(body.query ?? ''), filters, sort: body.sort }, body.cursor);
  });
  on('POST', '/api/browse', async (request) => core.browse(await request.json()));
  on('POST', '/api/subscriptions/feed', async (request) => {
    const body = await request.json<{ cursor?: string }>();
    return core.browse({ source: 'subscriptions', cursor: body.cursor });
  });
  on('GET', '/api/content/:id', (request) => core.content(request.params.id));
  on('GET', '/api/creators/:id', (request) => core.creator(request.params.id));

  // Contributions to algorithm nodes (they pay credits for these)
  on('POST', '/api/vote', async (request) => {
    const body = await request.json<{ nodeId?: string; id?: string; vote?: number }>();
    const entry = nodes.require(String(body.nodeId));
    return nodes.client(entry).json<{ credited: number }>('/v1/votes', { body: { id: body.id, vote: body.vote } });
  });
  on('GET', '/api/vote/:id', (request) =>
    nodes.client(node(request)).json(`/v1/votes/${encodeURIComponent(request.query.get('content') ?? '')}`)
  );
  on('POST', '/api/suggest', async (request) => {
    const body = await request.json<{ nodeId?: string; id?: string; kind?: string; value?: string; reason?: string; timestamp?: number }>();
    const entry = nodes.require(String(body.nodeId));
    const { nodeId: _node, ...rest } = body;
    return nodes.client(entry).json<{ status: string }>('/v1/suggestions', { body: rest });
  });
  on('GET', '/api/contributions', () => core.contributions());

  // Subscriptions
  on('GET', '/api/subscriptions', () => ({ subscriptions: core.store.data.data.subscriptions }));
  on('POST', '/api/subscriptions', async (request) => core.subscribe(await request.json()));
  on('DELETE', '/api/subscriptions/:id', (request) => core.unsubscribe(request.params.id));

  // Publishing (uploads arrive through a route of each host: files or browser memory)
  on('POST', '/api/publish', async (request) => core.publisher.publish(await request.json<PublishRequest>(2 * MiB)));
  on('POST', '/api/publish/external', async (request) => core.publisher.publishExternal(await request.json<ExternalPublishRequest>(2 * MiB)));
  on('GET', '/api/jobs', () => ({ jobs: [...core.publisher.jobs.values()].reverse() }));
  on('GET', '/api/jobs/:id', (request) => {
    const job = core.publisher.jobs.get(request.params.id);
    if (!job) throw notFound('No such job');
    return job;
  });

  // Library and history
  on('GET', '/api/library', () => ({ published: core.store.data.data.library, history: core.store.data.data.history }));
  on('POST', '/api/history', async (request) => core.remember(await request.json()));
  on('DELETE', '/api/history', () => core.forgetHistory());

  // Settings, identity, cache
  on('PATCH', '/api/settings', async (request) => core.updateSettings(await request.json<Partial<Settings>>()));
  on('GET', '/api/identity/export', () => ({ seed: formatSeed(core.store.identity.seed), id: core.store.identity.id }));
  on('POST', '/api/identity/import', async (request) => {
    const body = await request.json<{ seed?: string }>();
    let seed: Buffer;
    try {
      seed = parseSeed(String(body.seed ?? ''));
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    return core.restoreIdentity(seed);
  });
  on('GET', '/api/cache', () => ({ ...core.cache.usage(), limit: core.settings.cacheMiB * MiB }));
  on('DELETE', '/api/cache', async () => {
    await core.cache.clear();
    return core.cache.usage();
  });

  return routes;
}
