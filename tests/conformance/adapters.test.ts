// Crawler-adapter conformance suite: the fixture set any implementation can run
// semantically. Sample platform URLs must parse to their canonical sources, every
// built-in adapter must produce the documented discovery shape from the recorded
// responses, and no adapter ships without fixtures. Fast and offline: tests/fakeweb.ts
// stands in for the platforms. The fixture schema is documented in README.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { Crawler, crawlerDefaults, type CrawlerConfig } from '../../src/algorithm/crawler/crawler.js';
import type { Discovered } from '../../src/algorithm/crawler/types.js';
import { formatSource, parseContentId, parseSource, sourceFromUrl } from '../../src/shared/sources.js';
import { startFakeWeb } from '../fakeweb.js';

interface SourceCase {
  adapter?: string;
  url: string;
  source: string;
}

interface DiscoveryCase {
  adapter: string;
  target?: string;
  /** How many discovery rounds to run (frontier-driven adapters like web need more). */
  rounds?: number;
  config: Record<string, Record<string, unknown>>;
  expectCount?: number;
  expect: Record<string, unknown>[];
}

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as {
  sources: SourceCase[];
  discovery: DiscoveryCase[];
};

/** $FAKEWEB → the recorded-response server; ${enc:…} → percent-encoded inner text. */
function fill(text: string, base: string): string {
  return text
    .replace(/\$\{enc:([^}]+)\}/g, (_, inner: string) => encodeURIComponent(inner.split('$FAKEWEB').join(base)))
    .split('$FAKEWEB')
    .join(base);
}

/** Subset match: every listed field must equal (recursively); unlisted fields are free. */
function matches(item: unknown, want: Record<string, unknown>): boolean {
  return Object.entries(want).every(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? matches((item as Record<string, unknown>)[key] ?? {}, value as Record<string, unknown>)
      : JSON.stringify((item as Record<string, unknown>)[key]) === JSON.stringify(value)
  );
}

describe('crawler-adapter conformance: canonical sources', () => {
  for (const [index, sourceCase] of fixtures.sources.entries()) {
    it(`${index + 1}. ${sourceCase.url} → ${fill(sourceCase.source, '')}`, () => {
      const source = sourceFromUrl(sourceCase.url);
      assert.ok(source, 'the URL is recognized');
      assert.equal(formatSource(source), fill(sourceCase.source, ''));
      // The canonical id round-trips: it parses back to the same source and is a
      // usable content id part.
      assert.deepEqual(parseSource(fill(sourceCase.source, '')), source);
      const parsed = parseContentId(fill(sourceCase.source, ''));
      assert.ok(parsed, 'the source is a usable content id');
      assert.equal(parsed.base, fill(sourceCase.source, ''));
    });
  }
});

describe('crawler-adapter conformance: discovery shapes', async () => {
  const web = await startFakeWeb();
  after(() => web.close());

  for (const caseItem of fixtures.discovery) {
    it(`${caseItem.adapter} produces its documented discoveries`, async () => {
      const found: Discovered[] = [];
      const allOff = Object.fromEntries(Object.keys(crawlerDefaults().adapters).map((id) => [id, { enabled: false }]));
      const adapters = JSON.parse(fill(JSON.stringify({ ...allOff, ...caseItem.config }), web.url)) as CrawlerConfig['adapters'];
      const crawler = new Crawler(
        (): CrawlerConfig => ({
          ...crawlerDefaults(),
          enabled: true,
          allowPrivateAddresses: true,
          hostDelayMs: 0,
          pauseMs: 0,
          queries: ['aurora'],
          adapters,
        }),
        null,
        (items) => {
          found.push(...items);
          return items.length;
        }
      );
      for (let round = 0; round < (caseItem.rounds ?? 1); round++) {
        // A round may end on a robots-disallowed page: expected discovery behavior.
        await crawler.runOnce(caseItem.adapter, caseItem.target ? fill(caseItem.target, web.url) : undefined).catch(() => undefined);
      }
      for (const want of caseItem.expect) {
        const expected = JSON.parse(fill(JSON.stringify(want), web.url)) as Record<string, unknown>;
        assert.ok(
          found.some((item) => matches(item, expected)),
          `expected an item matching ${JSON.stringify(expected)}; found ${JSON.stringify(found.map((item) => item.id))}`
        );
      }
      if (caseItem.expectCount !== undefined) assert.equal(found.length, caseItem.expectCount);
    });
  }
});

describe('crawler-adapter conformance: coverage', () => {
  it('names every built-in adapter in the fixture set', () => {
    const named = new Set([...fixtures.sources.map((item) => item.adapter), ...fixtures.discovery.map((item) => item.adapter)]);
    for (const id of Object.keys(crawlerDefaults().adapters)) {
      assert.ok(named.has(id), `the ${id} adapter has no conformance fixture`);
    }
  });
});
