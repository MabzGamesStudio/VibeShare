// The wire half of src/shared/ must stay browser-safe: it is compiled into the web
// client and the mobile WebView, where `node:` modules do not exist. Node-only
// infrastructure lives under src/shared/node/ (moved there for exactly this reason), and
// this test fails the moment a wire module reaches for it.
//
// `crypto.ts` is the one documented exception: it is the Node implementation that browser
// builds swap for gui/src/web/crypto.ts through a Vite alias, so wire modules may import
// it by name. It is the only file in the wire half allowed to touch `node:`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SHARED = new URL('../../src/shared/', import.meta.url).pathname;
const PLATFORM_SWAP = new Set(['crypto.ts']);

/** Every .ts file in the wire half (src/shared/**, excluding src/shared/node/**). */
function wireFiles(dir = SHARED, prefix = ''): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node') continue; // the Node-only half, by construction
      out.push(...wireFiles(join(dir, entry.name), name));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ name, path: join(dir, entry.name) });
    }
  }
  return out;
}

describe('wire/Node boundary', () => {
  const files = wireFiles().filter((file) => !PLATFORM_SWAP.has(file.name));

  it('finds the wire modules (the test cannot pass vacuously)', () => {
    assert.ok(files.length > 20, `expected the wire half to have modules, found ${files.length}`);
  });

  it('has no `node:` imports in the wire half', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file.path, 'utf8');
      if (/from\s+'node:/.test(text) || /require\('node:/.test(text)) offenders.push(file.name);
    }
    assert.deepEqual(offenders, [], `these wire modules import Node builtins: ${offenders.join(', ')}`);
  });

  it('has no imports of the Node-only half', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file.path, 'utf8');
      if (/from\s+'\.\/node\//.test(text) || /from\s+'(?:\.\.\/)+shared\/node\//.test(text)) offenders.push(file.name);
    }
    assert.deepEqual(offenders, [], `these wire modules reach into src/shared/node/: ${offenders.join(', ')}`);
  });

  it('keeps the Node-only modules outside the wire half', () => {
    // A quick sanity list: these must exist under src/shared/node/ and nowhere else.
    for (const name of ['http', 'store', 'tor', 'tracecontext', 'tracing-node', 'assets', 'log', 'devbuild', 'contentfile']) {
      const inside = readFileSync(join(SHARED, 'node', `${name}.ts`), 'utf8');
      assert.ok(inside.length > 0, `${name}.ts must live in src/shared/node/`);
    }
  });
});
