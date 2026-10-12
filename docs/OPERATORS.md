# Running provider and algorithm nodes

Both server node types work the same way:

```bash
vibeshare provider  --data /var/lib/vibeshare/provider  --public-url https://cdn.example.org
vibeshare algorithm --data /var/lib/vibeshare/algorithm --public-url https://feed.example.org
```

On first start a node creates in its data directory:

| File | What it is |
|---|---|
| `identity.json` | The node's key. **Back it up**: the reference (and every client's trust in it) depends on it. |
| `admin-token` | Token for the `/admin` dashboard and the admin API (or set `VIBESHARE_ADMIN_TOKEN`). |
| `config.json` | Everything below. Edit it, or use *Settings* in the dashboard (changes apply at once; host and port need a restart). |
| `ledger.json`, `ledger-audit.jsonl` | Accounts, balances, and an append-only log of every credit movement. |
| `payments.json` | Invoices, used transactions, vouchers (stored hashed). |
| provider: `content-index.json`, `uploads.json`, `storage-service.json`, `blobs/` | Content index, pending uploads, storage jobs, local chunks. |
| algorithm: `registry.json`, `contributions.json`, `thumbnails/` | Listed/blocked content and creators, votes/suggestions/submissions, thumbnails. |

`--config <file>` reads the configuration from elsewhere; `--port`, `--host`, `--public-url` and `--name` override it for one run.

**Network.** Put the node behind a reverse proxy with TLS (Caddy, nginx, Traefik) and set `publicUrl` to the address clients use; set `trustProxy: true` so per-IP limits see real addresses. Docker: `docker compose up -d` ([docker-compose.yml](../docker-compose.yml)). systemd: [examples/systemd](../examples/systemd).

## Settings both node types share

```jsonc
{
  "name": "Example CDN",
  "description": "Shown to clients next to the node.",
  "publicUrl": "https://cdn.example.org",
  "contact": "ops@example.org",
  "terms": "https://example.org/terms",
  "host": "0.0.0.0",
  "port": 7701,
  "trustProxy": false,
  "signup": {
    "grant": 500,          // credits for every new account
    "powBits": 0,          // proof of work to open an account (16–20 slows down farming)
    "anonymous": true,     // allow token-only accounts
    "perIpPerHour": 30     // new accounts per address per hour (0 = no limit)
  },
  "peers": ["vs:algorithm:vk1…@https://feed.example.org"],   // recommended to clients
  "payments": [ … ]
}
```

## Payment methods

Each entry has an `id` (unique, used in URLs), a `type`, and optionally `label`, `description`, `enabled`, `minCredits`, `maxCredits`, `invoiceMinutes`. Full examples: [examples/provider.config.json](../examples/provider.config.json).

| Type | Settings | How it is checked |
|---|---|---|
| `voucher` | — | Codes from *Payments → Vouchers* (or `POST /v1/admin/vouchers`). Sell or give them anywhere. |
| `evm` | `network`, `chainId`, `rpcUrl`, `address`, `currency`, `decimals`, `token` (ERC-20 contract, omit for ETH/native), `creditsPerCoin`, `confirmations` | Receipt over JSON-RPC: status, recipient (or ERC-20 `Transfer` log), exact amount, confirmations, block time inside the invoice window. Works on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain… |
| `bitcoin` | `apiUrl` (Esplora: `https://mempool.space/api`, blockstream, or your own), `address`, `creditsPerCoin`, `confirmations` | Output to the address with the exact amount, confirmations |
| `solana` | `rpcUrl`, `address`, `currency`, `mint` (SPL token, omit for SOL), `decimals`, `creditsPerCoin` | Balance change of the address (or its token account) equals the exact amount |
| `lightning` | `lnbitsUrl`, `invoiceKey`, `creditsPerCoin` (per BTC) | Invoice created and checked through LNbits |
| `checkout` | `checkoutUrl` (may contain `{invoice}`, `{account}`, `{credits}`), `secret`, `format: generic \| stripe`, `creditsPerUnit`, `currency` | Signed webhook to `/v1/payments/<id>/webhook`. Stripe: point a webhook for `checkout.session.completed` there and use Payment Links with `?client_reference_id={invoice}`. Generic: HMAC-SHA256 of the body in `x-vs-signature`, body `{ eventId, invoice, amount }` — glue for Ko-fi, Gumroad, BTCPay, Coinbase Commerce, PayPal IPN… |
| `manual` | `instructions` (may contain `{invoice}`) | The payer adds a note; you approve or reject under *Payments → Invoices*. |

On-chain invoices ask for the price plus a small unique tail (≤ 0.1 %, at least 1000 base units), so a transaction identifies its invoice without memos. Every transaction is credited once.

## Content provider

### Pricing

```jsonc
"pricing": {
  "manifest": 0,          // credits per manifest request
  "perMiB": 1,            // credits per MiB of chunks
  "freeMiBPerDay": 100,   // free download allowance per account per day
  "creatorShare": 0.2,    // share of download credits paid to the uploader's account here
  "upload": { "mode": "open", "perMiB": 0, "maxBytes": 4294967296 },   // open | paid | closed
  "overrides": { "vs1…": 0 }   // per-content price per MiB (Content → Price in the dashboard)
}
```

### Storage backends

Chunks are written to `replication` writable backends (in priority order, lower first) and read from wherever they are, falling back through every backend and finally to client nodes of the storage service. Every chunk read is checked against its hash, so backends need not be trusted.

```jsonc
"storage": {
  "replication": 2,
  "cacheMiB": 128,        // hot chunks in memory
  "cacheFetched": true,   // copy chunks read from read-only backends or clients into writable ones
  "usePeers": true,       // ask client storage for chunks no backend has
  "backends": [ … ]
}
```

| Type | Settings | Works with |
|---|---|---|
| `local` | `path` (relative to the data directory) | Any disk or mounted volume (NFS, SMB, `rclone mount`…) |
| `s3` | `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey`, `prefix`, `pathStyle` (default true) | AWS S3, Cloudflare R2 (`region: "auto"`), Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Storj, Filebase (S3 on IPFS) |
| `webdav` | `url`, `username`, `password` | Nextcloud, ownCloud, Box, pCloud, Koofr, `rclone serve webdav` (and so Google Drive, Dropbox, OneDrive…) |
| `ipfs` | `apiUrl` (Kubo RPC), `gatewayUrl`, `authorization` | Your Kubo node, with its pinning and remote pinning services |
| `http` | `baseUrl`, `headers` | Read-only: any static host or CDN serving `<baseUrl>/<chunk id>` |
| `provider` | `ref` | Read-only: another VibeShare provider. Your node pays it from its own account there and can resell or cache its content (a pull-through mirror). |
| `memory` | — | Testing |

All backends take `id`, `priority` (default 10) and `write: false` to make them read-only. A provider pointed at a bucket another provider writes to can serve that content too: it adopts manifests from the backends on first request.

### Storage service: paying clients to store data

Client nodes that turn on *Earn → Store data for providers* accept your **jobs**, download the chunks, and keep a long poll open through which you send **tasks**. You choose what to store, for how long, and what it pays:

```jsonc
"storageService": {
  "enabled": true,
  "challengeIntervalSeconds": 900,   // proof-of-storage challenge per assignment
  "minPassRatio": 0.8,               // challenges to pass for the completion reward
  "offlineGraceSeconds": 120,        // missed polls after this count as failed challenges
  "taskTimeoutSeconds": 30,
  "auto": {                          // a job for every new upload
    "enabled": false,
    "replicas": 2,
    "durationDays": 30,
    "rewards": { "upfront": 5, "perRetrieval": 1, "perChallenge": 1, "completion": 20 },
    "requireIdentity": false         // only key-based accounts may take the job
  }
}
```

Create jobs for particular content from *Content → Storage job* (copies, days, rewards). Challenges ask for `sha256(nonce ‖ chunk)` when the provider has its own copy, or for the chunk itself when it does not. When your backends miss a chunk, the provider asks online holders for it and pays `perRetrieval`.

## Search algorithm node

### What it shows

- **Catalog** — content ids you set are `listed` (whitelist) or `blocked` (blacklist) with a reason; every other id is `unknown` to clients. Edit title, description, format, age rating, topics, tags, language and creator. *Forget* returns an id to unknown.
- **Creators** — people, companies and groups. Creators whose id is a key (`vk1…`) are proven by manifest signatures or a `creatorProof` on submission. Blocking a creator hides all their content.
- **Review** — submissions from creators (with thumbnail and the creator's metadata; you can edit before listing) and suggestions from users (tags, topics, format, rating, reports — each with reasons and timestamps). Accepted suggestions are kept as evidence clients can see.
- **Import** — queue everything a provider's catalog lists for review.

### Policy, pricing and rewards

```jsonc
"pricing": { "feed": 0, "search": 0, "lookup": 0, "submission": 0 },   // credits per request
"rewards": {
  "vote": 1, "voteDailyCap": 50,      // first vote on each item, up to N rewarded votes a day
  "acceptedSuggestion": 10,            // to everyone who made an accepted suggestion
  "requireIdentity": false,            // only key-based accounts earn
  "autoAcceptAgreement": 3             // accept when N accounts suggest the same (0 = by hand)
},
"policy": {
  "maxRating": "nsfw",                 // never serve above this (e.g. "13+" for a family node)
  "defaultMaxRating": "18+",           // when the client sends no preference
  "autoListSubmissions": false         // list submissions without review
},
"topics": ["science", "learning", …],
"pageSize": 24
```

### Ranking

```jsonc
"ranking": {
  "strategy": "balanced",        // balanced | hot | new | top | random | custom
  "weights": { "quality": 1, "recency": 1, "preference": 1.5, "discovery": 0.3 },
  "halfLifeHours": 72,           // freshness halves every N hours
  "gravity": 1.5,                // how fast "hot" items sink
  "module": "/etc/vibeshare/ranker.mjs",   // for "custom"
  "description": "Shown to clients."
}
```

- `balanced`: weighted sum of approval (smoothed likes ratio), freshness, match with the viewer's favourite topics and a seeded random term for discovery (stable across pages).
- `hot`: votes over age, Hacker-News style. `new`: newest first. `top`: Wilson lower bound of approval. `random`: seeded shuffle.
- `custom`: an ES module whose default export receives the entries that passed the viewer's filters and returns them sorted, or `{ [id]: score }`. It may be async — call your own recommendation service. See [examples/ranking/ranker.mjs](../examples/ranking/ranker.mjs).

### Discovery (crawler)

The crawler fills the catalog with content from other platforms. It is on by default; the *Crawler* tab of the dashboard shows each adapter's runs, finds and errors, the hosts it talked to and what their `robots.txt` blocked, and lets you pause it, run an adapter now, add seed sites and edit the discovery queries.

```jsonc
"crawler": {
  "enabled": true,
  "userAgent": "VibeShareBot/0.1 (+https://github.com/MabzGamesStudio/VibeShare)",  // matched against robots.txt groups
  "concurrency": 2,              // adapters working at once
  "pauseMs": 4000,               // between two units of work
  "hostDelayMs": 2000,           // between two requests to one host (more when its robots.txt asks for a Crawl-delay)
  "timeoutMs": 15000,
  "maxEntries": 20000,           // discoveries kept; the oldest unvoted ones are pruned first
  "autoList": true,              // list finds right away, or keep them "pending" in Review
  "defaultRating": "13+",        // for finds whose platform does not flag adult content
  "queries": ["science", "music", "nature", …],   // searched on platforms that have search
  "learnFromSearches": true,     // client searches become queries too
  "searchPlatforms": true,       // also search the platforms when a client searches (first page only)
  "searchTimeoutMs": 3000,       // how long a client search waits for them (results are cached)
  "searchCacheMinutes": 30,
  "allowPrivateAddresses": false,
  "apiDelayMs": 250,             // between two calls to one platform API
  "blockedSources": [],          // sources never crawled, e.g. ["tiktok", "x"] (see Sources below)
  "sites": { "allow": [], "block": [] },   // web crawler: only these sites (empty = any) / never these sites
  "adapters": {
    "youtube":     { "enabled": true, "channels": ["UCLA_DiR1FfKNvjuUpBHmylQ", …], "apiKey": "", "dailyLimit": 10000, "searchShare": 0.5 },   // channel feeds; search needs a Data API key
    "peertube":    { "enabled": true, "instances": ["https://framatube.org", "https://tilvids.com"], "searchIndex": "https://sepiasearch.org" },
    "dailymotion": { "enabled": true },
    "archive":     { "enabled": true },
    "wikimedia":   { "enabled": true },
    "openverse":   { "enabled": true },
    "flickr":      { "enabled": true, "tags": ["landscape", "nature", …], "apiKey": "" },   // public tag feeds; search with an API key
    "mastodon":    { "enabled": true, "instances": ["https://mastodon.social"], "tags": ["photography", "art", …] },
    "bluesky":     { "enabled": true },
    "lemmy":       { "enabled": true, "instances": ["https://lemmy.world"] },
    "web":         { "enabled": true, "seeds": ["https://example.org/videos/"], "maxDepth": 2, "sameSite": true },
    "vimeo":       { "enabled": true, "accessToken": "", "dailyLimit": 1000, "searchShare": 0.5 },
    "reddit":      { "enabled": true, "clientId": "", "clientSecret": "", "subreddits": ["EarthPorn", "pics", …] },
    …                            // every platform API below, with its credentials, dailyLimit and searchShare
  }
},
"sources": { "priorities": { "vibeshare": 10 } }   // 0 (hidden) – 10; sources not named here are 5
```

- **Manners.** Every URL — and every redirect — is checked against the host's `robots.txt` (RFC 9309: the most specific rule wins, `Allow` wins ties, wildcards; a missing robots.txt allows everything, an unreachable one blocks everything for a while). Requests to a host are spaced by `hostDelayMs` or its Crawl-delay, responses are size-limited, and private and local addresses are never fetched.
- **What a find becomes.** Its id is the platform source (`yt:…`, `peertube:host/uuid`, `ig:reel/…`, `url:…`), so clients play it from the platform: its media file when the platform offers one, its embedded player otherwise. Formats come from the platform and the media's shape (portrait video is a short video), ratings from the platform's sensitive/adult flags (otherwise `defaultRating`), topics from the words of the title and description.
- **Your decisions win.** Content you listed, blocked or edited is never changed by the crawler; it only adds what is missing (a thumbnail, a media link). Bulk-list or block pending finds from the catalog.
- Set `"enabled": false` to run a hand-curated node.

### Platform APIs

Platforms that only allow automated access through their official API are crawled with credentials from your own developer account. Paste them in the dashboard's *API keys* tab (or under `crawler.adapters.<id>` in `config.json`); an API without its credentials does nothing. Each API card links to the place to get them.

| Adapter | Credentials | Default daily budget | Finds |
|---|---|---|---|
| `youtube` | `apiKey` (YouTube Data API v3) | 10 000 units (a search costs 100) | videos and shorts matching the queries; channel feeds work without a key |
| `flickr` | `apiKey` | 3 000 | photos matching the queries; tag feeds work without a key |
| `vimeo` | `accessToken` (public scope) | 1 000 | videos |
| `twitch` | `clientId`, `clientSecret` | 5 000 | live channels and videos of matching categories |
| `unsplash` | `accessKey` | 1 000 | photos |
| `pexels` | `apiKey` | 600 | photos and videos |
| `giphy` | `apiKey` | 1 000 | GIFs |
| `tenor` | `apiKey` (Google Cloud key with the Tenor API) | 5 000 | GIFs |
| `imgur` | `clientId` | 5 000 | images and videos |
| `deviantart` | `clientId`, `clientSecret` | 2 000 | artwork (mature works are skipped) |
| `europeana` | `apiKey` | 5 000 | images, video and sound from European museums and archives |
| `reddit` | `clientId`, `clientSecret`, `subreddits` | 5 000 | images, videos and links to platforms from the subreddits and from searches |
| `tumblr` | `apiKey` (OAuth consumer key) | 4 000 | photo and video posts with matching tags |
| `x` | `bearerToken` | 100 | posts with photos and videos (search access depends on your X API tier) |
| `instagram` | `accessToken`, `userId`, `hashtags` | 100 | top media of hashtags (Instagram Graph API hashtag search; needs a professional account and app review) |
| `spotify` | `clientId`, `clientSecret`, `market` | 5 000 | tracks and podcast episodes |
| `jamendo` | `clientId` | 1 000 | Creative Commons music |
| `freesound` | `token` | 2 000 | sounds |

- **Budgets.** `dailyLimit` counts calls (YouTube: quota units) per UTC day; set it within the platform's own limit. `searchShare` (0–1, default 0.5) is the part kept for client searches: the crawler stops at `dailyLimit × (1 − searchShare)`, while searches may use the whole budget. When a client searches and the API still has budget, the platform is searched too (with `searchPlatforms` on) and what it returns is added to the catalog.
- **Rate limits.** Calls to an API are spaced by `apiDelayMs`. When a platform answers 429, the API is paused for as long as its `Retry-After` says (an hour otherwise), crawling and searching alike. Usage and pauses are shown on each API card.
- **Tokens.** APIs with a client ID and secret (Twitch, DeviantArt, Reddit, Spotify) get an app token from the platform and reuse it until it expires. Credentials are only ever sent to the API they belong to.
- **Terms.** Each platform's developer terms apply to your use: attribution, how long results may be kept, and some APIs (Instagram's hashtag search, higher X tiers, TikTok's Research API) need approval first. Platforms whose terms do not allow this kind of use are not included.

### Sources and priorities

The *Sources* tab lists every source of content — VibeShare (content published on providers) and each platform — with how many of its items are listed or pending.

- **Crawl.** Untick a source to block it (`crawler.blockedSources`): its adapter stops, links to it are no longer followed or identified, its hosts are never fetched, nothing more from it is added, and what was found there before is left out of feeds and search (content you added yourself stays).
- **Priority.** 0 to 10 (`sources.priorities`), 5 when not set and 10 for VibeShare. Within a source the ranking's order is kept; between sources, every step above 5 moves items up and every step below moves them down — at 10, an item ranks where one ten times further down the list would. Priority 0 leaves the source out of feeds and search altogether.
- **Sites.** `crawler.sites.block` lists sites that are never fetched, not even through a platform's API; `crawler.sites.allow`, when not empty, limits the web crawler to the sites on it. A name covers its subdomains.

## Security checklist

- Keep `identity.json` and `admin-token` private (they are written with mode 600).
- Serve over HTTPS; clients pin your key, but TLS protects tokens in transit.
- Turn on `powBits` and `perIpPerHour` if you hand out signup credits.
- Use read-only backends (`write: false`) for storage you do not control.
- Back up the data directory: the ledger is your users' money.
