// Operator adapter modules (crawler.modules): an external ES module exports an
// Adapter and joins the built-ins — winning on id collisions — loaded the same way
// the custom ranking module is.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Crawler, crawlerDefaults, type CrawlerConfig } from '../../src/algorithm/crawler/crawler.js';
import type { Discovered } from '../../src/algorithm/crawler/types.js';
import { tempDir } from '../helpers.js';

describe('loadable crawler adapters', () => {
  it('loads an operator module and sees its discoveries', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, 'temp-adapter.mjs');
      writeFileSync(
        path,
        `export default {
          id: 'tempmod',
          label: 'Temp platform',
          description: 'A test adapter.',
          defaults: { enabled: true },
          match: (url) => url.hostname === 'temp.example',
          parse: (url) => ({ scheme: 'url', value: encodeURIComponent(url.toString()) }),
          targets: () => ['temp'],
          async discover() {
            return { items: [{ id: 'yt:tempfound1', title: 'Temp find', format: 'video', adapter: 'tempmod' }] };
          },
        };
        export const adapters = [{
          id: 'youtube',
          label: 'Stub YouTube',
          description: 'Wins the built-in youtube id.',
          defaults: { enabled: true },
          match: () => false,
          parse: () => null,
          targets: () => ['temp'],
          async discover() {
            return { items: [{ id: 'yt:stubfind1', title: 'Stub find', format: 'video', adapter: 'youtube' }] };
          },
        }];
`
      );
      const config: CrawlerConfig = { ...crawlerDefaults(), modules: [path] };
      const found: Discovered[] = [];
      const crawler = new Crawler(() => config, null, (items) => {
        found.push(...items);
        return items.length;
      });

      const loaded = await crawler.loadModules();
      assert.deepEqual(
        loaded.map((adapter) => adapter.id),
        ['tempmod', 'youtube']
      );

      const round = await crawler.runOnce('tempmod', 'q:test');
      assert.equal(round.adapter, 'tempmod');
      assert.equal(round.found, 1);
      assert.equal(round.added, 1);
      assert.equal(found.at(-1)?.id, 'yt:tempfound1');

      // The operator's module wins the built-in youtube id: the run reaches the stub.
      const collision = await crawler.runOnce('youtube', 'q:test');
      assert.equal(collision.adapter, 'youtube');
      assert.equal(collision.found, 1);
      assert.equal(found.at(-1)?.id, 'yt:stubfind1');
    } finally {
      cleanup();
    }
  });
});
