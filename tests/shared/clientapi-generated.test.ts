// The generated typed API client must match the client route table exactly. The test
// regenerates the module in memory and compares it byte for byte with the checked-in
// copy: a route that moves, vanishes or changes its declared contract without running
// `npm run generate:api` fails here instead of drifting past the GUI at runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { generateApiSource, routeKey } from '../../scripts/generate-api-client.js';
import { clientRoutePaths } from '../../src/client/api.js';
import { CLIENT_API, clientApiPath, type ClientApiRoute } from '../../src/shared/clientapi.generated.js';

describe('the generated typed API client', () => {
  it('is up to date with the client route table (stale? run `npm run generate:api`)', () => {
    const onDisk = readFileSync(new URL('../../src/shared/clientapi.generated.ts', import.meta.url), 'utf8');
    assert.equal(generateApiSource(), onDisk, 'the checked-in generated client no longer matches the route table');
  });

  it('covers every route of the table exactly once, with its method and path', () => {
    const routes = clientRoutePaths();
    const keys = Object.keys(CLIENT_API) as ClientApiRoute[];
    assert.equal(keys.length, routes.length);
    for (const { method, path } of routes) {
      const key = routeKey(method, path) as ClientApiRoute;
      assert.deepEqual(CLIENT_API[key], { method, path }, `${method} ${path} is in the generated map under ${key}`);
    }
  });

  it('builds parameterized paths from the route keys', () => {
    assert.equal(clientApiPath('get-state'), '/api/state');
    assert.equal(clientApiPath('get-content-id', { id: 'vs1abc' }), '/api/content/vs1abc');
  });
});
