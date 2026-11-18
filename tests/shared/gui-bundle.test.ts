// The built GUI must be found from where the server code actually lives.
//
// This is a regression test for a real outage: `findGuiDir()` resolves `gui/dist`
// relative to its own module url, and moving that module into `src/shared/node/` (and
// `dist/shared/node/`) shifted the path one level too deep — every node then answered
// `{"code":"not_found","message":"No route for GET /admin"}` until the path was fixed.
// If the GUI has not been built in this checkout the test skips, so `npm test` stays
// usable on a fresh clone.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findGuiDir } from '../../src/shared/node/assets.js';
import { startProvider } from '../helpers.js';

const dir = findGuiDir();
const built = Boolean(dir && existsSync(join(dir, 'index.html')) && existsSync(join(dir, 'admin.html')));

describe('the built GUI is served', () => {
  it('finds the built bundle from the module location', (t) => {
    if (!built) return t.skip('gui/dist is not built in this checkout (run npm run build:gui)');
    assert.ok(dir, 'findGuiDir() must find gui/dist');
    assert.ok(existsSync(join(dir!, 'index.html')));
    assert.ok(existsSync(join(dir!, 'admin.html')), 'the admin console is part of the same bundle');
  });

  it('serves the admin console at /admin instead of a 404', async (t) => {
    if (!built) return t.skip('gui/dist is not built in this checkout (run npm run build:gui)');
    const provider = await startProvider(undefined, null, { guiDir: dir });
    after(async () => {
      await provider.stop();
    });
    const answer = await fetch(`${provider.url()}/admin`);
    assert.equal(answer.status, 200, 'GET /admin must serve the console, not "No route for GET /admin"');
    assert.match(answer.headers.get('content-type') ?? '', /text\/html/);
    const body = await answer.text();
    assert.match(body, /<html/i, 'the admin console HTML is served');
    // The client page (the console's index.html) must be served too.
    const root = await fetch(`${provider.url()}/`);
    assert.equal(root.status, 200);
  });
});
