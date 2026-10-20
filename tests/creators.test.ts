import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { generateIdentity, signData, type Identity } from '../src/shared/crypto.js';
import {
  claimSigningPayload,
  type AccountLinkResponse,
  type AlgorithmInfo,
  type CreatorAccountLinkRequest,
  type CreatorContentResponse,
  type CreatorInfo,
  type SignedInfo,
} from '../src/shared/protocol.js';
import { admin, clientFor, startAlgorithm, startClient, tempDir } from './helpers.js';
import { creatorRefOf } from '../src/shared/sources.js';

describe('creators linking their accounts together', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());

  const creator = generateIdentity();
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company', keys: [creator.id] } });

  const proofFor = (key: Identity, subject: string) => {
    const ts = Date.now();
    return { key: key.id, ts, sig: signData(key, claimSigningPayload(node.identity.id, subject, ts)) };
  };

  it('only lets the creator (its key) link accounts, and shows them on its page', async () => {
    const impostor = generateIdentity();
    const bad: CreatorAccountLinkRequest = {
      creator: 'name:labs',
      accounts: [{ platform: 'yt', handle: '@science' }],
      proof: proofFor(impostor, 'name:labs'),
    };
    await assert.rejects(clientFor(url, 'pseudonym').json('/v1/creators/accounts', { method: 'PUT', body: bad }), /Only the creator/);

    const good: CreatorAccountLinkRequest = {
      creator: 'name:labs',
      accounts: [
        { platform: 'yt', handle: '@science', url: 'https://youtube.com/@science' },
        { platform: 'tiktok', handle: '@science' },
        { platform: 'x', handle: '@science' },
      ],
      proof: proofFor(creator, 'name:labs'),
    };
    const saved = await clientFor(url, 'pseudonym').json<AccountLinkResponse>('/v1/creators/accounts', { method: 'PUT', body: good });
    assert.equal(saved.linked, true, 'a signed request links at once');
    assert.deepEqual(
      saved.creator?.accounts?.map((account) => [account.platform, account.handle]),
      [
        ['yt', '@science'],
        ['tiktok', '@science'],
        ['x', '@science'],
      ]
    );
    // What the creator page shows.
    const view = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(view.creator.accounts?.length, 3);
  });

  it('caps how many accounts one creator may link, at the number the operator sets', async () => {
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { maxCreatorAccounts: 2 } });
    const tooMany: CreatorAccountLinkRequest = {
      creator: 'name:labs',
      accounts: [
        { platform: 'yt', handle: '@a' },
        { platform: 'x', handle: '@a' },
        { platform: 'tiktok', handle: '@a' },
      ],
      proof: proofFor(creator, 'name:labs'),
    };
    await assert.rejects(clientFor(url, 'pseudonym').json('/v1/creators/accounts', { method: 'PUT', body: tooMany }), /at most 2 accounts/);
    // The limit travels in the node info, where clients (and the GUI) can see it.
    const { info } = await clientFor(url).json<SignedInfo>('/v1/info', { auth: false });
    assert.equal((info as AlgorithmInfo).maxCreatorAccounts, 2);
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { maxCreatorAccounts: 8 } });
  });

  it('lets a new creator start their record with their key as id', async () => {
    const fresh = generateIdentity();
    const request: CreatorAccountLinkRequest = {
      creator: fresh.id,
      name: 'Solo Rider',
      kind: 'person',
      accounts: [{ platform: 'x', handle: '@solo' }],
      proof: proofFor(fresh, fresh.id),
    };
    const saved = await clientFor(url, 'pseudonym').json<AccountLinkResponse>('/v1/creators/accounts', { method: 'PUT', body: request });
    assert.equal(saved.linked, true);
    assert.equal(saved.creator?.id, fresh.id);
    assert.equal(saved.creator?.name, 'Solo Rider');
    assert.equal(saved.creator?.accounts?.[0]?.handle, '@solo');
  });

  it('lets anyone propose external links without the key; the operator decides', async () => {
    const stranger = clientFor(url, 'pseudonym');
    // Without the key, every account must be an external link to the creator.
    await assert.rejects(
      stranger.json('/v1/creators/accounts', {
        method: 'PUT',
        body: { creator: 'name:labs', accounts: [{ platform: 'tiktok', handle: '@science' }] },
      }),
      /must be an external link/
    );

    const proposed = await stranger.json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: {
        creator: 'name:labs',
        accounts: [{ platform: 'reddit', handle: '@science', url: 'https://reddit.com/u/science' }],
      },
    });
    assert.equal(proposed.linked, false, 'unsigned accounts wait for the operator');
    assert.equal(proposed.proposal?.status, 'pending');

    // Asking again is not new: the pending proposal comes back.
    const again = await stranger.json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: {
        creator: 'name:labs',
        accounts: [{ platform: 'reddit', handle: '@science', url: 'https://reddit.com/u/science' }],
      },
    });
    assert.equal(again.proposal?.id, proposed.proposal?.id);

    // The operator decides: accepting links them, merged with what the creator linked.
    const pending = await admin<{ proposals: { id: string; creatorName?: string }[] }>(url, '/v1/admin/account-links');
    assert.equal(pending.proposals.length, 1);
    assert.equal(pending.proposals[0].creatorName, 'Science Labs');
    await admin(url, `/v1/admin/account-links/${pending.proposals[0].id}/accept`, { body: {} });
    const view = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(view.creator.accounts?.length, 4, 'the suggested link joined the three the creator linked');

    // The proposer sees the outcome among their own proposals.
    const mine = await stranger.json<{ proposals: { status: string }[] }>('/v1/account-links/mine');
    assert.equal(mine.proposals[0].status, 'accepted');
  });

  it('the operator can delete a proposal instead, and refuse unsigned ones entirely', async () => {
    const stranger = clientFor(url, 'pseudonym');
    const proposed = await stranger.json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: { creator: 'name:labs', accounts: [{ platform: 'x', handle: '@science', url: 'https://x.com/science' }] },
    });
    await admin(url, `/v1/admin/account-links/${proposed.proposal!.id}/delete`, { body: {} });
    const after = await admin<{ proposals: unknown[] }>(url, '/v1/admin/account-links');
    assert.equal(after.proposals.length, 0, 'deleted without linking');

    await admin(url, '/v1/admin/config', { method: 'PUT', body: { allowUnsignedAccountLinks: false } });
    await assert.rejects(
      stranger.json('/v1/creators/accounts', {
        method: 'PUT',
        body: { creator: 'name:labs', accounts: [{ platform: 'x', handle: '@science', url: 'https://x.com/science' }] },
      }),
      /signed with the creator key/
    );
    await admin(url, '/v1/admin/config', { method: 'PUT', body: { allowUnsignedAccountLinks: true } });
  });
});

describe('linking to related creators on VibeShare', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  const icon = 'data:image/png;base64,AAAA';
  const signer = generateIdentity();
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:friend', name: 'Friendly Neighbor', kind: 'person', icon } });
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company', keys: [signer.id] } });
  const proofFor = () => {
    const ts = Date.now();
    return { key: signer.id, ts, sig: signData(signer, claimSigningPayload(node.identity.id, 'name:labs', ts)) };
  };

  it('takes a creator id, a link id or a /creator/ page link — never a link to another platform', () => {
    assert.equal(creatorRefOf('name:friend'), 'name:friend');
    assert.equal(creatorRefOf('yt:abcdef'), 'yt:abcdef');
    assert.equal(creatorRefOf('https://vibeshare.app/#/creator/name:friend'), 'name:friend');
    assert.equal(creatorRefOf('http://127.0.0.1:7700/#/creator/name%3Afriend?x=1'), 'name:friend');
    assert.equal(creatorRefOf('/creator/name:friend'), 'name:friend');
    assert.equal(creatorRefOf('https://youtube.com/@someone'), null);
    assert.equal(creatorRefOf('www.tiktok.com/@someone'), null);
    assert.equal(creatorRefOf(''), null);
  });

  it('shows the existing creator’s name and icon, ignoring the submitted handle and subscribers', async () => {
    const saved = await clientFor(url, 'pseudonym').json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: {
        creator: 'name:labs',
        accounts: [
          { platform: 'yt', handle: '@neighbor', subscribers: 12345, creator: 'https://vibeshare.app/#/creator/name:friend' },
          { platform: 'mastodon', handle: '@labs', url: 'https://mastodon.social/@labs' },
        ],
        proof: proofFor(),
      },
    });
    assert.equal(saved.linked, true);
    assert.equal(saved.creator?.accounts?.[0].creator, 'name:friend', 'a page link is parsed to the creator id');

    // The creator page: the related creator's own name and icon stand in for the handle
    // and subscriber count the client submitted.
    const view = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    const [related, outside] = view.creator.accounts ?? [];
    assert.equal(related.creator, 'name:friend');
    assert.equal(related.name, 'Friendly Neighbor');
    assert.equal(related.icon, icon, 'a known related creator shows its icon');
    assert.equal(related.subscribers, undefined, 'subscribers are ignored for a creator the node knows');
    assert.equal(outside.name, undefined, 'outside-platform links keep just their platform and handle');
  });

  it('refuses outside-platform links where a related creator belongs', async () => {
    await assert.rejects(
      clientFor(url, 'pseudonym').json('/v1/creators/accounts', {
        method: 'PUT',
        body: {
          creator: 'name:labs',
          accounts: [{ platform: 'yt', handle: '@neighbor', creator: 'https://youtube.com/@someone' }],
          proof: proofFor(),
        },
      }),
      /not a link to another platform/
    );
  });
});

describe('suggesting content related to a creator', async () => {
  const node = await startAlgorithm({ rewards: { acceptedSuggestion: 5 } });
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  const client = clientFor(url, 'pseudonym');

  it('takes the suggestion with its optional message; accepting pays the client', async () => {
    const first = await client.json<CreatorContentResponse>('/v1/creators/name:labs/suggestions', {
      body: {
        id: 'yt:newclip',
        message: 'This is their second channel',
        title: 'A clip on their second channel',
        platform: 'youtube',
        metrics: { views: 1234, likes: 56 },
      },
    });
    assert.equal(first.newInfo, true);
    assert.equal(first.credited, 0, 'credits come with the acceptance');
    assert.equal(first.suggestion.message, 'This is their second channel');
    assert.equal(first.suggestion.status, 'pending');
    assert.equal(first.suggestion.title, 'A clip on their second channel');
    assert.deepEqual(first.suggestion.metrics, { views: 1234, likes: 56 });

    const again = await client.json<CreatorContentResponse>('/v1/creators/name:labs/suggestions', { body: { id: 'yt:newclip' } });
    assert.equal(again.newInfo, false, 'the same content is not suggested twice');

    const pending = await admin<{ suggestions: { id: string; message?: string; creatorName?: string }[] }>(url, '/v1/admin/creator-suggestions');
    assert.equal(pending.suggestions.length, 1);
    assert.equal(pending.suggestions[0].message, 'This is their second channel');
    assert.equal(pending.suggestions[0].creatorName, 'Science Labs');
    await admin(url, `/v1/admin/creator-suggestions/${pending.suggestions[0].id}/accept`, { body: {} });

    const account = await client.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 105, 'the accepted suggestion paid 5 credits');
    const feed = await client.json<{ items: { id: string; title: string; creator?: { id: string }; stats: { platformLikes?: number } }[] }>('/v1/feed', { body: {}, auth: false });
    const linked = feed.items.find((item) => item.id === 'yt:newclip');
    assert.ok(linked && linked.creator?.id === 'name:labs', 'the content joined the creator');
    assert.equal(linked.title, 'A clip on their second channel', 'the suggested title came with it');
  });

  it('deletes a suggestion the operator does not want; it can be suggested again', async () => {
    await client.json('/v1/creators/name:labs/suggestions', { body: { id: 'yt:spam' } });
    const pending = await admin<{ suggestions: { id: string; contentRef: string }[] }>(url, '/v1/admin/creator-suggestions');
    const spam = pending.suggestions.find((s) => s.contentRef === 'yt:spam')!;
    await admin(url, `/v1/admin/creator-suggestions/${spam.id}/delete`, { body: {} });
    const after = await admin<{ suggestions: unknown[] }>(url, '/v1/admin/creator-suggestions');
    assert.equal(after.suggestions.length, 0, 'deleted for good');
    const again = await client.json<CreatorContentResponse>('/v1/creators/name:labs/suggestions', { body: { id: 'yt:spam' } });
    assert.equal(again.newInfo, true, 'a deleted suggestion can be made again');
  });

  it('is also visible to the client among its own suggestions', async () => {
    const mine = await client.json<{ suggestions: { contentRef: string; status: string }[] }>('/v1/creator-suggestions/mine');
    assert.ok(mine.suggestions.some((s) => s.contentRef === 'yt:newclip' && s.status === 'accepted'));
    assert.ok(mine.suggestions.some((s) => s.contentRef === 'yt:spam' && s.status === 'pending'));
  });
});

describe('a client searching for creators', async () => {
  const { dir, cleanup } = tempDir();
  const algorithm = await startAlgorithm({ name: 'Curator' });
  const { client, api } = await startClient(dir);
  after(async () => {
    await client.stop();
    await algorithm.stop();
    cleanup();
  });

  await admin(algorithm.url(), '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  await admin(algorithm.url(), '/v1/admin/creators', { method: 'PUT', body: { id: 'name:solo', name: 'Solo Rider', kind: 'person' } });
  await admin(algorithm.url(), '/v1/admin/creators', { method: 'PUT', body: { id: 'name:coats', name: 'Lab Coat Live', kind: 'person' } });
  await api('/api/nodes', { body: { text: algorithm.reference() } });

  it('finds creators by name (Explore shows them next to the content results)', async () => {
    const found = await api<{ creators: CreatorInfo[] }>('/api/creators?q=labs');
    assert.deepEqual(
      found.creators.map((c) => c.id),
      ['name:labs']
    );
    const people = await api<{ creators: CreatorInfo[] }>('/api/creators?q=solo');
    assert.equal(people.creators[0]?.name, 'Solo Rider');
    const none = await api<{ creators: CreatorInfo[] }>('/api/creators?q=nobody-here');
    assert.deepEqual(none.creators, []);
  });

  it('matches creators whose name is not an exact match', async () => {
    // The words may come in any order…
    const swapped = await api<{ creators: CreatorInfo[] }>('/api/creators?q=labs science');
    assert.deepEqual(
      swapped.creators.map((c) => c.id),
      ['name:labs']
    );
    // …match only partly…
    const partial = await api<{ creators: CreatorInfo[] }>('/api/creators?q=rid');
    assert.deepEqual(
      partial.creators.map((c) => c.id),
      ['name:solo']
    );
    // …and the closer names come first.
    const ranked = await api<{ creators: CreatorInfo[] }>('/api/creators?q=lab');
    assert.deepEqual(
      ranked.creators.map((c) => c.id),
      ['name:coats', 'name:labs']
    );
  });
});

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('suggesting a creator icon', async () => {
  const node = await startAlgorithm({ rewards: { acceptedSuggestion: 3 } });
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });

  it('takes the picture and pays the client when the operator uses it', async () => {
    const client = clientFor(url, 'pseudonym');
    // Only small images are accepted.
    await assert.rejects(client.json('/v1/creators/name:labs/icon-suggestion', { body: { icon: 'data:text/html,hi' } }), /data: URL/);
    const big = `data:image/png;base64,${Buffer.alloc(210 * 1024).toString('base64')}`;
    await assert.rejects(client.json('/v1/creators/name:labs/icon-suggestion', { body: { icon: big } }), /at most 200 kB/);

    const first = await client.json<{ newInfo: boolean; suggestion: { status: string } }>('/v1/creators/name:labs/icon-suggestion', {
      body: { icon: TINY_PNG },
    });
    assert.equal(first.newInfo, true);
    assert.equal(first.suggestion.status, 'pending');

    const pending = await admin<{ suggestions: { id: string; icon: string }[] }>(url, '/v1/admin/creator-icons');
    assert.equal(pending.suggestions[0].icon, TINY_PNG);
    await admin(url, `/v1/admin/creator-icons/${pending.suggestions[0].id}/accept`, { body: {} });

    const view = await client.json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(view.creator.icon, TINY_PNG, 'the icon became the creator icon');
    const account = await client.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 103, 'the accepted icon paid 3 credits');
  });
});

describe('linking accounts between creators', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:friend', name: 'Friendly Studio', kind: 'company' } });

  it('goes both ways by default, and one way when asked', async () => {
    const stranger = clientFor(url, 'pseudonym');
    const both = await stranger.json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: {
        creator: 'name:labs',
        accounts: [{ platform: 'x', handle: '@labs', url: 'https://x.com/labs', creator: 'name:friend', subscribers: 1200 }],
      },
    });
    await admin(url, `/v1/admin/account-links/${both.proposal!.id}/accept`, { body: {} });
    const friend = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:friend', { auth: false });
    assert.equal(friend.creator.accounts?.some((a) => a.creator === 'name:labs'), true, 'the friend shows the link back');
    const labs = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(labs.creator.accounts?.[0]?.subscribers, undefined, 'a creator this node knows stands in: handle and numbers are ignored');
    assert.equal(labs.creator.accounts?.[0]?.name, 'Friendly Studio', 'the existing creator info is served instead');

    // One way: only the suggesting creator shows it.
    const oneWay = await stranger.json<AccountLinkResponse>('/v1/creators/accounts', {
      method: 'PUT',
      body: {
        creator: 'name:labs',
        accounts: [{ platform: 'tiktok', handle: '@labs', url: 'https://tiktok.com/@labs', creator: 'name:friend' }],
        symmetric: false,
      },
    });
    await admin(url, `/v1/admin/account-links/${oneWay.proposal!.id}/accept`, { body: {} });
    const friendAfter = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:friend', { auth: false });
    assert.equal(friendAfter.creator.accounts?.length, 1, 'a one way link adds nothing to the other side');
    const labsAfter = await clientFor(url).json<{ creator: CreatorInfo }>('/v1/creators/name:labs', { auth: false });
    assert.equal(labsAfter.creator.accounts?.length, 2);
  });
});

describe('an operator editing content by hand', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/content', { method: 'PUT', body: { id: 'yt:edit1', title: 'Old title', format: 'video', rating: 'all' } });

  it('changes any of the details, and the console lists slice as asked', async () => {
    await admin(url, '/v1/admin/content', {
      method: 'PUT',
      body: {
        id: 'yt:edit1',
        title: 'New title',
        format: 'music',
        rating: '13+',
        durationSeconds: 240,
        publishedAt: '2024-05-01T00:00:00.000Z',
        link: 'yt:edit1',
        pageUrl: 'https://youtube.com/watch?v=edit1',
        providers: ['vs:provider:vk1x@https://p.example'],
        platformStats: { views: 4200 },
      },
    });
    const listed = await admin<{
      items: { id: string; title: string; format: string; durationSeconds?: number; pageUrl?: string; platformStats?: Record<string, number> }[];
    }>(url, '/v1/admin/content?q=new%20title');
    const entry = listed.items.find((item) => item.id === 'yt:edit1')!;
    assert.equal(entry.title, 'New title');
    assert.equal(entry.format, 'music');
    assert.equal(entry.durationSeconds, 240);
    assert.equal(entry.pageUrl, 'https://youtube.com/watch?v=edit1');
    assert.deepEqual(entry.platformStats, { views: 4200 });

    // The console lists slice both ways: limits and totals come back.
    const slice = await admin<{ items: unknown[]; total?: number }>(url, '/v1/admin/content?limit=5');
    assert.equal(slice.items.length <= 5, true);
    assert.equal(slice.total, 1);
    const creators = await admin<{ creators: unknown[]; total?: number }>(url, '/v1/admin/creators?limit=5');
    assert.equal(creators.total, 0);
  });
});

describe('an operator searching creators by name', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:solo', name: 'Solo Rider', kind: 'person' } });
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:coats', name: 'Lab Coat Live', kind: 'person' } });

  it('finds creators by name, the words in any order and only partly', async () => {
    const byName = await admin<{ creators: { id: string }[] }>(url, '/v1/admin/creators?q=science%20labs');
    assert.deepEqual(byName.creators.map((creator) => creator.id), ['name:labs']);

    // "coat live" is "Lab Coat Live" — and the paging counts only what matches.
    const partial = await admin<{ creators: { id: string }[]; total?: number }>(url, '/v1/admin/creators?q=coat%20live&limit=5');
    assert.equal(partial.total, 1);
    assert.deepEqual(partial.creators.map((creator) => creator.id), ['name:coats']);

    const none = await admin<{ creators: { id: string }[] }>(url, '/v1/admin/creators?q=zzz');
    assert.deepEqual(none.creators, []);
  });
});

describe('an operator editing creator details', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:solo', name: 'Solo Rider', kind: 'person' } });

  it('sees every detail of a creator and can change any of them', async () => {
    await admin(url, '/v1/admin/creators', {
      method: 'PUT',
      body: {
        id: 'name:solo',
        name: 'Solo Rider',
        kind: 'person',
        description: 'Rides alone, films everything.',
        keys: ['vk1solo'],
        links: ['https://solo.example'],
        icon: 'data:image/png;base64,AAAA',
        status: 'blocked',
      },
    });
    const found = await admin<{ creators: (CreatorInfo & { status: string; addedAt: string })[] }>(url, '/v1/admin/creators?q=solo');
    const solo = found.creators.find((creator) => creator.id === 'name:solo')!;
    assert.equal(solo.name, 'Solo Rider');
    assert.equal(solo.kind, 'person');
    assert.equal(solo.description, 'Rides alone, films everything.');
    assert.deepEqual(solo.keys, ['vk1solo']);
    assert.deepEqual(solo.links, ['https://solo.example']);
    assert.equal(solo.icon, 'data:image/png;base64,AAAA');
    assert.equal(solo.status, 'blocked');
    assert.ok(solo.addedAt, 'the record says when it was added');

    // The console's save is authoritative: keys it leaves out are gone, and
    // details it does not send along stay as they were.
    await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:solo', name: 'Solo Rider', kind: 'person', keys: [] } });
    const after = await admin<{ creators: (CreatorInfo & { status: string })[] }>(url, '/v1/admin/creators?q=solo');
    const saved = after.creators.find((creator) => creator.id === 'name:solo')!;
    assert.deepEqual(saved.keys, []);
    assert.equal(saved.description, 'Rides alone, films everything.');
    assert.equal(saved.status, 'blocked');
  });
});
