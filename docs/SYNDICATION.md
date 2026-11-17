# Syndication and share links

Two read-only surfaces let the world follow VibeShare content without any single host
holding it hostage:

1. **Outbound syndication** on an algorithm node — Atom feeds and a minimal
   ActivityPub actor/outbox, built from the node's listed catalog.
2. **Host-agnostic share links** — a `vs://` URI that names the content itself, so a
   shared id survives any one web-client copy, fork or native app going away.

The https share link stays the default everywhere; both surfaces are additive.

## 1. Outbound syndication (algorithm node)

Set `publicUrl` in the node's config (the address the world reaches it at, e.g.
`https://search.example`) — every link in every answer is built from it. With no shared
URL configured (and no onion address published) the routes answer `503 not_configured`
with a message that says what to set; they never emit relative or localhost links.

Only **listed** content appears: what the operator blocked or has not reviewed yet is
absent from every feed, the outbox and the entry pages. The same anonymous rating
ceiling that applies to ordinary requests (`policy.defaultMaxRating`) applies here.
Each feed carries the 50 newest entries, and answers are `Cache-Control: public,
max-age=300`. No account and no payment are involved — these routes are free and
read-only. Titles and descriptions are untrusted data: they leave XML-escaped (plain
character references, never CDATA).

| Route | Answers |
| --- | --- |
| `GET /v1/syndication/catalog/feed.xml` | Atom feed of the newest listed content |
| `GET /v1/syndication/creators/:id/feed.xml` | Atom feed of one creator's content |
| `GET /v1/syndication/topics/:name/feed.xml` | Atom feed of one topic (by name or id) |
| `GET /v1/syndication/content/:id` | One entry's page (JSON), what a feed `<id>` resolves to |
| `GET /v1/syndication/actor` | ActivityPub actor (JSON-LD), read-only — there is no inbox |
| `GET /v1/syndication/outbox` | ActivityPub `OrderedCollection` of recent content |
| `GET /.well-known/vibeshare` | Discovery document (see below) |

Each Atom entry's `<link>` points at the page the content lives on (its platform URL)
when it has one, and at its `/v1/syndication/content/:id` page here otherwise. The feed
advertises the actor with `rel="alternate"`, and the actor advertises the feed — a feed
reader or a fediverse server can find either from either.

```xml
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://search.example/v1/syndication/catalog/feed.xml</id>
  <title>Curator</title>
  <updated>2026-01-02T03:04:05.000Z</updated>
  <link rel="self" type="application/atom+xml" href="https://search.example/v1/syndication/catalog/feed.xml"/>
  <link rel="alternate" type="application/activity+json" href="https://search.example/v1/syndication/actor"/>
  <entry>
    <id>https://search.example/v1/syndication/content/yt%3Anew1</id>
    <title>Fresh &#38; &#60;b&#62;bold&#60;/b&#62; &#34;ideas&#34;</title>
    <published>2026-01-02T03:04:05.000Z</published>
    <link rel="alternate" href="https://platform.example/watch/new1"/>
  </entry>
</feed>
```

## 2. Host-agnostic share links (`vs://`)

A shared content id as a URI any VibeShare app can open:

```
vs://watch/<content-id>          the short form (canonical)
vibeshare://watch/<content-id>   the same, long form
vs://watch/<content-id>?p=<provider-id-hint>   with the provider hint https links carry
```

The content id is URL-encoded exactly as in the https links (`encodeURIComponent`), so
any id — including one with `~sources`, `:` or `?` — survives the round trip. The GUI's
share dialog offers the `vs://` link beside the web link (copy button), and the entry
pages above expose it as `links.share`.

**Parsing rules** (for any app or web-client copy implementing the scheme):

- accept the scheme case-insensitively, `vs` or `vibeshare`, with `://watch/`;
- URL-decode the id; an optional trailing `/` is not part of it;
- an optional `?p=` query is the provider node hint;
- anything else — another scheme, a different path, a broken encoding, an unknown
  query — is **not** a share URI: answer "not mine" and fall back to the https link.
  Parsing never throws and never guesses. The https link keeps working everywhere.

## 3. `/.well-known/vibeshare` — claiming a host

A host (any web-client copy, fork or node) says what it understands by serving
`/.well-known/vibeshare` as JSON at its origin:

```json
{
  "scheme": "vs",
  "schemes": ["vs", "vibeshare"],
  "share": "vs://watch/<content-id>",
  "name": "Curator",
  "node": "vs:algorithm:vk1…",
  "actor": "https://search.example/v1/syndication/actor",
  "outbox": "https://search.example/v1/syndication/outbox",
  "feeds": {
    "catalog": "https://search.example/v1/syndication/catalog/feed.xml",
    "creators": "https://search.example/v1/syndication/creators/<creator-id>/feed.xml",
    "topics": "https://search.example/v1/syndication/topics/<topic-name>/feed.xml"
  }
}
```

- `scheme`/`schemes`/`share` declare the share-URI claim of this host; `name`, `node`,
  `actor`, `outbox` and `feeds` are what this host serves (a web-client copy would list
  its own equivalents — its share base and the nodes it plays from).
- **Native apps** claim the scheme with the platform association files, in the same
  spirit as universal links:

  `/.well-known/apple-app-site-association` (iOS):

  ```json
  {
    "applinks": { "apps": [], "details": [{ "appID": "TEAMID.app.vibeshare", "paths": ["/watch/*"] }] },
    "webcredentials": { "apps": [] }
  }
  ```

  `/.well-known/assetlinks.json` (Android):

  ```json
  [{ "relation": ["delegate_permission/common.handle_all_urls"],
     "target": { "namespace": "android_app", "package_name": "app.vibeshare", "sha256_cert_fingerprints": ["…"] } }]
  ```

  and register `vs` / `vibeshare` as their custom URL scheme (that part needs no file
  on any host — the OS association is what opens `vs://` links in the app).

A `vs://` link resolves through whichever app or web-client copy answers for it on the
device; when none does, the accompanying https link is the fallback every share dialog
still puts first.
