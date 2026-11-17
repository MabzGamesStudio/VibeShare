// Outbound syndication: Atom feeds and the read-only ActivityPub surface of an
// algorithm node. The routes exist so platforms and RSS readers follow a node without
// scraping it — so the checks are about what leaves the node: well-formed XML with
// untrusted text escaped, only listed content, absolute links, and clear errors.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { admin, startAlgorithm } from '../helpers.js';

const HOST = 'https://node.example';
const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

/**
 * Parses as XML: the document opens with the XML declaration, every tag closes in the
 * order it opened, and no text or attribute value carries a bare `<` or `&` (entities
 * are the only way untrusted text may appear).
 */
function assertWellFormed(xml: string): void {
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
  const stack: string[] = [];
  for (const token of xml.slice(xml.indexOf('?>') + 2).match(/<[^>]+>|[^<]+/g) ?? []) {
    assert.ok(!/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z]+;)/.test(token), `bare & in ${JSON.stringify(token.slice(0, 80))}`);
    if (!token.startsWith('<')) continue;
    if (token.startsWith('</')) {
      assert.equal(stack.pop(), token.slice(2, -1).trim(), `closing tag of ${token}`);
    } else {
      const name = /^<([A-Za-z][\w:.-]*)/.exec(token)?.[1];
      assert.ok(name, `tag name in ${JSON.stringify(token.slice(0, 80))}`);
      if (!token.endsWith('/>')) stack.push(name!);
    }
  }
  assert.deepEqual(stack, [], 'every tag closed');
}

describe('outbound syndication', async () => {
  const node = await startAlgorithm({ publicUrl: HOST });
  // The node listens on its port whatever the shared URL says: requests go there, and
  // every link the routes emit must still be built from HOST.
  const url = `http://127.0.0.1:${node.port}`;
  after(() => node.stop());

  await admin(url, '/v1/admin/creators', { method: 'PUT', body: { id: 'name:labs', name: 'Science Labs', kind: 'company' } });
  const seed = [
    {
      id: 'yt:new1',
      title: 'Fresh & <b>bold</b> "ideas"',
      description: 'A description with <script>alert(1)</script> & friends',
      format: 'video',
      rating: 'all',
      topics: ['science'],
      creatorId: 'name:labs',
      pageUrl: 'https://platform.example/watch/new1',
      publishedAt: ago(1),
    },
    { id: 'yt:old2', title: 'Older entry', format: 'music', rating: 'all', topics: ['science'], creatorId: 'name:labs', publishedAt: ago(2) },
    { id: 'ia:other', title: 'Other topic', format: 'article', rating: 'all', topics: ['history'], publishedAt: ago(3) },
    { id: 'x:spam', title: 'Blocked <spam>', format: 'other', rating: 'all', topics: ['science'], status: 'blocked', reason: 'spam' },
    { id: 'x:pending', title: 'Pending find', format: 'other', rating: 'all', topics: ['science'], status: 'pending' },
    { id: 'x:nsfw', title: 'Over the ceiling', format: 'video', rating: 'nsfw', topics: ['science'] },
  ];
  for (const item of seed) await admin(url, '/v1/admin/content', { method: 'PUT', body: item });

  const get = async (path: string) => {
    const response = await fetch(url + path);
    return { response, text: await response.text() };
  };

  it('serves an Atom feed of the newest listed content, escaped end to end', async () => {
    const { response, text: xml } = await get('/v1/syndication/catalog/feed.xml');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/atom\+xml/);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    assertWellFormed(xml);
    // Untrusted titles and descriptions leave as character references, never as markup.
    assert.ok(xml.includes('Fresh &#38; &#60;b&#62;bold&#60;/b&#62; &#34;ideas&#34;'), 'the title is escaped');
    assert.ok(!xml.includes('<script>'), 'no markup smuggles through');
    assert.ok(!xml.includes('<b>bold'), 'and no partial markup either');
    // Only listed content goes out: blocked, unreviewed and over-ceiling entries stay in.
    assert.ok(!xml.includes('Blocked'), 'blocked content stays out');
    assert.ok(!xml.includes('Pending find'), 'unreviewed content stays out');
    assert.ok(!xml.includes('Over the ceiling'), 'content over the anonymous rating ceiling stays out');
    // Newest first, with absolute links built from the shared URL.
    assert.ok(xml.indexOf('Older entry') > xml.indexOf('Fresh'), 'newest first');
    assert.ok(xml.includes(`href="${HOST}/v1/syndication/catalog/feed.xml"`), 'the self link is absolute');
    assert.ok(xml.includes(`type="application/activity+json" href="${HOST}/v1/syndication/actor"`), 'the actor is advertised');
    assert.ok(xml.includes('href="https://platform.example/watch/new1"'), 'an entry links to its own page');
    assert.ok(xml.includes(`href="${HOST}/v1/syndication/content/yt%3Aold2"`), 'and one without a page links to its page here');
  });

  it('caps any feed at the 50 newest entries', async () => {
    for (let index = 0; index < 55; index++) {
      await admin(url, '/v1/admin/content', {
        method: 'PUT',
        body: { id: `yt:fill${index}`, title: `Filler ${index}`, format: 'video', rating: 'all', topics: ['science'], publishedAt: ago(10 + index) },
      });
    }
    const { text: xml } = await get('/v1/syndication/catalog/feed.xml');
    assert.equal((xml.match(/<entry>/g) ?? []).length, 50);
  });

  it('serves one feed per creator and one per topic', async () => {
    const creator = await get(`/v1/syndication/creators/${encodeURIComponent('name:labs')}/feed.xml`);
    assert.equal(creator.response.status, 200);
    assertWellFormed(creator.text);
    assert.ok(creator.text.includes('Fresh'), 'the creator feed has its content');
    assert.ok(!creator.text.includes('Other topic'), 'and nothing of anyone else');
    const topic = await get('/v1/syndication/topics/science/feed.xml');
    assert.equal(topic.response.status, 200);
    assertWellFormed(topic.text);
    assert.ok(topic.text.includes('Older entry'), 'the topic feed has its content');
    assert.ok(!topic.text.includes('Other topic'), 'and nothing filed elsewhere');
    assert.ok(!topic.text.includes('Blocked'), 'the topic feed keeps blocked content out too');
    const missing = await get('/v1/syndication/topics/no-such/feed.xml');
    assert.equal(missing.response.status, 404, 'an unknown topic is a clear 404');
  });

  it('exposes a read-only ActivityPub actor and outbox', async () => {
    const actor = (await (await fetch(`${url}/v1/syndication/actor`)).json()) as {
      id: string;
      type: string;
      name: string;
      outbox: string;
      inbox?: string;
      attachment?: unknown[];
    };
    assert.equal(actor.id, `${HOST}/v1/syndication/actor`);
    assert.equal(actor.type, 'Application');
    assert.equal(actor.name, node.config.name);
    assert.equal(actor.outbox, `${HOST}/v1/syndication/outbox`);
    assert.equal(actor.inbox, undefined, 'read-only: there is no inbox to post to');
    assert.ok(Array.isArray(actor.attachment), 'the feeds are advertised from the actor');

    const outbox = (await (await fetch(`${url}/v1/syndication/outbox`)).json()) as {
      '@context': string;
      type: string;
      id: string;
      totalItems: number;
      orderedItems: { type: string; actor: string; object: { id: string; name: string } }[];
    };
    assert.equal(outbox['@context'], 'https://www.w3.org/ns/activitystreams');
    assert.equal(outbox.type, 'OrderedCollection');
    assert.equal(outbox.id, `${HOST}/v1/syndication/outbox`);
    assert.equal(outbox.totalItems, outbox.orderedItems.length);
    assert.ok(outbox.orderedItems.length > 0 && outbox.orderedItems.length <= 50, 'the collection is capped');
    const first = outbox.orderedItems[0];
    assert.equal(first.type, 'Create');
    assert.equal(first.actor, `${HOST}/v1/syndication/actor`);
    assert.ok(first.object.id.startsWith(`${HOST}/v1/syndication/content/`), 'objects resolve back to this node');
    assert.equal(typeof first.object.name, 'string');
  });

  it('gives every entry a resolvable page with its share link', async () => {
    const page = (await (await fetch(`${url}/v1/syndication/content/${encodeURIComponent('yt:new1')}`)).json()) as {
      title: string;
      links: { page?: string; share: string; feed: string };
    };
    assert.equal(page.title, 'Fresh & <b>bold</b> "ideas"');
    assert.equal(page.links.page, 'https://platform.example/watch/new1');
    assert.equal(page.links.share, 'vs://watch/yt%3Anew1');
    assert.equal(page.links.feed, `${HOST}/v1/syndication/catalog/feed.xml`);
    const blocked = await fetch(`${url}/v1/syndication/content/${encodeURIComponent('x:spam')}`);
    assert.equal(blocked.status, 404, 'a blocked id answers as if it never existed');
  });

  it('advertises itself at /.well-known/vibeshare', async () => {
    const wellKnown = (await (await fetch(`${url}/.well-known/vibeshare`)).json()) as {
      scheme: string;
      schemes: string[];
      share: string;
      actor: string;
      feeds: { catalog: string };
    };
    assert.equal(wellKnown.scheme, 'vs');
    assert.deepEqual(wellKnown.schemes, ['vs', 'vibeshare']);
    assert.equal(wellKnown.share, 'vs://watch/<content-id>');
    assert.equal(wellKnown.actor, `${HOST}/v1/syndication/actor`);
    assert.equal(wellKnown.feeds.catalog, `${HOST}/v1/syndication/catalog/feed.xml`);
  });
});

describe('syndication without a shared URL', async () => {
  const node = await startAlgorithm();
  const url = `http://127.0.0.1:${node.port}`;
  after(() => node.stop());

  it('says so clearly instead of emitting links nobody can follow', async () => {
    for (const path of ['/v1/syndication/catalog/feed.xml', '/v1/syndication/actor', '/v1/syndication/outbox']) {
      const response = await fetch(url + path);
      assert.equal(response.status, 503, path);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /shared URL/i, path);
    }
  });
});
