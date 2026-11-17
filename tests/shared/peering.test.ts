// One peering vocabulary for both node kinds: the provider's send/receive and the
// algorithm node's fetch/serve must map onto the same PeerLink without losing a direction.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describePeerLink,
  peerDirections,
  peerLinkFromAlgorithm,
  peerLinkFromProvider,
  peerLinkToAlgorithm,
  peerLinkToProvider,
} from '../../src/shared/peering.js';

describe('the shared peering vocabulary', () => {
  it('maps both node kinds onto one shape', () => {
    assert.deepEqual(peerLinkFromProvider({ ref: 'vs:provider:k@https://p', send: true, receive: false }), {
      ref: 'vs:provider:k@https://p',
      outgoing: true,
      incoming: false,
      carries: 'bytes',
    });
    assert.deepEqual(peerLinkFromAlgorithm({ ref: 'vs:algorithm:k@https://a', fetch: false, serve: true }), {
      ref: 'vs:algorithm:k@https://a',
      outgoing: false,
      incoming: true,
      carries: 'metadata',
    });
  });

  it('round-trips back to each node kind without losing a direction', () => {
    const provider = { ref: 'vs:provider:k@https://p', send: false, receive: true };
    assert.deepEqual(peerLinkToProvider(peerLinkFromProvider(provider)), provider);
    const algorithm = { ref: 'vs:algorithm:k@https://a', fetch: true, serve: true };
    assert.deepEqual(peerLinkToAlgorithm(peerLinkFromAlgorithm(algorithm)), algorithm);
  });

  it('describes every combination in one line', () => {
    assert.equal(describePeerLink({ ref: 'r', outgoing: true, incoming: true }), 'both ways');
    assert.equal(describePeerLink({ ref: 'r', outgoing: true, incoming: false }), 'outgoing only');
    assert.equal(describePeerLink({ ref: 'r', outgoing: false, incoming: true }), 'incoming only');
    assert.equal(describePeerLink({ ref: 'r', outgoing: false, incoming: false }), 'no exchange');
    assert.deepEqual(peerDirections({ ref: 'r', outgoing: true, incoming: true }), ['outgoing', 'incoming']);
  });
});
