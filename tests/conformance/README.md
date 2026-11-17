# Crawler-adapter conformance suite

A semantic, offline fixture set any implementation can run against — the reference
TypeScript adapters pass it here, and a Go/Rust/Python port (or an operator's own
crawler module) can check itself against the same expectations.

## What it checks

1. **Canonical sources** (`sources` in `fixtures.json`): sample platform URLs must
   parse to the documented canonical source id (`https://vimeo.com/76979871` →
   `vimeo:76979871`). This is the `SourceAdapter` contract of `src/shared/sources.ts`:
   recognize your own URLs and turn them into `scheme:value` ids. The `url:…` cases
   document the web-link catch-all (the value is the percent-encoded URL).
2. **Discovery shapes** (`discovery` in `fixtures.json`): given the recorded platform
   responses for a request, an adapter must produce the documented `Discovered` items
   (matched as subsets: listed fields must match exactly, unlisted fields are free).
3. **Coverage**: every built-in adapter must be named in at least one fixture, so a new
   adapter cannot land without conformance expectations.

## Fixture schema (`fixtures.json`)

```jsonc
{
  // URL → canonical source. `adapter` ties the case to a built-in adapter (used by the
  // coverage check); scheme-only cases (no adapter) leave it out.
  "sources": [
    { "adapter": "vimeo", "url": "https://vimeo.com/76979871", "source": "vimeo:76979871" }
  ],
  // Recorded-response → expected discoveries. `config` overrides the adapter's
  // settings (instance/API URLs point at the recorded responses); `target` is the
  // discovery unit the adapter runs (omitted: the adapter's own default target);
  // `rounds` runs several discovery rounds (frontier-driven adapters like web need
  // this). `expect` items are SUBSETS of the expected Discovered; `expectCount`
  // (optional) pins the exact number of items found.
  "discovery": [
    {
      "adapter": "peertube",
      "target": "instance:$FAKEWEB/peertube",
      "config": { "peertube": { "enabled": true, "instances": ["$FAKEWEB/peertube"] } },
      "expect": [{ "id": "peertube:tube.example/kkGMgK9ZtnKfYAgnEtQxbv", "format": "video" }]
    }
  ]
}
```

**Templates** (substituted before use):

- `$FAKEWEB` — the base URL of the recorded-response server (`tests/fakeweb.ts`, a
  local stand-in for the platforms; never touches the network).
- `${enc:…}` — the inner text, percent-encoded (used for `url:` canonical ids).

## Running it

- Reference implementation: `npx tsx --test tests/conformance/adapters.test.ts`.
- Any other implementation: serve the recorded responses (the bodies behind the
  `tests/fakeweb.ts` routes named by each case's `config` URLs), run the named adapter
  on the given `target`, and compare against `expect` with subset semantics.

## Extending it

New adapter? Add `sources` cases for its platform URLs (and `adapter` to existing
catch-all cases is not needed) and a `discovery` case with one recorded response and
its expected items. The coverage test fails until every built-in adapter is named.
