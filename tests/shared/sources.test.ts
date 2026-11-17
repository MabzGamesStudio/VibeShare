// The source-scheme registry: every scheme VibeShare ships parses and embeds exactly
// as it always has, `lemmy` joins them, and a fork can register a scheme of its own.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baseId,
  embedFor,
  formatSource,
  parseContentId,
  parseSource,
  platformOf,
  registerSourceScheme,
  sourceFromUrl,
  sourceSchemeOf,
  sourceSchemeLabel,
  withSources,
} from '../../src/shared/sources.js';

const CID = `vs1${'a'.repeat(52)}`;

describe('source schemes', () => {
  it('round-trips every scheme it has always had', () => {
    const ids = ['yt:dQw4w9WgXcQ', 'vimeo:76979871', 'dm:x8abcde', 'sc:user/track', 'spotify:track:abc123', 'tiktok:7301234567890123456', 'ig:p/Cx123', 'x:1234567890', 'bsky:bsky.app/3k2abc', 'masto:mastodon.social/@user/123456789012345678', 'twitch:v123456789', 'ia:identifier', 'peertube:peertube.example/abc-123', 'ipfs:QmHash123/file.png', 'url:https%3A%2F%2Fexample.com%2Fpage'];
    for (const id of ids) {
      const source = parseSource(id);
      assert.ok(source, id);
      assert.equal(formatSource(source), id);
    }
    // Schemes are matched exactly as written and never empty.
    assert.equal(parseSource('YT:dQw4w9WgXcQ'), null);
    assert.equal(parseSource('yt:'), null);
    assert.equal(parseSource('zzz:123'), null);
  });

  it('parses platform links exactly as it always has', () => {
    const cases: [string, string][] = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
      ['https://www.youtube.com/shorts/abc123', 'yt:abc123'],
      ['https://vimeo.com/76979871', 'vimeo:76979871'],
      ['https://player.vimeo.com/video/76979871', 'vimeo:76979871'],
      ['https://www.dailymotion.com/video/x8abcde', 'dm:x8abcde'],
      ['https://dai.ly/x8abcde', 'dm:x8abcde'],
      ['https://www.instagram.com/p/Cx123/', 'ig:p/Cx123'],
      ['https://bsky.app/profile/bsky.app/post/3k2abc', 'bsky:bsky.app/3k2abc'],
      ['https://open.spotify.com/track/abc123', 'spotify:track:abc123'],
      ['https://www.tiktok.com/@someone/video/7301234567890123456', 'tiktok:7301234567890123456'],
      ['https://x.com/someone/status/1234567890', 'x:1234567890'],
      ['https://www.twitch.tv/videos/123456789', 'twitch:v123456789'],
      ['https://www.twitch.tv/somechannel', 'twitch:somechannel'],
      ['https://archive.org/details/identifier', 'ia:identifier'],
      ['https://peertube.example/videos/watch/abc-123', 'peertube:peertube.example/abc-123'],
      ['https://mastodon.social/@user/123456789012345678', 'masto:mastodon.social/@user/123456789012345678'],
      ['https://ipfs.io/ipfs/QmHash123/file.png', 'ipfs:QmHash123/file.png'],
      ['https://example.com/page', 'url:https%3A%2F%2Fexample.com%2Fpage'],
    ];
    for (const [url, id] of cases) {
      const source = sourceFromUrl(url);
      assert.equal(source && formatSource(source), id, url);
    }
    // A pasted source id stays what it is.
    assert.equal(formatSource(sourceFromUrl('yt:dQw4w9WgXcQ')!), 'yt:dQw4w9WgXcQ');
  });

  it('has lemmy alongside the other schemes', () => {
    const source = sourceFromUrl('https://lemmy.ml/post/12345');
    assert.equal(source && formatSource(source), 'lemmy:lemmy.ml/post/12345');
    assert.equal(sourceSchemeLabel('lemmy'), 'Lemmy');
    assert.equal(formatSource(parseSource('lemmy:lemmy.ml/post/12345')!), 'lemmy:lemmy.ml/post/12345');
    // A Lemmy post has no player of its own: it opens on its instance.
    const embed = embedFor(source!);
    assert.equal(embed.kind, 'link');
    assert.equal(embed.page, 'https://lemmy.ml/post/12345');
    // The shape must be exactly /post/<id>: other platforms' post links stay web links.
    const tumblr = sourceFromUrl('https://ann.tumblr.com/post/1234567890/aurora');
    assert.equal(tumblr && formatSource(tumblr), `url:${encodeURIComponent('https://ann.tumblr.com/post/1234567890/aurora')}`);
  });

  it('embeds and pages the platforms exactly as it always has', () => {
    const yt = embedFor({ scheme: 'yt', value: 'dQw4w9WgXcQ' }, { autoplay: true });
    assert.equal(yt.kind, 'iframe');
    assert.ok(yt.src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'));
    assert.ok(yt.src.includes('enablejsapi=1'));
    assert.equal(yt.page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(yt.label, 'YouTube');

    const video = embedFor({ scheme: 'twitch', value: 'v123456789' }, { parentHost: 'play.example' });
    assert.equal(video.src, 'https://player.twitch.tv/?video=v123456789&parent=play.example');
    assert.equal(video.page, 'https://www.twitch.tv/videos/123456789');
    const channel = embedFor({ scheme: 'twitch', value: 'somechannel' }, { parentHost: 'play.example' });
    assert.equal(channel.src, 'https://player.twitch.tv/?channel=somechannel&parent=play.example');

    const ipfs = embedFor({ scheme: 'ipfs', value: 'QmHash123/pic.png' }, { ipfsGateway: 'https://gw.example/' });
    assert.equal(ipfs.kind, 'image');
    assert.equal(ipfs.src, 'https://gw.example/ipfs/QmHash123/pic.png');
    assert.equal(ipfs.page, 'https://gw.example/ipfs/QmHash123/pic.png');

    // A web link that is not a page shows with nothing to open.
    const plain = embedFor({ scheme: 'url', value: 'notaurl' });
    assert.equal(plain.kind, 'link');
    assert.equal(plain.src, '');
    assert.equal(plain.page, '');
    assert.equal(embedFor({ scheme: 'url', value: 'https%3A%2F%2Fexample.com%2Fpic.jpg' }).kind, 'image');

    // The Internet Archive serves its own stills.
    assert.equal(sourceSchemeOf('ia')?.imageFor?.('identifier'), 'https://archive.org/services/img/identifier');
  });

  it('keeps content id handling identical', () => {
    const parsed = parseContentId(`${CID}~yt:dQw4w9WgXcQ~ia:foo`);
    assert.ok(parsed?.native);
    assert.equal(parsed.base, CID);
    assert.equal(baseId(parsed.full), parsed.base);
    assert.deepEqual(parsed.sources.map(formatSource), ['yt:dQw4w9WgXcQ', 'ia:foo']);
    const merged = withSources(parsed.full, [{ scheme: 'ia', value: 'foo' }, { scheme: 'vimeo', value: '1' }]);
    assert.equal(merged, `${parsed.full}~vimeo:1`);
    assert.equal(platformOf('yt:dQw4w9WgXcQ').key, 'yt');
    assert.equal(platformOf(CID).key, 'vibeshare');
  });

  it('embeds and pages a scheme a fork registered', () => {
    registerSourceScheme({
      id: 'mytube',
      label: 'MyTube',
      media: 'iframe',
      parse(url) {
        const path = url.pathname.split('/').filter(Boolean);
        return url.hostname === 'mytube.example' && path[0] === 'watch' && path[1] ? { scheme: 'mytube', value: path[1] } : null;
      },
      pageFor: (value) => `https://mytube.example/watch/${value}`,
      embedFor: (value) => ({ kind: 'iframe', src: `https://mytube.example/embed/${value}` }),
    });
    const source = sourceFromUrl('https://mytube.example/watch/42');
    assert.equal(source && formatSource(source), 'mytube:42');
    const embed = embedFor(source!);
    assert.equal(embed.src, 'https://mytube.example/embed/42');
    assert.equal(embed.page, 'https://mytube.example/watch/42');
    assert.equal(embed.label, 'MyTube');
    assert.equal(parseContentId(`${CID}~mytube:42`)?.sources[0]?.scheme, 'mytube');
  });
});
