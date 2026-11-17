// Outbound syndication: what this node hands the outside world to follow — Atom feeds
// of the catalog, of one creator or of one topic (RSS readers and platforms consume
// them as they are), and a minimal read-only ActivityPub surface (an actor and its
// outbox) so fediverse software can follow the node without scraping it. Everything
// here is read-only and free — no account, no payment — and only `listed` content goes
// out: what the operator blocked or has not reviewed yet never appears.
//
// Every URL in every answer is absolute, built from the node's shared URL (the address
// the operator published), because feed readers and ActivityPub servers live on other
// machines; with no shared URL the routes say so instead of emitting links nobody can
// follow. Titles and descriptions come from operators, peers and platforms and are
// never trusted as markup: every piece of text is XML-escaped on the way out (plain
// escaping, never CDATA — an untrusted `]]>` could close a CDATA section and smuggle
// markup past the parser).
import type { AlgorithmNode } from '../node.js';
import { type Ctx, HttpError, notFound } from '../../shared/node/http.js';
import type { Entry } from '../registry.js';
import { formatShareUri } from '../../shared/share.js';

/** The newest entries any feed or the outbox carries at once. */
const FEED_LIMIT = 50;

/** Feeds move as content is listed: public, but re-checked soon. */
const CACHE = 'public, max-age=300';

const ATOM = 'application/atom+xml; charset=utf-8';
const ACTIVITY_JSON = 'application/activity+json; charset=utf-8';

/** The address the world can reach this node at — or a clear error, never a relative link. */
function sharedBase(node: AlgorithmNode): string {
  const base = (node.config.publicUrl?.trim() || node.onionUrl() || '').replace(/\/+$/, '');
  if (!base) {
    throw new HttpError(503, 'not_configured', 'Syndication needs a shared URL: set publicUrl in this node’s config (or publish an onion address).');
  }
  return base;
}

/** Text into XML text or attribute values: nothing untrusted passes raw. */
function escapeXml(text: string): string {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The newest listed content — what an anonymous request already sees, capped. */
function newest(node: AlgorithmNode): Entry[] {
  const entries = node.registry.visible(node.preferencesOf(undefined), node.config.policy.maxRating);
  // publishedAt is an ISO string, so string order is time order.
  return entries.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0)).slice(0, FEED_LIMIT);
}

/** One entry's permanent page on this node (its id resolves to the JSON below). */
function entryContentUrl(base: string, entry: Entry): string {
  return `${base}/v1/syndication/content/${encodeURIComponent(entry.id)}`;
}

/** Where a reader opens an entry: the page it lives on, else its page on this node. */
function entryLink(base: string, entry: Entry): string {
  // An untrusted page URL is only a link when it is a web URL at all — a javascript: or
  // data: URL in a feed is an attack on whatever reader opens it.
  return entry.pageUrl && /^https?:\/\//i.test(entry.pageUrl) ? entry.pageUrl : entryContentUrl(base, entry);
}

function isoOrNow(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

/** One Atom feed, escaped end to end (see the header: no CDATA with untrusted text). */
function atomFeed(
  base: string,
  input: { self: string; title: string; subtitle?: string; author: string; updated?: string; entries: Entry[] }
): string {
  const actor = `${base}/v1/syndication/actor`;
  const entries = input.entries
    .map((entry) => {
      const link = entryLink(base, entry);
      const categories = entry.topics.map((topic) => `    <category term="${escapeXml(topic)}"/>`).join('\n');
      return [
        '  <entry>',
        `    <id>${escapeXml(entryContentUrl(base, entry))}</id>`,
        `    <title>${escapeXml(entry.title)}</title>`,
        `    <published>${escapeXml(isoOrNow(entry.publishedAt))}</published>`,
        `    <updated>${escapeXml(isoOrNow(entry.updatedAt || entry.publishedAt))}</updated>`,
        `    <link rel="alternate" href="${escapeXml(link)}"/>`,
        entry.description ? `    <summary type="text">${escapeXml(entry.description)}</summary>` : '',
        categories,
        '  </entry>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(input.self)}</id>`,
    `  <title>${escapeXml(input.title)}</title>`,
    input.subtitle ? `  <subtitle>${escapeXml(input.subtitle)}</subtitle>` : '',
    `  <updated>${escapeXml(isoOrNow(input.updated || input.entries[0]?.publishedAt))}</updated>`,
    `  <author><name>${escapeXml(input.author)}</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(input.self)}"/>`,
    `  <link rel="alternate" type="application/activity+json" href="${escapeXml(actor)}"/>`,
    entries,
    '</feed>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The ActivityPub object type of an entry's format. */
function objectType(format: Entry['format']): string {
  if (format === 'video' || format === 'short-video' || format === 'live') return 'Video';
  if (format === 'image' || format === 'image-list') return 'Image';
  if (format === 'music' || format === 'audio' || format === 'podcast') return 'Audio';
  if (format === 'article') return 'Article';
  return 'Object';
}

export function registerSyndicationRoutes(node: AlgorithmNode): void {
  const router = node.router;

  /** One Atom feed of the newest listed content, narrowed to a creator or a topic. */
  const sendFeed = (ctx: Ctx, title: string, subtitle: string | undefined, keep: (entry: Entry) => boolean): void => {
    const base = sharedBase(node);
    const xml = atomFeed(base, {
      self: `${base}${ctx.url.pathname}`,
      title,
      subtitle,
      author: node.config.name,
      entries: newest(node).filter(keep),
    });
    ctx.res.writeHead(200, { 'content-type': ATOM, 'cache-control': CACHE }).end(xml);
  };

  router.get('/v1/syndication/catalog/feed.xml', (ctx) => {
    sendFeed(ctx, node.config.name, node.config.description, () => true);
  });

  router.get('/v1/syndication/creators/:id/feed.xml', (ctx) => {
    const creator = node.registry.creator(ctx.params.id);
    if (!creator || creator.status === 'blocked') throw notFound('No such creator');
    sendFeed(ctx, `${creator.name} — ${node.config.name}`, creator.description, (entry) => entry.creatorId === creator.id);
  });

  router.get('/v1/syndication/topics/:name/feed.xml', (ctx) => {
    const key = ctx.params.name.toLowerCase();
    const topic = node.registry.topics(true).find((record) => record.id === ctx.params.name || record.name.toLowerCase() === key);
    if (!topic || topic.status !== 'listed') throw notFound('No such topic');
    // Entries filed under the topic by id, and older ones that only carry its name.
    sendFeed(
      ctx,
      `${topic.name} — ${node.config.name}`,
      topic.description,
      (entry) => (entry.topicIds ?? []).includes(topic.id) || entry.topics.includes(topic.name)
    );
  });

  // One entry's own page: what a feed's <id> resolves to. Only listed content is
  // reachable at all, so a blocked or unreviewed id answers like one that never existed.
  router.get('/v1/syndication/content/:id', (ctx) => {
    const base = sharedBase(node);
    const entry = node.registry.visible(node.preferencesOf(undefined), node.config.policy.maxRating).find((item) => item.id === ctx.params.id);
    if (!entry) throw notFound('No such content');
    const page = entry.pageUrl && /^https?:\/\//i.test(entry.pageUrl) ? entry.pageUrl : undefined;
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      format: entry.format,
      rating: entry.rating,
      topics: entry.topics,
      creator: entry.creatorId ? node.registry.creator(entry.creatorId)?.name : undefined,
      publishedAt: entry.publishedAt,
      links: {
        page,
        share: formatShareUri(entry.id),
        feed: `${base}/v1/syndication/catalog/feed.xml`,
      },
    };
  });

  // The actor: how fediverse software follows this node. Read-only by design — there is
  // no inbox to post to and nothing here accepts activities.
  router.get('/v1/syndication/actor', (ctx) => {
    const base = sharedBase(node);
    ctx.res.writeHead(200, { 'content-type': ACTIVITY_JSON, 'cache-control': CACHE }).end(
      JSON.stringify({
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${base}/v1/syndication/actor`,
        type: 'Application',
        name: node.config.name,
        summary: node.config.description,
        outbox: `${base}/v1/syndication/outbox`,
        attachment: [
          { type: 'Link', rel: 'alternate', mediaType: 'application/atom+xml', href: `${base}/v1/syndication/catalog/feed.xml` },
          { type: 'Link', rel: 'alternate', mediaType: 'application/json', href: `${base}/.well-known/vibeshare` },
        ],
      })
    );
  });

  // The outbox: an ordered collection of the newest listed content, one Create activity
  // per entry, so ActivityPub servers can pull what this node publishes.
  router.get('/v1/syndication/outbox', (ctx) => {
    const base = sharedBase(node);
    const entries = newest(node);
    ctx.res.writeHead(200, { 'content-type': ACTIVITY_JSON, 'cache-control': CACHE }).end(
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${base}/v1/syndication/outbox`,
        type: 'OrderedCollection',
        totalItems: entries.length,
        orderedItems: entries.map((entry) => ({
          id: `${entryContentUrl(base, entry)}#create`,
          type: 'Create',
          actor: `${base}/v1/syndication/actor`,
          published: isoOrNow(entry.publishedAt),
          object: {
            id: entryContentUrl(base, entry),
            type: objectType(entry.format),
            name: entry.title,
            summary: entry.description,
            url: entryLink(base, entry),
            published: isoOrNow(entry.publishedAt),
          },
        })),
      })
    );
  });

  // The discovery document: what a host (this node, or any web-client copy that follows
  // the same rules) claims — the scheme it understands and what it serves here.
  router.get('/.well-known/vibeshare', (ctx) => {
    const base = sharedBase(node);
    ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': CACHE }).end(
      JSON.stringify({
        scheme: 'vs',
        schemes: ['vs', 'vibeshare'],
        share: 'vs://watch/<content-id>',
        name: node.config.name,
        node: node.identity.id,
        actor: `${base}/v1/syndication/actor`,
        outbox: `${base}/v1/syndication/outbox`,
        feeds: {
          catalog: `${base}/v1/syndication/catalog/feed.xml`,
          creators: `${base}/v1/syndication/creators/<creator-id>/feed.xml`,
          topics: `${base}/v1/syndication/topics/<topic-name>/feed.xml`,
        },
      })
    );
  });
}
