# VibeShare protocol (v1)

Every node speaks HTTP + JSON. Clients and nodes can be written in any language; this document is the contract. Types are in [`src/shared/protocol.ts`](../src/shared/protocol.ts).

Conventions: errors are `{"error": {"code": "...", "message": "..."}}` with a matching HTTP status (`402 payment_required` carries `price` and `balance`). All public endpoints allow CORS from any origin; authentication is by bearer token, never cookies.

## 1. Identifiers

### Keys

Nodes and users have Ed25519 keys. A key id is `vk1` + lowercase RFC 4648 base32 (no padding) of the 32-byte public key:

```
vk1veihoj2vhdza5zfo64taqgwrg2j72c3saahgtbmzbbx4km75dlya
```

Signatures are Ed25519 over UTF-8 strings, encoded base64url.

**Pseudonyms.** A client may use a different key per node: `seed' = HKDF-SHA256(ikm = main seed, salt = "vibeshare-pseudonym-v1", info = node key id, 32 bytes)`. Only the holder of the main seed can re-derive it.

### Node references

```
vs:<type>:<key id>@<base URL>          type = provider | algorithm
vs:provider:vk1…@https://cdn.example.org
```

A bare `http(s)://` URL is also accepted: the client learns the type and key from `/v1/info`. When the reference has a key, the client refuses a node whose signed info is not signed by that key.

### Content ids

**Chunks.** Native content is cut into chunks of `chunkSize` bytes (default 1 MiB, at most 8 MiB); only the last may be shorter. A chunk id is `vc1` + base32(SHA-256(bytes)).

**Manifests.**

```json
{
  "v": 1,
  "name": "ambient-drift.wav",
  "mime": "audio/wav",
  "size": 5292044,
  "chunkSize": 1048576,
  "chunks": [{ "id": "vc1…", "size": 1048576 }, …],
  "createdAt": "2026-10-11T19:17:55.000Z",
  "meta": { "title": "…", "description": "…", "format": "music", "rating": "all", "topics": [], "tags": [], "language": "en", "durationSeconds": 60 },
  "sources": ["yt:…"],
  "creator": { "id": "vk1…", "name": "Ada Synth", "kind": "person", "sig": "…" }
}
```

`meta`, `sources` and `creator` are optional. The creator signature covers `"vibeshare-manifest\n" + canonicalJson(manifest with creator.sig removed)`. *Canonical JSON* has object keys sorted, no whitespace and no `undefined` members.

The content id is `vs1` + base32(SHA-256(canonicalJson(manifest))) — the signature is part of the hash.

**External ids** name content that lives elsewhere, as `scheme:value`:

| Scheme | Value | Example |
|---|---|---|
| `yt` | YouTube video id | `yt:dQw4w9WgXcQ` |
| `vimeo` | Vimeo id | `vimeo:76979871` |
| `dm` | Dailymotion id | `dm:x8abc12` |
| `sc` | SoundCloud path | `sc:artist/track` |
| `spotify` | `type:id` | `spotify:track:4uLU6hMCjMI75M1A2tKUQC` |
| `tiktok` | video id | `tiktok:7234567890` |
| `ig` | `p` or `reel` + `/` + shortcode | `ig:reel/Cabc123` |
| `x` | post id | `x:1234` |
| `bsky` | `handle-or-did/post-key` | `bsky:alice.bsky.social/3kabc` |
| `masto` | `host/@user/status-id` | `masto:mastodon.social/@bob/1123581321` |
| `twitch` | channel, or `v` + video id | `twitch:v987` |
| `ia` | Internet Archive identifier | `ia:BigBuckBunny_124` |
| `peertube` | `host/video-id` | `peertube:tube.example/abc` |
| `ipfs` | CID and path | `ipfs:bafy…/movie.mp4` |
| `url` | URL-encoded link | `url:https%3A%2F%2F…` |

**Fallbacks.** Any id may be followed by `~`-separated sources to try, in order, when the content is not available otherwise: `vs1…~yt:dQw4w9WgXcQ~ia:some-item`. Everything before the first `~` is the *base id*; nodes index by it.

## 2. Node info

`GET /v1/info` → `{ "info": NodeInfo, "sig": "…" }` with `sig` = signature by `info.id` over `"vibeshare-info\n" + canonicalJson(info)`.

Common fields: `v`, `type`, `id`, `name`, `description`, `software`, `time`, `url`, `onion` (the node's Tor onion address, `http://….onion`, when it publishes one), `contact`, `terms`, `signup { grant, powBits, anonymous }`, `payments [PaymentMethodInfo]`, `peers [node references]`.

Node references can name an onion address (`vs:provider:vk1…@http://….onion`); clients reach it through Tor's SOCKS port with remote name resolution. Since the node is identified by its key, a client may send requests for a node to its `onion` address instead of `url` (it checks the signed info either way).

Providers add `pricing { manifest, perMiB, freeMiBPerDay, creatorShare, upload { mode, perMiB, maxBytes } }`, `services.storage { enabled, openJobs }` and `stats`. Algorithm nodes add `pricing { feed, search, lookup, submission }`, `rewards { vote, voteDailyCap, acceptedSuggestion, requireIdentity, autoAcceptAgreement }`, `ranking { strategy, description }`, `taxonomy.topics` and `stats`.

## 3. Accounts and credits

Every node keeps its own ledger. Credits are integers and only mean something on the node that issued them.

| Request | Body | Response |
|---|---|---|
| `POST /v1/auth/session` | `{ key, ts, sig, pow? }` with `sig` over `"vibeshare-session\n" + nodeId + "\n" + ts` | `{ token, accountId, expiresAt, balance }` |
| `POST /v1/auth/anonymous` | `{ ts, nonce, pow? }` | `{ token, accountId, balance }` — the token *is* the account |
| `GET /v1/account` | — | `{ account, history }` |

`ts` is Unix milliseconds within 10 minutes of the node's clock; each signature and anonymous nonce is accepted once. Session tokens last 24 hours.

**Proof of work.** If `signup.powBits > 0`, opening an account requires `pow` such that SHA-256(`"vibeshare-pow\n" + nodeId + "\n" + subject + "\n" + ts + ":" + pow`) starts with `powBits` zero bits; `subject` is the key id, or `anon:` + nonce. A key session for an account that already exists needs no proof; the node answers `403 pow_required` when one is needed.

Authenticated requests send `Authorization: Bearer <token>`. On `401` a client opens a new session.

### Payments

| Request | Notes |
|---|---|
| `GET /v1/payments` | `{ methods }` |
| `POST /v1/payments/:method/invoices` `{ credits }` | Returns an `Invoice` with `pay { address, amount, currency, uri, checkoutUrl, instructions }` |
| `GET /v1/payments/invoices/:id` | Status: `open`, `paid`, `expired`, `pending-review`, `rejected` |
| `POST /v1/payments/:method/claim` | `voucher`: `{ code }` · `evm`/`bitcoin`/`solana`: `{ invoiceId, txHash }` · `lightning`/`checkout`: `{ invoiceId }` · `manual`: `{ invoiceId, note }` |
| `POST /v1/payments/:method/webhook` | For `checkout` methods: `x-vs-signature: hex HMAC-SHA256(secret, body)` with body `{ eventId, invoice, amount \| credits }`, or Stripe's `Stripe-Signature` for `checkout.session.completed` events |

On-chain invoices ask for an exact amount: the price plus a small unique tail, so the transaction identifies the invoice. Each transaction is credited once.

## 4. Content provider

| Request | Auth | Notes |
|---|---|---|
| `HEAD /v1/content/:cid` | — | 200 if the node has the content |
| `GET /v1/content/:cid` | if `pricing.manifest > 0` | The manifest |
| `POST /v1/has` `{ ids }` | — | `{ has: { id: bool } }` |
| `GET /v1/quote/:cid` | optional | `{ size, perMiB, manifest, total, freeBytesLeft, balance }` |
| `GET /v1/chunks/:chunkId?cid=` | if the price is > 0 | Chunk bytes. Headers `x-vs-charged`, `x-vs-balance`. `cid` selects per-content prices and the creator share. |
| `POST /v1/uploads` `{ manifest }` | yes | `{ cid, status, missing: [chunk ids], cost }` |
| `PUT /v1/uploads/:cid/chunks/:chunkId` | yes | Raw chunk bytes (checked against the id) |
| `POST /v1/uploads/:cid/commit` | yes | `{ cid, status: "ready" }`; `409 incomplete` lists missing chunks |
| `GET /v1/catalog?offset&limit` | — | Hosted content with creator-declared metadata (if the operator publishes it) |
| `POST /v1/suggestions` | yes | `ProviderSuggestionRequest` `{ id, kind: source\|duplicate\|missing, sources?: [{ platform, url }], duplicateOf?, note? }` → `{ suggestion, newInfo, credited }` — what the node is missing about a content: links to it on other platforms (one content id can carry several sources), a content id it duplicates (helps dedupe and compression), or absent data. Only new suggestions pay (`rewards.suggestion`, daily capped); the operator reviews them in the dashboard and accepted ones merge into the content record and catalog. |
| `GET /v1/suggestions/mine` | yes | The account's suggestions |

Price of a chunk: `ceil(bytes × perMiB / 1 MiB)`, after the account's free daily allowance. If the content has an uploader account on the node, `floor(price × creatorShare)` is credited to it.

### Storage service

| Request | Notes |
|---|---|
| `GET /v1/services/storage/offers` | `{ offers: [StorageOffer] }` — chunks, bytes, duration, rewards, free slots |
| `POST /v1/services/storage/offers/:jobId/accept` | → `StorageAssignment` (status `downloading`) |
| `GET /v1/services/storage/assignments/:id/chunks/:chunkId` | Free download of an assigned chunk |
| `POST /v1/services/storage/assignments/:id/ready` | Status `active`; the first challenge follows at once and pays the `upfront` reward when passed |
| `GET /v1/services/storage/tasks?wait=25` | Long poll → `{ tasks: [{ id, type, assignmentId, chunkId, nonce?, deadline }] }` |
| `POST /v1/services/storage/tasks/:id` | `retrieve`: the chunk bytes · `challenge` with `nonce`: hex SHA-256 of the nonce string (UTF-8) followed by the chunk bytes · without `nonce`: the chunk bytes |
| `POST /v1/services/storage/assignments/:id/release` | Give the assignment back |
| `GET /v1/services/storage/assignments` | The account's assignments |

Rewards: `perRetrieval` per correct retrieval, `perChallenge` per passed challenge, `completion` at the end of the term when at least `minPassRatio` of challenges passed. A client that has not polled for `offlineGraceSeconds` fails the challenges it misses.

## 5. Search algorithm

| Request | Body / response |
|---|---|
| `POST /v1/feed` | `{ preferences?, cursor?, limit?, seed? }` → `Page<ContentItem>` |
| `POST /v1/search` | `{ query, filters?, sort?: relevance\|new\|top, cursor?, limit? }` → `Page<ContentItem>`. Queries understand `#tag`, `@creator`, `format:x`, `topic:x`. |
| `POST /v1/lookup` | `{ ids }` → `{ items: [LookupResult] }` |
| `GET /v1/content/:id` | `LookupResult` |
| `GET /v1/thumbnails/:key` | JPEG/PNG/WebP |
| `POST /v1/creators/latest` | `{ creators, preferences?, cursor? }` → newest content of those creators |
| `GET /v1/creators/:id`, `GET /v1/creators?q=` | Creator profiles |
| `GET /v1/taxonomy` | Formats, ratings, topics, suggestion kinds, platforms |
| `POST /v1/votes` | `{ id, vote: 1 \| -1 \| 0 }` → `{ likes, dislikes, vote, credited }` |
| `POST /v1/suggestions` | `{ id, kind: tag\|topic\|format\|rating\|creator\|published\|report\|source\|duplicate, value, reason, timestamp?, platform? }` — `source` adds a missing link to the content (a content id can carry several sources), `duplicate` reports it as a duplicate of another id |
| `POST /v1/submissions` | `SubmissionRequest` — a content id **or** a link, title, metadata, `thumbnail` (data: URL ≤ 200 kB), `providers`, and optionally `creatorProof { key, ts, sig }` with `sig` over `"vibeshare-claim\n" + nodeId + "\n" + baseId + "\n" + ts` |
| `POST /v1/reports` | `{ id }` — a content id or link the client played from outside the network → `{ known, credited }`; the node keeps what it did not have and rewards the reporter |
| `POST /v1/claims` | `ClaimRequest` `{ id, source?, metrics: { views, likes, comments, subscribers, upvotes… }, publishedAt? }` → `ClaimResponse` `{ known, newInfo, credited, multiplier, updated }` — the popularity numbers the client saw on the content's platform. Only numbers the node did not have yet pay: `claims.base × multiplier`, where the multiplier sums one weight per enabled metric of the source (configurable per source in the admin page, e.g. `0.001 × views + 0.01 × likes`) times a recency factor that decays exponentially to 1× as the post ages. The multiplier is never below 1, and any metric can be switched off. |
| `GET /v1/suggestions/mine`, `GET /v1/submissions/mine` | Status of the account's contributions |

A `Preferences.languages` list (`["en"]`) keeps content whose declared language is one of them, and content without one whose title could be in one of them — judged leniently by the scripts and letters it uses ([`src/shared/language.ts`](../src/shared/language.ts)).

Answers to requests made with a session token carry `x-vs-balance` (the account's balance on this node after the request) and, when the request was charged, `x-vs-charged`. Clients keep their balance and the node's status from these headers instead of polling.

`LookupResult` is a full `ContentItem` (status `listed`), `{ id, status: "blocked", reason }`, or `{ id, status: "unknown" }` for every id the operator never set.

`ContentItem`: `id` (with fallbacks), `title`, `description`, `format`, `rating`, `topics`, `tags`, `language`, `durationSeconds`, `creator`, `thumbnail` (a `/v1/thumbnails/<key>` path, or an https URL for content found on other platforms), `media { url, type: image|video|audio, width, height }` (a file the platform serves directly), `pageUrl` (the content's page on its platform), `origin` (`operator`, `submission` or `crawler`), `publishedAt`, `stats { likes, dislikes, views?, platformLikes? }` (VibeShare votes on this node; views and likes on the original platform when known), `providers` and `notes` (accepted suggestions as evidence).

A search may also query other platforms (see the operator guide's discovery crawler); what they return is added to the catalog and can be in the same page of results.

`Preferences`: `formats`, `maxRating`, `topics`, `onlyTopics`, `blockedTags`, `blockedCreators`, `creatorKinds`, `languages`. Ratings are ordered `all < 10+ < 13+ < 16+ < 18+ < nsfw`; the node never returns more than its own `policy.maxRating`.

## 6. Admin API

Both node types expose `/v1/admin/*` to the operator with `x-admin-token: <token>` (or `Authorization: Bearer <token>`): status, configuration (`GET`/`PUT /v1/admin/config`, `?replace=1` for the whole document), accounts and credit adjustments, vouchers, invoices; provider content (`GET /v1/admin/content/:cid` for everything known about one content, with its manifest, chunks and client suggestions), prices, storage backends, storage jobs and assignments; algorithm content (with the preview images kept on the node), blocklists, creators, suggestions, submissions and catalog imports, the crawler (`GET /v1/admin/crawler` with each platform API's usage) and sources (`GET /v1/admin/sources`: every source with its priority, whether it is blocked and its listed/pending counts). The claim credit multipliers are configured per content source (`config.claims`, one weight per metric plus the recency decay). The `/admin` page of each node is a GUI for all of it.

## 7. Client daemon (local API)

The client node serves its GUI and a local API on `127.0.0.1:7700`. The API requires the per-run token found in the page (`<meta name="vs-token">`, header `x-vs-token`) and refuses foreign `Host` headers (DNS rebinding). Streams are served at `/stream/<content id>` with `Range` support; untrusted content is served with a sandboxing Content-Security-Policy. The routes are defined once in [`src/client/api.ts`](../src/client/api.ts) on top of the client core ([`src/client/core.ts`](../src/client/core.ts)); the daemon ([`src/client/daemon.ts`](../src/client/daemon.ts)) adds uploads to disk, proxied thumbnails, the storage service, Tor routing (`POST /api/tor/check`) and `GET /api/events`: Server-Sent Events (`event: nodes`, the node list) whenever a node's status or balance changes, so the GUI shows credits live without asking any node.

The web client ([distribution/](../distribution)) answers the same routes in the browser: a service worker serves `api/…` and `stream/…` relative to where the site is hosted, keeps its data in IndexedDB and loads thumbnails straight from the algorithm nodes; node changes reach open tabs as `{ type: "vs-nodes", nodes }` messages from the worker. Shared links have the form `<web client>/#/watch/<content id>`, optionally with `?p=<provider reference>` naming a provider that hosts the content.

Beyond browsing, publishing and votes, the local API covers reporting platform stats (`POST /api/claim`), suggestions of missing data to provider nodes (`POST /api/suggest/provider`) and to algorithm nodes (`POST /api/suggest`, including `source` and `duplicate`), and profiles (`GET`/`POST /api/profiles`, `PATCH`/`DELETE /api/profiles/:id`, `POST /api/profiles/:id/switch`): several users of one client, each with their own nodes, settings, history and client id, either public or protected with a username and password.
