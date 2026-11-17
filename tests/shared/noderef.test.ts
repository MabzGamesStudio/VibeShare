// The node-reference registries: node kinds and key algorithms are open — the parser
// reads them, so a fork registers its own (`storage`, another key format) without
// touching parseNodeRef. The built-ins must stay byte-identical.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatNodeRef,
  keyAlgorithms,
  keyAlgorithmOf,
  nodeTypes,
  parseNodeRef,
  parseNodeRefs,
  registerKeyAlgorithm,
  registerNodeType,
} from '../../src/shared/noderef.js';

const KEY = `vk1${'a'.repeat(52)}`;

describe('node references', () => {
  it('parses and formats the references it always has, byte for byte', () => {
    for (const type of ['provider', 'algorithm'] as const) {
      const ref = `vs:${type}:${KEY}@https://cdn.example.org`;
      const parsed = parseNodeRef(ref);
      assert.ok(parsed);
      assert.equal(parsed.type, type);
      assert.equal(parsed.id, KEY);
      assert.equal(parsed.url, 'https://cdn.example.org');
      assert.equal(formatNodeRef({ type: parsed.type!, id: parsed.id!, url: parsed.url }), ref);
    }
    // Keys and types are case-insensitive on the wire, and lower-cased on the way in.
    const mixed = parseNodeRef(`VS:PROVIDER:${KEY.toUpperCase()}@https://cdn.example.org`);
    assert.equal(mixed?.type, 'provider');
    assert.equal(mixed?.id, KEY);
    // A bare URL works and carries no type or key.
    assert.deepEqual(parseNodeRef('https://cdn.example.org/'), { url: 'https://cdn.example.org' });
    // …and so does the vibeshare:// prefix.
    assert.equal(parseNodeRef(`vibeshare://vs:algorithm:${KEY}@http://203.0.113.7:7702`)?.url, 'http://203.0.113.7:7702');
  });

  it('rejects references of unregistered kinds and malformed keys', () => {
    assert.equal(parseNodeRef(`vs:storage:${KEY}@https://cdn.example.org`), null);
    assert.equal(parseNodeRef(`vs:provider:vk1tooshort@https://cdn.example.org`), null);
    assert.equal(parseNodeRef(`vs:provider:${KEY}@not a url`), null);
    const { refs, invalid } = parseNodeRefs(`vs:provider:${KEY}@https://a.example\nhttps://b.example\ngarbage`);
    assert.equal(refs.length, 2);
    assert.deepEqual(invalid, ['garbage']);
  });

  it('parses a reference of a kind and a key format a fork registered', () => {
    registerNodeType({ id: 'storage', label: 'Storage node', description: 'Holds replicas.' });
    assert.ok(nodeTypes().some((type) => type.id === 'storage'));

    const storageRef = `vs:storage:${KEY}@https://cdn.example.org`;
    assert.equal(parseNodeRef(storageRef)?.type, 'storage');
    assert.equal(formatNodeRef({ type: 'storage', id: KEY, url: 'https://cdn.example.org' }), storageRef);

    registerKeyAlgorithm({
      prefix: 'kt1',
      label: 'Test keys',
      bytes: 8,
      validate: (id) => /^kt1[a-z2-7]{13}$/.test(id),
      generate: () => `kt1${'b'.repeat(13)}`,
    });
    assert.ok(keyAlgorithms().some((algorithm) => algorithm.prefix === 'kt1'));
    assert.equal(keyAlgorithmOf('kt1bbbbbbbbbbbbb')?.prefix, 'kt1');
    assert.equal(parseNodeRef(`vs:algorithm:kt1bbbbbbbbbbbbb@https://cdn.example.org`)?.id, 'kt1bbbbbbbbbbbbb');
  });

  it('keeps vk1 (Ed25519) as the built-in key format', () => {
    const ed = keyAlgorithmOf(KEY);
    assert.equal(ed?.prefix, 'vk1');
    assert.equal(ed?.label, 'Ed25519');
    assert.equal(ed?.bytes, 32);
    assert.ok(ed?.validate(KEY));
    assert.ok(!ed?.validate('vk1nope'));
    const fresh = ed!.generate();
    assert.ok(ed?.validate(fresh), 'a generated id validates as its own algorithm');
  });
});
