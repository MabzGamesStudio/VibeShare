import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blockHash,
  checkCommentChain,
  commentDataHash,
  commentIdAt,
  commentSigningPayload,
  type CommentBlock,
  type CommentData,
} from '../src/shared/comments.js';
import { bytesCid } from '../src/shared/content.js';
import { generateIdentity, signData } from '../src/shared/crypto.js';
import { startMaliciousAlgorithm, startMaliciousClient, startMaliciousProvider } from '../src/demo/malicious.js';
import { admin, clientFor, randomBytesOf, startAlgorithm, startClient, startProvider, tempDir } from './helpers.js';

/** A comment chain that verifies as it stands — the attacks take it apart from there. */
function makeChain(): CommentBlock[] {
  const identity = generateIdentity();
  const blocks: CommentBlock[] = [];
  let prev = '';
  for (const text of ['one', 'two', 'three']) {
    const data: CommentData = {
      id: commentIdAt('root', prev, text, identity.id),
      text,
      key: identity.id,
      sig: signData(identity, commentSigningPayload({ key: identity.id, replyFrom: 'root', text })),
      time: new Date().toISOString(),
      replyFrom: 'root',
    };
    const dataHash = commentDataHash(data);
    blocks.push({ prev, dataHash, hash: blockHash(prev, dataHash, data.id), id: data.id, data });
    prev = blocks.at(-1)!.hash;
  }
  return blocks;
}

describe('malicious nodes (developer testing)', () => {
  it('a client sending a comment with an incorrect signature is refused', async () => {
    const node = await startAlgorithm();
    try {
      const identity = generateIdentity();
      const answer = clientFor(node.url(), 'identity', identity);
      await assert.rejects(
        answer.json(`/v1/comments/${encodeURIComponent('vs1test')}`, {
          method: 'POST',
          body: { text: 'signed by nobody', key: identity.id, sig: 'not-a-signature' },
        }),
        /signature/i
      );
    } finally {
      await node.stop();
    }
  });

  it('an algorithm node serving a tampered comment, a deleted one, or a bad signature is caught', async () => {
    const evil = await startMaliciousAlgorithm();
    try {
      const fetchComments = async () => (await fetch(`${evil.url()}/v1/comments/x`)).json() as Promise<{ blocks: CommentBlock[] }>;
      const chain = makeChain();

      evil.setComments(chain, 'tamper');
      assert.ok(checkCommentChain((await fetchComments()).blocks).errors.length > 0, 'changed text does not match its hash');

      evil.setComments(chain, 'delete');
      assert.ok(checkCommentChain((await fetchComments()).blocks).errors.length > 0, 'a cut chain does not link');

      evil.setComments(chain, 'badsig');
      assert.ok(checkCommentChain((await fetchComments()).blocks).errors.length > 0, 'a signature that does not verify is flagged');

      evil.setComments(chain, 'none');
      assert.deepEqual(checkCommentChain((await fetchComments()).blocks).errors, [], 'the unattacked chain still verifies');
    } finally {
      await evil.stop();
    }
  });

  it('a provider serving bytes that do not match the content id is refused by the client', async () => {
    const evil = await startMaliciousProvider();
    const { dir, cleanup } = tempDir();
    const { client: node, api } = await startClient(dir);
    try {
      const cid = bytesCid(randomBytesOf(128, 5));
      const answer = await api<{ ok: boolean; error: string }>(`/api/content-link`, {
        method: 'POST',
        body: { url: `${evil.url()}/v1/chunks/whatever`, cid },
      });
      assert.equal(answer.ok, false);
      assert.match(answer.error, /does not match the expected cid/i);
    } finally {
      await node.stop();
      await evil.stop();
      cleanup();
    }
  });

  it('a vvsh stream with an incorrect chunk, or chunks without the merkle path, is refused', async () => {
    const evil = await startMaliciousProvider();
    const { dir, cleanup } = tempDir();
    const { client: node, api } = await startClient(dir);
    try {
      await api('/api/nodes', { body: { text: evil.reference() } });
      const state = await api<{ nodes: { id: string; type: string }[] }>('/api/state');
      const nodeId = state.nodes.find((n) => n.type === 'provider')!.id;

      // The object named by a hash that is not that hash: one wrong chunk in a stream.
      await assert.rejects(api('/api/vvsh/object', { body: { nodeId, hash: 'a'.repeat(64) } }), /path|hash|vvsh|wire/i);

      // Chunks offered without the tree path down from the root: nothing to verify against.
      await assert.rejects(
        api('/api/vvsh/chunk', { body: { nodeId, root: 'b'.repeat(64), chunkCount: 2, index: 0, rendition: '720p' } }),
        /verifiable path|vvsh|hash/i
      );
    } finally {
      await node.stop();
      await evil.stop();
      cleanup();
    }
  });

  it('a provider that answers too slowly is timed out', async () => {
    const evil = await startMaliciousProvider();
    try {
      evil.setDelay(5000);
      const client = clientFor(evil.url());
      await assert.rejects(client.json('/v1/slow', { timeoutMs: 400 }), /timed out|timeout|abort/i);
    } finally {
      await evil.stop();
    }
  });

  it('serves interactive behavior dashboards and browsable honest-demo metadata', async () => {
    const honest = await startAlgorithm();
    const evil = await startMaliciousAlgorithm();
    try {
      await admin(honest.url(), '/v1/admin/content', {
        method: 'PUT',
        body: { id: 'yt:dashboard-demo', title: 'Visible through the malicious node', format: 'video' },
      });
      evil.setHonestNode(honest.url());
      const page = await fetch(`${evil.url()}/admin`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Malicious algorithm/);
      const feed = await (await fetch(`${evil.url()}/v1/feed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })).json() as { items: { title: string }[] };
      assert.equal(feed.items[0].title, 'Visible through the malicious node');
      const behavior = await fetch(`${evil.url()}/admin/behavior`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attack: 'badsig' }),
      });
      assert.deepEqual(await behavior.json(), { attack: 'badsig' });
    } finally {
      await evil.stop();
      await honest.stop();
    }
  });

  it('overloads are survived and held to the rate limit on both node kinds', async () => {
    const provider = await startProvider();
    const algorithm = await startAlgorithm();
    const attacker = startMaliciousClient();
    try {
      await admin(provider.url(), '/v1/admin/moderation', { body: { subject: 'ip', target: '127.0.0.1', action: 'ratelimit', perMinute: 20 } });
      await admin(algorithm.url(), '/v1/admin/moderation', { body: { subject: 'ip', target: '127.0.0.1', action: 'ratelimit', perMinute: 20 } });

      const statuses = await Promise.all(Array.from({ length: 60 }, () => fetch(`${provider.url()}/v1/info`).then((r) => r.status, () => 0)));
      assert.ok(statuses.includes(429), 'the flood is held to the rate limit');
      await admin(provider.url(), '/v1/admin/status');

      await attacker.flood(`${algorithm.url()}/v1/peers/peers`, 60);
      const after = await admin<{ reference: string }>(algorithm.url(), '/v1/admin/status');
      assert.ok(after.reference.startsWith('vs:algorithm:'), 'and the algorithm node is still standing');
    } finally {
      await provider.stop();
      await algorithm.stop();
    }
  });

  it('the malicious nodes connect to honest peers and clients', async () => {
    const provider = await startProvider();
    const { dir, cleanup } = tempDir();
    const { client: node, api } = await startClient(dir);
    const evil = await startMaliciousProvider();
    try {
      // As a peer of the honest provider…
      await admin(provider.url(), '/v1/admin/peers', { method: 'PUT', body: { peers: [{ ref: evil.reference(), send: false, receive: true }] } });
      const peers = await admin<{ peers: { ref: string }[] }>(provider.url(), '/v1/admin/peers');
      assert.ok(peers.peers.some((peer) => peer.ref === evil.reference()), 'the provider took it as a peer');

      // …and as a node the client talks to.
      await api('/api/nodes', { body: { text: evil.reference() } });
      const state = await api<{ nodes: { id: string; type: string }[] }>('/api/state');
      assert.ok(state.nodes.some((entry) => entry.type === 'provider'), 'the client lists it');
    } finally {
      await node.stop();
      await provider.stop();
      await evil.stop();
      cleanup();
    }
  });
});