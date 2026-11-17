# Extending VibeShare

Every extension point in the system, with a worked example. The architecture
(map of modules, the browser/Node boundary) is in
[ARCHITECTURE.md](ARCHITECTURE.md); this page is the how-to. All examples are
minimal but real — trim them to taste.

Contents: [routes](#routes) · [custom ranking modules](#custom-ranking-modules) ·
[storage backends](#storage-backends) · [payment methods](#payment-methods) ·
[crawler platform adapters](#crawler-platform-adapters) ·
[hosting platforms](#hosting-platforms) ·
[page presets and themes](#client-page-presets-and-themes) ·
[moderation policy](#moderation-policy)

## Routes

**Server route** (any node): register it in the node's `registerRoutes()`
(public) or `adminRoutes()` (operator) — `src/provider/node.ts`,
`src/algorithm/node.ts`, `src/node/node.ts` for the base every node serves. The
router is the one in [`src/shared/node/http.ts`](../src/shared/node/http.ts); handlers get
a `Ctx` (`req`, `res`, `params`, `query`, `ip`) and return JSON (or `undefined`
after writing the response themselves). Add the request/response types to
[`src/shared/protocol/`](../src/shared/protocol) so clients can share them, and
document the route in [PROTOCOL.md](PROTOCOL.md).

```ts
// in ProviderNode.registerRoutes():
router.post('/v1/admin/pin/:cid', async (ctx) => {
  this.requireAdmin(ctx);                       // admin routes check the token
  const cid = String(ctx.params.cid).split('~')[0];
  if (!this.store.getContent(cid)) throw notFound('No such content');
  this.pinned.add(cid);                         // your own bookkeeping
  this.traces.trace('basic', 'provider.node', 'content pinned', { data: { cid: cid.slice(0, 16) } });
  return { pinned: true, cid };
});
```

**Client local-API route**: one `on('METHOD', '/api/…')` line in
[`src/client/api.ts`](../src/client/api.ts) — that table is the whole local API
and the GUI's `gui/src/api.ts` talks to it. Daemon-only pieces (uploads, streams)
live in `src/client/daemon.ts`.

## Custom ranking modules

`ranking.strategy: "custom"` makes the algorithm node load the ES module named
by `ranking.module` and rank with it. Built-ins (`balanced`, `hot`, `new`,
`top`, `random`) need no code. The module's default export receives the entries
that passed the viewer's filters and returns them in order, or a map of scores
by entry id (higher first); it may be `async` (e.g. to call your own ML
service). A full example ships at
[`examples/ranking/ranker.mjs`](../examples/ranking/ranker.mjs):

```js
// ranker.mjs — point ranking.module at this file.
export default function rank(entries, { preferences, seed, now, config, helpers }) {
  const scores = {};
  for (const entry of entries) {
    scores[entry.id] =
      1.2 * helpers.wilson(entry.likes, entry.dislikes) +   // quality
      0.6 * helpers.recency(entry, now, config.halfLifeHours) + // freshness
      1.5 * helpers.preferenceMatch(entry, preferences) +   // favourite topics
      0.3 * helpers.seededRandom(seed, entry.id);           // stable shuffle
  }
  return scores;
}
```

`entry` carries `{ id, title, format, rating, topics, tags, creatorId,
publishedAt, likes, dislikes, durationSeconds, … }`; `helpers` provides
`wilson`, `quality`, `recency`, `preferenceMatch` and `seededRandom`; `config`
is the node's `ranking` config (weights, `halfLifeHours`, `gravity`). The
contract lives in `src/algorithm/ranking.ts` (`Ranker`, `RankContext`).

## Storage backends

A provider keeps blobs (chunks and manifests) in any mix of backends, reading
them in priority order. To add one, implement `BlobBackend` in
[`src/provider/storage/backends.ts`](../src/provider/storage/backends.ts), add
your config to the `BackendConfig` union, and wire it into
`ProviderNode.createBackend`'s switch in `src/provider/node.ts`:

```ts
export interface BlobBackend {
  readonly id: string;
  readonly type: string;
  readonly writable: boolean;
  /** Stores a blob; return a locator when your backend names blobs itself (like IPFS CIDs). */
  put(key: string, data: Buffer): Promise<string | undefined>;
  get(key: string, locator?: string): Promise<Buffer | null>;
  delete(key: string, locator?: string): Promise<void>;
  check(): Promise<{ ok: boolean; detail: string }>;   // the dashboard's health row
}

interface CommonConfig {
  id: string;          // unique per node
  priority?: number;   // lower is tried first (default 10)
  write?: boolean;     // false = read-only (mirrors)
}
```

```ts
// A worked skeleton: a backend over an arbitrary HTTP store with an index.
export interface FancyConfig extends CommonConfig {
  type: 'fancy';
  endpoint: string;
  apiKey: string;
}

export class FancyBackend implements BlobBackend {
  readonly type = 'fancy';
  readonly writable: boolean;
  constructor(readonly id: string, private config: FancyConfig, private traces?: TraceStore) {
    this.writable = config.write !== false;
  }
  async put(key: string, data: Buffer) {
    await request(`${this.config.endpoint}/blobs/${key}`, {
      method: 'PUT', raw: data, headers: { authorization: `Bearer ${this.config.apiKey}` },
    });
    return undefined;                 // no locator: the key names the blob
  }
  async get(key: string) {
    try {
      const response = await request(`${this.config.endpoint}/blobs/${key}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof RemoteError && error.status === 404) return null;
      throw error;
    }
  }
  async delete(key: string) {
    await request(`${this.config.endpoint}/blobs/${key}`, { method: 'DELETE' });
  }
  async check() {
    return { ok: true, detail: this.config.endpoint };
  }
}
```

Reads and writes go through `backendTrace` in the same file when you copy an
existing backend — that keeps the per-operation dependency traces (URL, status,
bytes, timing) consistent. Storage in the dashboard: *Settings → Storage
backends*; config reference: [OPERATORS.md](OPERATORS.md#storage-backends).

## Payment methods

A payment method sells credits on one node. The contract is `PaymentMethod` in
[`src/node/payments/interface.ts`](../src/node/payments/interface.ts) (one
module per method under [`src/node/payments/`](../src/node/payments); the
registry is `METHOD_CLASSES` in `payments/index.ts`):

```ts
export interface PaymentMethod {
  readonly config: PaymentConfig;
  /** What the payer sees: id, type, label, rate and limits. */
  info(): PaymentMethodInfo;
  /** Opens an invoice (methods that settle another way may throw). */
  createInvoice(account: Account, credits: number): Promise<StoredInvoice>;
  /** The payer's proof: credits the account, or moves the invoice into review. */
  claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult>;
  /** Hosted checkouts settle through a webhook; the other methods throw. */
  webhook(raw: Buffer, headers: Ctx['req']['headers']): Promise<unknown>;
}
```

The base classes do most of the work: `Method` (credit checks, own-invoice
lookup, expiry) and `ExactAmountMethod` (on-chain style: exact amount with a
unique tail so a transaction identifies the invoice — see `EvmMethod` /
`BitcoinMethod` for reference). A worked skeleton:

```ts
// src/node/payments/fancy.ts
export interface FancyConfig extends BaseMethodConfig {
  type: 'fancy';
  endpoint: string;   // only public data — nodes refuse seed phrases / private keys
}

export class FancyMethod extends Method<FancyConfig> {
  info() {
    return { ...this.baseInfo('Fancy Pay'), needsProof: true };
  }

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const amount = this.checkCredits(credits);
    // newInvoice stores it; `pay` is what the payer sees (address, amount, currency, uri).
    return this.payments.newInvoice(account, this.config.id, amount, this.expiry(), {
      address: this.config.endpoint, amount, currency: 'USD',
    });
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const invoice = this.ownInvoice(account, body.invoiceId);
    const tx = String(body.tx ?? '');
    const ok = await verifySomewhere(this.config.endpoint, tx);
    if (!ok) return { credited: 0, balance: this.payments.ledger.get(account.id)?.balance ?? 0, invoice };
    // settle() marks the invoice paid and credits the account exactly once (by usedKey).
    return this.payments.settle(invoice, `fancy:${tx}`, tx);
  }
}
```

Then add `fancy` to `PaymentType` in `src/shared/protocol`, a `FancyConfig`
variant to `PaymentConfig`, and register the class in `METHOD_CLASSES`
(`payments/index.ts`). Configuration lives in each node's `payments` list (the
dashboard edits it); [OPERATORS.md](OPERATORS.md#payment-methods) documents what
operators see.

## Crawler platform adapters

The discovery crawler finds content per platform through `Adapter`s in
[`src/algorithm/crawler/adapters/`](../src/algorithm/crawler/adapters) (one
module per family: `video`, `images`, `social`, `apis` — itself one module per
platform — and `web`; the contract is
[`types.ts`](../src/algorithm/crawler/types.ts)). Every adapter speaks the shared
`SourceAdapter` contract: it recognizes its own platform's URLs (`match`) and
turns them into the canonical source id (`parse`, `yt:…`). An adapter offers
discovery units (`targets`) and/or client search; both are optional:

```ts
export interface Adapter<C = Record<string, unknown>> extends SourceAdapter {
  id: string;
  label: string;
  description: string;
  defaults: C & { enabled: boolean };
  api?: ApiInfo;                // official API with the operator's key + daily budget
  match(url: URL): boolean;     // does this URL belong to the platform?
  parse(url: URL): ExternalSource | null;   // …and what canonical source is it?
  targets?(config: C, queries: string[]): string[];
  discover?(ctx: CrawlContext, config: C, target: string): Promise<AdapterResult>;
  search?(ctx: CrawlContext, config: C, query: string): Promise<Discovered[]>;
}
```

`CrawlContext` gives you a polite `fetcher` (robots.txt, per-host delays,
private-address protection), `ctx.api(url, request)` for official API calls
(counted against the day's budget; throws `BudgetUsed`), `token()` for OAuth and
`traces` for the node's trace log. A worked skeleton:

```ts
// src/algorithm/crawler/adapters/fancy.ts
export const fancy = {
  id: 'fancy',
  label: 'FancyVideo',
  description: 'Public feeds of fancy.video',
  defaults: { enabled: true },
  targets: () => ['https://fancy.video/feed.xml'],
  async discover(ctx, config, target) {
    const xml = await (await ctx.fetcher.get(target, { accept: 'application/xml' })).text();
    return {
      // Discovered carries a content id (`url:…` for anything without a platform scheme).
      items: [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => ({
        id: `url:${encodeURIComponent(m[1])}`,
        title: '…',                    // whatever the feed carries
        format: 'video',
      })),
      links: [],                       // or pages worth crawling later
    };
  },
} satisfies Adapter;
```

Register it in the adapter list the crawler reads (see the bottom of
`adapters/`), or — without forking — drop the module anywhere on disk and list it
in `crawler.modules` in the node's config: it is loaded like the custom ranking
module (a default export that is one `Adapter`, or an `adapters` list) and joins
the built-ins, winning on id collisions. Either way the *Crawler* tab then shows
it with an on/off switch, its stats and any `robots.txt` blocks. Follow the
platform's terms; recorded-response tests in `tests/` keep adapters honest when
platforms change.

## Node kinds, key algorithms and source schemes

Three registries make the wire formats open, so a fork adds to them without
editing any parser:

- **Node kinds** — `registerNodeType({ id, label })` in
  [`noderef.ts`](../src/shared/noderef.ts) adds a `vs:<type>:<key>@<url>`
  reference kind (`provider` and `algorithm` ship today).
- **Key algorithms** — `registerKeyAlgorithm({ prefix, label, bytes, validate,
  generate })` adds a key id format (`vk1` = Ed25519 ships today).
- **Source schemes** — `registerSourceScheme({ id, label, media, parse,
  embedFor, pageFor, imageFor? })` in
  [`sources.ts`](../src/shared/sources.ts) adds a `scheme:value` content source:
  how its URLs are recognized and how it embeds or pages (`yt`, `peertube`,
  `lemmy`… all live in that registry).

## Hosting platforms

The client's *Earn → Provider jobs* wizard walks users through hosting content
on free static hosts. Each platform is a `HostingPlatform` in
[`gui/src/earn/hosting/types.ts`](../gui/src/earn/hosting/types.ts), one module
per platform under [`gui/src/earn/hosting/platforms/`](../gui/src/earn/hosting/platforms),
registered in `platforms/index.ts`. The interface carries the account-creation
`steps`, the wizard `fields`, URL building/parsing (`buildBaseUrl`,
`buildSiteUrl`, `parseBaseUrl`, `siteUrlCandidates`) and which push pipeline
`publish` runs:

```ts
// gui/src/earn/hosting/platforms/fancy.ts
export const fancy: HostingPlatform = {
  id: 'fancy',
  name: 'Fancy Pages',
  signup: 'https://fancy.example/signup',
  docs: 'https://fancy.example/docs/static-sites',
  steps: [
    {
      title: 'Create the site',
      lines: ['Open the dashboard.', 'Click New site and pick the free plan.'],
      links: [{ label: 'Dashboard', url: 'https://fancy.example/dashboard' }],
    },
    // …
  ],
  fields: [
    { id: 'user', label: 'User', placeholder: 'yourname', hint: 'The account owning the site.' },
    { id: 'site', label: 'Site name', placeholder: 'vibeshare-data' },
    { id: 'folder', label: 'Folder for content ids', default: 'public' },
    { id: 'token', label: 'Access token', secret: true, hint: 'Read-write token for the files API.' },
  ],
  buildBaseUrl: (v) => `https://${v.user}.fancy.example/${v.folder}/`,
  buildSiteUrl: (v) => `https://${v.user}.fancy.example/`,
  publish: 'gitlab', // or a new pipeline in push.ts
};
```

The wizard's five panels (account, access, base URL, save & offer, review) and
the per-step checks are generated from `steps`/`fields`; `checks.ts` probes the
site, the token and each content id. `drafts.ts`/`zip.ts`/`push.ts` provide the
file drafts, zip downloads and push pipelines shared by platforms.

## Client page presets and themes

Client pages are `PageConfig` records (layout, content source, filters, visible
metadata, per-page options) in [`src/shared/clientapi.ts`](../src/shared/clientapi.ts);
defaults and presets live in
[`src/shared/clientdefaults.ts`](../src/shared/clientdefaults.ts). The three
built-in presets are `'videos' | 'shorts' | 'images'` (`PagePreset`);
`presetPage()` builds one, `PRESETS` is the list the client restores when a
preset page is missing:

```ts
export type PagePreset = 'videos' | 'shorts' | 'images';
export const PRESETS: PagePreset[] = ['videos', 'shorts', 'images'];
```

To add a preset: extend `PagePreset`, add a `presetPage` case (layout, source,
filters, fields) and append it to `PRESETS`. Users can already build the same
page by hand — a preset is only the out-of-the-box copy. Themes are the
`theme: 'system' | 'dark' | 'light'` setting (the GUI's CSS variables in
`gui/src/styles.css` define both palettes; a new palette means new variables
there, which is a code change rather than a plug-in point).

## Moderation policy

Moderation is data, not code: [`src/node/moderation.ts`](../src/node/moderation.ts)
holds entries and enforces them on every request. Each entry acts on an account
id, an IP address or a peer node:

```ts
type ModerationAction = 'permaban' | 'tempban' | 'ratelimit';

interface ModerationEntry {
  subject: 'account' | 'ip' | 'peer';
  target: string;
  action: ModerationAction;
  until?: string;       // tempban: when it ends
  perMinute?: number;   // ratelimit: requests per minute still allowed
  reason?: string;
}
```

Operators manage entries in the dashboard (*Accounts → Moderation*) or over the
API (`GET`/`POST /v1/admin/moderation`, `DELETE /v1/admin/moderation/:id`);
`POST /v1/admin/moderation/sync` exchanges entries with every configured peer,
so one operator's ban reaches the network (`GET`/`POST /v1/peers/moderation`).
`Moderation.enforce()` is the gate all requests pass — policies like "rate-limit
signup endpoints harder" would extend that gate and the entry shapes together.
