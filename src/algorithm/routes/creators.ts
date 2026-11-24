// Creators, groups and topics: the pages clients see, group membership, and what
// clients may suggest for groups and topics.

import type { AlgorithmNode } from '../node.js';
import { type Account } from '../../node/ledger.js';
import { randomId } from '../../shared/crypto.js';
import { type Ctx, badRequest, notFound, readJson } from '../../shared/node/http.js';
import { type ContentItem, type CreatorInfo, type GroupSuggestion, type GroupSuggestionRequest, type GroupSuggestionResponse, type Preferences, type TopicCreateRequest, type TopicCreateResponse, type TopicInfo, type TopicSuggestion, type TopicSuggestionRequest, type TopicSuggestionResponse } from '../../shared/protocol.js';
import { type CreatorRecord, type TopicRecord } from '../registry.js';
import { cleanIds, cleanLinks, creatorMatch, nativeSuggestions, pageOf, topicMatch } from '../support.js';
import { checkedIcon, servedAccounts } from '../routes/suggestions.js';

/** A topic as clients see it: its name, description, icon and how much content it has. */
export function topicInfo(node: AlgorithmNode, topic: TopicRecord): TopicInfo {
  return {
    id: topic.id,
    name: topic.name,
    description: topic.description,
    icon: topic.icon,
    items: node.registry.countTopic(topic.id),
  };
}
export function memberInfo(node: AlgorithmNode, id: string): CreatorInfo {
  const creator = node.registry.creator(id);
  if (!creator) return { id, name: id.slice(0, 16), kind: 'unknown' };
  return {
    id: creator.id,
    name: creator.name,
    kind: creator.kind,
    description: creator.description,
    links: creator.links,
    icon: creator.icon,
  };
}
/**
 * A group page: the group, its members (for the carousel) and the content of every
 * member in one list, newest first. A group has no content of its own.
 */
export function groupView(node: AlgorithmNode, rawId: string): { group: CreatorInfo; members: CreatorInfo[]; items: ContentItem[] } {
  const group = node.registry.creator(String(rawId ?? '').trim());
  if (!group || group.status === 'blocked') throw notFound('Unknown group');
  if (group.kind !== 'group') throw badRequest('This creator is not a group');
  const members = node.registry.members(group.id);
  const ids = new Set(members);
  const items = node.registry
    .visible(node.preferencesOf({}), node.config.policy.maxRating)
    .filter((entry) => entry.creatorId !== undefined && ids.has(entry.creatorId))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 200)
    .map((entry) => node.registry.view(entry));
  const { status: _status, addedAt: _added, ...info } = group;
  return { group: { ...info, members }, members: members.map((id) => memberInfo(node, id)), items };
}
/** A topic page: the topic and every content filed under that exact topic id. */
export function topicView(node: AlgorithmNode, rawId: string): { topic: TopicInfo; items: ContentItem[] } {
  const topic = node.registry.topic(String(rawId ?? '').trim());
  if (!topic || topic.status === 'blocked') throw notFound('Unknown topic');
  const items = node.registry
    .visible(node.preferencesOf({}), node.config.policy.maxRating)
    .filter((entry) => (entry.topicIds ?? []).includes(topic.id))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 200)
    .map((entry) => node.registry.view(entry));
  return { topic: topicInfo(node, topic), items };
}
/**
 * A client brings a topic. It is stored under the hash of its name, so two clients
 * asking for the same name land on the same topic; nothing is paid for it.
 */
export function createTopic(node: AlgorithmNode, _account: Account, body: TopicCreateRequest): TopicCreateResponse {
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('A topic needs a name');
  if (name.length > 120) throw badRequest('A topic name is at most 120 characters');
  const description = body.description === undefined ? undefined : String(body.description).slice(0, 2000);
  const { topic, created } = node.registry.upsertTopic({ name, description });
  return { topic: topicInfo(node, topic), newInfo: created, credited: 0 };
}
/**
 * A client suggesting changes to a group — members to add or drop, a name, a description,
 * links, an icon. Kept for the operator, who accepts it or deletes it.
 */
export function suggestGroup(node: AlgorithmNode, account: Account, rawId: string, body: GroupSuggestionRequest): GroupSuggestionResponse {
  const group = node.registry.creator(String(rawId ?? '').trim());
  if (!group || group.status === 'blocked') throw notFound('Unknown group');
  if (group.kind !== 'group') throw badRequest('This creator is not a group');
  const add = cleanIds(body.add);
  const remove = cleanIds(body.remove);
  const icon = checkedIcon(body.icon);
  const name = body.name === undefined ? undefined : String(body.name).trim().slice(0, 120) || undefined;
  const description = body.description === undefined ? undefined : String(body.description).slice(0, 2000) || undefined;
  const links = body.links === undefined ? undefined : cleanLinks(body.links);
  if (!add.length && !remove.length && !name && !description && !icon && !links?.length) {
    throw badRequest('A group suggestion asks for members, a name, a description, links or an icon');
  }
  const suggestion: GroupSuggestion = {
    id: randomId('grp-', 8),
    groupId: group.id,
    groupName: group.name,
    add,
    remove,
    name,
    description,
    links,
    icon,
    reason: body.reason === undefined ? undefined : String(body.reason).slice(0, 500) || undefined,
    accountId: account.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  node.contributions.data.groupSuggestions[suggestion.id] = suggestion;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:suggestGroup', {
    message: `${suggestion.id} · ${group.id.slice(0, 24)}`,
    data: {
      id: suggestion.id,
      group: group.id.slice(0, 32),
      add: add.length,
      remove: remove.length,
      account: account.id.slice(0, 16),
    },
  });
  return { suggestion, newInfo: true, credited: 0 };
}
/** The operator accepts a group suggestion: everything it asks for is applied at once. */
export function acceptGroupSuggestion(node: AlgorithmNode, suggestion: GroupSuggestion): number {
  if (suggestion.status !== 'pending') return 0;
  const group = node.registry.creator(suggestion.groupId);
  if (group) {
    node.registry.setMembers(group.id, suggestion.add ?? [], suggestion.remove ?? []);
    if (suggestion.name || suggestion.description || suggestion.links?.length || suggestion.icon) {
      node.registry.upsertCreator({
        id: group.id,
        kind: 'group',
        name: suggestion.name,
        description: suggestion.description,
        links: suggestion.links?.length ? suggestion.links : undefined,
        icon: suggestion.icon,
      });
    }
  }
  return paySuggestion(node, suggestion, 'accepted group suggestion');
}
/** A client suggesting what a topic's description or icon should say. */
export function suggestTopic(node: AlgorithmNode, account: Account, rawId: string, body: TopicSuggestionRequest): TopicSuggestionResponse {
  const topic = node.registry.topic(String(rawId ?? '').trim());
  if (!topic || topic.status === 'blocked') throw notFound('Unknown topic');
  const description = body.description === undefined ? undefined : String(body.description).slice(0, 2000) || undefined;
  const icon = checkedIcon(body.icon);
  if (!description && !icon) throw badRequest('A topic suggestion carries a description or an icon');
  const store = node.contributions.data.topicSuggestions;
  const existing = Object.values(store).find((s) => s.topicId === topic.id && s.status === 'pending');
  if (existing) return { suggestion: existing, newInfo: false, credited: 0 };
  const suggestion: TopicSuggestion = {
    id: randomId('tps-', 8),
    topicId: topic.id,
    topicName: topic.name,
    description,
    icon,
    reason: body.reason === undefined ? undefined : String(body.reason).slice(0, 500) || undefined,
    accountId: account.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store[suggestion.id] = suggestion;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:suggestTopic', {
    message: `${suggestion.id} · ${topic.id.slice(0, 24)}`,
    data: { id: suggestion.id, topic: topic.id.slice(0, 32), account: account.id.slice(0, 16) },
  });
  return { suggestion, newInfo: true, credited: 0 };
}
/** The operator accepts a topic suggestion: the description or icon is stored. */
export function acceptTopicSuggestion(node: AlgorithmNode, suggestion: TopicSuggestion): number {
  if (suggestion.status !== 'pending') return 0;
  const topic = node.registry.topic(suggestion.topicId);
  if (topic) {
    node.registry.upsertTopic({ id: topic.id, name: topic.name, description: suggestion.description, icon: suggestion.icon });
  }
  return paySuggestion(node, suggestion, 'accepted topic suggestion');
}
/** Marks an accepted suggestion and pays the client that made it, as icons do. */
export function paySuggestion(node: AlgorithmNode, suggestion: GroupSuggestion | TopicSuggestion, reason: string): number {
  suggestion.status = 'accepted';
  suggestion.reviewedAt = new Date().toISOString();
  const reward = node.config.rewards.acceptedSuggestion;
  let credited = 0;
  const account = node.ledger.get(suggestion.accountId);
  if (account && reward > 0 && node.canEarn(account)) {
    node.ledger.credit(account.id, reward, reason, suggestion.id);
    credited = reward;
  }
  suggestion.credited = credited;
  node.contributions.changed();
  node.traces.trace('basic', 'algorithm.suggestions', 'function:paySuggestion', {
    message: `${suggestion.id} accepted · ${credited} credits`,
    data: { id: suggestion.id, kind: reason, credited, account: suggestion.accountId.slice(0, 16) },
  });
  return credited;
}
export function registerCreatorsRoutes(node: AlgorithmNode): void {
  const router = node.router;
  const admin = (ctx: Ctx) => node.requireAdmin(ctx);
    router.post('/v1/creators/latest', async (ctx) => {
      const body = await readJson<{ creators?: string[]; preferences?: Preferences; cursor?: string; limit?: number; bloom?: unknown; previews?: boolean }>(ctx.req);
      const wanted = (body.creators ?? []).slice(0, 500).map(String);
      // A subscription may name a creator, a group (its members' content is what it means)
      // or a topic (the content filed under its id), so each id is read as all three.
      const creators = new Set<string>();
      const topicIds = new Set<string>();
      for (const id of wanted) {
        if (id.startsWith('tp1')) topicIds.add(id);
        for (const member of node.registry.members(id)) creators.add(member);
        creators.add(id);
      }
      node.charge(ctx, node.config.pricing.feed, 'subscriptions');
      // The background subscriptions job looks for what is new on the subscribed
      // creators' own platforms: bounded batches, a few creators per tick, within one
      // run's budgets (creators, platform calls, wall clock). The page answers with
      // whatever has landed within a short wait; the job keeps working after it and
      // the next request continues where it stopped (each creator is re-checked only
      // every crawler.creatorRefreshHours).
      await node.crawler.requestSubscriptionsJob([...creators]).wait(1500);
      // The subscriptions feed is simply the newest content of the creators you follow:
      // seen-content filters do not apply here — it lists what is recent, seen or not.
      const preferences = node.preferencesOf(body.preferences);
      const items = node.registry
        .visible(preferences, node.config.policy.maxRating)
        .filter(
          (entry) =>
            (entry.creatorId !== undefined && creators.has(entry.creatorId)) ||
            (entry.topicIds ?? []).some((topic) => topicIds.has(topic))
        )
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      const first = nativeSuggestions(items, preferences.formats);
      const page = pageOf([...first, ...items.filter((entry) => !first.includes(entry))], body.cursor, node.limitOf(body.limit));
      return { ...page, items: page.items.map((entry) => node.clientView(entry, body.previews !== false, first.includes(entry))) };
    });

    // Creator search (Explore): no exact name needed — the words may come in any order
    // and match only partly, in the name, the id or a linked account.
    router.get('/v1/creators', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim();
      const kind = (ctx.query.get('kind') ?? '').trim();
      const creators = Object.values(node.registry.data.creators)
        .filter((creator) => creator.status === 'listed')
        .filter((creator) => !kind || creator.kind === kind)
        .map((creator) => ({ creator, score: creatorMatch(creator, q) }))
        .filter((match): match is { creator: CreatorRecord; score: number } => match.score !== null)
        .sort((a, b) => a.score - b.score || a.creator.name.localeCompare(b.creator.name))
        .slice(0, 50)
        .map((match) => ({ ...match.creator, accounts: servedAccounts(node, match.creator) }));
      return { creators };
    });

    router.get('/v1/creators/:id', (ctx) => {
      const creator = node.registry.creator(ctx.params.id);
      if (!creator || creator.status === 'blocked') throw notFound('Unknown creator');
      const items = node.registry
        .visible(node.preferencesOf({}), node.config.policy.maxRating)
        .filter((entry) => entry.creatorId === creator.id)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 100)
        .map((entry) => node.registry.view(entry));
      const { status: _status, addedAt: _added, ...info } = creator;
      return { creator: { ...info, accounts: creator.accounts ? servedAccounts(node, creator) : undefined }, items };
    });

    // A group is a creator of kind `group` whose members are other content creators.
    // Its page is the group's own row plus every member's content in one list; there is
    // no linking between creators, only membership.
    router.get('/v1/groups/:id', (ctx) => groupView(node, ctx.params.id));

    // A topic is a category of content: content carries the topic id it is filed under.
    router.get('/v1/topics', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim();
      const topics = node.registry
        .topics()
        .map((topic) => ({ topic, score: topicMatch(topic, q) }))
        .filter((match): match is { topic: TopicRecord; score: number } => match.score !== null)
        .sort((a, b) => a.score - b.score || a.topic.name.localeCompare(b.topic.name))
        .slice(0, 50)
        .map((match) => topicInfo(node, match.topic));
      return { topics };
    });

    // A client bringing a topic: the node stores it (its id is the hash of the name).
    router.post('/v1/topics', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<TopicCreateRequest>(ctx.req);
      return createTopic(node, account, body);
    });

    router.get('/v1/topics/:id', (ctx) => topicView(node, ctx.params.id));

    // A client suggesting a change to a group — members to add or drop, a name, a
    // description, links, an icon. The operator accepts it or deletes it.
    router.post('/v1/groups/:id/suggestion', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<GroupSuggestionRequest>(ctx.req, 1024 * 1024);
      return suggestGroup(node, account, ctx.params.id, body);
    });

    router.get('/v1/group-suggestions/mine', (ctx) => {
      const account = node.auth.require(ctx);
      return {
        suggestions: Object.values(node.contributions.data.groupSuggestions ?? {})
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    // A client suggesting what a topic description or icon should say.
    router.post('/v1/topics/:id/suggestion', async (ctx) => {
      const account = node.auth.require(ctx);
      const body = await readJson<TopicSuggestionRequest>(ctx.req, 1024 * 1024);
      return suggestTopic(node, account, ctx.params.id, body);
    });

    router.get('/v1/topic-suggestions/mine', (ctx) => {
      const account = node.auth.require(ctx);
      return {
        suggestions: Object.values(node.contributions.data.topicSuggestions ?? {})
          .filter((s) => s.accountId === account.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200),
      };
    });

    // A creator linking their accounts on other platforms (YouTube, TikTok, Twitter…):
    // signed with the creator's key it links at once; unsigned it is kept for the operator.
    router.get('/v1/admin/creators', (ctx) => {
      admin(ctx);
      const q = (ctx.query.get('q') ?? '').trim().slice(0, 100);
      let all = Object.values(node.registry.data.creators);
      // The console finds creators by name: the words may come in any order and match
      // only partly, in the name, the id or a linked account.
      if (q) {
        all = all
          .map((creator) => ({ creator, score: creatorMatch(creator, q) }))
          .filter((match): match is { creator: CreatorRecord; score: number } => match.score !== null)
          .sort((a, b) => a.score - b.score || a.creator.name.localeCompare(b.creator.name))
          .map((match) => match.creator);
      }
      // Without a limit the whole list (the way it has always answered).
      if (ctx.query.get('limit') === null) return { creators: all };
      const page = pageOf(all, ctx.query.get('cursor') ?? undefined, node.listLimit(ctx.query.get('limit')));
      return { creators: page.items, cursor: page.cursor, total: page.total };
    });
    router.put('/v1/admin/creators', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ id: string; accounts?: { platform: string; handle: string; url?: string }[] }>(ctx.req);
      if (Array.isArray(body.accounts) && body.accounts.length > Math.max(0, node.config.maxCreatorAccounts)) {
        throw badRequest(`A creator may link at most ${node.config.maxCreatorAccounts} accounts`);
      }
      // The console edits the whole record: what it leaves out of keys is gone.
      return node.registry.upsertCreator(body, { replaceKeys: true });
    });
    router.get('/v1/admin/groups', (ctx) => {
      admin(ctx);
      const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
      const groups = node.registry
        .groups(true)
        .filter((group) => !q || group.name.toLowerCase().includes(q) || group.id.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500)
        .map((group) => ({
          ...group,
          memberCreators: (group.members ?? []).map((id) => memberInfo(node, id)),
          items: node.registry.all().filter((entry) => entry.creatorId !== undefined && (group.members ?? []).includes(entry.creatorId)).length,
        }));
      return { groups };
    });

    // The operator's own edits of a group: its name, description, links, icon and status.
    router.put('/v1/admin/groups', async (ctx) => {
      admin(ctx);
      const body = await readJson<{
        id: string;
        name?: string;
        description?: string;
        icon?: string;
        links?: string[];
        members?: string[];
        status?: 'listed' | 'blocked';
      }>(ctx.req, 1024 * 1024);
      const id = String(body.id ?? '').trim();
      if (!id) throw badRequest('A group needs an id');
      const existing = node.registry.creator(id);
      if (existing && existing.kind !== 'group') throw badRequest('This creator is not a group');
      const icon = checkedIcon(body.icon);
      const group = node.registry.upsertCreator({
        id,
        kind: 'group',
        name: body.name,
        description: body.description,
        icon: body.icon === undefined ? undefined : (icon ?? ''),
        links: body.links,
        members: body.members ?? existing?.members ?? [],
        status: body.status,
      });
      return { group };
    });

    // Who is in a group. Membership is binary: a creator is added or dropped, nothing else.
    router.post('/v1/admin/groups/:id/members', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ add?: string[]; remove?: string[] }>(ctx.req);
      return { group: node.registry.setMembers(ctx.params.id, cleanIds(body.add), cleanIds(body.remove)) };
    });

    // Changes clients asked for on groups: accept applies them, delete drops the request.
    router.get('/v1/admin/group-suggestions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(node.contributions.data.groupSuggestions ?? {})
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({
          ...s,
          groupName: s.groupName ?? node.registry.creator(s.groupId)?.name,
          addNames: (s.add ?? []).map((id) => node.registry.creator(id)?.name ?? id),
          removeNames: (s.remove ?? []).map((id) => node.registry.creator(id)?.name ?? id),
        }));
      return { suggestions };
    });

    router.post('/v1/admin/group-suggestions/:id/:action', (ctx) => {
      admin(ctx);
      const store = node.contributions.data.groupSuggestions ?? {};
      const suggestion = store[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        acceptGroupSuggestion(node, suggestion);
      } else if (ctx.params.action === 'delete') {
        delete store[ctx.params.id];
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:deleteGroupSuggestion', {
          message: `${ctx.params.id} deleted`,
          data: { id: ctx.params.id, group: suggestion.groupId.slice(0, 32) },
        });
      } else throw notFound();
      return { ok: true };
    });

    // Topics: one row per topic, with what users suggested for it, waiting here.
    router.get('/v1/admin/topics', (ctx) => {
      admin(ctx);
      const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
      const topics = node.registry
        .topics(true)
        .filter((topic) => !q || topic.name.toLowerCase().includes(q) || topic.id.toLowerCase().includes(q))
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
        .slice(0, 500)
        .map((topic) => topicInfo(node, topic));
      return { topics };
    });

    // The operator's own topics: a new one gets the id its name hashes to; an existing id
    // is edited (name, description, icon, status).
    router.put('/v1/admin/topics', async (ctx) => {
      admin(ctx);
      const body = await readJson<{ id?: string; name: string; description?: string; icon?: string; status?: 'listed' | 'blocked' }>(
        ctx.req,
        1024 * 1024
      );
      const icon = checkedIcon(body.icon);
      const { topic } = node.registry.upsertTopic({
        id: body.id,
        name: body.name,
        description: body.description,
        icon: body.icon === undefined ? undefined : (icon ?? ''),
        status: body.status,
      });
      return { topic: topicInfo(node, topic) };
    });

    // Descriptions and icons clients suggested for topics: accept stores them, delete drops them.
    router.get('/v1/admin/topic-suggestions', (ctx) => {
      admin(ctx);
      const status = ctx.query.get('status') ?? 'pending';
      const suggestions = Object.values(node.contributions.data.topicSuggestions ?? {})
        .filter((s) => s.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map((s) => ({ ...s, topicName: s.topicName ?? node.registry.topic(s.topicId)?.name }));
      return { suggestions };
    });

    router.post('/v1/admin/topic-suggestions/:id/:action', (ctx) => {
      admin(ctx);
      const store = node.contributions.data.topicSuggestions ?? {};
      const suggestion = store[ctx.params.id];
      if (!suggestion) throw notFound('No such suggestion');
      if (ctx.params.action === 'accept') {
        acceptTopicSuggestion(node, suggestion);
      } else if (ctx.params.action === 'delete') {
        delete store[ctx.params.id];
        node.contributions.changed();
        node.traces.trace('basic', 'algorithm.admin', 'function:deleteTopicSuggestion', {
          message: `${ctx.params.id} deleted`,
          data: { id: ctx.params.id, topic: suggestion.topicId.slice(0, 32) },
        });
      } else throw notFound();
      return { ok: true };
    });

}

