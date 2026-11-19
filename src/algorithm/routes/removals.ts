// Content removal requests: POST /v1/removals. The content's creator is answered with
// the deletion itself; everyone else's ask waits in the queue for the operator's
// verdict on the delete review page.
import { HttpError, notFound, readJson, type Ctx } from '../../shared/node/http.js';
import type { RemovalOutcome, RemovalRequest, RemovalRequestInput, RemovalRequestView } from '../../shared/protocol.js';
import { baseId } from '../../shared/sources.js';
import type { AlgorithmNode } from '../node.js';
import { identityOf } from '../registry.js';

export function registerRemovalRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);

  /** Everything this node knows about one content: its entry and its submissions. */
  const known = (key: string) => ({
    entry: node.registry.get(key),
    submissions: Object.values(node.contributions.data.submissions).filter((submission) => baseId(submission.contentId) === key),
  });

  /** Deletes the content the node's own way: the entry goes, pending submissions with it. */
  const removeContent = (key: string): void => {
    node.registry.remove(key);
    for (const submission of known(key).submissions) {
      if (submission.status !== 'pending') continue;
      submission.status = 'rejected';
      submission.reviewedAt = new Date().toISOString();
      submission.note = 'content removed at its creator’s request';
    }
    node.contributions.changed();
    node.removals.dropContent(key);
  };

  const view = (request: RemovalRequest): RemovalRequestView => {
    const entry = node.registry.get(request.cid);
    const creator = entry?.creatorId ? node.registry.creator(entry.creatorId) : undefined;
    return {
      ...request,
      ...(entry?.title ? { title: entry.title } : {}),
      ...(entry ? { creator: creator?.name ?? entry.creatorId } : {}),
    };
  };

  router.post('/v1/removals', async (ctx): Promise<RemovalOutcome> => {
    const account = node.auth.require(ctx);
    const body = await readJson<RemovalRequestInput>(ctx.req);
    const key = identityOf({ id: String(body.id ?? '') }).key;
    const { entry, submissions } = known(key);
    if (!entry && !submissions.length) throw notFound('This node does not know this content');
    // The creator's own content goes at once: the entry's creator, or the account (or
    // creator key) behind one of the submissions.
    const mine =
      Boolean(entry?.creatorId && entry.creatorId === account.id) ||
      submissions.some((submission) => submission.accountId === account.id || (submission.verifiedCreator ?? '') === account.id);
    if (mine) {
      removeContent(key);
      return { deleted: true };
    }
    if (node.removals.has(account.id, key)) {
      throw new HttpError(409, 'already_requested', 'This content already has a removal request from this account waiting for review');
    }
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 2000) : undefined;
    return { queued: true, request: node.removals.queue({ cid: key, account: account.id, message }) };
  });

  router.get('/v1/admin/removals', (ctx) => {
    admin(ctx);
    const all = node.removals.pending();
    const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') ?? 50) || 50));
    return { items: all.slice(offset, offset + limit).map(view), total: all.length };
  });

  router.post('/v1/admin/removals/:id/approve', (ctx) => {
    admin(ctx);
    const request = node.removals.get(ctx.params.id);
    if (!request) throw notFound('No such removal request');
    removeContent(request.cid);
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
