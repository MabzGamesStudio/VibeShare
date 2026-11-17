// The wire's self-description must match the package the build ships: a release bump
// that forgets src/shared/version.ts would otherwise leave nodes claiming an old version.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SOFTWARE } from '../../src/shared/protocol.js';
import { VERSION } from '../../src/shared/version.js';

describe('version', () => {
  it('is one number, shared by package.json and the wire', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    assert.equal(VERSION, pkg.version, 'src/shared/version.ts must match package.json');
    assert.equal(SOFTWARE, `vibeshare/${VERSION}`, 'SOFTWARE is derived from VERSION');
  });
});
