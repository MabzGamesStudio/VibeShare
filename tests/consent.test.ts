import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONSENT_VERSION, chooseConsent, embedsAllowed, loadConsent, type ConsentRecord } from '../gui/src/consent.js';

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
});