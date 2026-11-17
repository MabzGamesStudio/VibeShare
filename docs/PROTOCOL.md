# VibeShare protocol (v1)

Every node speaks HTTP + JSON. Clients and nodes can be written in any language; this document is the contract. Types are in [`src/shared/protocol.ts`](../src/shared/protocol.ts) (a barrel re-exporting the wire types split by domain under [`src/shared/protocol/`](../src/shared/protocol)).

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

Common fields: `v`, `protocol { min, max }` and `features` (see [§8](#8-versioning-and-deprecation) and [§10](#10-capabilities-the-features-map)), `type`, `id`, `name`, `description`, `software`, `time`, `url`, `onion` (the node's Tor onion address, `http://….onion`, when it publishes one), `contact`, `terms`, `signup { grant, powBits, anonymous }`, `payments [PaymentMethodInfo]`, `peers [node references]`, `tracing` (deprecated in favour of `features.tracing` — read `features` first, fall back here).

Node references can name an onion address (`vs:provider:vk1…@http://….onion`); clients reach it through Tor's SOCKS port with remote name resolution. Since the node is identified by its key, a client may send requests for a node to its `onion` address instead of `url` (it checks the signed info either way).

Providers add `pricing { manifest, perMiB, freeMiBPerDay, creatorShare, upload { mode, perMiB, maxBytes } }`, `services.storage { enabled, openJobs }` (deprecated in favour of the `features['storage-*']` keys) and `stats`. Algorithm nodes add `pricing { feed, search, lookup, submission }`, `rewards { vote, voteDailyCap, acceptedSuggestion, requireIdentity, autoAcceptAgreement }`, `ranking { strategy, description }`, `taxonomy.topics` and `stats`, plus the deprecated-in-favour-of-`features` optional fields `discovery`, `bloom` and `maxCreatorAccounts`.

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
| `GET /v1/payments/invoices/:id/receipt` | The node's **signed receipt** (`PaymentReceipt`): the payment request it issued, the payer's transfer proof, the credits granted/owed, `status` and `sig` over `receiptSigningPayload(receipt)` — clients verify it with the node id as the public key and keep it locally |
| `POST /v1/payments/:method/claim` | `voucher`: `{ code }` · `evm`/`bitcoin`/`solana`/`monero`: `{ invoiceId, txHash }` · `lightning`: `{ invoiceId }` (LNbits) or `{ invoiceId, paymentHash }` (address mode) · `checkout`: `{ invoiceId }` · `manual`: `{ invoiceId, note }` |
| `POST /v1/payments/:method/webhook` | For `checkout` methods: `x-vs-signature: hex HMAC-SHA256(secret, body)` with body `{ eventId, invoice, amount \| credits }`, or Stripe's `Stripe-Signature` for `checkout.session.completed` events |

On-chain invoices ask for an exact amount: the price plus a small unique tail, so the transaction identifies the invoice. Each transaction is credited once. `PaymentMethodInfo` carries `needsProof` (the payer must send a transaction id or payment hash) and `review` (the operator confirms the transfer by hand — Monero, a Lightning address, `manual`), so a client knows what to ask for before paying. Payment methods only ever hold public addresses: nodes reject configurations carrying a seed phrase, private key or view key.

### Moderation exchange (every node)

| Request | Auth | Notes |
|---|---|---|
| `GET /v1/peers/moderation` | peer | The moderation entries this node holds (bans, temporary bans, rate limits) |
| `POST /v1/peers/moderation` | peer | `{ entries }` — another node's entries to merge in, so one operator's ban reaches the network |

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
| `POST /v1/peers/has` `{ ids }` | peer | `{ has: { id: bool } }` — which content bytes (by their hash) this node holds |
| `GET /v1/peers/chunks/:chunkId` | peer | The bytes of a chunk, for a peer set to receive them here (free) |
| `PUT /v1/peers/chunks/:chunkId` | peer | The bytes of a chunk a peer sends here (checked against their hash; kept per replication) |
| `PUT /v1/peers/manifests/:cid` | peer | A manifest (with its chunk ids) a peer sends here for content it is pushing; the chunks follow on `PUT /v1/peers/chunks/:chunkId` |
| `POST /v1/content-urls` | yes | `ContentUrlSubmission` `{ cid?, url?, baseUrl? }` — a URL (or base URL where `<baseUrl>/<cid>` serves any cid) where the client hosts a copy of the content. Kept for the operator unless `contentUrls.autoAccept`; accepted URLs are pulled from and pay the client per verified download |
| `GET /v1/content-urls/mine` | yes | `{ items }` — this account's submitted URLs and their status |
| `POST /v1/content-urls/fetch` | yes | `{ cid }` — pull a content copy now from the accepted URLs: `{ fetched, downloaded }` |
| `GET /v1/downloads/:cid` | — | The downloaded copy of a content (raw bytes, when this node fetched one) |
| `GET /v1/content/:cid/tier` | — | `{ tier }` — the content's storage tier state and lifecycle (or the upgrade menu for unassigned content) |
| `POST /v1/content/:cid/tier` | yes | `{ tier?, extendDays? }` — spend credits to assign a tier or extend the lifecycle; returns the new tier state |
| `PUT /v1/vvsh/objects/:hash` | yes | Raw bytes of one `.vvsh` object (tree record or payload), stored under its hash |
| `GET /v1/vvsh/objects/:hash` | optional | The bytes of one `.vvsh` object. Unauthenticated reads are free (direct URL opens); authenticated reads are charged per MiB (`x-vs-charged`, `x-vs-balance`) |
| `GET /v1/vvsh/stream/:spec` | optional | A `.vvsh` stream as byte ranges (`Range` header; answers capped at 2 MiB per response). `spec` is base64url JSON naming the tree root, chunk map and renditions — only the chunks the asked-for bytes fall in are read and charged |
| `POST /v1/vvsh/quote` | — | `{ bytes?, totalSeconds?, config? }` → `{ quote }` — price of a `.vvsh` conversion on this node |
| `POST /v1/vvsh/convert` | yes | Start a conversion job (metadata + config, charged by the quote): `{ jobId, … }` |
| `PUT /v1/vvsh/convert/:jobId/piece` | yes | Upload one piece of the source video (chunked, so long ones never land in one buffer) |
| `POST /v1/vvsh/convert/:jobId/finish` | yes | No more pieces: the conversion runs |
| `GET /v1/vvsh/convert/:jobId` | yes | The job's state: progress, warnings, the finished manifest |
| `PUT /v1/vvsh/manifest` | yes | Commit the signed manifest of a converted stream: `{ cid }` |
| `GET /v1/dev/host`, `PUT /v1/dev/host/:cid`, `GET /v1/dev/host/:cid`, `GET /v1/dev/host/base/:cid` | varies | **Developer builds only** (never registered in packaged releases): a static data host for testing the URL flows locally; `base/:cid` mirrors the `<base>/<cid>` shape clients offer |

Peering: a provider lists other providers as peers (`config.peering.peers`, each with `send` and `receive`), fetches chunks it is missing from them when nothing local has them, and pushes whole contents to them from the dashboard (or pulls a content's missing chunks from them).

Price of a chunk: `ceil(bytes × perMiB / 1 MiB)`, after the account's free daily allowance. If the content has an uploader account on the node, `floor(price × creatorShare)` is credited to it.

### Storage service

| Request | Notes |
|---|---|
| `GET /v1/services/storage/offers` | `{ offers: [StorageOffer] }` — chunks, bytes, duration, rewards, free slots |
| `POST /v1/services/storage/offers/:jobId/accept` | → `StorageAssignment` (status `downloading`); the `upfront` reward is paid when the assignment is accepted and the endpoint the client submitted answers |
| `GET /v1/services/storage/assignments/:id/chunks/:chunkId` | Free download of an assigned chunk |
| `POST /v1/services/storage/assignments/:id/ready` | Status `active` — the client holds the data now |
| `GET /v1/services/storage/tasks?wait=25` | Long poll → `{ tasks: [{ id, type: "retrieve", assignmentId, chunkId, deadline }] }` |
| `POST /v1/services/storage/tasks/:id` | The chunk bytes, for a `retrieve` task → `{ credited, balance }` |
| `POST /v1/services/storage/assignments/:id/release` | Give the assignment back |
| `GET /v1/services/storage/assignments` | The account's assignments (with the URL backups the account offers for each job's content) |

Rewards: `upfront` on acceptance (when the client's endpoint is live),
`perRetrieval` per served retrieval, `completion` at the end of the term while
the client still holds the data. The provider re-tests each client's endpoint
every `retrievalIntervalSeconds` (and on demand from the dashboard); a client
whose endpoint fails the checks is **removed** from the job (assignment status
`removed`) and the job **reopens** for another client (visible as the job's
`reopened` count). Assignment statuses: `downloading`, `active`, `completed`,
`failed`, `released`, `removed`.

## 5. Search algorithm

| Request | Body / response |
|---|---|
| `POST /v1/feed` | `{ preferences?, cursor?, limit?, seed? }` → `Page<ContentItem>` |
| `POST /v1/search` | `{ query, filters?, sort?: relevance\|new\|top, cursor?, limit? }` → `Page<ContentItem>`. Queries understand `#tag`, `@creator`, `format:x`, `topic:x`. |
| `POST /v1/lookup` | `{ ids }` → `{ items: [LookupResult] }` |
| `GET /v1/content/:id` | `LookupResult` |
| `GET /v1/thumbnails/:key` | JPEG/PNG/WebP |
| `POST /v1/creators/latest` | `{ creators, preferences?, cursor? }` → newest content of those creators |
| `GET /v1/creators/:id`, `GET /v1/creators?q=&kind=` | Creator profiles; `kind=group` lists only groups (a group is a creator of kind `group`, so its id works everywhere a creator id does) |
| `GET /v1/groups/:id` | `{ group, members, items }` — a group with its member creators (resolved, for the carousel) and the content of every member together, newest first |
| `POST /v1/groups/:id/suggestion` | `GroupSuggestionRequest` `{ add?, remove?, name?, description?, links?, icon?, reason? }` → `GroupSuggestionResponse`. Kept for the operator, who accepts it (applying everything at once and paying `rewards.acceptedSuggestion`) or deletes it. |
| `GET /v1/group-suggestions/mine` | The group changes this account asked for, with their status |
| `GET /v1/topics?q=` | `{ topics }` — topics matching a name or an id, with how much listed content carries each |
| `GET /v1/topics/:id` | `{ topic, items }` — a topic and every listed content filed under that exact topic id |
| `POST /v1/topics` | `TopicCreateRequest` `{ name, description? }` → `TopicCreateResponse` — a client bringing a topic; the id is the hash of the name (`tp1…`, never the name), the same name always lands on the same topic, and nothing is paid |
| `POST /v1/topics/:id/suggestion` | `TopicSuggestionRequest` `{ description?, icon?, reason? }` → `TopicSuggestionResponse`, kept for the operator like a group suggestion |
| `GET /v1/topic-suggestions/mine` | The topic descriptions and icons this account suggested, with their status |
| `GET /v1/taxonomy` | Formats, ratings, topics, suggestion kinds, platforms |
| `POST /v1/votes` | `{ id, vote: 1 \| -1 \| 0 }` → `{ likes, dislikes, vote, credited }` |
| `POST /v1/suggestions` | `{ id, kind: tag\|topic\|format\|rating\|creator\|published\|report\|source\|duplicate, value, reason, timestamp?, platform? }` — `source` adds a missing link to the content (a content id can carry several sources), `duplicate` reports it as a duplicate of another id |
| `POST /v1/submissions` | `SubmissionRequest` — a content id **or** a link, title, metadata, `thumbnail` (data: URL ≤ 200 kB), `providers`, and optionally `creatorProof { key, ts, sig }` with `sig` over `"vibeshare-claim\n" + nodeId + "\n" + baseId + "\n" + ts` |
| `POST /v1/reports` | `{ id }` — a content id or link the client played from outside the network → `{ known, credited }`; the node keeps what it did not have and rewards the reporter |
| `POST /v1/claims` | `ClaimRequest` `{ id, source?, metrics: { views, likes, comments, subscribers, upvotes… }, publishedAt? }` → `ClaimResponse` `{ known, newInfo, credited, multiplier, updated }` — the popularity numbers the client saw on the content's platform. Only numbers the node did not have yet pay: `claims.base × multiplier`, where the multiplier sums one weight per enabled metric of the source (configurable per source in the admin page, e.g. `0.001 × views + 0.01 × likes`) times a recency factor that decays exponentially to 1× as the post ages. The multiplier is never below 1, and any metric can be switched off. |
| `GET /v1/suggestions/mine`, `GET /v1/submissions/mine` | Status of the account's contributions |
| `POST /v1/peers/metadata` | peer | `{ id? , link? }` → `{ entry: PeerEntry \| null }` — the metadata of one content by its cid **or** by its link (pending and crawler finds included) |
| `POST /v1/peers/discover` | peer | `{ criteria: PeerDiscoverCriteria }` → `{ items: [PeerEntry] }` — new cids and links matching the criteria: `platform`, `has: any\|cid\|link\|both` (only ids, only links, or only content carrying both), `metrics: [{ key, min?, max? }]` (by the platform numbers the node kept), `filters` (formats, rating ceiling, topics, tags) and `algorithm: new\|popular\|random` — whether the peer answers with its newest, its most popular by platform numbers, or a random mix. |
| `GET /v1/peers/peers` | peer | `{ self, peers }` — this node's own reference and the peers it knows, so two nodes can learn each other's peers (bootstrap) |
| `POST /v1/peers/import` | peer | One bounded batch of a catalog push (`{ entries, topics, creators, groups, comments }`) → per-category `PeerImportReport` `{ accepted, skipped }`; bad items are skipped, never fatal |
| `GET /v1/comments/:id` | — | The comment chain of a content (headers plus the blocks the storage setting allows the client to see) |
| `POST /v1/comments/:id` | yes | `CommentPostRequest` — add a comment or reply; the account pays per comment (rate limited per hour) |
| `POST /v1/comments/:id/:comment/vote` | yes | `{ vote: 1 \| -1 \| 0 }` on one comment |
| `POST /v1/comments/:id/:comment/remove` | yes | Remove the account's own comment |
| `GET /v1/bloom` | — | The node's seen-content bloom-filter state (sizes, scopes) |
| `PUT /v1/bloom` | yes | Submit the client's seen-content filter bytes for the node to keep (`bloom.storage` tiers price this) |
| `DELETE /v1/bloom` | yes | Drop the account's kept filter |
| `GET /v1/account-filter` | — | The account's own long-term filter kept here (bits, expected items, hashes) |
| `PUT /v1/account-filter` | yes | Submit/refresh the account's long-term filter |
| `DELETE /v1/account-filter` | yes | Drop it |
| `PUT /v1/creators/accounts` | yes | Link external platform accounts to the creator's identity (`AccountLinkProposal`, signed with the creator key) |
| `GET /v1/account-links/mine` | yes | The account links this account proposed, with their review status |
| `POST /v1/creators/:id/suggestions` | yes | Propose a name, description, links or image change for a creator (kept as a `CreatorContentSuggestion` for review) |
| `GET /v1/creator-suggestions/mine` | yes | This account's creator suggestions and their status |
| `POST /v1/creators/:id/icon-suggestion` | yes | Propose a new creator icon (`CreatorIconSuggestion`) |
| `GET /v1/creator-icons/mine` | yes | This account's icon suggestions and their status |
| `GET /v1/votes/:id` | optional | `{ likes, dislikes, vote }` — the vote counts and this account's own vote |

Algorithm nodes list other nodes as peers (`config.peering.peers`, each with `fetch` and `serve`) and ask them for metadata or discoveries from the dashboard; finds come back as `PeerEntry` and can be adopted into the catalog as pending (origin `peer`).

### Peering vocabulary and handshake

The two node kinds named the same two directions differently — providers say `send`/`receive`,
algorithm nodes say `fetch`/`serve` — so the shared vocabulary lives in
[`src/shared/peering.ts`](../src/shared/peering.ts) as a neutral `PeerLink`:

| `PeerLink` field | Provider config | Algorithm config | Meaning |
|---|---|---|---|
| `outgoing` | `send` | `fetch` | this node may start exchanges with the peer |
| `incoming` | `receive` | `serve` | the peer may start exchanges with this node |
| `carries` | `"bytes"` | `"metadata"` | what travels (chunks vs. metadata/discoveries) |

Both admin peer endpoints (`GET /v1/admin/peers` on each node kind) return the configured
`peers` as before **and** a `links` array of `PeerLink` objects for the same relationships,
so an admin UI or a fork reads one shape for every node kind. The config shape itself is
unchanged (additive on both sides).

**Handshake.** A peer identifies itself with its node reference
(`vs:<type>:<key-id>@<url>`) over an ordinary authenticated session: it signs the login
challenge with its key, and the receiving node checks that key against its configured peer
list. The directions above then decide which calls that session may make — an `incoming`
link may push chunks / import a catalog, an `outgoing` link may be asked for chunks /
metadata. A node whose key is not in the peer list is refused, whatever its URL says; the
key pin in the reference is what makes a hijacked domain unable to impersonate the peer.

A `Preferences.languages` list (`["en"]`) keeps content whose declared language is one of them, and content without one whose title could be in one of them — judged leniently by the scripts and letters it uses ([`src/shared/language.ts`](../src/shared/language.ts)).

Answers to requests made with a session token carry `x-vs-balance` (the account's balance on this node after the request) and, when the request was charged, `x-vs-charged`. Clients keep their balance and the node's status from these headers instead of polling.

`LookupResult` is a full `ContentItem` (status `listed`), `{ id, status: "blocked", reason }`, or `{ id, status: "unknown" }` for every id the operator never set.

`ContentItem`: `id` (with fallbacks), `title`, `description`, `format`, `rating`, `topics`, `topicIds` (the topic records the content is filed under — each an exact topic id the node stores, filled from the topic names), `tags`, `language`, `durationSeconds`, `creator`, `groups` (the groups its creator is a member of), `thumbnail` (a `/v1/thumbnails/<key>` path, or an https URL for content found on other platforms), `media { url, type: image|video|audio, width, height }` (a file the platform serves directly), `pageUrl` (the content's page on its platform), `origin` (`operator`, `submission` or `crawler`), `publishedAt`, `stats { likes, dislikes, views?, platformLikes? }` (VibeShare votes on this node; views and likes on the original platform when known), `providers` and `notes` (accepted suggestions as evidence).

A search may also query other platforms (see the operator guide's discovery crawler); what they return is added to the catalog and can be in the same page of results.

`Preferences`: `formats`, `maxRating`, `topics`, `onlyTopics`, `blockedTopics`, `blockedTags`, `blockedCreators`, `creatorIds`, `onlyCreators`, `creatorKinds`, `languages`. Topics match by name or by topic id; blacklisting a group hides everyone in it, and whitelisting one (`creatorIds` with `onlyCreators`) keeps exactly its members. Ratings are ordered `all < 10+ < 13+ < 16+ < 18+ < nsfw`; the node never returns more than its own `policy.maxRating`.

## 6. Admin API

Both node types expose `/v1/admin/*` to the operator, authenticated with `x-admin-token: <token>` (or `Authorization: Bearer <token>`). These tables list every admin route a node serves; the `/admin` page of each node is a GUI for all of it.

### Every node (`BaseNode`, plus the payments and tracing modules)

| Method | Path | Request → Response |
|---|---|---|
| GET | `/v1/admin/status` | → `{ reference, info, accounts, credits, … }` — the dashboard overview |
| GET | `/v1/admin/config` | → the whole configuration document |
| PUT | `/v1/admin/config` | config patch → the saved document. `?replace=1` takes the body as the whole document (missing keys fall back to defaults) |
| GET | `/v1/admin/accounts?q=` | → `{ accounts }` (balances, notes, last seen) |
| GET | `/v1/admin/accounts/:id` | → `{ account, history }` |
| POST | `/v1/admin/accounts/:id/adjust` | `{ amount, reason? }` — credit/debit by hand → `{ account }` |
| POST | `/v1/admin/accounts/:id/note` | `{ note }` |
| GET | `/v1/admin/moderation` | → `{ entries }` — bans, temporary bans, rate limits |
| POST | `/v1/admin/moderation` | `{ subject, action: permaban\|tempban\|ratelimit, until?, reason? }` → `{ entry }` |
| DELETE | `/v1/admin/moderation/:id` | → `{ removed }` |
| POST | `/v1/admin/moderation/sync` | → `{ peers, accepted }` — exchange entries with every configured peer |
| GET | `/v1/admin/invoices` | → `{ invoices }` — payment invoices awaiting review |
| POST | `/v1/admin/invoices/:id/approve` | Grant the credits of a `manual`/review invoice |
| POST | `/v1/admin/invoices/:id/reject` | → `{ invoice }` |
| POST | `/v1/admin/vouchers` | `{ credits, count? }` → `{ codes }` — generate voucher codes |
| GET | `/v1/admin/vouchers` | → `{ vouchers }` (codes stored hashed) |
| GET | `/v1/admin/tracing/settings` | → `{ settings }` — the local trace log's settings |
| PUT | `/v1/admin/tracing/settings` | `Partial<TraceSettings>` (nested `levels` merged) → `{ settings }` |
| GET | `/v1/admin/tracing/events?query=&from=&to=&levels=&traceId=&limit=&offset=` | → `{ events, total }` |
| GET | `/v1/admin/tracing/timelines?…` | → `{ timelines, total }` (same filters) |
| DELETE | `/v1/admin/tracing/events` | → `{ cleared }` |

### Content provider

| Method | Path | Request → Response |
|---|---|---|
| GET | `/v1/admin/content?q=&offset=&limit=` | → the hosted content list |
| GET | `/v1/admin/content/:cid` | → everything about one content: manifest, chunks and the backends holding them, downloads, credits, client suggestions |
| DELETE | `/v1/admin/content/:cid` | Remove the content and its index entry |
| POST | `/v1/admin/content/import` | Import content from a file or URL on the server |
| POST | `/v1/admin/content/upload` | Upload content straight from the dashboard |
| POST | `/v1/admin/content/:cid/price` | Per-content price override |
| POST | `/v1/admin/content/:cid/verify` | Re-check the stored chunks against their hashes |
| POST | `/v1/admin/content/:cid/details` | Update the content's metadata |
| GET | `/v1/admin/suggestions` | → client suggestions awaiting review (links, duplicates, missing data) |
| POST | `/v1/admin/suggestions/:id/:action` | `accept` (merges into the record and pays the account) or `reject` |
| GET | `/v1/admin/content-urls` | → `{ items, config }` — client-submitted content URLs |
| POST | `/v1/admin/content-urls/:id` | `{ status: accepted\|rejected }` → `{ record }` |
| GET | `/v1/admin/peers` | → `{ peers, … }` — the peering configuration |
| PUT | `/v1/admin/peers` | Set the peer list (`{ peers: [{ ref, send, receive }] }`) |
| POST | `/v1/admin/peers/push` | Push one bounded batch of content to one peer (cursor-driven, resumable) |
| POST | `/v1/admin/peers/push-item` | Push one content |
| POST | `/v1/admin/peers/fetch` | Pull a content's missing chunks from the peers |
| POST | `/v1/admin/peers/sync` | Run one automatic content-sync round now |
| POST | `/v1/admin/peers/sync/config` | Configure the automatic content sync |
| GET | `/v1/admin/storage/backends` | → the configured backends, their state and check results |
| GET | `/v1/admin/storage/jobs` | → the storage-service jobs |
| POST | `/v1/admin/storage/jobs` | Open a job (content, copies, duration, rewards) |
| POST | `/v1/admin/storage/jobs/:id` | Update a job |
| POST | `/v1/admin/storage/jobs/:id/close` | Stop hiring holders |
| DELETE | `/v1/admin/storage/jobs/:id` | Delete the job |
| POST | `/v1/admin/storage/jobs/:id/test` | Test every holder's endpoint now |
| GET | `/v1/admin/storage/assignments` | → all assignments across jobs (holders, statuses, earnings) |
| GET | `/v1/admin/tiers` | → the storage tiers and their per-tier content/byte counts |
| POST | `/v1/admin/tiers/assign-unassigned` | `{ tier }` → `{ assigned }` — assign every unassigned content to one tier |
| POST | `/v1/admin/tiers/:cid` | Assign one content to a tier |
| DELETE | `/v1/admin/tiers/:cid` | Remove a content's tier assignment |

### Search algorithm node

| Method | Path | Request → Response |
|---|---|---|
| GET | `/v1/admin/content?q=&status=&offset=` | → the catalog with the preview images kept on the node |
| PUT | `/v1/admin/content` | Update metadata of one or more entries |
| POST | `/v1/admin/content/:id/block` | Blocklist an id (with a reason) |
| POST | `/v1/admin/blocklist` | Blocklist a batch of ids |
| DELETE | `/v1/admin/content/:id` | Remove an entry (back to *unknown*) |
| POST | `/v1/admin/content/bulk` | Bulk-update entries |
| GET | `/v1/admin/bloom` | → the seen-content filters kept for accounts (with the storage tiers) |
| DELETE | `/v1/admin/bloom/:account` | Drop one account's kept filter |
| DELETE | `/v1/admin/account-filters/:account` | Drop one account's long-term filter |
| GET | `/v1/admin/comments?q=` | → moderated comment chains |
| GET | `/v1/admin/comments/:id` | One chain in full |
| PUT | `/v1/admin/comments/:id` | Edit a chain's headers |
| DELETE | `/v1/admin/comments/:id` | Delete a chain |
| POST | `/v1/admin/comments/:id/:comment/:action` | Moderate one comment (approve/remove) |
| GET | `/v1/admin/censored/:set` | → the censored or adjacent word set (`set` = the two sets) |
| POST | `/v1/admin/censored/:set` | Add a word |
| PUT | `/v1/admin/censored/:set` | Replace/edit the set |
| DELETE | `/v1/admin/censored/:set/:word` | Remove one word (automatic fuzzy filtering catches close variants) |
| GET | `/v1/admin/creators` | → the creators index |
| PUT | `/v1/admin/creators` | Edit creators |
| GET | `/v1/admin/suggestions` | → metadata suggestions awaiting review |
| POST | `/v1/admin/suggestions/:id/:action` | `accept` or `reject` (accepted ones merge into the entry and pay the account) |
| GET | `/v1/admin/creator-suggestions` | → creator name/description/links/image proposals |
| POST | `/v1/admin/creator-suggestions/:id/:action` | `accept` or `reject` |
| GET | `/v1/admin/creator-icons` | → icon proposals |
| POST | `/v1/admin/creator-icons/:id/:action` | `accept` or `reject` |
| GET | `/v1/admin/account-links` | → external account links proposed without the creator key |
| POST | `/v1/admin/account-links/:id/:action` | `accept` or `reject` |
| GET | `/v1/admin/groups` | → groups and members |
| PUT | `/v1/admin/groups` | Create/edit groups |
| POST | `/v1/admin/groups/:id/members` | Add or remove members |
| GET | `/v1/admin/group-suggestions` | → group change requests awaiting review |
| POST | `/v1/admin/group-suggestions/:id/:action` | `accept` (applies everything and pays) or `reject` |
| GET | `/v1/admin/topics` | → topics |
| PUT | `/v1/admin/topics` | Create/edit topics |
| GET | `/v1/admin/topic-suggestions` | → topic description/icon requests |
| POST | `/v1/admin/topic-suggestions/:id/:action` | `accept` or `reject` |
| GET | `/v1/admin/submissions` | → content submissions awaiting review |
| POST | `/v1/admin/submissions/:id/:action` | `accept`, `reject`, … |
| GET | `/v1/admin/crawler` | → the crawler state: each adapter, its stats and platform API usage |
| POST | `/v1/admin/crawler/run` | Run one crawl round (optionally one adapter) |
| POST | `/v1/admin/crawler/seeds` | Add seed sites for the web crawler |
| GET | `/v1/admin/sources` | → every source with its priority, blocked flag and listed/pending counts |
| POST | `/v1/admin/import` | Import a provider's catalog for review (`{ provider, limit }`) |
| GET | `/v1/admin/peers` | → peers, job and bootstrap configuration |
| PUT | `/v1/admin/peers` | Set the peer list (`{ peers: [{ ref, fetch, serve }] }`) |
| POST | `/v1/admin/peers/search` | Run one peer-discovery round now |
| POST | `/v1/admin/peers/job` | Configure/trigger the peer exchange job |
| POST | `/v1/admin/peers/bootstrap` | Learn peers from the bootstrap nodes |
| POST | `/v1/admin/peers/metadata` | `{ peer?, id?, link?, adopt? }` → `{ results }` — ask peers for one content's metadata |
| POST | `/v1/admin/peers/discover` | `{ peer?, criteria?, adopt? }` → `{ results }` — ask peers for new cids/links |
| POST | `/v1/admin/peers/push` | `{ ref, category, cursor }` — push one bounded batch of this node's catalog to one node (resumable) |

## 7. Client daemon (local API)

The client node serves its GUI and a local API on `127.0.0.1:7700`. The API requires the per-run token found in the page (`<meta name="vs-token">`, header `x-vs-token`) and refuses foreign `Host` headers (DNS rebinding). Streams are served at `/stream/<content id>` with `Range` support; untrusted content is served with a sandboxing Content-Security-Policy. The routes are defined once in [`src/client/api.ts`](../src/client/api.ts) on top of the client core ([`src/client/core.ts`](../src/client/core.ts)); the daemon ([`src/client/daemon.ts`](../src/client/daemon.ts)) adds uploads to disk, proxied thumbnails, the storage service, Tor routing and Server-Sent Events. The web client ([distribution/](../distribution)) answers the same routes in the browser: a service worker serves `api/…` and `stream/…`, keeps its data in IndexedDB and loads thumbnails straight from the algorithm nodes; node changes reach open tabs as `{ type: "vs-nodes", nodes }` messages from the worker. Shared links have the form `<web client>/watch/<content id>`, optionally with `?p=<provider reference>`.

**API version.** Every `/api/*` reply carries an `x-vs-api` header and `GET /api/version` answers `{ version }`, both coming from one shared constant ([`src/shared/api-version.ts`](../src/shared/api-version.ts)) that the daemon, the route table and the web worker import, so the three implementations cannot disagree. The versioning rule: within one version every change is additive — new routes, new optional fields. Anything breaking (a removed or renamed route, a changed payload meaning) bumps the version, and callers see the bump in the header before anything else fails.

### State, nodes, settings

| Method | Path | Request → Response |
|---|---|---|
| GET | `/api/version` | → `{ version }` — the local API's contract version, also stamped on every reply as the `x-vs-api` header |
| GET | `/api/state` | → the client's saved state: settings, nodes, pages, subscriptions, history… |
| PATCH | `/api/settings` | `Partial<Settings>` → the updated settings |
| POST | `/api/nodes` | `{ text }` — add node references/URLs (one per line) → `{ added, errors }` |
| GET | `/api/nodes/export?type=` | → `{ text }` — the node list as shareable references |
| PATCH | `/api/nodes/:id` | Enable/disable, reorder, rename, price limit, account mode |
| DELETE | `/api/nodes/:id` | Remove a node |
| POST | `/api/nodes/order` | `{ ids }` — reorder the node list |
| POST | `/api/nodes/:id/refresh` | Re-fetch a node's info and balance |
| POST | `/api/nodes/refresh` | Refresh all nodes |
| GET | `/api/nodes/:id/account` | → `{ account }` on that node |
| POST | `/api/tor/check` | → whether traffic leaves through Tor (`{ ok, … }`) |
| GET | `/api/probe` | HEAD/GET probe of a URL → `{ ok, status, bytes, type, ms }` (endpoint checks) |
| GET | `/api/events` | Server-Sent Events (`event: nodes`) whenever a node's status or balance changes — why the GUI never polls |
| GET | `/api/cache`, DELETE | Chunk-cache usage and clear |

### Payments and receipts (proxied to a node)

| Method | Path | Request → Response |
|---|---|---|
| GET | `/api/nodes/:id/payments` | → the node's payment methods |
| POST | `/api/nodes/:id/invoices` | `{ method, credits }` → the `Invoice` |
| GET | `/api/nodes/:id/invoices/:invoice` | Invoice status |
| POST | `/api/nodes/:id/claim` | `{ method, invoiceId?, … }` → `{ balance }` — claim the credits |
| GET | `/api/receipts` | → `{ receipts }` — the signed payment receipts kept on this device |
| DELETE | `/api/receipts/:id` | Forget a receipt |

### Browsing, search and content

| Method | Path | Request → Response |
|---|---|---|
| POST | `/api/feed` | `{ preferences?, cursor? }` → `Page<ContentItem>` |
| POST | `/api/search` | `{ query, filters?, sort? }` → `Page<ContentItem>` |
| POST | `/api/browse` | `{ … }` — one page of a configured page's content |
| POST | `/api/lookup` | `{ ids }` → `{ items }` — which ids the algorithm nodes know |
| GET | `/api/content/:id` | The full content view (from every node) |
| GET | `/api/creators/:id`, GET `/api/creators?q=&kind=` | Creator profiles; the search |
| GET | `/api/groups/:id`, GET `/api/topics`, GET `/api/topics/:id` | Groups and topics |
| GET | `/api/comments/:id` | The comment chain of a content |
| GET | `/api/jobs`, GET `/api/jobs/:id` | Publish/conversion jobs and their progress |
| GET | `/api/library` | `{ published, history }` — what this client published and watched |
| GET | `/api/subscriptions`, POST, DELETE `/api/subscriptions/:id` | The subscription list |
| POST | `/api/subscriptions/feed` | The newest content of the subscribed creators |
| GET | `/api/search-history`, DELETE `/api/search-history` | The saved searches |
| GET | `/api/saved`, POST, PATCH `/api/saved/:id`, DELETE `/api/saved/:id` | Saved content ids |
| POST | `/api/cid-collections`, PATCH, DELETE `/api/cid-collections/:id` | Named collections of saved ids |
| GET | `/api/toasts`, POST, DELETE `/api/toasts`, DELETE `/api/toasts/:id` | Toast messages (kept only while the user turns that on) |
| POST | `/api/history`, DELETE `/api/history` | Remember / forget watched content |

### Contributing (votes, suggestions, comments, creators)

| Method | Path | Request → Response |
|---|---|---|
| POST | `/api/vote` | `{ id, vote }` → `{ likes, dislikes, vote, credited }` (to every algorithm node) |
| GET | `/api/vote/:id` | The vote counts and this account's vote |
| POST | `/api/suggest` | Metadata suggestion to algorithm nodes (tags, topics, format, rating, creator, published, source, duplicate…) |
| POST | `/api/suggest/provider` | Suggestion to provider nodes (source links, duplicate ids, missing data) |
| POST | `/api/report` | Report a content id played from outside the network |
| POST | `/api/claim` | `{ id, source, metrics, publishedAt? }` — report platform stats for the claim rewards |
| GET | `/api/contributions` | Everything this account contributed, with its status |
| POST | `/api/comments/:id` | Post a comment |
| POST | `/api/comments/:id/:comment/vote` | Vote on a comment |
| POST | `/api/comments/:id/:comment/remove` | Remove the account's own comment |
| POST | `/api/groups/suggestions`, GET `/api/groups/suggestions/:id` | Propose group changes; their status |
| POST | `/api/topics/suggestions`, GET `/api/topics/suggestions/:id` | Propose topic descriptions/icons; their status |
| POST | `/api/topics` | Bring a topic (id is the hash of its name) |
| PUT | `/api/creators/accounts` | Link external platform accounts to the creator identity |
| GET | `/api/account-links/:id` | The account links proposed to that node |
| POST | `/api/creator-suggestions`, GET `/api/creator-suggestions/:id` | Propose creator changes; their status |
| POST | `/api/creator-icons`, GET `/api/creator-icons/:id` | Propose a creator icon; its status |

### Publishing and hosting

| Method | Path | Request → Response |
|---|---|---|
| POST | `/api/publish` | `PublishRequest` (≤ 2 MiB JSON) — upload to the picked providers and submit to algorithm nodes |
| POST | `/api/publish/preview` | Compute the content id of an upload **before** anything is sent (fills the suggest form) |
| POST | `/api/publish/external` | List content that lives elsewhere |
| POST | `/api/upload/url` | Pull the data behind a URL to publish it the same way |
| POST | `/api/content-link` | Register a hosted URL for a content |
| POST | `/api/upload` | Raw file upload to disk (daemon) |
| POST | `/api/nodes/:id/content-urls`, GET `/api/nodes/:id/content-urls`, POST `/api/nodes/:id/content-urls/fetch` | Offer URLs where the client hosts content copies to a provider; list them; trigger a pull |
| GET | `/api/nodes/:id/tier/:cid`, POST `/api/nodes/:id/tier/:cid` | A content's tier on a provider; buy/extend it |
| GET | `/api/nodes/:id/storage-jobs` | Provider storage jobs relevant to this client (offers, assignments) |

### Seen-content filters (bloom)

| Method | Path | Request → Response |
|---|---|---|
| GET | `/api/bloom` | The filter book's status |
| POST | `/api/bloom/mark` | Mark content as seen |
| POST | `/api/bloom/reset` | Reset a scope |
| GET | `/api/bloom/offers/:id` | Storage offers for the filter on that provider |
| POST | `/api/bloom/storage/:id`, DELETE `/api/bloom/storage/:id` | Buy / drop paid filter storage on a provider |
| GET | `/api/bloom/account/:id`, POST `/api/bloom/account`, POST `/api/bloom/account/:id`, DELETE `/api/bloom/account/:id` | The account's long-term filter on algorithm nodes: state, submit/refresh, drop |

### VVSH composing (client-side conversion)

| Method | Path | Request → Response |
|---|---|---|
| GET | `/api/vvsh/encoder` | → `{ backend: ffmpeg \| mediarecorder, warning? }` |
| POST | `/api/vvsh/quote` | Price of a local conversion |
| POST | `/api/vvsh/session`, PUT `/api/vvsh/session/:id/piece`, GET `/api/vvsh/session/:id`, POST `/api/vvsh/session/:id/finish` | A conversion session: start, upload pieces (or recorded chunks), poll, finish |
| POST | `/api/vvsh/chunk` | Convert one video chunk (recorder pipeline) |
| POST | `/api/vvsh/export` | Export the assembled stream |
| POST | `/api/vvsh/object`, PUT `/api/vvsh/object` | Build/store one `.vvsh` object locally |
| POST | `/api/vvsh/manifest` | Build the signed manifest (the content id) |

### Profiles, identity, storage worker, thumbnails and streams

| Method | Path | Request → Response |
|---|---|---|
| GET | `/api/profiles`, POST `/api/profiles` | List / create profiles (public, protected, hidden) |
| POST | `/api/profiles/unlock` | `{ username, password }` — unlock a hidden profile |
| PATCH | `/api/profiles/:id`, DELETE `/api/profiles/:id`, POST `/api/profiles/:id/switch` | Update / delete / switch profile |
| GET | `/api/identity/export`, POST `/api/identity/import` | The `vibeshare-seed-…` backup and restore |
| GET | `/api/services` | The storage-service worker's status (jobs held, earnings) |
| POST | `/api/services/sync`, `/api/services/verify`, `/api/services/release` | Sync now; verify/release an assignment |
| GET | `/api/thumb/:id/:key` | A proxied thumbnail (daemon; the web client loads them from the algorithm nodes) |
| GET | `/api/dev/info` | `{ dev }` — whether this is a developer build (also gates `/v1/dev/*` and the `dev-host` pages) |
| GET | `/api/nodes/:id/dev-host`, POST `/api/nodes/:id/dev-host` | **Developer builds only** — the provider's static test host: list hosted files; upload one under its cid |
| GET | `/stream/:id` | Content bytes with `Range` support (verified chunk by chunk; sandboxed CSP) |

### Local tracing

| Method | Path | Request → Response |
|---|---|---|
| GET | `/api/tracing/settings` | → `{ settings }` (off by default) |
| PUT | `/api/tracing/settings` | `Partial<TraceSettings>` (nested `levels` merged) → `{ settings }` |
| POST | `/api/tracing/events` | One event from the GUI (a user action), joined to the timeline whose trace id it carries |
| GET | `/api/tracing/events?query=&from=&to=&levels=&traceId=&limit=&offset=` | → `{ events, total }` |
| GET | `/api/tracing/timelines?…` | → `{ timelines, total }` |
| DELETE | `/api/tracing/events` | → `{ cleared }` |

## 8. Versioning and deprecation

**Version numbers.** `PROTOCOL_VERSION` (currently **2**) is the version this build speaks; `NodeInfoBase.v` carries it for readers that predate ranges, and `NodeInfoBase.protocol: { min, max }` is the authoritative range of versions the node speaks (v2+). v1 is frozen: everything documented before v2 — the routes, the fields, their meanings — never changes shape or meaning. A **v2** may only add: new routes, new optional fields, new enum members (which readers must tolerate), and new capability keys. Removing or renaming anything waits for a v3 with a deprecation period behind it.

**Request header.** Clients send `x-vs-protocol: <current>` on every request (a `NodeClient` does this automatically). Servers may use it to serve an older shape; they must not reject requests over it — old clients simply do not send it.

**Compatibility matrix.** Client and node work together when their protocol ranges **overlap**; the effective version is the lower of the two maxima. A node without `protocol` (anything pre-v2) advertises its bare `v`, which every range still covers — so today's nodes and clients keep talking to each other unchanged.

| Node range vs ours | Result |
|---|---|
| Overlap (any shared version) | Works, at `min(node.max, ours.max)` |
| `node.min > our max` (node dropped the versions we speak) | Typed error `protocol_incompatible` (`too-new`): "…update the client to use this node." |
| `node.max < our min` (node predates everything we speak) | Typed error `protocol_incompatible` (`too-old`): "…the node needs updating." |

The failure is a typed error (with the two ranges attached), not a random 400: `NodeClient` throws `ProtocolMismatchError` (a `RemoteError` with `code: "protocol_incompatible"`) when the signed info does not overlap.

**Deprecation policy.** A route or field that will disappear is deprecated, never silently changed:

- Mark it in this document with *deprecated in favour of …* and the fallback rule.
- Serve it with the **`Deprecation`** header (RFC 9745: `Deprecation: @<unix-seconds>`) and, once the removal is scheduled, **`Sunset: <http-date>`** (RFC 8594) plus `Link: <url>; rel="deprecation"` pointing at the story. The helpers in `src/shared/node/deprecation.ts` build these headers.
- Keep serving it for at least one minor software release after `Sunset` is announced. Nothing is removed inside a protocol version; a removal is a version bump.

**How old clients degrade.** They keep sending v1 shapes and reading v1 fields; every v2 addition is optional or ignorable, so an old client on a v2 node loses nothing it had. A v2 client on a v1 node ignores the absent `protocol`/`features` fields and falls back to the classic one-off fields (below). A client that meets an unknown *enum member* treats it as "unknown" rather than failing (an unknown content status reads like `unknown`, an unknown rating is not shown, etc.).

## 9. Unknown fields and extension bags

Normative rule, applying to every JSON object in this protocol:

- **Receivers MUST ignore members they do not know.** No receiver may reject a message, manifest or record because it carries extra members — validators check the members they know and skip the rest.
- **Senders MUST NOT rely on unknown members being kept.** A node may drop what it does not understand while copying or re-encoding metadata, so anything sent in an unknown member can disappear on the next hop.

**The `x` bag.** Where sharing matters, put extensions in the namespaced bag `x?: Record<string, unknown>` — on `ManifestMeta` (manifests) and `ContentItem` (listings). Keys inside `x` should be namespaced by their origin (`"com.example.thing"`) so forks do not collide.

One deliberate exception to "may be dropped": `ManifestMeta.x` is **hashed like any other manifest field** — the content id is the canonical-JSON hash of the whole manifest, so `x` changes the id exactly like `title` does (key order inside `x` does not matter; canonical JSON sorts). Anything that stores or serves a manifest therefore keeps it byte-faithfully or the id no longer matches. Validation accepts any plain object in `x` up to 8 KiB of canonical JSON and ignores every other unknown member.

## 10. Capabilities (the `features` map)

`NodeInfoBase.features?: Record<string, boolean | number | string | string[]>` is the forward-looking, machine-readable surface of a node: what it supports beyond the base protocol. Keys are stable strings; readers **MUST ignore keys they do not know** (forks add their own), and the map is filled from what the node already advertises plus the fixed surfaces of its kind. **Read `features` first; fall back to the classic one-off fields** (`tracing`, `services`, `discovery`, `bloom`, `maxCreatorAccounts`, …) when the key is absent (pre-v2 nodes). Those fields stay in place for interop and are marked deprecated in §2.

| Key | Type | Meaning |
|---|---|---|
| `tracing` | boolean | The node's local trace log is on |
| `comments` | boolean | Comment chains are served (algorithm nodes) |
| `claims` | boolean | Platform-metric claims are accepted (`POST /v1/claims`) |
| `vvsh` | boolean | `.vvsh` objects, streams and conversion are served (provider nodes) |
| `content-urls` | boolean | Client-hosted content URLs are accepted |
| `suggestion-kinds` | string[] | The suggestion kinds `POST /v1/suggestions` takes |
| `storage-service` | boolean | The storage service (paid client storage) is running |
| `storage-open-jobs` | number | Jobs currently hiring holders |
| `upload-max-bytes` | number | Largest upload accepted (the body-size cap of the node) |
| `ranking` | string | The active ranking strategy |
| `topics` | number | How many topics the node offers |
| `discovery` | boolean | The discovery crawler runs |
| `searches-platforms` | boolean | Client searches also query other platforms |
| `discovery-platforms` | string[] | The platforms the crawler knows |
| `bloom` | boolean | Seen-content bloom filters are accepted |
| `bloom-inline-max-bits` / `bloom-account-max-bits` | number | Filter size caps |
| `bloom-tiers` | string[] | The ids of the paid filter-storage tiers |
| `page-limit-feed` / `page-limit-search` / `page-limit-creators` / `page-limit-catalog` | number | The `limit` caps of §11 |

## 11. Pages, cursors and limits

`Page<T> { items, cursor?, total? }` is the paging shape of every collection that can grow.

- **`cursor` is opaque.** Pass it back unchanged to get the next page; when it is absent, the last page was reached. It carries no meaning clients may depend on — today it is a plain offset, tomorrow it may not be.
- **Ordering** is stable within one pagination run: the same cursor sequence walks the same order. Nothing is promised *between* runs — a re-sorted feed is a new run.
- **The catalog may change mid-pagination.** Items added or removed while a client pages can shift what later pages show (an offset cursor cannot do better without server-side snapshots). Resume promptly, de-duplicate by id on the client, and treat `total` (when present) as the size at the time the page was cut, not as a promise.
- **`limit` caps** are per collection and shared as `PAGE_LIMITS` (`pageLimit(collection, requested, fallback?)` clamps into `[1, cap]`, falling back to the node's page size when nothing was asked): `feed`/`search`/`creators` **100**, `catalog`/`lookupIds`/`mine` **200**, admin console lists **500**. A request above the cap gets the cap silently — never an error.

| Collection | Cap | Enforced in |
|---|---|---|
| `POST /v1/feed`, `POST /v1/search` | 100 | the route's `pageLimit` clamp |
| `POST /v1/creators/latest`, `GET /v1/creators` | 100 | same clamp |
| `GET /v1/catalog` (provider) | 200 | the route's clamp |
| `POST /v1/lookup` (`ids`) | 200 | the route's slice |
| `GET /v1/submissions/mine` and friends | 200 | the route's slice |
| Admin console lists | 500 | the admin list clamp |
