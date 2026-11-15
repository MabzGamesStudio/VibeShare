// The fuzzy matching behind the censored-words filter: evasions are folded back to the
// word they stand for ("@R+" is "art") before anything is compared, and close variants of
// longer words are caught while short innocent neighbours are left alone.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { censorTokens, isCensoredVariant, normalizeCensorWord } from '../src/algorithm/node.js';

describe('censored word matching', () => {
  it('folds leet-speak, lookalikes and punctuation back to plain words', () => {
    assert.equal(normalizeCensorWord('@R+'), 'art');
    assert.equal(normalizeCensorWord('A-R-T'), 'art');
    assert.equal(normalizeCensorWord('sci3nc3'), 'science');
    assert.equal(normalizeCensorWord('5t0ry'), 'story');
  });

  it('collapses padded letters so "arrrt" reads as "art" too', () => {
    assert.equal(normalizeCensorWord('arrrt'), 'art');
    assert.equal(normalizeCensorWord('heeello'), normalizeCensorWord('hello'));
  });

  it('reads a comment as its normalized words, in order', () => {
    assert.deepEqual(censorTokens('plain @R+ text'), ['plain', 'art', 'text']);
  });

  it('matches exact words after folding, and close variants of longer words only', () => {
    assert.ok(isCensoredVariant('@R+', 'art'));
    assert.ok(isCensoredVariant('ARRT', 'art'));
    assert.ok(isCensoredVariant('sci3nc3', 'science'));
    assert.ok(isCensoredVariant('scienece', 'science'), 'one inserted letter still counts');
    // Short words match exactly only: "ate" is not "art", and neither is "start".
    assert.ok(!isCensoredVariant('ate', 'art'));
    assert.ok(!isCensoredVariant('start', 'art'));
    assert.ok(!isCensoredVariant('nature', 'science'));
    assert.ok(!isCensoredVariant('', 'art'));
  });
});