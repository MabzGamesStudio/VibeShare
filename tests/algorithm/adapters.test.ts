// The source-adapter contract every crawler adapter must satisfy: an id and label,
// and URL recognition (match/parse) that never throws. The client's URL handling and
// the crawler's adapters speak the same contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_ADAPTERS } from '../../src/algorithm/crawler/adapters/apis/index.js';
import { PLATFORM_ADAPTERS } from '../../src/algorithm/crawler/crawler.js';
import type { Adapter } from '../../src/algorithm/crawler/types.js';
import { formatSource, sourceFromUrl } from '../../src/shared/sources.js';

const SAMPLE_URLS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://vimeo.com/76979871',
  'https://www.twitch.tv/videos/123456789',
  'https://x.com/someone/status/1234567890',
  'https://www.instagram.com/reel/Cx123',
  'https://open.spotify.com/track/abc123',
  'https://archive.org/details/identifier',
  'https://peertube.example/videos/watch/abc-123',
  'https://mastodon.social/@user/123456789012345678',
  'https://lemmy.ml/post/12345',
  'https://www.flickr.com/photos/someone/12345678901',
  'https://example.com/a/page?with=query',
  'https://example.com/not/a/known/platform.jpg',
  'nonsense',
];

describe('crawler adapters', () => {
  it('lists the API platforms it always has, in order', () => {
    assert.deepEqual(
      API_ADAPTERS.map((adapter) => adapter.id),
      ['vimeo', 'twitch', 'unsplash', 'pexels', 'giphy', 'tenor', 'imgur', 'deviantart', 'europeana', 'reddit', 'tumblr', 'x', 'instagram', 'spotify', 'jamendo', 'freesound']
    );
    assert.equal(PLATFORM_ADAPTERS.length, 10 + API_ADAPTERS.length);
  });

  for (const adapter of [...PLATFORM_ADAPTERS, ...API_ADAPTERS] as Adapter[]) {
    it(`${adapter.id} satisfies the source-adapter contract`, () => {
      assert.equal(typeof adapter.id, 'string');
      assert.ok(adapter.id.length > 0);
      assert.equal(typeof adapter.label, 'string');
      assert.equal(typeof adapter.match, 'function');
      assert.equal(typeof adapter.parse, 'function');
      for (const text of SAMPLE_URLS) {
        let url: URL | null = null;
        try {
          url = new URL(text);
        } catch {
          url = null;
        }
        if (!url) continue;
        assert.doesNotThrow(() => adapter.match(url!), `${adapter.id}.match(${text})`);
        assert.doesNotThrow(() => adapter.parse(url!), `${adapter.id}.parse(${text})`);
        const parsed = adapter.parse(url!);
        if (parsed) assert.equal(formatSource(parsed), formatSource(sourceFromUrl(text) ?? parsed), `${adapter.id}.parse(${text}) is canonical`);
      }
    });
  }

  it('recognizes its own platform URLs', () => {
    const byId = new Map([...PLATFORM_ADAPTERS, ...API_ADAPTERS].map((adapter) => [adapter.id, adapter]));
    assert.ok(byId.get('youtube')?.match(new URL('https://youtu.be/dQw4w9WgXcQ')));
    assert.ok(!byId.get('youtube')?.match(new URL('https://vimeo.com/76979871')));
    assert.ok(byId.get('flickr')?.match(new URL('https://www.flickr.com/photos/someone/12345678901')));
    assert.ok(!byId.get('flickr')?.match(new URL('https://example.com/page')));
    assert.ok(byId.get('lemmy')?.match(new URL('https://lemmy.ml/post/12345')));
  });
});
