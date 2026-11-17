// One declarative route shape for every server. These tests pin the helpers down and
// prove a real node exposes its routes as data (a manifest), which is what docs and
// drift checks read instead of parsing source.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { registerRouteTable, routeManifest, routeTable, tableManifest, type RouteEntry } from '../../src/shared/node/routes.js';
import type { Ctx } from '../../src/shared/node/http.js';
import { startProvider } from '../helpers.js';

const handler = (_ctx: Ctx) => undefined;
const entry = (method: RouteEntry['method'], path: string): RouteEntry<Ctx> => ({ method, path, handler });

describe('the shared route table', () => {
  it('applies a base prefix, keeps order and registers into a Router', async () => {
    const table = routeTable('test', [entry('GET', '/one'), entry('POST', '/two')], '/v1');
    assert.deepEqual(tableManifest(table), [
      { method: 'GET', path: '/v1/one' },
      { method: 'POST', path: '/v1/two' },
    ]);
    assert.deepEqual(routeManifest([table, routeTable('more', [entry('DELETE', '/three')])]), [
      { method: 'GET', path: '/v1/one' },
      { method: 'POST', path: '/v1/two' },
      { method: 'DELETE', path: '/three' },
    ]);
    // A table bound to a Router is live: the manifest list and the Router's own agree.
    const { Router } = await import('../../src/shared/node/http.js');
    const router = new Router();
    registerRouteTable(router, table);
    assert.deepEqual(router.manifest(), tableManifest(table));
  });
});

describe('a running node exposes its routes as a manifest', async () => {
  const provider = await startProvider();
  after(async () => {
    await provider.stop();
  });

  it('lists every registered route once, in the shared shape', () => {
    const manifest = provider.router.manifest();
    assert.ok(manifest.length > 20, `expected a real node to register many routes, found ${manifest.length}`);
    const seen = new Set<string>();
    for (const route of manifest) {
      assert.equal(typeof route.method, 'string');
      assert.match(route.path, /^\//, `every path starts with a slash: ${route.path}`);
      const key = `${route.method} ${route.path}`;
      assert.ok(!seen.has(key), `duplicate route registration: ${key}`);
      seen.add(key);
    }
    // A route the wire protocol documents, to prove the manifest is the real surface.
    assert.ok(manifest.some((route) => route.method === 'GET' && route.path === '/v1/info'));
  });
});
