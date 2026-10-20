import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  blockHash,
  checkCommentChain,
  commentDataHash,
  commentIdAt,
  commentRemovePayload,
  commentSigningPayload,
  type ChainEntry,
  type CommentBlock,
  type CommentEntry,
} from '../src/shared/comments.js';
import { baseId } from '../src/shared/sources.js';
import { generateIdentity, sha256hex, signData, type Identity } from '../src/shared/crypto.js';
import { admin, clientFor, startAlgorithm, startClient, startProvider, tempDir } from './helpers.js';
import type { CommentsResponse } from '../src/shared/clientapi.js';

interface CommentsAnswer {
  root: string;
  blocks: CommentBlock[];
  votes: Record<string, { likes: number; dislikes: number; mine?: 1 | -1 | 0 }>;
  shown: boolean;
}

const content = 'vs1' + 'c'.repeat(52);
const root = baseId(content);

/** What a commenter signs and sends along with their comment ('0' means first level). */
const sign = (key: Identity, replyFrom: string, text: string) => ({
  key: key.id,
  sig: signData(key, commentSigningPayload({ key: key.id, replyFrom: replyFrom === '0' ? root : replyFrom, text })),
});

const resolved = (answer: CommentsAnswer) => {
  const chain = checkCommentChain(answer.blocks, answer.votes);
  assert.deepEqual(chain.errors, [], 'the chain the node sent verifies cleanly');
  return chain.entries;
};

const comment = (entries: ChainEntry[], text: string): CommentEntry => {
  const found = entries.find((entry) => !('removed' in entry) && entry.text === text) as CommentEntry | undefined;
  assert.ok(found, `the comment "${text}" is in the chain`);
  return found!;
};

describe('comments on a content page, as a hash chain', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  const alice = generateIdentity();
  const mallory = generateIdentity();
  const asAlice = clientFor(url, 'identity', alice);
  const asMallory = clientFor(url, 'identity', mallory);

  it('chains every comment to the one before it and the client can verify it', async () => {
    const first = await asAlice.json<{ block: CommentBlock }>(`/v1/comments/${content}`, {
      method: 'POST',
      body: { text: 'First!', ...sign(alice, '0', 'First!') },
    });
    assert.ok(first.block.data?.id, 'the node makes up the comment id');
    assert.equal(first.block.data!.id, commentIdAt(root, '0', 'First!', alice.id), 'the id hashes the page, the commenter, the text and the chain tip');
    assert.equal(
      first.block.data!.id,
      sha256hex([sha256hex(root), sha256hex(alice.id), sha256hex('First!'), '0'].join('\n')),
      'a first level id is the hash of the hashes of the content (cid, or first link), the commenter id, the text and the most recent header (0 when none)'
    );
    assert.equal(first.block.data!.replyFrom, root, 'a first level comment replies to the page root (its cid, or first link)');
    const parentId = first.block.data!.id;
    await asAlice.json(`/v1/comments/${content}`, {
      method: 'POST',
      body: { text: 'A reply', replyFrom: parentId, ...sign(alice, parentId, 'A reply') },
    });

    const answer = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    assert.equal(answer.blocks.length, 2);
    assert.equal(answer.root, root);
    const entries = resolved(answer);
    const top = comment(entries, 'First!');
    const reply = comment(entries, 'A reply');
    assert.equal(top.replyFrom, root, 'a top level comment replies to the page root');
    assert.equal(reply.replyFrom, top.id, 'a reply names the comment it replies to');
    assert.equal(top.key, alice.id, "the commenter's key is on the comment");
    assert.equal(
      answer.blocks[1].id,
      commentIdAt(parentId, answer.blocks[0].hash, 'A reply', alice.id),
      'a reply hashes the id it replies from, with the block before it as the chain tip'
    );
  });

  it('lets only the same exact key edit a comment, keeping the history', async () => {
    const created = await asAlice.json<{ block: CommentBlock }>(`/v1/comments/${content}`, {
      method: 'POST',
      body: { text: 'Hello', ...sign(alice, '0', 'Hello') },
    });
    const id = created.block.data!.id;
    await assert.rejects(
      asMallory.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'Hacked', editOf: id, ...sign(mallory, '0', 'Hacked') } }),
      /Only the comment's own key/
    );
    await asAlice.json(`/v1/comments/${content}`, {
      method: 'POST',
      body: { text: 'Hello, edited', editOf: id, ...sign(alice, '0', 'Hello, edited') },
    });

    const answer = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    const edited = comment(resolved(answer), 'Hello, edited');
    assert.equal(edited.id, id, 'the edit is a new block carrying the same id');
    assert.equal(edited.edited, true);
    assert.deepEqual(edited.history.map((version) => version.text), ['Hello'], 'the earlier text stays in the history');
  });

  it('keeps the block headers but sends no data once the author asks for removal', async () => {
    const created = await asAlice.json<{ block: CommentBlock }>(`/v1/comments/${content}`, {
      method: 'POST',
      body: { text: 'Goodbye', ...sign(alice, '0', 'Goodbye') },
    });
    const id = created.block.data!.id;
    await assert.rejects(
      asMallory.json(`/v1/comments/${content}/${id}/remove`, {
        method: 'POST',
        body: { key: mallory.id, sig: signData(mallory, commentRemovePayload(id)) },
      }),
      /Only the comment's own key/
    );
    await asAlice.json(`/v1/comments/${content}/${id}/remove`, {
      method: 'POST',
      body: { key: alice.id, sig: signData(alice, commentRemovePayload(id)) },
    });

    const answer = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    assert.equal(answer.blocks.filter((block) => block.data?.id === id).length, 0, 'the data is gone');
    const entries = resolved(answer);
    assert.ok(entries.some((entry) => 'removed' in entry), 'clients see that a comment was removed');
    assert.equal(entries.some((entry) => !('removed' in entry) && entry.text === 'Goodbye'), false);
  });

  it('writes down only the date parts the commenter chose, and keeps anonymous comments unchangeable', async () => {
    for (const [text, timePrecision] of [
      ['Dated', 'date'],
      ['Yearly', 'year'],
      ['Quiet', 'none'],
    ] as const) {
      await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text, timePrecision, ...sign(alice, '0', text) } });
    }
    await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'Whisper', anonymous: true, timePrecision: 'none' } });

    const entries = resolved(await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`));
    assert.match(comment(entries, 'Dated').time, /^\d{4}-\d{2}-\d{2}$/, 'a date is a date');
    assert.match(comment(entries, 'Yearly').time, /^\d{4}$/, 'a year is a year');
    assert.equal(comment(entries, 'Quiet').time, '', 'nothing is written down when asked');
    const whisper = comment(entries, 'Whisper');
    assert.equal(whisper.anonymous, true);
    assert.equal(whisper.key, undefined, 'no key on an anonymous comment');
    await assert.rejects(
      asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'Changed', editOf: whisper.id, ...sign(alice, '0', 'Changed') } }),
      /Anonymous comments cannot be edited/
    );
    await assert.rejects(
      asAlice.json(`/v1/comments/${content}/${whisper.id}/remove`, {
        method: 'POST',
        body: { key: alice.id, sig: signData(alice, commentRemovePayload(whisper.id)) },
      }),
      /Anonymous comments cannot be removed/
    );
  });

  it('counts likes and dislikes and remembers who voted', async () => {
    const created = await asAlice.json<{ block: CommentBlock }>(`/v1/comments/${content}`, {
      method: 'POST',
      body: { text: 'Vote on me', ...sign(alice, '0', 'Vote on me') },
    });
    const id = created.block.data!.id;
    await asMallory.json(`/v1/comments/${content}/${id}/vote`, { method: 'POST', body: { vote: 1 } });
    await asAlice.json(`/v1/comments/${content}/${id}/vote`, { method: 'POST', body: { vote: -1 } });

    const entries = resolved(await asMallory.json<CommentsAnswer>(`/v1/comments/${content}`));
    const voted = comment(entries, 'Vote on me');
    assert.equal(voted.likes, 1);
    assert.equal(voted.dislikes, 1);
    assert.equal(voted.mine, 1, 'the asking account sees its own vote');
  });
});

describe('the operator moderating comments', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  const alice = generateIdentity();
  const asAlice = clientFor(url, 'identity', alice);

  it('hides single comments and whole sections while the headers stay verifiable', async () => {
    for (const text of ['Keep me', 'Hide me']) {
      await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text, ...sign(alice, '0', text) } });
    }
    const before = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    const hiddenId = before.blocks.find((block) => block.data?.text === 'Hide me')!.data!.id;

    await admin(url, `/v1/admin/comments/${content}/${hiddenId}/hide`, { method: 'POST', body: {} });
    const entries = resolved(await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`));
    assert.equal(entries.filter((entry) => !('removed' in entry)).length, 1);
    assert.ok(entries.some((entry) => 'removed' in entry), 'clients see that a comment was removed');

    // The whole section: the headers keep verifying, but no data goes out.
    await admin(url, `/v1/admin/comments/${content}`, { method: 'PUT', body: { shown: false } });
    const off = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    assert.equal(off.shown, false);
    assert.ok(off.blocks.every((block) => !block.data), 'no comment data at all');
    assert.deepEqual(checkCommentChain(off.blocks, off.votes).errors, [], 'the headers still verify');
    assert.equal(checkCommentChain(off.blocks, off.votes).entries.length, off.blocks.length);

    await admin(url, `/v1/admin/comments/${content}`, { method: 'PUT', body: { shown: true } });
    await admin(url, `/v1/admin/comments/${content}/${hiddenId}/show`, { method: 'POST', body: {} });
    const back = resolved(await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`));
    assert.deepEqual(back.map((entry) => ('removed' in entry ? 'removed' : entry.text)).sort(), ['Hide me', 'Keep me']);
  });
});

describe('the operator flushing comment data, and pages without comments', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  const alice = generateIdentity();
  const asAlice = clientFor(url, 'identity', alice);

  it('keeps nothing at all for a page that has no comments', async () => {
    const page = 'yt:nocommentshere';
    for (let ask = 0; ask < 2; ask++) {
      const answer = await asAlice.json<CommentsAnswer>(`/v1/comments/${page}`);
      assert.deepEqual(answer.blocks, [], 'an empty chain comes back');
    }
    const view = await admin<{ sections: { content: string }[] }>(url, '/v1/admin/comments');
    assert.ok(!view.sections.some((section) => section.content === page), 'reading a page never stores a comment section');
    const open = await admin<{ blocks: number; comments: unknown[] }>(url, `/v1/admin/comments/${page}`);
    assert.equal(open.blocks, 0, 'the operator sees no information about a page without comments');
  });

  it('flushes every block, vote and hiding of one content page', async () => {
    await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'Goes away', ...sign(alice, '0', 'Goes away') } });
    const posted = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    assert.equal(posted.blocks.length, 1);
    await asAlice.json(`/v1/comments/${content}/${posted.blocks[0].id}/vote`, { method: 'POST', body: { vote: 1 } });

    assert.equal(
      (await admin<{ flushed: boolean }>(url, `/v1/admin/comments/${content}`, { method: 'DELETE' })).flushed,
      true,
      'the flush finds the data it removes'
    );
    const gone = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    assert.deepEqual(gone.blocks, [], 'the chain is gone');
    assert.deepEqual(gone.votes, {}, 'the votes are gone');
    const view = await admin<{ sections: { content: string }[] }>(url, '/v1/admin/comments');
    assert.ok(!view.sections.some((section) => section.content === baseId(content)), 'the page is not listed anymore');
    assert.equal(
      (await admin<{ flushed: boolean }>(url, `/v1/admin/comments/${content}`, { method: 'DELETE' })).flushed,
      false,
      'flushing a page twice is fine'
    );
  });
});

describe('a client checking the chain itself', async () => {
  const node = await startAlgorithm();
  const url = node.url();
  after(() => node.stop());
  const alice = generateIdentity();
  const asAlice = clientFor(url, 'identity', alice);

  it('catches data that was rewritten or a block that was cut out', async () => {
    for (const text of ['One', 'Two', 'Three']) {
      await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text, ...sign(alice, '0', text) } });
    }
    const answer = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);

    const rewritten = answer.blocks.map((block, index) =>
      index === 1 && block.data ? { ...block, data: { ...block.data, text: 'Two lies' } } : block
    );
    assert.ok(checkCommentChain(rewritten, answer.votes).errors.length > 0, 'changed data does not match its hash');

    const cut = [answer.blocks[0], answer.blocks[2]];
    assert.ok(checkCommentChain(cut, answer.votes).errors.length > 0, 'a cut chain does not link');
  });
});

describe('a search node limiting what comments may say', async () => {
  const node = await startAlgorithm({ comments: { maxPerHour: 2, maxLength: 20 } });
  const url = node.url();
  after(() => node.stop());
  const alice = generateIdentity();
  const asAlice = clientFor(url, 'identity', alice);

  it('rate limits each account and refuses overlong comments', async () => {
    await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'one', ...sign(alice, '0', 'one') } });
    await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'two', ...sign(alice, '0', 'two') } });
    await assert.rejects(
      asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'three', ...sign(alice, '0', 'three') } }),
      /per hour/
    );
    const stranger = generateIdentity();
    await assert.rejects(
      clientFor(url, 'identity', stranger).json(`/v1/comments/${content}`, {
        method: 'POST',
        body: { text: 'x'.repeat(21), ...sign(stranger, '0', 'x'.repeat(21)) },
      }),
      /at most 20/
    );
  });
});

describe('a browser checking the chain without Node globals', async () => {
  it('verifies the very comment that failed in the browser', async () => {
    // The response that came back from the algorithm node, pasted as-is.
    const data = {
      id: 'a5cc8fa2ab3b176f02e933274e4822511f0f6ba8e511f5626121b5fee8303c90',
      text: 'hi',
      key: 'vk1zo4pihzz5ui2eknkumuu7fsrnzq2mkb73w62q7dyj7e5dq4tln4q',
      sig: 'TOtsKigyQApq6-tevxHX058ga-A4D9GaEv9XaMFWNtc8H9xb_GKkvUPw5V5Iy6sXhKQrMBLhQEd0bQw6pWIsBw',
      time: '2026-10-19T23:19:10.057Z',
      replyFrom: 'yt:_t_31A7gens',
    };
    const payload = commentSigningPayload(data);
    // The GUI bundle runs the browser crypto: nothing on the verification path may fall
    // back to Node globals. (Import first — the module loader itself needs Buffer.)
    const webCrypto = (await import(pathToFileURL(resolve(import.meta.dirname, '../gui/src/web/crypto.ts')).href)) as {
      isKeyId: (id: string) => boolean;
      verifySignature: (key: string, data: string, sig: string) => boolean;
    };
    const globals = globalThis as { Buffer?: unknown };
    const real = globals.Buffer;
    delete globals.Buffer;
    try {
      assert.equal(webCrypto.isKeyId(data.key), true);
      assert.equal(webCrypto.verifySignature(data.key, payload, data.sig), true, 'the signature verifies in a browser');
      assert.equal(commentDataHash(data), '109eaeb98d5d23b21871fa9fd030f57d938e0657940ebe2d622d4068118c7145');
      assert.equal(blockHash('', commentDataHash(data), data.id), '2574ec31734cc5bf368fb113322f1109eb9173faac2ac525d38a7631df65c2d7');
    } finally {
      globals.Buffer = real;
    }
    // And the chain check resolves it into the comment.
    const chain = checkCommentChain(
      [{ prev: '', dataHash: '109eaeb98d5d23b21871fa9fd030f57d938e0657940ebe2d622d4068118c7145', hash: '2574ec31734cc5bf368fb113322f1109eb9173faac2ac525d38a7631df65c2d7', id: data.id, data }],
      {}
    );
    assert.deepEqual(chain.errors, []);
  });
});

describe('a client posting a comment and reloading the section from the node', async () => {
  const { dir, cleanup } = tempDir();
  const node = await startAlgorithm();
  const { client, api } = await startClient(dir);
  await api('/api/nodes', { body: { text: node.reference() } });
  after(async () => {
    await client.stop();
    await node.stop();
    cleanup();
  });

  it('shows the posted comment in what the algorithm search node sends back', async () => {
    await api(`/api/comments/${content}`, { body: { text: 'Posted from the client', anonymous: false, timePrecision: 'datetime' } });
    // The comment section reloaded from the response of the algorithm search node.
    const answer = await clientFor(node.url()).json<CommentsAnswer>(`/v1/comments/${content}`, { auth: false });
    const chain = checkCommentChain(answer.blocks, answer.votes);
    assert.deepEqual(chain.errors, [], JSON.stringify(answer.blocks));
    const posted = chain.entries.find((entry) => !('removed' in entry) && entry.text === 'Posted from the client') as CommentEntry | undefined;
    assert.ok(posted, 'the posted comment is in the section the node sends back');
    assert.equal(posted.replyFrom, answer.root, 'it is a first level comment: it replies to the page root');
    assert.equal(
      posted.id,
      commentIdAt(answer.root, '0', 'Posted from the client', client.store.identity.id),
      'the id hashes the page root, the commenter key, the text and the chain tip'
    );

    // An anonymous comment carries no key, so none goes into its id either.
    await api(`/api/comments/${content}`, { body: { text: 'Quietly', anonymous: true, timePrecision: 'none' } });
    const withAnon = await clientFor(node.url()).json<CommentsAnswer>(`/v1/comments/${content}`, { auth: false });
    const anon = checkCommentChain(withAnon.blocks, withAnon.votes).entries.find(
      (entry) => !('removed' in entry) && entry.text === 'Quietly'
    ) as CommentEntry | undefined;
    assert.ok(anon, 'the anonymous comment is there too');
    assert.equal(anon.anonymous, true);
    assert.equal(
      anon.id,
      commentIdAt(withAnon.root, withAnon.blocks[0].hash, 'Quietly'),
      'nothing takes the key’s place in the id of an anonymous comment'
    );
  });

  it('keeps the chain clean through replies, edits and removals made from the client', async () => {
    const page = 'vs1' + 'e'.repeat(52) + '~yt:clip1';
    await api(`/api/comments/${encodeURIComponent(page)}`, { body: { text: 'Top level', timePrecision: 'date' } });
    const before = await clientFor(node.url()).json<CommentsAnswer>(`/v1/comments/${encodeURIComponent(page)}`, { auth: false });
    const top = checkCommentChain(before.blocks, before.votes).entries.find(
      (entry) => !('removed' in entry) && entry.text === 'Top level'
    ) as CommentEntry;
    assert.ok(top, 'the first comment is in the section');
    assert.equal(top.replyFrom, before.root, 'a page with a link id roots its first level comments in that link');

    await api(`/api/comments/${encodeURIComponent(page)}`, { body: { text: 'A reply', replyFrom: top.id } });
    await api(`/api/comments/${encodeURIComponent(page)}`, { body: { text: 'Top level, fixed', editOf: top.id, replyFrom: top.replyFrom } });
    await api(`/api/comments/${encodeURIComponent(page)}/${top.id}/remove`, { body: {} });

    const answer = await clientFor(node.url()).json<CommentsAnswer>(`/v1/comments/${encodeURIComponent(page)}`, { auth: false });
    const chain = checkCommentChain(answer.blocks, answer.votes);
    assert.deepEqual(chain.errors, [], JSON.stringify(answer.blocks));
    const kept = chain.entries.filter((entry) => !('removed' in entry)) as CommentEntry[];
    assert.deepEqual(kept.map((entry) => entry.text), ['A reply'], 'only the reply carries data once the author removed their comment');
    assert.equal(chain.entries.filter((entry) => 'removed' in entry).length, 2, 'the comment and its edit keep their headers only');
  });
});

describe('the client writing and reading comments through its daemon', async () => {
  const { dir, cleanup } = tempDir();
  const node = await startAlgorithm();
  const { client, api } = await startClient(dir);
  await api('/api/nodes', { body: { text: node.reference() } });
  after(async () => {
    await client.stop();
    await node.stop();
    cleanup();
  });

  it('posts a comment and the chain it reads back verifies', async () => {
    await api(`/api/comments/${content}`, { body: { text: 'Through the daemon', timePrecision: 'datetime' } });
    const answer = await api<CommentsResponse>(`/api/comments/${content}`);
    const chain = checkCommentChain(answer.blocks, answer.votes);
    assert.deepEqual(chain.errors, [], JSON.stringify(answer.blocks));
  });

  it('takes pasted text with stray whitespace, replies and edits without breaking the chain', async () => {
    const page = 'vs1' + 'd'.repeat(52) + '~yt:black1';
    await api(`/api/comments/${encodeURIComponent(page)}`, { body: { text: 'Pasted line\n', timePrecision: 'date' } });
    const after = await api<CommentsResponse>(`/api/comments/${encodeURIComponent(page)}`);
    const first = after.blocks[0].data!;
    await api(`/api/comments/${encodeURIComponent(page)}`, { body: { text: '  A reply  ', replyFrom: first.id } });
    await api(`/api/comments/${encodeURIComponent(page)}`, { body: { text: 'Fixed up ', editOf: first.id, replyFrom: first.replyFrom } });
    const answer = await api<CommentsResponse>(`/api/comments/${encodeURIComponent(page)}`);
    assert.deepEqual(checkCommentChain(answer.blocks, answer.votes).errors, [], JSON.stringify(answer.blocks));
  });
});

describe('a search node keeping comment data on a content provider', async () => {
  const provider = await startProvider();
  const node = await startAlgorithm({ comments: { storage: 'provider', provider: { url: provider.url() } } });
  const url = node.url();
  after(async () => {
    await node.stop();
    await provider.stop();
  });
  const alice = generateIdentity();
  const asAlice = clientFor(url, 'identity', alice);

  it('sends the comment data there and keeps the headers here, and clients see no difference', async () => {
    await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'Stored away', ...sign(alice, '0', 'Stored away') } });
    await asAlice.json(`/v1/comments/${content}`, { method: 'POST', body: { text: 'Also there', ...sign(alice, '0', 'Also there') } });

    const answer = await asAlice.json<CommentsAnswer>(`/v1/comments/${content}`);
    const entries = resolved(answer);
    assert.equal(comment(entries, 'Stored away').key, alice.id);
    assert.equal(comment(entries, 'Also there').key, alice.id);
    // The whole history comes back assembled from the provider's copy.
    assert.equal(answer.blocks.length, 2);
    assert.ok(answer.blocks.every((block) => block.data), 'every comment comes back');
  });
});