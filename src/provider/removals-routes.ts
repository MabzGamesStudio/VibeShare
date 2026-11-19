// Content removal requests on a provider: POST /v1/removals. The uploader's own
// content is deleted at once (with its storage jobs and bytes); everyone else's ask
// waits in the queue for the operator's verdict on the delete review page.
import { HttpError, notFound, readJson, type Ctx } from '../shared/node/http.js';
import type { RemovalOutcome, RemovalRequest, RemovalRequestInput, RemovalRequestView } from '../shared/protocol.js';
import type { ProviderNode } from './node.js';

export function registerRemovalRoutes(node: ProviderNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);

  /** The record behind an id: a content id, or a link id the node knows (a source).
   * Pending-review records are scanned too: their uploader may only ever see them here. */
  const findContent = (id: string) =>
    node.store.getContent(id) ??
    [...node.store.list(0, Number.MAX_SAFE_INTEGER), ...node.store.pendingContent()].find(
      (record) => record.sources?.includes(id) || record.duplicates?.includes(id)
    );

  const removeContent = async (cid: string): Promise<void> => {
    await node.removeContent(cid);
    node.removals.dropContent(cid);
  };

  const view = (request: RemovalRequest): RemovalRequestView => {
    const record = node.store.getContent(request.cid);
    const title = record?.title ?? record?.name;
    return { ...request, ...(title ? { title } : {}), ...(record?.creator ? { creator: record.creator } : {}) };
  };

  router.post('/v1/removals', async (ctx): Promise<RemovalOutcome> => {
    const account = node.auth.require(ctx);
    const body = await readJson<RemovalRequestInput>(ctx.req);
    const id = String(body.id ?? '').trim();
    const record = id ? findContent(id) : undefined;
    if (!record) throw notFound('This node does not know this content');
    if (record.uploader === account.id) {
      await removeContent(record.cid);
      return { deleted: true };
    }
    if (node.removals.has(account.id, record.cid)) {
      throw new HttpError(409, 'already_requested', 'This content already has a removal request from this account waiting for review');
    }
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 2000) : undefined;
    return { queued: true, request: node.removals.queue({ cid: record.cid, account: account.id, message }) };
  });

  router.get('/v1/admin/removals', (ctx) => {
    admin(ctx);
    const all = node.removals.pending();
    const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') ?? 50) || 50));
    return { items: all.slice(offset, offset + limit).map(view), total: all.length };
  });

  router.post('/v1/admin/removals/:id/approve', async (ctx) => {
    admin(ctx);
    const request = node.removals.get(ctx.params.id);
    if (!request) throw notFound('No such removal request');
    await removeContent(request.cid);
    return { deleted: true };
  });

  router.post('/v1/admin/removals/:id/reject', (ctx) => {
    admin(ctx);
    const request = node.removals.get(ctx.params.id);
    if (!request) throw notFound('No such removal request');
    node.removals.drop(request.id);
    return { rejected: true };
  });
}
