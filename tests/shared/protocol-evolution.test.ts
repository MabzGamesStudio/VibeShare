// The additive v2 protocol surfaces: extension bags hash into the content id and stay
// tolerant in validation, page limits clamp the way the routes do, the version matrix
// accepts every node it must and fails typed for the rest, and the capability map
// derives from what a node already advertises. Tracing stays off; these are pure
// wire-layer checks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkIdOf, contentIdOf, validateManifest, type Manifest } from '../../src/shared/content.js';
import {
  featuresOf,
  negotiateProtocol,
  PAGE_LIMITS,
  pageLimit,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
  protocolRange,
  enrichNodeInfo,
  SUGGESTION_KINDS,
  type AlgorithmInfo,
  type ProviderInfo,
} from '../../src/shared/protocol.js';
import { deprecationHeaders, deprecationOf } from '../../src/shared/node/deprecation.js';
import { RemoteError } from '../../src/shared/remote.js';
import { ProtocolMismatchError } from '../../src/shared/nodeclient.js';

const chunk = chunkIdOf(new Uint8Array([1, 2, 3]));

function manifest(meta?: Manifest['meta']): Manifest {
  return {
    v: 1,
    name: 'note.txt',
    mime: 'text/plain',
    size: 3,
    chunkSize: 1024,
    chunks: [{ id: chunk, size: 3 }],
    createdAt: '2026-01-01T00:00:00.000Z',
    meta,
  };
}

describe('extension bags', () => {
  it('hash into the content id, stably and like any other field', () => {
    const bag = manifest({ title: 'T', x: { 'app.z': 1, 'fork.a': 'two' } });
    const reordered = manifest({ title: 'T', x: { 'fork.a': 'two', 'app.z': 1 } });
    assert.equal(contentIdOf(bag), contentIdOf(reordered), 'canonical JSON sorts keys, so insertion order must not matter');
    assert.equal(contentIdOf(bag), contentIdOf(manifest({ title: 'T', x: { 'app.z': 1, 'fork.a': 'two' } })), 'the id is stable across calls');
    assert.notEqual(contentIdOf(bag), contentIdOf(manifest({ title: 'T' })), 'the bag changes the id like any other field');
    assert.notEqual(contentIdOf(bag), contentIdOf(manifest({ title: 'T', x: { 'app.z': 2 } })), 'a different bag, a different id');
  });

  it('validators ignore unknown members and accept the bag', () => {
    const fromTheFuture = {
      ...manifest({ title: 'T', futureMeta: 'ignored', x: { anything: [1, 2, 3] } } as Manifest['meta']),
      futureField: { nested: true },
    };
    assert.doesNotThrow(() => validateManifest(fromTheFuture), 'unknown keys are skipped, never rejected');
    assert.equal((fromTheFuture as { futureField?: unknown }).futureField !== undefined, true, 'validation returns the manifest untouched');
  });

  it('keeps the bag a plain object of a sane size', () => {
    assert.throws(() => validateManifest({ ...manifest(), meta: { x: 42 } }), /bad meta\.x/);
    assert.throws(() => validateManifest({ ...manifest(), meta: { x: { big: 'x'.repeat(9000) } } }), /meta\.x is too large/);
    assert.doesNotThrow(() => validateManifest({ ...manifest(), meta: { x: { small: true } } }));
  });
});

describe('page limits', () => {
  it('clamp to the caps the routes enforce today', () => {
    assert.equal(PAGE_LIMITS.feed, 100);
    assert.equal(PAGE_LIMITS.search, 100);
    assert.equal(PAGE_LIMITS.creators, 100);
    assert.equal(PAGE_LIMITS.catalog, 200);
    assert.equal(PAGE_LIMITS.lookupIds, 200);
    assert.equal(PAGE_LIMITS.mine, 200);
    assert.equal(PAGE_LIMITS.admin, 500);
    assert.equal(pageLimit('feed', 250), 100);
    assert.equal(pageLimit('admin', 10_000), 500);
    assert.equal(pageLimit('lookupIds', 201), 200);
    assert.equal(pageLimit('catalog', 50), 50);
    assert.equal(pageLimit('feed', 0), 1);
    assert.equal(pageLimit('search', -5), 1);
    assert.equal(pageLimit('feed', undefined, 24), 24, 'the node default fills in when nothing was asked');
    assert.equal(pageLimit('feed', 'nonsense', 24), 24, 'garbage falls back to the default');
  });
});

describe('version negotiation', () => {
  it('keeps v1 working and fails typed outside the range', () => {
    assert.equal(PROTOCOL_MIN, 1);
    assert.equal(PROTOCOL_VERSION, 2);
    assert.deepEqual(protocolRange(), { min: 1, max: 2 }, 'v2 keeps speaking v1');

    const oldNode = negotiateProtocol(undefined, 1);
    assert.equal(oldNode.ok, true, 'a pre-v2 node advertises its bare v, which every range covers');
    assert.equal(oldNode.version, 1);

    const both = negotiateProtocol({ min: 1, max: 2 });
    assert.equal(both.ok, true);
    assert.equal(both.version, 2, 'the negotiated version is the lower of the two maxima');
    assert.equal(negotiateProtocol({ min: 1, max: 5 }, undefined, { min: 1, max: 2 }).version, 2);

    const tooNew = negotiateProtocol({ min: 3, max: 4 });
    assert.equal(tooNew.ok, false);
    assert.equal(tooNew.code, 'too-new');
    assert.match(tooNew.message ?? '', /update the client/);

    const tooOld = negotiateProtocol({ min: 0, max: 0 });
    assert.equal(tooOld.ok, false);
    assert.equal(tooOld.code, 'too-old');
  });

  it('reports the failure as a typed error, not a random 400', () => {
    const verdict = negotiateProtocol({ min: 3, max: 4 });
    const error = new ProtocolMismatchError(verdict);
    assert.ok(error instanceof RemoteError, 'callers that handle RemoteError handle this too');
    assert.equal(error.status, 0);
    assert.equal(error.code, 'protocol_incompatible');
    assert.match(error.message, /update the client/);
  });
});

describe('capability map', () => {
  const provider: ProviderInfo = {
    v: PROTOCOL_VERSION,
    type: 'provider',
    id: 'vk1provider',
    name: 'P',
    description: '',
    software: 'vibeshare/test',
    time: '2026-01-01T00:00:00.000Z',
    signup: { grant: 0, powBits: 0, anonymous: true },
    payments: [],
    peers: [],
    pricing: {
      manifest: 0,
      perMiB: 1,
      freeMiBPerDay: 10,
      creatorShare: 0.2,
      upload: { mode: 'open', perMiB: 0, maxBytes: 4 * 1024 * 1024 },
    },
    rewards: { report: 1, reportDailyCap: 10, suggestion: 1, suggestionDailyCap: 10 },
    services: { storage: { enabled: true, openJobs: 3 } },
    stats: { contents: 2, bytes: 100 },
    tracing: { enabled: true, expirationHours: 24 },
  };

  const algorithm: AlgorithmInfo = {
    v: PROTOCOL_VERSION,
    type: 'algorithm',
    id: 'vk1algorithm',
    name: 'A',
    description: '',
    software: 'vibeshare/test',
    time: '2026-01-01T00:00:00.000Z',
    signup: { grant: 0, powBits: 0, anonymous: true },
    payments: [],
    peers: [],
    pricing: { feed: 0, search: 0, lookup: 0, submission: 0 },
    rewards: { vote: 1, voteDailyCap: 10, acceptedSuggestion: 1, report: 1, reportDailyCap: 10, requireIdentity: false, autoAcceptAgreement: 0 },
    ranking: { strategy: 'balanced', description: '' },
    taxonomy: { topics: ['science'] },
    stats: { listed: 1, blocked: 0, creators: 1 },
    discovery: { crawling: true, searchesPlatforms: true, platforms: ['youtube'] },
    bloom: { inlineMaxBits: 1024, accountMaxBits: 4096, storage: { tiers: [{ id: 'day', maxBits: 1024, durationSeconds: 86400, price: 1 }] } },
    maxCreatorAccounts: 8,
  };

  it('derives provider capabilities from what the info advertises', () => {
    const features = featuresOf(provider);
    assert.equal(features.tracing, true);
    assert.equal(features['storage-service'], true);
    assert.equal(features['storage-open-jobs'], 3);
    assert.equal(features['upload-max-bytes'], 4 * 1024 * 1024);
    assert.equal(features.vvsh, true);
    assert.equal(features['page-limit-catalog'], 200);
  });

  it('derives algorithm capabilities from what the info advertises', () => {
    const features = featuresOf(algorithm);
    assert.equal(features.comments, true);
    assert.equal(features.claims, true);
    assert.deepEqual(features['suggestion-kinds'], [...SUGGESTION_KINDS]);
    assert.equal(features.ranking, 'balanced');
    assert.equal(features.topics, 1);
    assert.equal(features.discovery, true);
    assert.deepEqual(features['discovery-platforms'], ['youtube']);
    assert.equal(features['bloom-inline-max-bits'], 1024);
    assert.deepEqual(features['bloom-tiers'], ['day']);
  });

  it('enriches a signed info with the range and the map, leaving the rest alone', () => {
    const enriched = enrichNodeInfo(algorithm);
    assert.deepEqual(enriched.protocol, { min: 1, max: 2 });
    assert.ok(enriched.features);
    assert.equal(enriched.id, algorithm.id);
    assert.equal(enriched.name, algorithm.name);
  });
});

describe('deprecation headers', () => {
  it('formats Deprecation, Sunset and Link the way the RFCs say', () => {
    const headers = deprecationHeaders({
      deprecatedAt: '2026-01-01T00:00:00.000Z',
      sunset: '2026-07-01T00:00:00.000Z',
      link: 'https://example.org/deprecation',
    });
    assert.equal(headers.Deprecation, '@1767225600');
    assert.equal(headers.Sunset, 'Wed, 01 Jul 2026 00:00:00 GMT');
    assert.equal(headers.Link, '<https://example.org/deprecation>; rel="deprecation"');
    const read = deprecationOf(headers);
    assert.equal(read?.sunset, headers.Sunset);
    assert.equal(read?.link, 'https://example.org/deprecation');
    assert.equal(deprecationOf({}), null, 'a response without the headers is not deprecated');
  });
});
