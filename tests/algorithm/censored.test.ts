// The fuzzy matching behind the censored-words filter: evasions are folded back to the
// word they stand for ("@R+" is "art") before anything is compared, and close variants of
// longer words are caught while short innocent neighbours are left alone.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AlgorithmNode, censorTokens, isCensoredVariant, normalizeCensorWord } from '../../src/algorithm/node.js';
import { addCensoredWords, censorVariants, censoredIn } from '../../src/algorithm/routes/comments.js';

/** The node's censorship store, as the word-set routes see it. */
const fakeNode = () =>
  ({ censorship: { data: { words: [], adjacent: [] }, changed() {} } }) as unknown as AlgorithmNode;

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

describe('censored word variants', () => {
  it('generates the lookalike spellings of a word — bounded and deterministic', () => {
    const variants = censorVariants('art');
    assert.ok(variants.includes('@rt'), 'one-character substitutions');
    assert.ok(variants.includes('ar+'));
    assert.ok(variants.includes('@r+'), 'pairs of substitutions');
    assert.ok(variants.includes('aRt'), 'case tricks');
    assert.ok(!variants.includes('art'), 'the word itself is not a variant');
    assert.ok(variants.length <= 64, 'capped per word');
    assert.deepEqual(censorVariants('art'), variants, 'the same word always yields the same list');
    assert.deepEqual(censorVariants('art '), variants, 'spelling generation ignores padding');
  });

  it('covers evasions the folder alone cannot reach ("8i9" for "big")', () => {
    assert.notEqual(normalizeCensorWord('8i9'), 'big', '8 and 9 fold to nothing');
    assert.ok(!isCensoredVariant('8i9', 'big'), 'the three-letter rule alone would miss it');
    assert.ok(censorVariants('big').includes('8i9'), 'the stored spellings carry it');
  });

  it('keeps the variants out of the list but matches through them', () => {
    const node = fakeNode();
    addCensoredWords(node, 'words', 'art, language\n@R+');
    assert.deepEqual(node.censorship.data.words, ['art', 'language'], 'only what the operator typed is listed (normalised, deduped)');
    assert.ok(!node.censorship.data.words.includes('@r+'), 'the lookalikes never show in the list');
    assert.ok((node.censorship.data.variants ?? []).length > 0, 'they are kept for matching');
    assert.equal(censoredIn(node, 'a comment with @R+ in it'), 'censored', '"art" is caught in its @R+ form');
    assert.equal(censoredIn(node, 'a plain comment'), null);
  });

  it('adds a whole list in one go — commas and new lines both split it', () => {
    const node = fakeNode();
    const result = addCensoredWords(node, 'words', 'art, language, @R+,\nart');
    assert.equal(result.changed, true);
    assert.deepEqual(node.censorship.data.words, ['art', 'language'], 'trimmed, deduped and normalised');
    assert.match(result.note ?? '', /Added 2 words/);
  });
});