import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { topicIdOf } from '../src/shared/taxonomy.js';
import type { ContentItem, CreatorInfo, GroupSuggestionResponse, Page, TopicCreateResponse, TopicInfo, TopicSuggestionResponse } from '../src/shared/protocol.js';
import { admin, clientFor, startAlgorithm } from './helpers.js';

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('groups and topics', async () => {
  const node = await startAlgorithm({ rewards: { acceptedSuggestion: 4 } });
  const url = node.url();
  after(() => node.stop());

  const vid = (letter: string) => `vs1${letter.repeat(52)}`;
  const suggester = clientFor(url, 'pseudonym');

  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:solo', name: 'Solo Rider', kind: 'person' } });
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:outsider', name: 'Not In The Group', kind: 'person' } });
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: `${vid('a')}~yt:aaa111`, title: 'Black holes', format: 'video', rating: 'all', topics: ['science'], tags: ['space'], creatorId: 'name:labs', publishedAt: ago(2) } });
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: vid('b'), title: 'Bike ride', format: 'video', rating: 'all', topics: ['sport'], tags: ['bike'], creatorId: 'name:solo', publishedAt: ago(1) } });
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: vid('c'), title: 'Outside content', format: 'video', rating: 'all', topics: ['science'], tags: [], creatorId: 'name:outsider', publishedAt: ago(3) } });

  it('is a creator of kind group; other creators never become one', async () => {
    const created = await admin<{ group: { id: string; kind: string; members?: string[] } }>(url, '/v1/admin/groups', {
      method: 'PUT',
      body: { id: 'name:nightly', name: 'Nightly creators', description: 'Everything nightly' },
    });
    assert.equal(created.group.kind, 'group');
    assert.deepEqual(created.group.members, []);

    // A group id is a creator id: the ordinary creators list finds it, and only with kind=group.
    const groups = await clientFor(url).json<{ creators: CreatorInfo[] }>('/v1/creators?kind=group', { auth: false });
    assert.deepEqual(
      groups.creators.map((creator) => creator.id),
      ['name:nightly']
    );
    const people = await clientFor(url).json<{ creators: CreatorInfo[] }>('/v1/creators?kind=person', { auth: false });
    assert.deepEqual(
      people.creators.map((creator) => creator.id).sort(),
      ['name:outsider', 'name:solo']
    );

    // Only creators the node knows become members.
    await assert.rejects(admin(url, '/v1/admin/groups/name:nightly/members', { body: { add: ['name:ghost'] } }), /Unknown creator/);
  });

  it('adds and drops members, and shows their content together on the group page', async () => {
    await admin(url, '/v1/admin/groups/name:nightly/members', { body: { add: ['name:labs', 'name:solo'] } });
    const view = await clientFor(url).json<{ group: CreatorInfo & { members: string[] }; members: CreatorInfo[]; items: ContentItem[] }>(
      '/v1/groups/name:nightly',
      { auth: false }
    );
    assert.deepEqual(view.group.members, ['name:labs', 'name:solo']);
    assert.deepEqual(
      view.members.map((member) => member.name),
      ['Science Labs', 'Solo Rider']
    );
    // Every member's content, newest first, and nothing from outside the group.
    assert.deepEqual(
      view.items.map((item) => item.title),
      ['Bike ride', 'Black holes']
    );

    // Only groups carry members, and the content says which groups its creator is in.
    const labs = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(labs.creator.members, undefined, 'a plain creator has no members');
    const content = view.items.find((item) => item.title === 'Black holes')!;
    assert.deepEqual(content.groups, [{ id: 'name:nightly', name: 'Nightly creators' }]);

    await admin(url, '/v1/admin/groups/name:nightly/members', { body: { remove: ['name:solo'] } });
    const shrunk = await clientFor(url).json<{ items: ContentItem[] }>('/v1/groups/name:nightly', { auth: false });
    assert.deepEqual(
      shrunk.items.map((item) => item.title),
      ['Black holes']
    );
    await admin(url, '/v1/admin/groups/name:nightly/members', { body: { add: ['name:solo'] } });
  });

  it('keeps a client’s suggested changes for the operator, who applies them on accept', async () => {
    const suggested = await suggester.json<GroupSuggestionResponse>('/v1/groups/name:nightly/suggestion', {
      body: {
        add: ['name:outsider'],
        name: 'Nightly collective',
        description: 'Nightly everything',
        links: ['https://example.org/nightly'],
        reason: 'they post nightly',
      },
    });
    assert.equal(suggested.newInfo, true);
    assert.equal(suggested.credited, 0, 'nothing is paid before the operator accepts');

    const pending = await admin<{ suggestions: (GroupSuggestionResponse['suggestion'] & { addNames: string[] })[] }>(url, '/v1/admin/group-suggestions');
    assert.equal(pending.suggestions.length, 1);
    assert.deepEqual(pending.suggestions[0].addNames, ['Not In The Group']);

    await admin(url, `/v1/admin/group-suggestions/${suggested.suggestion.id}/accept`, { body: {} });
    const view = await clientFor(url).json<{ group: CreatorInfo & { members: string[] }; items: ContentItem[] }>('/v1/groups/name:nightly', { auth: false });
    assert.equal(view.group.name, 'Nightly collective');
    assert.equal(view.group.description, 'Nightly everything');
    assert.deepEqual(view.group.links, ['https://example.org/nightly']);
    assert.deepEqual(view.group.members, ['name:labs', 'name:solo', 'name:outsider']);
    assert.deepEqual(
      view.items.map((item) => item.title),
      ['Bike ride', 'Black holes', 'Outside content']
    );
    const account = await suggester.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 4, 'the accepted suggestion paid the client');

    // A suggestion that asks for nothing is refused, and so is one for a plain creator.
    await assert.rejects(suggester.json('/v1/groups/name:nightly/suggestion', { body: { reason: 'nothing' } }), /asks for members/);
    await assert.rejects(suggester.json('/v1/groups/name:labs/suggestion', { body: { name: 'x' } }), /not a group/);

    // Back to two members, so the page filters below see the group as it was.
    await admin(url, '/v1/admin/groups/name:nightly/members', { body: { remove: ['name:outsider'] } });
  });

  it('lets a page whitelist or blacklist a group, a creator or a topic', async () => {
    const search = (filters: Record<string, unknown>) =>
      clientFor(url).json<Page<ContentItem>>('/v1/search', { body: { query: '', filters, limit: 20 }, auth: false });
    const titles = (items: ContentItem[]) => items.map((item) => item.title).sort();
    assert.deepEqual(titles((await search({})).items), ['Bike ride', 'Black holes', 'Outside content']);

    // Whitelisting a group keeps exactly the content of its members.
    const inGroup = await search({ creatorIds: ['name:nightly'], onlyCreators: true });
    assert.deepEqual(titles(inGroup.items), ['Bike ride', 'Black holes']);
    // Whitelisting one creator keeps only theirs.
    const oneCreator = await search({ creatorIds: ['name:labs'], onlyCreators: true });
    assert.deepEqual(titles(oneCreator.items), ['Black holes']);
    // Blacklisting a group takes everyone in it out, not only the group's own page.
    const noGroup = await search({ blockedCreators: ['name:nightly'] });
    assert.deepEqual(titles(noGroup.items), ['Outside content']);
    // Blacklisting a topic takes everything filed under it out, by name or by id.
    assert.deepEqual(titles((await search({ blockedTopics: ['science'] })).items), ['Bike ride']);
    assert.deepEqual(titles((await search({ blockedTopics: [topicIdOf('science')] })).items), ['Bike ride']);
  });
});


describe('topics: the categories content is filed under', async () => {
  const node = await startAlgorithm({ rewards: { acceptedSuggestion: 3 } });
  const url = node.url();
  after(() => node.stop());

  const vid = (letter: string) => `vs1${letter.repeat(52)}`;
  const author = clientFor(url, 'pseudonym');

  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  await admin(url, '/v1/admin/content', {
    method: 'PUT',
    body: { id: vid('d'), title: 'Deep sea dwellers', format: 'video', rating: 'all', topics: ['science'], tags: [], creatorId: 'name:labs', publishedAt: ago(1) },
  });

  it('files content under the exact topic id, and keeps a topic under its hash', async () => {
    const science = topicIdOf('science');
    assert.match(science, /^tp1[0-9a-f]{32}$/, 'a topic id is a hash, never the name');
    assert.notEqual(science, 'science');

    const entry = await clientFor(url).json<ContentItem>('/v1/content/' + encodeURIComponent(vid('d')), { auth: false });
    assert.deepEqual(entry.topicIds, [science], 'content carries the topic id it is filed under');

    const page = await clientFor(url).json<{ topic: TopicInfo; items: ContentItem[] }>(`/v1/topics/${science}`, { auth: false });
    assert.equal(page.topic.name, 'science');
    assert.equal(page.topic.items, 1);
    assert.deepEqual(
      page.items.map((item) => item.title),
      ['Deep sea dwellers']
    );

    // Search finds it by a part of the name and by its id; an unknown topic gives nothing.
    const byName = await clientFor(url).json<{ topics: TopicInfo[] }>('/v1/topics?q=sci', { auth: false });
    assert.deepEqual(
      byName.topics.map((topic) => topic.id),
      [science]
    );
    assert.equal((await clientFor(url).json<{ topics: TopicInfo[] }>(`/v1/topics?q=${science}`, { auth: false })).topics.length, 1);
    assert.deepEqual((await clientFor(url).json<{ topics: TopicInfo[] }>('/v1/topics?q=zzzz', { auth: false })).topics, []);
  });

  it('lets a client bring a topic; the same name always lands on the same id', async () => {
    const created = await author.json<TopicCreateResponse>('/v1/topics', { body: { name: 'Deep Sea', description: 'Life under water' } });
    assert.equal(created.newInfo, true);
    assert.equal(created.topic.id, topicIdOf('Deep Sea'));
    assert.equal(created.credited, 0, 'bringing a topic is not paid');
    const again = await author.json<TopicCreateResponse>('/v1/topics', { body: { name: 'deep sea' } });
    assert.equal(again.newInfo, false);
    assert.equal(again.topic.id, created.topic.id);
    assert.equal(again.topic.description, 'Life under water', 'the first description stays');
    await assert.rejects(author.json('/v1/topics', { body: { name: '  ' } }), /needs a name/);
  });

  it('stores a description or icon the operator accepted, and refuses an unknown topic', async () => {
    const id = topicIdOf('Deep Sea');
    const suggested = await author.json<TopicSuggestionResponse>(`/v1/topics/${id}/suggestion`, {
      body: { description: 'Everything below the surface', reason: 'the topic had none' },
    });
    assert.equal(suggested.newInfo, true);
    const again = await author.json<TopicSuggestionResponse>(`/v1/topics/${id}/suggestion`, { body: { description: 'other words' } });
    assert.equal(again.newInfo, false, 'one suggestion per topic waits at a time');
    assert.equal(again.suggestion.id, suggested.suggestion.id);

    const pending = await admin<{ suggestions: { id: string; topicName?: string }[] }>(url, '/v1/admin/topic-suggestions');
    assert.equal(pending.suggestions[0].topicName, 'Deep Sea');
    await admin(url, `/v1/admin/topic-suggestions/${suggested.suggestion.id}/accept`, { body: {} });

    const page = await clientFor(url).json<{ topic: TopicInfo }>(`/v1/topics/${id}`, { auth: false });
    assert.equal(page.topic.description, 'Everything below the surface');
    const account = await author.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 3, 'the accepted topic suggestion paid the client');

    await assert.rejects(clientFor(url).json(`/v1/topics/${topicIdOf('nowhere')}`, { auth: false }), /Unknown topic/);
    await assert.rejects(clientFor(url).json('/v1/groups/name:labs', { auth: false }), /not a group/);
  });
});

