// Host-agnostic share links: a content id as a `vs://` URI that survives any single
// host. Parsing is forgiving of form but strict of meaning: anything it does not
// understand answers null and the caller keeps its https link.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatShareUri, isShareUri, parseShareUri } from '../../src/shared/share.js';

describe('host-agnostic share links', () => {
  it('round-trips any content id through a vs:// link', () => {
    for (const id of ['vs1abc', 'vs1abc~yt:dQw4w9WgXcQ', 'yt:some/video?x=1', 'ia:old-cartoon', 'https://example.org/a b?c#d', 'x/%zz']) {
      const uri = formatShareUri(id);
      assert.ok(uri.startsWith('vs://watch/'), uri);
      assert.equal(parseShareUri(uri)?.contentId, id, `round trip of ${id}`);
    }
  });

  it('reads both schemes, case freely, and keeps the provider hint', () => {
    assert.deepEqual(parseShareUri(formatShareUri('vs1abc', 'vs:provider:vk1x@https://p.example')), {
      contentId: 'vs1abc',
      providerHint: 'vs:provider:vk1x@https://p.example',
    });
    assert.equal(parseShareUri('vibeshare://watch/yt%3Ax')?.contentId, 'yt:x');
    assert.equal(parseShareUri('VS://Watch/yt%3Ax')?.contentId, 'yt:x');
    assert.equal(parseShareUri('vs://watch/vs1abc/')?.contentId, 'vs1abc', 'a trailing slash is not part of the id');
    assert.equal(isShareUri('vs://watch/vs1abc'), true);
  });

  it('falls back safely on anything it does not understand', () => {
    const foreign = [
      '',
      'not a link',
      'https://example.org/watch/vs1abc',
      'ftp://watch/vs1abc',
      'vs://open/vs1abc',
      'vs://watch/',
      'vs://watch/%zz',
      'vs://watch/vs1abc?other=1',
    ];
    for (const text of foreign) {
      assert.equal(parseShareUri(text), null, JSON.stringify(text));
      assert.equal(isShareUri(text), false, JSON.stringify(text));
    }
  });
});
