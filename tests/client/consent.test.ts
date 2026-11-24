import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONSENT_VERSION, chooseConsent, choosePlatform, embedsAllowed, loadConsent, platformKeyOf, type ConsentRecord } from '../../gui/src/consent.js';

/** The browser's storage, stand-in for tests: the consent record never leaves the device. */
function stubStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe('cookie and third-party embed consent (strictest rules)', () => {
  it('loads nothing before an explicit choice: browsing is never consent', () => {
    assert.equal(embedsAllowed(null), false, 'no record: embeds stay off');
    const old = { choice: 'accepted', at: new Date().toISOString(), version: CONSENT_VERSION - 1 } as ConsentRecord;
    assert.equal(embedsAllowed(old), false, 'a record from an older policy asks again');
  });

  it('an explicit accept turns embeds on, a rejection keeps them off', () => {
    const accepted: ConsentRecord = { choice: 'accepted', at: new Date().toISOString(), version: CONSENT_VERSION };
    const rejected: ConsentRecord = { choice: 'rejected', at: new Date().toISOString(), version: CONSENT_VERSION };
    assert.equal(embedsAllowed(accepted), true);
    assert.equal(embedsAllowed(rejected), false);
  });

  it('remembers the choice on this device, and withdrawing it asks again', () => {
    stubStorage();
    assert.equal(loadConsent(), null);
    const record = chooseConsent('accepted');
    assert.equal(loadConsent()?.at, record.at, 'the consent record is kept (strictly necessary)');
    assert.equal(embedsAllowed(loadConsent()), true);

    // Withdrawal is as easy as the choice itself: forget it and nothing loads again.
    chooseConsent('rejected');
    assert.equal(embedsAllowed(loadConsent()), false);
  });

  it('decides per platform: an allow narrows nothing and a deny narrows only itself', () => {
    // Global accept + one platform switched off: that one is blocked, the others load.
    const accepted: ConsentRecord = { choice: 'accepted', at: new Date().toISOString(), version: CONSENT_VERSION, platforms: { yt: false } };
    assert.equal(embedsAllowed(accepted, 'yt'), false, 'the platform the person switched off stays off');
    assert.equal(embedsAllowed(accepted, 'vimeo'), true, 'the others follow the global choice');
    // Global reject + one platform switched on: only that one loads.
    const narrow: ConsentRecord = { choice: 'rejected', at: new Date().toISOString(), version: CONSENT_VERSION, platforms: { yt: true } };
    assert.equal(embedsAllowed(narrow, 'yt'), true, 'an explicitly allowed platform loads');
    assert.equal(embedsAllowed(narrow, 'vimeo'), false, 'everything else stays off');
    assert.equal(embedsAllowed(narrow), true, 'and something is allowed at all');
    const rejected: ConsentRecord = { choice: 'rejected', at: new Date().toISOString(), version: CONSENT_VERSION };
    assert.equal(embedsAllowed(rejected, 'yt'), false, 'a global rejection with no exceptions keeps everything off');
  });

  it('keeps a record saved before the per-platform choice working as before', () => {
    const legacyOn: ConsentRecord = { choice: 'accepted', at: new Date().toISOString(), version: CONSENT_VERSION };
    assert.equal(embedsAllowed(legacyOn, 'yt'), true, 'an old accept covers every platform');
    const legacyOff: ConsentRecord = { choice: 'rejected', at: new Date().toISOString(), version: CONSENT_VERSION };
    assert.equal(embedsAllowed(legacyOff, 'yt'), false, 'an old rejection keeps every platform off');
    assert.equal(embedsAllowed(legacyOff), false);
  });

  it('saves one platform at a time, and a whole-choice answer starts the map over', () => {
    stubStorage();
    chooseConsent('accepted');
    choosePlatform('yt', false);
    assert.equal(embedsAllowed(loadConsent(), 'yt'), false, 'the one platform is narrowed');
    assert.equal(embedsAllowed(loadConsent(), 'vimeo'), true, 'the rest still load');
    chooseConsent('rejected');
    assert.equal(embedsAllowed(loadConsent(), 'yt'), false, 'a whole-choice answer clears the map');
    choosePlatform('yt', true);
    assert.equal(embedsAllowed(loadConsent(), 'yt'), true, 'and a platform can be switched on again');
  });

  it('names the platform of an id: the scheme it comes from, VibeShare for its own', () => {
    assert.equal(platformKeyOf('vs1abc'), 'vibeshare');
    assert.equal(platformKeyOf('yt:dQw4w9WgXcQ'), 'yt');
    assert.equal(platformKeyOf(undefined), 'vibeshare');
  });
});