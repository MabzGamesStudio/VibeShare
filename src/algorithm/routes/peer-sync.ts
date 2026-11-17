// Full-catalog sync between nodes (manual content sync): shipping this node's
// catalog to a peer in bounded batches, and taking a peer's in.

import type { AlgorithmNode } from '../node.js';
import { isKeyId } from '../../shared/crypto.js';
import { type CommentBlock, checkCommentChain, commentIdAt } from '../../shared/comments.js';
import { type Ctx, badRequest, readJson } from '../../shared/node/http.js';
import { parseNodeRef } from '../../shared/noderef.js';
import { PEER_PUSH_CATEGORIES, type PeerCatalogEntry, type PeerCommentChain, type PeerCreatorRecord, type PeerImportBatch, type PeerImportReport, type PeerPushCategory, type PeerPushResult, type PeerTopicRecord } from '../../shared/protocol.js';
import { baseId } from '../../shared/sources.js';
import { CREATOR_KINDS, type CreatorKind, topicIdOf } from '../../shared/taxonomy.js';
import { CONTENT_ORIGINS, asArray, cleanAccounts, cleanIds, cleanLinks, cleanMedia, cleanMediaList, cleanNotes, cleanStats, isHashHex } from '../support.js';
import { commentDataOf, commentSyncBlocks, saveComments } from '../routes/comments.js';
import { checkedIcon } from '../routes/suggestions.js';
import { peerClient, requirePeer } from '../routes/peers.js';

/** The topics of a full push: every topic record (listing decisions included), plus
 *  the bare names this node offers in its topic list, keyed by their hash as always. */
export function syncTopics(node: AlgorithmNode): { key: string; record: PeerTopicRecord }[] {
  const byId = new Map<string, PeerTopicRecord>();
  for (const topic of node.registry.topics(true)) {
    byId.set(topic.id, { id: topic.id, name: topic.name, description: topic.description, icon: topic.icon, status: topic.status });
  }
  for (const name of node.config.topics) {
    const id = topicIdOf(name);
    if (!byId.has(id)) byId.set(id, { id, name, status: 'listed' });
  }
  return [...byId.entries()]
    .map(([key, record]) => ({ key, record }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** Every creator and group as it travels in a push. Proof keys stay home: they are
 *  trust anchors (they prove creator claims), so a catalog never carries them. */
export function syncCreators(node: AlgorithmNode): { key: string; record: PeerCreatorRecord }[] {
  return Object.values(node.registry.data.creators)
    .map((creator): { key: string; record: PeerCreatorRecord } => ({
      key: creator.id,
      record: {
        id: creator.id,
        name: creator.name,
        kind: creator.kind,
        description: creator.description,
        links: creator.links,
        accounts: creator.accounts,
        icon: creator.icon,
        members: creator.members,
        status: creator.status,
      },
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** Every content entry as it travels in a push: what the registry keeps per content.
 *  Votes are per account and stay local, and so do thumbnail images (only a remote
 *  thumbnail URL travels). */
export function syncEntries(node: AlgorithmNode): { key: string; record: PeerCatalogEntry }[] {
  return node.registry
    .all()
    .map((entry): { key: string; record: PeerCatalogEntry } => ({
      key: entry.id,
      record: {
        id: entry.id,
        contentId: entry.contentId,
        link: entry.link,
        sources: entry.sources,
        status: entry.status,
        reason: entry.reason,
        title: entry.title,
        description: entry.description,
        format: entry.format,
        rating: entry.rating,
        topics: entry.topics,
        topicIds: entry.topicIds,
        language: entry.language,
        durationSeconds: entry.durationSeconds,
        gallery: entry.gallery,
        creatorId: entry.creatorId,
        providers: entry.providers.length ? entry.providers : undefined,
        publishedAt: entry.publishedAt,
        pageUrl: entry.pageUrl,
        thumbnailUrl: entry.thumbnailUrl,
        media: entry.media,
        platformStats: entry.platformStats && Object.keys(entry.platformStats).length ? entry.platformStats : undefined,
        notes: entry.notes.length ? entry.notes : undefined,
        origin: entry.origin,
      },
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** The comment chains of a full push: the pages that have comments, in a stable order. */
export async function syncChains(node: AlgorithmNode): Promise<{ key: string; record: PeerCommentChain }[]> {
  const out: { key: string; record: PeerCommentChain }[] = [];
  const sections = Object.entries(node.comments.data.sections).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, section] of sections) {
    if (!section.blocks.length) continue;
    out.push({ key, record: { content: key, blocks: commentSyncBlocks(node, section, await commentDataOf(node, section)) } });
  }
  return out;
}
/** How many items a full sync moves, per category. */
export async function catalogTotals(node: AlgorithmNode): Promise<Record<PeerPushCategory, number>> {
  return {
    topics: syncTopics(node).length,
    creators: syncCreators(node).length,
    entries: node.registry.all().length,
    comments: (await syncChains(node)).length,
  };
}
/** Cuts a page down until its JSON fits comfortably in one bounded request. */
export function fitBatch<T>(node: AlgorithmNode, items: T[], limit: number, maxBytes = 3_000_000): T[] {
  let page = items.slice(0, limit);
  while (page.length > 1 && JSON.stringify(page).length > maxBytes) page = page.slice(0, -1);
  return page;
}
/**
 * One call of the push: one bounded batch of this catalog to one node, and how far
 * the sync got. `category` picks what moves (a call without one only reports totals),
 * `cursor` is the key of the last item the previous call sent — so a retry sends
 * exactly what is still missing, and re-sending anything is harmless anyway (the
 * receiving node upserts, and skips comment chains it already has).
 */
export async function pushCatalog(node: AlgorithmNode, refText: string, category: string | undefined, cursor: string | undefined): Promise<PeerPushResult> {
  const ref = parseNodeRef(refText);
  if (!ref) throw badRequest('ref must be a node reference or a URL');
  if ((cursor ?? '').length > 256) throw badRequest('cursor is too long');
  const base = { ref: refText.trim(), totals: await catalogTotals(node) };
  if (!category) return { ...base, category: null, sent: 0, cursor: null, done: false };
  if (!(PEER_PUSH_CATEGORIES as readonly string[]).includes(category)) {
    throw badRequest(`category is one of ${PEER_PUSH_CATEGORIES.join(', ')}`);
  }
  const cat = category as PeerPushCategory;
  const after = cursor ?? '';
  let batch: PeerImportBatch = {};
  let sent = 0;
  let done = true;
  let next: string | null = null;
  let oversized: number | undefined;

  if (cat === 'topics') {
    const remaining = syncTopics(node).filter((item) => item.key > after);
    const page = fitBatch(node, remaining, 200);
    batch = { topics: page.map((item) => item.record) };
    sent = page.length;
    done = page.length >= remaining.length;
    next = page.at(-1)?.key ?? null;
  } else if (cat === 'creators') {
    const remaining = syncCreators(node).filter((item) => item.key > after);
    const page = fitBatch(node, remaining, 200);
    batch = {
      creators: page.filter((item) => item.record.kind !== 'group').map((item) => item.record),
      groups: page.filter((item) => item.record.kind === 'group').map((item) => item.record),
    };
    sent = page.length;
    done = page.length >= remaining.length;
    next = page.at(-1)?.key ?? null;
  } else if (cat === 'entries') {
    const remaining = syncEntries(node).filter((item) => item.key > after);
    const page = fitBatch(node, remaining, 50);
    batch = { entries: page.map((item) => item.record) };
    sent = page.length;
    done = page.length >= remaining.length;
    next = page.at(-1)?.key ?? null;
  } else {
    // A comment chain is all or nothing: one that cannot fit a batch is left out for
    // good (reported as oversized) rather than blocking the cursor forever.
    const remaining = (await syncChains(node)).filter((item) => item.key > after);
    const page: (typeof remaining)[number][] = [];
    let blocks = 0;
    for (const item of remaining) {
      if (item.record.blocks.length > 1000 || JSON.stringify(item.record).length > 3_000_000) {
        oversized = (oversized ?? 0) + 1;
        continue;
      }
      if (page.length >= 8 || blocks + item.record.blocks.length > 1000) {
        done = false;
        break;
      }
      page.push(item);
      blocks += item.record.blocks.length;
    }
    while (page.length > 1 && JSON.stringify(page).length > 3_000_000) {
      page.pop();
      done = false;
    }
    batch = { comments: page.map((item) => item.record) };
    sent = page.length;
    next = page.at(-1)?.key ?? null;
  }

  try {
    const client = peerClient(node, { ref: base.ref });
    const pushStarted = Date.now();
    const report = await client.json<PeerImportReport>('/v1/peers/import', {
      body: batch,
      timeoutMs: 120_000,
    });
    node.traces.trace('dependency', 'algorithm.peers', 'push batch', {
      message: `${cat} → ${refText.slice(0, 36)} · ${sent} sent`,
      data: node.traces.summarize({
        ref: refText.slice(0, 80),
        url: `${client.url}/v1/peers/import`,
        method: 'POST',
        ms: Date.now() - pushStarted,
        category: cat,
        sent,
        done,
        oversized,
        accepted: report.entries.accepted + report.topics.accepted + report.creators.accepted + report.groups.accepted + report.comments.accepted,
        skipped: report.entries.skipped + report.topics.skipped + report.creators.skipped + report.groups.skipped + report.comments.skipped,
      }),
    });
    return { ...base, category: cat, sent, cursor: done ? null : next, done, report, oversized };
  } catch (error) {
    // The batch did not land: the cursor that was passed in still names it, so the
    // console's Continue/Try again sends exactly this batch again.
    node.traces.trace('error', 'algorithm.peers', 'push batch', {
      message: `${cat} → ${refText.slice(0, 36)} · batch kept for retry`,
      error: (error as Error).message,
      data: { ref: refText.slice(0, 80), category: cat, sent },
    });
    return { ...base, category: cat, sent: 0, cursor: cursor ?? null, done: false, error: (error as Error).message, oversized };
  }
}
/** Takes one bounded batch of a peer's full-catalog push in. Bad items are skipped,
 *  not fatal — one malformed record must not kill a whole sync — and every skip is
 *  counted and explained back to the pushing node. */
export async function importPeerBatch(node: AlgorithmNode, batch: PeerImportBatch): Promise<PeerImportReport> {
  const report: PeerImportReport = {
    entries: { accepted: 0, skipped: 0 },
    topics: { accepted: 0, skipped: 0 },
    creators: { accepted: 0, skipped: 0 },
    groups: { accepted: 0, skipped: 0 },
    comments: { accepted: 0, skipped: 0 },
    errors: [],
  };
  const note = (message: string) => {
    if (report.errors.length < 10) report.errors.push(message);
  };
  // Topics first, then creators and groups, then the entries that refer to them, then
  // comments — so one mixed batch resolves in the same order a full push moves them.
  for (const raw of asArray<PeerTopicRecord>(batch.topics, 200)) {
    try {
      importPeerTopic(node, raw);
      report.topics.accepted++;
    } catch (error) {
      report.topics.skipped++;
      note(`topic: ${(error as Error).message}`);
    }
  }
  for (const raw of asArray<PeerCreatorRecord>(batch.creators, 200)) {
    try {
      importPeerCreator(node, raw, false);
      report.creators.accepted++;
    } catch (error) {
      report.creators.skipped++;
      note(`creator: ${(error as Error).message}`);
    }
  }
  for (const raw of asArray<PeerCreatorRecord>(batch.groups, 100)) {
    try {
      importPeerCreator(node, raw, true);
      report.groups.accepted++;
    } catch (error) {
      report.groups.skipped++;
      note(`group: ${(error as Error).message}`);
    }
  }
  for (const raw of asArray<PeerCatalogEntry>(batch.entries, 100)) {
    try {
      importPeerEntry(node, raw);
      report.entries.accepted++;
    } catch (error) {
      report.entries.skipped++;
      note(`entry: ${(error as Error).message}`);
    }
  }
  for (const raw of asArray<PeerCommentChain>(batch.comments, 8)) {
    try {
      await importPeerComments(node, raw);
      report.comments.accepted++;
    } catch (error) {
      report.comments.skipped++;
      note(`comments: ${(error as Error).message}`);
    }
  }
  // One summary per batch — a bad record is skipped and explained back to the pushing
  // node (tolerated), so it is recorded as the failure it is, without one event per item.
  const accepted = report.entries.accepted + report.topics.accepted + report.creators.accepted + report.groups.accepted + report.comments.accepted;
  const skipped = report.entries.skipped + report.topics.skipped + report.creators.skipped + report.groups.skipped + report.comments.skipped;
  node.traces.trace(skipped ? 'error' : 'basic', 'algorithm.peers', 'function:importPeerBatch', {
    message: `${accepted} accepted · ${skipped} skipped`,
    data: {
      topics: report.topics,
      creators: report.creators,
      groups: report.groups,
      entries: report.entries,
      comments: report.comments,
      errors: report.errors.slice(0, 3),
    },
  });
  return report;
}
/**
 * A topic as a peer ships it. Topics are keyed by the hash of their name here as
 * everywhere: an id this node already knows edits that topic (a rename, exactly as
 * the console edits one), and a new topic lands under its own name's hash — a peer
 * cannot plant a record under an id this node never derived itself.
 */
export function importPeerTopic(node: AlgorithmNode, raw: PeerTopicRecord): void {
  const name = String(raw?.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('a topic needs a name');
  const status = raw.status ?? 'listed';
  if (status !== 'listed' && status !== 'blocked') throw badRequest('unknown topic status');
  const known = typeof raw.id === 'string' && raw.id ? node.registry.topic(raw.id) : undefined;
  if (typeof raw.id === 'string' && raw.id && !known && !/^tp1[0-9a-f]{32}$/.test(raw.id)) throw badRequest('malformed topic id');
  node.registry.upsertTopic({
    id: known?.id,
    name,
    description: raw.description === undefined ? undefined : String(raw.description).slice(0, 2000) || undefined,
    icon: raw.icon === undefined ? undefined : checkedIcon(raw.icon),
    status,
  });
}
/**
 * A creator (or a group) as a peer ships it. Proof keys are never read from the
 * batch: keys are trust anchors (they prove creator claims and submissions), and only
 * the operator's console or a creator's own proof brings them here. Membership ids
 * are kept as sent — ones this node does not know simply do not resolve.
 */
export function importPeerCreator(node: AlgorithmNode, raw: PeerCreatorRecord, group: boolean): void {
  const id = String(raw?.id ?? '').trim();
  if (!id || id.length > 128) throw badRequest('a creator needs an id of at most 128 characters');
  const kind = String(raw?.kind ?? '') as CreatorKind;
  if (!CREATOR_KINDS.includes(kind)) throw badRequest('unknown creator kind');
  if (group !== (kind === 'group')) throw badRequest(group ? 'a group record needs kind group' : 'a creator record is not a group');
  const name = String(raw?.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('a creator needs a name');
  const status = raw.status ?? 'listed';
  if (status !== 'listed' && status !== 'blocked') throw badRequest('unknown creator status');
  node.registry.upsertCreator({
    id,
    name,
    kind,
    description: raw.description === undefined ? undefined : String(raw.description).slice(0, 2000) || undefined,
    links: raw.links === undefined ? undefined : cleanLinks(raw.links, 16),
    accounts: raw.accounts === undefined ? undefined : cleanAccounts(raw.accounts),
    icon: raw.icon === undefined ? undefined : checkedIcon(raw.icon),
    members: kind === 'group' && raw.members !== undefined ? cleanIds(raw.members, 500) : undefined,
    status,
  });
}
/**
 * A content entry as a peer ships it. The registry validates the identity (a content
 * id, a link, or both) and the taxonomy, and its upsert keeps this node's votes and
 * stamps. The listing decision travels: whatever status the entry has there, it gets
 * here — that is the point of a catalog sync.
 */
export function importPeerEntry(node: AlgorithmNode, raw: PeerCatalogEntry): void {
  const status = raw?.status;
  if (status !== 'listed' && status !== 'blocked' && status !== 'pending') throw badRequest('unknown listing status');
  const origin = raw.origin !== undefined && CONTENT_ORIGINS.includes(raw.origin) ? raw.origin : undefined;
  const entry = node.registry.upsert({
    id: String(raw.id ?? ''),
    contentId: raw.contentId === undefined ? undefined : String(raw.contentId),
    link: raw.link === undefined ? undefined : String(raw.link),
    sources: asArray<string>(raw.sources, 32).map((source) => String(source).slice(0, 500)),
    status,
    reason: status === 'blocked' && raw.reason !== undefined ? String(raw.reason).slice(0, 200) : undefined,
    title: raw.title === undefined ? undefined : String(raw.title).slice(0, 300),
    description: raw.description === undefined ? undefined : String(raw.description).slice(0, 5000),
    format: raw.format,
    rating: raw.rating,
    // Tags fold into topics here as everywhere else.
    topics: raw.topics === undefined ? undefined : asArray<string>(raw.topics, 64).map((topic) => String(topic)),
    language: raw.language === undefined ? undefined : String(raw.language).slice(0, 35) || undefined,
    durationSeconds: Number.isFinite(raw.durationSeconds) ? Math.max(0, Math.round(Number(raw.durationSeconds))) : undefined,
    gallery: cleanMediaList(raw.gallery),
    creatorId: raw.creatorId === undefined ? undefined : String(raw.creatorId).slice(0, 128) || undefined,
    providers: asArray<string>(raw.providers, 16).map(String).filter((provider) => parseNodeRef(provider)),
    publishedAt: raw.publishedAt ? String(raw.publishedAt).slice(0, 40) : undefined,
    pageUrl: raw.pageUrl === undefined ? undefined : String(raw.pageUrl).slice(0, 2048) || undefined,
    // Thumbnails are images and do not travel in a catalog; a remote URL does.
    thumbnailUrl: raw.thumbnailUrl === undefined ? undefined : String(raw.thumbnailUrl).slice(0, 2048) || undefined,
    media: cleanMedia(raw.media),
    platformStats: cleanStats(raw.platformStats),
    notes: cleanNotes(raw.notes),
    origin,
  });
  // The exact topic ids of the entry are kept when they name a topic record here (so
  // filing survives renames); the rest falls back to the names, which is how this
  // node derives ids everywhere.
  if (Array.isArray(raw.topicIds)) {
    const known = asArray<string>(raw.topicIds, 64).filter((id) => node.registry.topic(String(id)));
    if (known.length) {
      entry.topicIds = [...new Set([...(entry.topicIds ?? []), ...known.map(String)])].slice(0, 64);
      node.registry.changed();
    }
  }
}
/**
 * A content page's comment chain as a peer ships it, taken in whole or not at all.
 * What makes it safe to take: the chain must verify end to end — headers link and
 * hash correctly, data matches its hashes, signatures check out, and edits come from
 * the same key (checkCommentChain, the exact rule clients apply) — every comment's id
 * must be the one this node's own rule makes up from what the comment attaches to,
 * and its reply-from must name the page's root or a comment earlier in the chain.
 * Only signature-checked comment data is imported: a comment without a key travels as
 * its header alone, so a lying peer cannot invent comments whole cloth — the worst it
 * can do is replay comments whose commenter really signed them. Times travel as the
 * sending node stamped them (they are not signed and cannot be checked here), and
 * votes never travel: accounts are local. A page that already has comments keeps
 * them: two chains each link their own history and cannot be merged.
 */
export async function importPeerComments(node: AlgorithmNode, chain: PeerCommentChain): Promise<void> {
  const key = baseId(String(chain?.content ?? ''));
  const raw = Array.isArray(chain?.blocks) ? chain.blocks : null;
  if (!key || key.length > 500 || !raw || !raw.length) throw badRequest('a comment chain needs a page and blocks');
  if (raw.length > 1000) throw badRequest('a comment chain is at most 1000 blocks');
  if (node.comments.data.sections[key]?.blocks.length) throw badRequest('this page already has comments here');
  const cleaned: CommentBlock[] = [];
  for (const piece of raw) {
    const block = (piece ?? {}) as Partial<CommentBlock>;
    const prev = String(block.prev ?? '');
    const dataHash = String(block.dataHash ?? '');
    const hash = String(block.hash ?? '');
    const id = String(block.id ?? '');
    if ((prev && !isHashHex(prev)) || !isHashHex(dataHash) || !isHashHex(hash) || !isHashHex(id)) {
      throw badRequest('the chain carries malformed block headers');
    }
    const data = block.data;
    const kept =
      data && data.key && data.sig
        ? {
            id: String(data.id ?? ''),
            text: String(data.text ?? ''),
            key: String(data.key),
            sig: String(data.sig),
            time: String(data.time ?? '').slice(0, 40),
            replyFrom: String(data.replyFrom ?? ''),
          }
        : undefined;
    if (kept) {
      if (!isKeyId(kept.key)) throw badRequest('a comment carries a malformed key');
      if (!kept.text.trim()) throw badRequest('a comment needs text');
      if (kept.text.length > 10_000) throw badRequest('a comment is too long');
    }
    cleaned.push(kept ? { prev, dataHash, hash, id, data: kept } : { prev, dataHash, hash, id });
  }
  // The whole chain verifies or nothing is imported: all or nothing, as clients see it.
  const { errors } = checkCommentChain(cleaned);
  if (errors.length) throw badRequest(`the comment chain does not verify: ${errors[0]}`);
  const madeIds = new Set<string>();
  const chainIds = new Set<string>();
  for (const block of cleaned) {
    const data = block.data;
    if (data) {
      if (data.replyFrom !== key && !chainIds.has(data.replyFrom)) throw badRequest('a comment replies to one that is not there');
      // An edit reuses the id of the comment it edits (pinned to the same key by the
      // chain check); a first-time id must be the one the node's own rule makes up.
      if (!madeIds.has(data.id)) {
        madeIds.add(data.id);
        if (commentIdAt(data.replyFrom, block.prev, data.text, data.key) !== data.id) {
          throw badRequest('a comment id is not the one this node makes up for it');
        }
      }
    }
    chainIds.add(block.id);
  }
  if (!madeIds.size) throw badRequest('the chain carries no comment data this node can verify');
  // Votes are per account and stay local: the section starts without any.
  node.comments.data.sections[key] = { blocks: cleaned, votes: {}, hidden: [], shown: true };
  await saveComments(node, node.comments.data.sections[key]);
}
export function registerPeerSyncRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
    router.post('/v1/peers/import', async (ctx) => {
      requirePeer(node, ctx);
      const body = await readJson<PeerImportBatch>(ctx.req, 4 * 1024 * 1024);
      return importPeerBatch(node, body);
    });
    router.post('/v1/admin/peers/push', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ ref?: string; category?: string; cursor?: string }>(ctx.req);
      return pushCatalog(node, String(body.ref ?? ''), body.category, body.cursor);
    });
}

