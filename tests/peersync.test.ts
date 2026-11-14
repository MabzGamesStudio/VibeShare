// Manual content sync: one algorithm node ships its full catalog to a peer in bounded
// batches — topics, creators and groups, content entries with their metadata and
// listing decisions, and the comment chains of its content pages. The receiving side
// stores only what it can verify: a lying peer cannot inject data this node would not
// make up itself (no invented comments, no made-up comment ids, no proof keys).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  blockHash,
  checkCommentChain,
  commentDataHash,
  commentIdAt,
  commentSigningPayload,
  type CommentBlock,
  type CommentData,
  type CommentEntry,
} from '../src/shared/comments.js';
import { generateIdentity, signData, type Identity } from '../src/shared/crypto.js';
import { PEER_PUSH_CATEGORIES, type PeerImportReport, type PeerPushResult } from '../src/shared/protocol.js';
import { baseId } from '../src/shared/sources.js';
import { TOPICS } from '../src/shared/taxonomy.js';
import { admin, clientFor, startAlgorithm } from './helpers.js';

const content = 'vs1' + 'a'.repeat(52);
const root = baseId(content);

/** What a commenter signs and sends along with their comment ('0' means first level). */
const sign = (key: Identity, replyFrom: string, text: string) => ({
  key: key.id,
  sig: signData(key, commentSigningPayload({ key: key.id, replyFrom: replyFrom === '0' ? root : replyFrom, text })),
});

/** One chain block, hashed exactly as the node hashes its own. */
const blockFor = (prev: string, data: CommentData): CommentBlock => {
  const dataHash = commentDataHash(data);
  return { prev, dataHash, hash: blockHash(prev, dataHash, data.id), id: data.id, data };
};

describe('manual content sync: full-catalog pushes between algorithm nodes', async () => {
  const a = await startAlgorithm({ name: 'Sync A' });
  const b = await startAlgorithm({ name: 'Sync B' });
  const alice = generateIdentity();
  const mallory = generateIdentity();
  const asAlice = clientFor(a.url(), 'identity', alice);
  // A pushing to B talks as its own node identity, exactly as its push driver does.
  const asAOnB = clientFor(b.url(), 'identity', a.identity);
  after(async () => {
    await a.stop();
    await b.stop();
  });

  /** Drives every category of A's push to B until each reports done. */
  const pushAll = async (): Promise<Record<string, number>> => {
    const sent: Record<string, number> = {};
    for (const category of PEER_PUSH_CATEGORIES) {
      let cursor: string | undefined;
      for (;;) {
        const result = await admin<PeerPushResult>(a.url(), '/v1/admin/peers/push', { body: { ref: b.reference(), category, cursor } });
        assert.equal(result.error, undefined, `the ${category} batch reached the peer`);
        assert.equal(result.category, category);
        sent[category] = (sent[category] ?? 0) + result.sent;
        if (result.done) break;
        assert.ok(result.cursor, 'an unfinished category reports a cursor to continue from');
        cursor = result.cursor ?? undefined;
      }
    }
    return sent;
  };

  it('pushes topics, creators, entries and comments to the peer', async () => {
    // A catalog to ship: a topic, a creator (with a proof key), a group it belongs to,
    // a listed entry filed under the topic and creator, a blocked entry, and comments
    // on the listed entry (two signed, one anonymous).
    await admin(a.url(), '/v1/admin/topics', { method: 'PUT', body: { name: 'Deep Sea', description: 'Life below the surface' } });
    await admin(a.url(), '/v1/admin/creators', { method: 'PUT', body: { id: 'name:ann', name: 'Ann Diver', kind: 'person', keys: [alice.id] } });
    await admin(a.url(), '/v1/admin/groups', { method: 'PUT', body: { id: 'grp-ocean', name: 'Ocean Crew', members: ['name:ann'] } });
    await admin(a.url(), '/v1/admin/content', {
      method: 'PUT',
      body: {
        id: content,
        title: 'Deep dive',
        format: 'video',
        rating: 'all',
        topics: ['Deep Sea'],
        creatorId: 'name:ann',
        language: 'en',
        durationSeconds: 120,
        publishedAt: new Date().toISOString(),
      },
    });
    await admin(a.url(), '/v1/admin/content', {
      method: 'PUT',
      body: {
        id: 'yt:blocked-one',
        title: 'Blocked clip',
        format: 'video',
        rating: '13+',
        status: 'blocked',
        reason: 'not suitable',
        publishedAt: new Date().toISOString(),
      },
    });
    const first = await asAlice.json<{ block: CommentBlock }>(`/v1/comments/${content}`, {
      body: { text: 'First!', ...sign(alice, '0', 'First!') },
    });
    const parentId = first.block.data!.id;
    await asAlice.json(`/v1/comments/${content}`, {
      body: { text: 'A reply', replyFrom: parentId, ...sign(alice, parentId, 'A reply') },
    });
    await asAlice.json(`/v1/comments/${content}`, { body: { text: 'anonymous hello', anonymous: true } });

    // B only takes a catalog from a peer its operator configured it to serve.
    await admin(b.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: a.reference(), fetch: true, serve: true }] } });

    // A totals probe first (what a full sync moves), then every category to done.
    const probe = await admin<PeerPushResult>(a.url(), '/v1/admin/peers/push', { body: { ref: b.reference() } });
    assert.equal(probe.category, null);
    assert.equal(probe.done, false);
    assert.ok(probe.totals.topics >= 2 && probe.totals.creators >= 2 && probe.totals.entries >= 2 && probe.totals.comments >= 1);
    const sent = await pushAll();
    assert.equal(sent.comments, 1, 'the one page with comments ships as one chain');

    // The entries arrived with their metadata and listing decisions.
    const catalog = await admin<{ items: { id: string; status: string; title: string; topics: string[]; creatorId?: string; reason?: string }[] }>(
      b.url(),
      '/v1/admin/content'
    );
    const dive = catalog.items.find((item) => item.id === content);
    assert.equal(dive?.title, 'Deep dive');
    assert.equal(dive?.status, 'listed');
    assert.deepEqual(dive?.topics, ['deep-sea']);
    assert.equal(dive?.creatorId, 'name:ann');
    const blocked = catalog.items.find((item) => item.id === 'yt:blocked-one');
    assert.equal(blocked?.status, 'blocked');
    assert.equal(blocked?.reason, 'not suitable');

    // Topics: the registry's records and the offered topic list both travel.
    const topics = await admin<{ topics: { name: string; description?: string }[] }>(b.url(), '/v1/admin/topics');
    const deepSea = topics.topics.find((topic) => topic.name === 'Deep Sea');
    assert.equal(deepSea?.description, 'Life below the surface');
    assert.ok(topics.topics.some((topic) => topic.name === TOPICS[0]), 'the offered topic list travels too');

    // Creators and groups travel — but proof keys never do (trust anchors stay home).
    const creators = await admin<{ creators: { id: string; name: string; kind: string; keys?: string[] }[] }>(b.url(), '/v1/admin/creators');
    const ann = creators.creators.find((creator) => creator.id === 'name:ann');
    assert.equal(ann?.name, 'Ann Diver');
    assert.deepEqual(ann?.keys ?? [], [], 'a catalog never carries proof keys');
    const onA = await admin<{ creators: { id: string; keys?: string[] }[] }>(a.url(), '/v1/admin/creators');
    assert.deepEqual(onA.creators.find((creator) => creator.id === 'name:ann')?.keys, [alice.id], 'the key really was on the sending side');
    const groups = await admin<{ groups: { id: string; members: string[] }[] }>(b.url(), '/v1/admin/groups');
    assert.deepEqual(groups.groups.find((group) => group.id === 'grp-ocean')?.members, ['name:ann']);

    // The comment chain arrived whole: signed comments with their data, the anonymous
    // one as its header only (nothing proves it), and the chain verifies cleanly.
    const answer = await admin<{ root: string; blocks: CommentBlock[]; votes: Record<string, { likes: number; dislikes: number }> }>(
      b.url(),
      `/v1/comments/${content}?limit=200`
    );
    assert.equal(answer.root, root);
    const chain = checkCommentChain(answer.blocks, answer.votes);
    assert.deepEqual(chain.errors, []);
    const texts = chain.entries
      .filter((entry): entry is CommentEntry => !('removed' in entry) && !('pending' in entry))
      .map((entry) => entry.text);
    assert.deepEqual(texts.sort(), ['A reply', 'First!'].sort());
    assert.ok(chain.entries.some((entry) => 'removed' in entry), 'anonymous comment data does not travel');
  });

  it('continues after the cursor, sending only what is still missing', async () => {
    const probe = await admin<PeerPushResult>(a.url(), '/v1/admin/peers/push', { body: { ref: b.reference() } });
    // A cursor past the first entry (sorted by id) sends only the rest of the category.
    const first = [content, 'yt:blocked-one'].sort()[0];
    const rest = await admin<PeerPushResult>(a.url(), '/v1/admin/peers/push', {
      body: { ref: b.reference(), category: 'entries', cursor: first },
    });
    assert.equal(rest.sent, probe.totals.entries - 1);
    assert.equal(rest.done, true);
    assert.equal(rest.cursor, null);

    // Re-running a category from scratch is still safe: comment chains the node already
    // has are kept (chains cannot merge), which is what makes a retry cheap.
    const again = await admin<PeerPushResult>(a.url(), '/v1/admin/peers/push', {
      body: { ref: b.reference(), category: 'comments' },
    });
    assert.equal(again.report?.comments.accepted, 0);
    assert.equal(again.report?.comments.skipped, 1);
    assert.ok(again.report?.errors.some((error) => /already has comments/.test(error)));
  });

  it('turns away strangers and refuses comment data it cannot verify', async () => {
    const stranger = clientFor(b.url(), 'identity', generateIdentity());
    await assert.rejects(stranger.json('/v1/peers/import', { body: {} }), /peer/);

    // A signed comment whose text was tampered with after signing: the chain (and the
    // hash of the data) does not verify — nothing of it is imported.
    const pageB = 'vs1' + 'b'.repeat(52);
    const rootB = baseId(pageB);
    const text = 'A real signed comment';
    const real = blockFor('', {
      id: commentIdAt(rootB, '', text, mallory.id),
      text,
      key: mallory.id,
      sig: signData(mallory, commentSigningPayload({ key: mallory.id, replyFrom: rootB, text })),
      time: new Date().toISOString(),
      replyFrom: rootB,
    });
    const tampered = { ...real, data: { ...real.data!, text: 'Send me your credits' } };
    const forgedText = await asAOnB.json<PeerImportReport>('/v1/peers/import', {
      body: { comments: [{ content: pageB, blocks: [tampered] }] },
    });
    assert.equal(forgedText.comments.accepted, 0);
    assert.equal(forgedText.comments.skipped, 1);

    // A well-formed and correctly signed comment under an id this node would never make
    // up for it: rejected by the same id rule the node applies to its own comments.
    const madeUpId = 'f'.repeat(64);
    const forgedId = blockFor('', { ...real.data!, id: madeUpId });
    const wrongId = await asAOnB.json<PeerImportReport>('/v1/peers/import', {
      body: { comments: [{ content: pageB, blocks: [forgedId] }] },
    });
    assert.equal(wrongId.comments.accepted, 0);
    assert.equal(wrongId.comments.skipped, 1);

    // A chain of anonymous comments alone proves nothing at all: nothing is imported.
    const pageC = 'vs1' + 'c'.repeat(52);
    const anonymous: CommentData = {
      id: commentIdAt(baseId(pageC), '', 'totally real', undefined),
      text: 'totally real',
      time: new Date().toISOString(),
      replyFrom: baseId(pageC),
    };
    const empty = await asAOnB.json<PeerImportReport>('/v1/peers/import', {
      body: { comments: [{ content: pageC, blocks: [blockFor('', anonymous)] }] },
    });
    assert.equal(empty.comments.accepted, 0);
    assert.equal(empty.comments.skipped, 1);

    // One malformed entry does not kill the batch: it is skipped and explained back.
    const mixed = await asAOnB.json<PeerImportReport>('/v1/peers/import', {
      body: {
        entries: [
          { id: 'junk-id', status: 'listed', title: 'Junk', format: 'video', rating: 'all', publishedAt: new Date().toISOString() },
          { id: 'yt:imported-one', status: 'listed', title: 'Imported', format: 'video', rating: 'all', publishedAt: new Date().toISOString() },
        ],
      },
    });
    assert.equal(mixed.entries.accepted, 1);
    assert.equal(mixed.entries.skipped, 1);
    assert.ok(mixed.errors.length, 'the skip is explained back to the pushing node');
    const catalog = await admin<{ items: { id: string; title: string }[] }>(b.url(), '/v1/admin/content');
    assert.ok(catalog.items.some((item) => item.id === 'yt:imported-one'));
  });
});
