// Everything a client contributes and votes on: tag/rating suggestions, reports,
// account links, creator content and icon suggestions, and their review.

import type { AlgorithmNode } from '../node.js';
import { type Account } from '../../node/ledger.js';
import { isKeyId, randomId, verifySignature } from '../../shared/crypto.js';
import { type Ctx, badRequest, forbidden, notFound, readJson } from '../../shared/node/http.js';
import { type AccountLinkProposal, type AccountLinkResponse, type CreatorAccount, type CreatorAccountLinkRequest, type CreatorContentRequest, type CreatorContentResponse, type CreatorContentSuggestion, type CreatorIconRequest, type CreatorIconResponse, type CreatorIconSuggestion, type ReportRequest, type ReportResponse, SUGGESTION_KINDS, type SuggestionRequest, claimSigningPayload } from '../../shared/protocol.js';
import { baseId, creatorRefOf, parseSource } from '../../shared/sources.js';
import { type Format, type Rating } from '../../shared/taxonomy.js';
import { type CreatorRecord, identityOf } from '../registry.js';
import { slug } from '../support.js';
import { type Suggestion, metricsOf, validateSuggestion } from '../contributions.js';

export function suggest(node: AlgorithmNode, account: Account, body: SuggestionRequest) {
  const entry = node.registry.get(String(body.id ?? ''));
  if (!entry) throw notFound('The node does not know this content');
  if (!SUGGESTION_KINDS.includes(body.kind)) throw badRequest(`kind is one of ${SUGGESTION_KINDS.join(', ')}`);
  const value = validateSuggestion(body.kind, String(body.value ?? ''));
  // The reason is optional: a correction can speak for itself.
  const reason = String(body.reason ?? '').trim().slice(0, 1000);
  const timestamp =
    body.timestamp !== undefined && Number.isFinite(Number(body.timestamp)) && Number(body.timestamp) >= 0
      ? Math.round(Number(body.timestamp) * 10) / 10
      : undefined;
  const suggestions = node.contributions.data.suggestions;
  let suggestion = Object.values(suggestions).find(
    (s) => s.contentId === entry.id && s.kind === body.kind && s.value === value && s.status === 'pending'
  );
  if (!suggestion) {
    suggestion = {
      id: randomId('sug-', 8),
      contentId: entry.id,
      kind: body.kind,
      value,
      status: 'pending',
      createdAt: new Date().toISOString(),
      votes: [],
    };
    suggestions[suggestion.id] = suggestion;
  }
  if (!suggestion.votes.some((vote) => vote.account === account.id)) {
    suggestion.votes.push({
      account: account.id,
      reason,
      timestamp,
      at: new Date().toISOString(),
      platform: body.platform ? String(body.platform).slice(0, 32) : undefined,
    });
  }
  node.contributions.changed();
  const needed = node.config.rewards.autoAcceptAgreement;
  // The operator's auto-accept applies the suggestion at once (reports still wait:
  // accepting one blocks the content, which is not "accepting content").
  if (body.kind !== 'report' && (node.config.policy.autoAccept || (needed > 0 && suggestion.votes.length >= needed))) {
    acceptSuggestion(node, suggestion);
  }
  node.traces.trace('basic', 'algorithm.suggestions', 'function:suggest', {
    message: `${suggestion.kind} ${suggestion.id} · ${suggestion.votes.length} agreeing`,
    data: {
      id: suggestion.id,
      kind: suggestion.kind,
      content: entry.id.slice(0, 32),
      account: account.id.slice(0, 16),
      agreeing: suggestion.votes.length,
      accepted: suggestion.status === 'accepted',
    },
  });
  const { votes, ...rest } = suggestion;
  return { ...rest, agreeing: votes.length };
}
/** The JSON a validated suggestion value carries (`data`, `topics`), with a fallback. */
function parsedJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function acceptSuggestion(node: AlgorithmNode, suggestion: Suggestion): void {
  if (suggestion.status !== 'pending') return;
  const entry = node.registry.get(suggestion.contentId);
  if (entry) {
    switch (suggestion.kind) {
      case 'topic':
        if (!entry.topics.includes(suggestion.value)) entry.topics.push(suggestion.value);
        break;
      case 'tag':
        // A tag (a content warning, say) is kept as a tag note on the entry — the same
        // place the operator's own tag corrections land; the generic note push below
        // records it with the reason the client gave.
        break;
      case 'format':
        entry.format = suggestion.value as Format;
        break;
      case 'rating':
        entry.rating = suggestion.value as Rating;
        break;
      case 'creator': {
        // Missing information a client provided: the creator of the content.
        const id = `name:${slug(suggestion.value)}`;
        node.registry.upsertCreator({ id, name: suggestion.value, kind: 'unknown' });
        entry.creatorId = id;
        break;
      }
      case 'published':
        entry.publishedAt = suggestion.value;
        break;
      case 'source':
        // Missing sources of the content: one content id can carry several.
        if (entry.sources.length < 16 && !entry.sources.includes(suggestion.value) && suggestion.value !== entry.id) {
          entry.sources.push(suggestion.value);
        }
        break;
      case 'duplicate':
        // Reported as a duplicate of another id; kept as evidence for the operator.
        break;
      case 'report':
        break;
      case 'title':
        // A corrected field: what the content now says (an empty one clears it).
        node.registry.upsert({ id: entry.id, title: suggestion.value });
        break;
      case 'description':
        node.registry.upsert({ id: entry.id, description: suggestion.value });
        break;
      case 'topics':
        // The corrected topic list: what it now says — additions, moves and deletes.
        node.registry.upsert({ id: entry.id, topics: parsedJson<string[]>(suggestion.value, []) });
        break;
      case 'data':
        // The corrected content data: the whole corrected map replaces the old one.
        node.registry.upsert({ id: entry.id, data: parsedJson<Record<string, string>>(suggestion.value, {}) });
        break;
      case 'thumbnail':
        if (suggestion.value) node.registry.setThumbnail(entry.id, suggestion.value);
        else node.registry.upsert({ id: entry.id, thumbnail: false });
        break;
    }
    // upsert() rebuilds the record: take the stored one before adding the evidence.
    const fresh = node.registry.get(suggestion.contentId) ?? entry;
    const first = suggestion.votes[0];
    if (first && suggestion.kind !== 'report') {
      // The note is evidence, not storage: a thumbnail's bytes or a whole data map
      // are named rather than kept, so one accepted correction never bloats every
      // answer that carries the content's notes.
      const value = suggestion.kind === 'thumbnail' ? '(image)' : suggestion.value.slice(0, 2000);
      fresh.notes = fresh.notes.filter((note) => !(note.kind === suggestion.kind && note.value === value));
      fresh.notes.push({ kind: suggestion.kind, value, reason: first.reason, timestamp: first.timestamp });
    }
    fresh.updatedAt = new Date().toISOString();
    node.registry.changed();
  }
  suggestion.status = 'accepted';
  suggestion.reviewedAt = new Date().toISOString();
  const reward = node.config.rewards.acceptedSuggestion;
  for (const vote of suggestion.votes) {
    const account = node.ledger.get(vote.account);
    if (account && reward > 0 && node.canEarn(account)) node.ledger.credit(account.id, reward, `accepted ${suggestion.kind}`, suggestion.id);
  }
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:acceptSuggestion', {
    message: `${suggestion.kind} ${suggestion.id} accepted`,
    data: { id: suggestion.id, kind: suggestion.kind, content: suggestion.contentId.slice(0, 32), votes: suggestion.votes.length },
  });
}
/**
 * A client reports the content id or link it played from outside the network. What the
 * node did not have is kept for review, and the reporter earns credits for finding it.
 */
export function report(node: AlgorithmNode, ctx: Ctx, account: Account, raw: string): ReportResponse {
  const trimmed = raw.trim();
  if (!trimmed) throw badRequest('id is required');
  const { key, contentId, link } = identityOf({ id: trimmed });
  const existing = node.registry.findByRef(trimmed);
  let newInfo = false;
  if (!existing) {
    node.registry.upsert({ id: key, contentId, link, status: 'pending', origin: 'report' });
    newInfo = true;
  } else {
    // The report adds information only when the entry does not already carry what it
    // says: the link can be the entry's own id (or one of its sources), and the same
    // goes for the content id — then the node knew the content already and the report
    // is worth nothing new.
    const knows = (value: string | undefined) =>
      value !== undefined && (existing.id === value || existing.link === value || existing.contentId === value || existing.sources.includes(value));
    if ((contentId && !knows(contentId)) || (link && !knows(link))) {
      // The node knew the content, but not the content id (or the link) it was played from.
      node.registry.upsert({ id: existing.id, contentId: contentId ?? existing.contentId, link: link ?? existing.link });
      newInfo = true;
    }
  }
  let credited = 0;
  const rewards = node.config.rewards;
  if (newInfo && rewards.report > 0 && node.canEarn(account) && node.ledger.daily(account, 'reports') < rewards.reportDailyCap) {
    node.ledger.addDaily(account, 'reports', 1);
    const updated = node.ledger.credit(account.id, rewards.report, 'report', key);
    ctx.res.setHeader('x-vs-balance', String(updated.balance));
    credited = rewards.report;
  }
  return { known: !newInfo, credited };
}
/** An icon a client suggests must be a small image data: URL, exactly as for creators. */
export function checkedIcon(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const icon = String(raw);
  const image = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(icon);
  const bytes = image ? Buffer.from(image[2], 'base64') : Buffer.alloc(0);
  if (!bytes.length) throw badRequest('The icon is a data: URL of a png, jpeg, webp or gif image');
  if (bytes.length > 200 * 1024) throw badRequest('The icon is at most 200 kB');
  return icon;
}
/** The accounts of a link request, cleaned: platform, handle and the link, when given. */
export function accountsOf(node: AlgorithmNode, body: CreatorAccountLinkRequest): CreatorAccount[] {
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []).map((account) => ({
    platform: String(account?.platform ?? '').trim().slice(0, 32),
    handle: String(account?.handle ?? '').trim().slice(0, 120),
    url: account?.url ? String(account.url).trim().slice(0, 2048) : undefined,
    creator: account?.creator ? String(account.creator).trim().slice(0, 128) : undefined,
    subscribers:
      Number.isFinite(Number(account?.subscribers)) && Number(account?.subscribers) >= 0 ? Math.round(Number(account.subscribers)) : undefined,
  }));
  for (const account of accounts) {
    if (!account.platform || !account.handle) throw badRequest('Every account needs a platform and a handle');
    if (account.creator !== undefined) {
      // A related creator is a VibeShare creator — its id, its link id, or its page link
      // (the id is parsed out of it). Links to other platforms do not belong here.
      const ref = creatorRefOf(account.creator);
      if (!ref) throw badRequest('A related creator is a VibeShare creator id, link id or page link — not a link to another platform');
      account.creator = ref;
    }
  }
  return accounts;
}
/**
 * The accounts as clients show them: when a related creator is already known here, its
 * own name and icon stand in for the submitted handle and subscriber count.
 */
export function servedAccounts(node: AlgorithmNode, creator: CreatorRecord): CreatorAccount[] {
  return (creator.accounts ?? []).map((account) => {
    const related = account.creator ? node.registry.creator(account.creator) : undefined;
    if (!related) return account;
    const { subscribers: _ignored, ...kept } = account;
    return { ...kept, name: related.name, icon: related.icon };
  });
}
/**
 * Links between accounts go both ways by default: an account pointing at another
 * creator also shows on that creator's page (pointing back). One-way links skip node.
 * A creator already at the account cap simply gets no back-link.
 */
export function linkBack(node: AlgorithmNode, fromCreator: string, accounts: CreatorAccount[], symmetric: boolean | undefined): void {
  if (symmetric === false) return;
  const max = Math.max(0, node.config.maxCreatorAccounts);
  for (const account of accounts) {
    if (!account.creator || account.creator === fromCreator) continue;
    const target = node.registry.creator(account.creator);
    if (!target) continue;
    const list = [...(target.accounts ?? [])];
    const same = (other: CreatorAccount) =>
      (account.url && other.url === account.url) || (other.platform === account.platform && other.handle === account.handle);
    if (list.some(same) || list.length >= max) continue;
    list.push({ platform: account.platform, handle: account.handle, url: account.url, creator: fromCreator });
    node.registry.upsertCreator({ id: account.creator, accounts: list });
  }
}
/**
 * A creator linking their accounts on other platforms (YouTube, TikTok, Twitter…) here.
 * Signing is optional: with the creator's key signing the request, the accounts are
 * linked at once. Without it, anyone may propose accounts that are external links to
 * the creator (each carrying its link) — the node's operator then decides whether to
 * link them or not. Either way the operator's cap decides how many may be linked.
 */
export function linkAccounts(node: AlgorithmNode, account: Account, body: CreatorAccountLinkRequest): AccountLinkResponse {
  const creatorId = String(body.creator ?? '').trim();
  if (!creatorId || creatorId.length > 128) throw badRequest('creator is required');
  const accounts = accountsOf(node, body);
  const max = Math.max(0, node.config.maxCreatorAccounts);
  if (accounts.length > max) throw badRequest(`A creator may link at most ${max} accounts`);
  const proof = body.proof;
  if (proof) {
    if (!isKeyId(proof.key) || Math.abs(Date.now() - Number(proof.ts)) > 15 * 60_000) throw badRequest('Bad or stale proof');
    if (!verifySignature(proof.key, claimSigningPayload(node.identity.id, creatorId, Number(proof.ts)), String(proof.sig))) {
      throw badRequest('The proof signature does not match');
    }
    const known = node.registry.creator(creatorId);
    // A new creator takes its key as its id; a known one is only touched by its own key.
    if (known ? !(known.id === proof.key || known.keys?.includes(proof.key)) : creatorId !== proof.key) {
      throw forbidden('Only the creator (holding its key) may link accounts for it');
    }
    const creator = node.registry.upsertCreator({ id: creatorId, name: body.name, kind: body.kind, keys: [proof.key], accounts });
    linkBack(node, creatorId, accounts, body.symmetric);
    node.traces.trace('basic', 'algorithm.suggestions', 'function:linkAccounts', {
      message: `${creatorId.slice(0, 24)} · ${accounts.length} accounts linked`,
      data: { creator: creatorId.slice(0, 32), accounts: accounts.length, signed: true, account: account.id.slice(0, 16) },
    });
    return { linked: true, creator };
  }
  // Unsigned: only external links to the creator, and only where the operator allows it.
  if (!node.config.allowUnsignedAccountLinks) throw forbidden('This node only links accounts signed with the creator key');
  for (const linked of accounts) {
    const link = linked.url ?? '';
    if (!link || (!parseSource(link) && !/^https?:\/\//.test(link))) {
      throw badRequest('Without the creator key, every account must be an external link to the creator (its url)');
    }
  }
  const store = node.contributions.data.accountLinks;
  const same = (list: CreatorAccount[]) => list.map((a) => a.url).sort().join('\n');
  const existing = Object.values(store).find((s) => s.status === 'pending' && s.creatorId === creatorId && same(s.accounts) === same(accounts));
  if (existing) return { linked: false, proposal: existing };
  const proposal: AccountLinkProposal = {
    id: randomId('acc-', 8),
    creatorId,
    creatorName: node.registry.creator(creatorId)?.name,
    accounts,
    name: body.name ? String(body.name).trim().slice(0, 120) : undefined,
    kind: body.kind,
    symmetric: body.symmetric,
    accountId: account.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store[proposal.id] = proposal;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:linkAccounts', {
    message: `${creatorId.slice(0, 24)} · ${accounts.length} accounts proposed`,
    data: { creator: creatorId.slice(0, 32), accounts: accounts.length, signed: false, proposal: proposal.id, account: account.id.slice(0, 16) },
  });
  return { linked: false, proposal };
}
/** The operator accepts a proposal: the accounts join the creator's, within the cap. */
export function acceptAccountLink(node: AlgorithmNode, proposal: AccountLinkProposal): CreatorRecord {
  if (proposal.status !== 'pending') throw badRequest('This proposal is already decided');
  const known = node.registry.creator(proposal.creatorId);
  const merged = [...(known?.accounts ?? [])];
  for (const account of proposal.accounts) {
    const same = (other: CreatorAccount) =>
      (account.url && other.url === account.url) || (other.platform === account.platform && other.handle === account.handle);
    if (!merged.some(same)) merged.push(account);
  }
  const max = Math.max(0, node.config.maxCreatorAccounts);
  if (merged.length > max) throw badRequest(`Linking these would make more than ${max} accounts for this creator`);
  const creator = node.registry.upsertCreator({ id: proposal.creatorId, name: proposal.name, kind: proposal.kind, accounts: merged });
  linkBack(node, proposal.creatorId, proposal.accounts, proposal.symmetric);
  proposal.status = 'accepted';
  proposal.reviewedAt = new Date().toISOString();
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:acceptAccountLink', {
    message: `${proposal.id} accepted · ${merged.length} accounts`,
    data: { id: proposal.id, creator: proposal.creatorId.slice(0, 32), accounts: merged.length },
  });
  return creator;
}
/**
 * Content a client says is related to a creator, with an optional message for the
 * operator: accepted, it is linked to the creator and the client earns credits;
 * deleted, it is simply gone.
 */
export function suggestCreatorContent(node: AlgorithmNode, account: Account, rawCreator: string, body: CreatorContentRequest): CreatorContentResponse {
  const creatorId = String(rawCreator ?? '').trim();
  const creator = node.registry.creator(creatorId);
  if (!creator || creator.status === 'blocked') throw notFound('Unknown creator');
  const ref = String(body.id ?? '').trim();
  if (!ref) throw badRequest('id is required');
  const identity = identityOf({ id: ref });
  const message = String(body.message ?? '').trim().slice(0, 1000);
  const store = node.contributions.data.creatorSuggestions;
  const existing = Object.values(store).find((s) => s.creatorId === creatorId && s.contentId === identity.key);
  if (existing) return { suggestion: existing, newInfo: false, credited: 0 };
  const suggestion: CreatorContentSuggestion = {
    id: randomId('ccs-', 8),
    creatorId,
    contentId: identity.key,
    contentRef: ref.slice(0, 4096),
    message: message || undefined,
    title: String(body.title ?? '').trim().slice(0, 300) || undefined,
    platform: String(body.platform ?? '').trim().slice(0, 32) || undefined,
    metrics: metricsOf(body.metrics),
    accountId: account.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store[suggestion.id] = suggestion;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:suggestCreatorContent', {
    message: `${suggestion.id} · ${creatorId.slice(0, 24)}`,
    data: { id: suggestion.id, creator: creatorId.slice(0, 32), content: identity.key.slice(0, 32), account: account.id.slice(0, 16) },
  });
  return { suggestion, newInfo: true, credited: 0 };
}
/** The operator accepts: the content is linked to the creator, and the client is paid. */
export function acceptCreatorContent(node: AlgorithmNode, suggestion: CreatorContentSuggestion): number {
  if (suggestion.status !== 'pending') return 0;
  const { key, contentId, link } = identityOf({ id: suggestion.contentRef });
  node.registry.upsert({
    id: key,
    contentId,
    link,
    creatorId: suggestion.creatorId,
    title: suggestion.title || undefined,
    platformStats: suggestion.metrics,
    origin: 'report',
  });
  suggestion.status = 'accepted';
  suggestion.reviewedAt = new Date().toISOString();
  const reward = node.config.rewards.acceptedSuggestion;
  let credited = 0;
  const account = node.ledger.get(suggestion.accountId);
  if (account && reward > 0 && node.canEarn(account)) {
    node.ledger.credit(account.id, reward, 'accepted creator content', suggestion.id);
    credited = reward;
  }
  suggestion.credited = credited;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:acceptCreatorContent', {
    message: `${suggestion.id} accepted · ${credited} credits`,
    data: { id: suggestion.id, creator: suggestion.creatorId.slice(0, 32), content: suggestion.contentId.slice(0, 32), credited },
  });
  return credited;
}
/**
 * An icon a client suggests for a creator: accepted, it becomes the creator's icon and
 * the client earns credits; deleted, it is simply gone.
 */
export function suggestCreatorIcon(node: AlgorithmNode, account: Account, rawCreator: string, body: CreatorIconRequest): CreatorIconResponse {
  const creatorId = String(rawCreator ?? '').trim();
  const creator = node.registry.creator(creatorId);
  if (!creator || creator.status === 'blocked') throw notFound('Unknown creator');
  const icon = String(body.icon ?? '');
  const image = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(icon);
  const bytes = image ? Buffer.from(image[2], 'base64') : Buffer.alloc(0);
  if (!bytes.length) throw badRequest('The icon is a data: URL of a png, jpeg, webp or gif image');
  if (bytes.length > 200 * 1024) throw badRequest('The icon is at most 200 kB');
  const store = node.contributions.data.iconSuggestions;
  const existing = Object.values(store).find((s) => s.creatorId === creatorId && s.status === 'pending');
  if (existing) return { suggestion: existing, newInfo: false, credited: 0 };
  const suggestion: CreatorIconSuggestion = {
    id: randomId('ico-', 8),
    creatorId,
    creatorName: creator.name,
    icon,
    accountId: account.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store[suggestion.id] = suggestion;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:suggestCreatorIcon', {
    message: `${suggestion.id} · ${creatorId.slice(0, 24)}`,
    data: { id: suggestion.id, creator: creatorId.slice(0, 32), account: account.id.slice(0, 16) },
  });
  return { suggestion, newInfo: true, credited: 0 };
}
/** The operator accepts: the image becomes the creator's icon and the client is paid. */
export function acceptCreatorIcon(node: AlgorithmNode, suggestion: CreatorIconSuggestion): number {
  if (suggestion.status !== 'pending') return 0;
  node.registry.upsertCreator({ id: suggestion.creatorId, icon: suggestion.icon });
  suggestion.status = 'accepted';
  suggestion.reviewedAt = new Date().toISOString();
  const reward = node.config.rewards.acceptedSuggestion;
  let credited = 0;
  const account = node.ledger.get(suggestion.accountId);
  if (account && reward > 0 && node.canEarn(account)) {
    node.ledger.credit(account.id, reward, 'accepted creator icon', suggestion.id);
    credited = reward;
  }
  suggestion.credited = credited;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:acceptCreatorIcon', {
    message: `${suggestion.id} accepted · ${credited} credits`,
    data: { id: suggestion.id, creator: suggestion.creatorId.slice(0, 32), credited },
  });
  return credited;
}
export function registerSuggestionsRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
  const data = () => node.contributions.data;
    router.put('/v1/creators/accounts', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<CreatorAccountLinkRequest>(ctx.req);
      return linkAccounts(node, account, body);
    });

    router.post('/v1/votes', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<{ id?: string; vote?: number }>(ctx.req);
      const entry = node.registry.get(String(body.id ?? ''));
      if (!entry || entry.status !== 'listed') throw notFound('Only listed content can be voted on');
      const vote = Number(body.vote);
      if (![1, -1, 0].includes(vote)) throw badRequest('vote is 1 (like), -1 (dislike) or 0 (none)');
      const votes = (data().votes[entry.id] ??= {});
      const previous = votes[account.id];
      const first = previous === undefined;
      if (previous === 1) entry.likes--;
      if (previous === -1) entry.dislikes--;
      if (vote === 0) delete votes[account.id];
      else {
        votes[account.id] = vote as 1 | -1;
        if (vote === 1) entry.likes++;
        else entry.dislikes++;
      }
      node.registry.changed();
      node.contributions.changed();
      let credited = 0;
      const rewards = node.config.rewards;
      if (first && vote !== 0 && rewards.vote > 0 && node.canEarn(account) && node.ledger.daily(account, 'votes') < rewards.voteDailyCap) {
        node.ledger.addDaily(account, 'votes', 1);
        const updated = node.ledger.credit(account.id, rewards.vote, 'vote', entry.id);
        ctx.res.setHeader('x-vs-balance', String(updated.balance));
        credited = rewards.vote;
      }
      return { likes: entry.likes, dislikes: entry.dislikes, vote, credited };
    });

    router.get('/v1/votes/:id', (ctx) => {
      const account = node.auth.require(ctx);
      const key = baseId(ctx.params.id);
      return { vote: data().votes[key]?.[account.id] ?? 0 };
    });

    router.post('/v1/suggestions', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<SuggestionRequest>(ctx.req);
      return suggest(node, account, body);
    });

    router.get('/v1/suggestions/mine', (ctx) => {
      const account = node.auth.require(ctx);
      const mine = Object.values(data().suggestions)
        .filter((s) => s.votes.some((v) => v.account === account.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200)
        .map(({ votes, ...rest }) => ({ ...rest, agreeing: votes.length }));
      return { suggestions: mine };
    });

    // Content a client says is related to a creator (with an optional message). The
    // operator accepts — the content joins the creator and the client is paid — or deletes.
    router.post('/v1/creators/:id/suggestions', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<CreatorContentRequest>(ctx.req);
      return suggestCreatorContent(node, account, ctx.params.id, body);
    });

    router.get('/v1/creator-suggestions/mine', (ctx) => {
      const account = node.auth.require(ctx);
      return {
        suggestions: Object.values(node.contributions.data.creatorSuggestions)
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    // Icons a client suggested for a creator (a small image), for the operator to judge.
    router.post('/v1/creators/:id/icon-suggestion', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<CreatorIconRequest>(ctx.req, 1024 * 1024);
      return suggestCreatorIcon(node, account, ctx.params.id, body);
    });

    router.get('/v1/creator-icons/mine', (ctx) => {
      const account = node.auth.require(ctx);
      return {
        suggestions: Object.values(node.contributions.data.iconSuggestions ?? {})
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    // The account links a client proposed without the creator's key, with their status.
    router.get('/v1/account-links/mine', (ctx) => {
      const account = node.auth.require(ctx);
      return {
        proposals: Object.values(node.contributions.data.accountLinks ?? {})
          .filter((p) => p.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    router.post('/v1/reports', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<ReportRequest>(ctx.req);
      return report(node, ctx, account, String(body.id ?? ''));
    });

    // Platform popularity numbers (views, likes, comments, subscribers…) the client saw:
    // only what is new to the node pays, times the source's credit multipliers.
    router.get('/v1/admin/suggestions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(node.contributions.data.suggestions)
        .filter((s) => s.status === status)
        .sort((a, b) => b.votes.length - a.votes.length || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({ ...s, title: node.registry.get(s.contentId)?.title }));
      return { suggestions };
    });
    router.post('/v1/admin/suggestions/:id/:action', (ctx) => {
      admin(ctx);
      const suggestion = node.contributions.data.suggestions[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        if (suggestion.kind === 'report') node.registry.block(suggestion.contentId, `reported: ${suggestion.value}`);
        acceptSuggestion(node, suggestion);
      } else if (ctx.params.action === 'reject') {
        suggestion.status = 'rejected';
        suggestion.reviewedAt = new Date().toISOString();
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:rejectSuggestion', {
          message: `${suggestion.kind} ${suggestion.id} rejected`,
          data: { id: suggestion.id, kind: suggestion.kind, content: suggestion.contentId.slice(0, 32) },
        });
      } else throw notFound();
      return { ok: true };
    });

    // Content clients suggested as related to a creator: accepted, it is linked to the
    // creator (and the client is paid); deleted, the suggestion is gone for good.
    router.get('/v1/admin/creator-suggestions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(node.contributions.data.creatorSuggestions)
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({ ...s, title: node.registry.get(s.contentId)?.title, creatorName: node.registry.creator(s.creatorId)?.name }));
      return { suggestions };
    });

    router.post('/v1/admin/creator-suggestions/:id/:action', (ctx) => {
      admin(ctx);
      const store = node.contributions.data.creatorSuggestions;
      const suggestion = store[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        acceptCreatorContent(node, suggestion);
      } else if (ctx.params.action === 'delete') {
        delete store[ctx.params.id];
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:deleteCreatorSuggestion', {
          message: `${ctx.params.id} deleted`,
          data: { id: ctx.params.id, creator: suggestion.creatorId.slice(0, 32) },
        });
      } else throw notFound();
      return { ok: true };
    });

    // Icons clients suggested for a creator: accepted it becomes the icon (and the
    // suggesting client is paid), deleted it is gone.
    router.get('/v1/admin/creator-icons', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(node.contributions.data.iconSuggestions ?? {})
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300);
      return { suggestions };
    });

    router.post('/v1/admin/creator-icons/:id/:action', (ctx) => {
      admin(ctx);
      const store = node.contributions.data.iconSuggestions ?? {};
      const suggestion = store[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        acceptCreatorIcon(node, suggestion);
      } else if (ctx.params.action === 'delete') {
        delete store[ctx.params.id];
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:deleteIconSuggestion', {
          message: `${ctx.params.id} deleted`,
          data: { id: ctx.params.id, creator: suggestion.creatorId.slice(0, 32) },
        });
      } else throw notFound();
      return { ok: true };
    });

    // Account links proposed without the creator's key: linked only if the operator says so.
    router.get('/v1/admin/account-links', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const proposals = Object.values(node.contributions.data.accountLinks ?? {})
        .filter((p) => p.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300);
      return { proposals };
    });

    router.post('/v1/admin/account-links/:id/:action', (ctx) => {
      admin(ctx);
      const store = node.contributions.data.accountLinks ?? {};
      const proposal = store[ctx.params.id];
      if (!proposal) throw notFound('No such proposal');
      if (ctx.params.action === 'accept') {
        acceptAccountLink(node, proposal);
      } else if (ctx.params.action === 'delete') {
        delete store[ctx.params.id];
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:deleteAccountLink', {
          message: `${ctx.params.id} deleted`,
          data: { id: ctx.params.id, creator: proposal.creatorId.slice(0, 32) },
        });
      } else throw notFound();
      return { ok: true };
    });
    // Groups: the operator sees each group with its members, and the changes clients asked for.
}

