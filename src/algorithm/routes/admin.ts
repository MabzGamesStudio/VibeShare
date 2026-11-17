// The operator's content desk: listing and blocking content, the bloom filters
// kept for accounts, the source list, and crawler and import controls.

import type { AlgorithmNode } from '../node.js';
import { type Ctx, HttpError, badRequest, readJson } from '../../shared/node/http.js';
import { parseContentId } from '../../shared/sources.js';
import { type Entry } from '../registry.js';
import { SOURCE_CATALOG, priorityOf, sourceKeyOf } from '../sources.js';
import { BLOOM_EXPECTED_ITEMS } from '../../shared/bloom.js';
import { pageOf } from '../support.js';
import { importCatalog } from '../routes/content.js';


export function registerAdminRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
    router.get('/v1/admin/content', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status');
      const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
      const items = node.registry
        .all()
        .filter((entry) => {
          if (status && entry.status !== status) return false;
          if (!q) return true;
          if (entry.title.toLowerCase().includes(q)) return true;
          // Ids match in any of their parts: a content id (`vs1…`), a source id
          // (`yt:12345678`) or the bare platform number (`12345678`).
          const parts = [entry.id, ...(entry.sources ?? [])].flatMap((part) => part.toLowerCase().split('~'));
          return parts.some((part) => part.includes(q) || part.endsWith(`:${q}`));
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        // The preview image kept on this node (or the remote one of discovered content).
        .map((entry) => ({
          ...entry,
          thumbnail: entry.thumbnail ? `/v1/thumbnails/${node.registry.thumbKey(entry.id)}` : entry.thumbnailUrl,
        }));
      return pageOf(items, ctx.query.get('cursor') ?? undefined, node.listLimit(ctx.query.get('limit')));
    });
    router.put('/v1/admin/content', async (ctx) => {
      admin(ctx);
      const body = await readJson<Partial<Entry> & { id: string; thumbnail?: string | boolean }>(ctx.req, 512 * 1024);
      const { thumbnail, ...rest } = body;
      // Whatever the operator touches is theirs: the crawler will not change it again.
      const entry = node.registry.upsert({ ...rest, origin: rest.origin ?? 'operator' });
      if (typeof thumbnail === 'string') node.registry.setThumbnail(entry.id, thumbnail);
      else node.cacheThumbnail(entry);
      node.traces.trace('basic', 'algorithm.admin', 'function:saveContent', {
        message: `${entry.id.slice(0, 24)} · ${entry.status}`,
        data: { id: entry.id.slice(0, 32), status: entry.status },
      });
      return node.registry.get(entry.id);
    });
    router.post('/v1/admin/content/:id/block', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ reason?: string }>(ctx.req);
      const entry = node.registry.block(ctx.params.id, body.reason);
      node.traces.trace('basic', 'algorithm.admin', 'function:blockContent', {
        message: `${entry.id.slice(0, 24)} blocked`,
        data: { id: entry.id.slice(0, 32), reason: (body.reason ?? '').slice(0, 80) },
      });
      return entry;
    });
    router.post('/v1/admin/blocklist', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ ids?: string[]; reason?: string }>(ctx.req, 4 * 1024 * 1024);
      const ids = (body.ids ?? []).filter((id) => parseContentId(String(id)));
      for (const id of ids) node.registry.block(id, body.reason);
      node.traces.trace('basic', 'algorithm.admin', 'function:blockList', {
        message: `${ids.length} ids blocked`,
        data: { ids: ids.length, reason: (body.reason ?? '').slice(0, 80) },
      });
      return { blocked: ids.length };
    });
    router.delete('/v1/admin/content/:id', (ctx) => {
      admin(ctx);
      const removed = node.registry.remove(ctx.params.id);
      node.traces.trace('basic', 'algorithm.admin', 'function:forgetContent', {
        message: `${ctx.params.id.slice(0, 24)} · ${removed ? 'removed' : 'unknown'}`,
        data: { id: ctx.params.id.slice(0, 32), removed },
      });
      return { removed };
    });
    // The seen-content filters kept here for accounts: the operator may see them all and
    // drop any of them. Expired paid copies are swept up while listing.
    router.get('/v1/admin/bloom', (ctx) => {
      admin(ctx);
      const stored: { account: string; bits: number; expected: number; hashes: number; expiresAt: string }[] = [];
      for (const [account, record] of Object.entries(node.blooms.data.stored)) {
        if (Date.parse(record.expiresAt) <= Date.now()) {
          delete node.blooms.data.stored[account];
          node.blooms.changed();
          continue;
        }
        stored.push({
          account,
          bits: record.filter.m,
          expected: record.filter.n ?? BLOOM_EXPECTED_ITEMS,
          hashes: record.filter.k,
          expiresAt: record.expiresAt,
        });
      }
      const accountFilters = Object.entries(node.blooms.data.accounts).map(([account, record]) => ({
        account,
        bits: record.filter.m,
        expected: record.filter.n ?? BLOOM_EXPECTED_ITEMS,
        hashes: record.filter.k,
        updatedAt: record.updatedAt,
      }));
      return { stored, accountFilters };
    });
    router.delete('/v1/admin/bloom/:account', (ctx) => {
      admin(ctx);
      const account = decodeURIComponent(ctx.params.account);
      const existed = Boolean(node.blooms.data.stored[account]);
      delete node.blooms.data.stored[account];
      if (existed) node.blooms.changed();
      return { removed: existed };
    });
    router.delete('/v1/admin/account-filters/:account', (ctx) => {
      admin(ctx);
      const account = decodeURIComponent(ctx.params.account);
      const existed = Boolean(node.blooms.data.accounts[account]);
      delete node.blooms.data.accounts[account];
      if (existed) node.blooms.changed();
      return { removed: existed };
    });
    // Comment sections: the operator sees them and decides whether one sends its comment
    // data at all (the block headers always go out), or hides single comments. Pages that
    // have no comments yet hold nothing here and are not listed at all.
    router.get('/v1/admin/crawler', (ctx) => {
      admin(ctx);
      return node.crawler.status();
    });
    // Every source, with its priority, whether the crawler may use it and how much it gave.
    router.get('/v1/admin/sources', (ctx) => {
      admin(ctx);
      const counts = new Map<string, { listed: number; pending: number }>();
      for (const entry of node.registry.all()) {
        const key = sourceKeyOf(entry);
        const count = counts.get(key) ?? { listed: 0, pending: 0 };
        if (entry.status === 'listed') count.listed++;
        if (entry.status === 'pending') count.pending++;
        counts.set(key, count);
      }
      const crawlable = new Set(node.crawler.status().adapters.map((adapter) => adapter.id));
      return {
        sources: SOURCE_CATALOG.map((source) => ({
          ...source,
          priority: priorityOf(source.key, node.config.sources.priorities),
          crawled: crawlable.has(source.key),
          blocked: node.config.crawler.blockedSources.includes(source.key),
          ...(counts.get(source.key) ?? { listed: 0, pending: 0 }),
        })),
        sites: node.config.crawler.sites,
      };
    });
    router.post('/v1/admin/crawler/run', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ adapter?: string; target?: string }>(ctx.req);
      try {
        return await node.crawler.runOnce(body.adapter, body.target);
      } catch (error) {
        throw new HttpError(502, 'crawl_failed', (error as Error).message);
      }
    });
    router.post('/v1/admin/crawler/seeds', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ url?: string }>(ctx.req);
      let url: URL;
      try {
        url = new URL(String(body.url ?? ''));
      } catch {
        throw badRequest('url must be an http(s) URL');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('url must be an http(s) URL');
      const seeds = node.configData.crawler.adapters.web.seeds;
      if (!seeds.includes(url.toString())) seeds.push(url.toString());
      node.configChanged();
      node.traces.trace('basic', 'algorithm.admin', 'function:addSeed', {
        message: `${url.host} · ${seeds.length} seeds`,
        data: { url: url.toString().slice(0, 120), seeds: seeds.length },
      });
      return { seeds };
    });
    router.post('/v1/admin/content/bulk', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ ids?: string[]; status?: 'listed' | 'blocked' | 'forget'; reason?: string }>(ctx.req, 4 * 1024 * 1024);
      const ids = (body.ids ?? []).map(String).slice(0, 5000);
      for (const id of ids) {
        if (body.status === 'forget') node.registry.remove(id);
        else if (body.status === 'blocked') node.registry.block(id, body.reason);
        else if (body.status === 'listed') node.registry.upsert({ id, status: 'listed', origin: 'operator' });
      }
      node.traces.trace('basic', 'algorithm.admin', 'function:bulkReview', {
        message: `${ids.length} ids · ${body.status ?? 'listed'}`,
        data: { ids: ids.length, status: body.status ?? 'listed', reason: (body.reason ?? '').slice(0, 80) },
      });
      return { updated: ids.length };
    });
    router.post('/v1/admin/import', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ provider?: string; limit?: number }>(ctx.req);
      return importCatalog(node, String(body.provider ?? ''), Math.min(1000, Number(body.limit ?? 200)));
    });
    // Peering with other nodes: metadata of a cid or a link, and discoveries by criteria.
}

