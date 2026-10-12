import { join } from 'node:path';
import { AlgorithmNode } from '../algorithm/node.js';
import { ClientNode } from '../client/daemon.js';
import { ProviderNode } from '../provider/node.js';
import { buildManifestFromBuffer, contentIdOf, signManifest, type ManifestMeta } from '../shared/content.js';
import { identityFromSeed, sha256 } from '../shared/crypto.js';
import { base32Encode } from '../shared/encoding.js';
import type { CreatorKind } from '../shared/taxonomy.js';
import { clip } from './clips.js';
import { artwork, dataUrl, melody, plasma, svgArt } from './media.js';

const WELCOME = `# Welcome to VibeShare

VibeShare is a file sharing and streaming network without a center. Three kinds of nodes work together, and anyone can run any of them:

**Client nodes** (this app) are where you watch, listen, read and publish. Your client keeps your keys, your credits and your choice of nodes.

**Content provider nodes** store content and send it to clients, chunk by chunk, for credits. Each provider runs its own credits and decides how you get them: buying them (crypto, cards, vouchers…) or earning them by storing data for the provider.

**Search algorithm nodes** decide what you see. They list (whitelist) or block (blacklist) content ids, describe them with tags, ratings and topics, rank them, and answer your searches. Ids they never reviewed are "unknown".

You choose which nodes to use, in which order. If a node is slow, offline, too expensive or you just don't like it, swap it out on the Nodes page — every node is one copy-pastable reference.
`;

const HOW = `How a piece of content gets to you

1. The home page asks your algorithm nodes for content ids that match your preferences (formats, age rating, topics, creators).
2. You pick one. Its id is the hash of a manifest listing the chunks of the file, plus optional fallbacks such as a YouTube or Internet Archive copy.
3. Your client asks your content providers, in your priority order, for the manifest and then for the chunks. Every chunk is checked against its hash, so no provider has to be trusted.
4. If no provider has it, the client shows the fallback: the content embedded from where it already lives.

Seeking in a video or song only downloads the chunks you need, and chunks you already have are reused for free.
`;

interface DemoItem {
  title: string;
  name: string;
  mime: string;
  data: () => Buffer;
  meta: ManifestMeta;
  creator: { seed: string; name: string; kind: CreatorKind };
  topics: string[];
  tags: string[];
  art: number;
  /** A thumbnail (PNG) other than the artwork for `art`. */
  thumb?: () => Buffer;
  description: string;
}

const CREATORS = {
  studio: { seed: 'demo-studio', name: 'Lumen Studio', kind: 'group' as const },
  ada: { seed: 'demo-ada', name: 'Ada Synth', kind: 'person' as const },
  vibeshare: { seed: 'demo-vibeshare', name: 'VibeShare Project', kind: 'group' as const },
};

function demoIdentity(seed: string) {
  return identityFromSeed(sha256(`vibeshare-demo:${seed}`));
}

const ITEMS: DemoItem[] = [
  {
    title: 'Aurora Bloom',
    name: 'aurora-bloom.svg',
    mime: 'image/svg+xml',
    data: () => svgArt(7),
    meta: { format: 'image', rating: 'all' },
    creator: CREATORS.studio,
    topics: ['art'],
    tags: ['generative', 'wallpaper'],
    art: 3,
    description: 'Generative artwork: soft light blooming over a dark gradient.',
  },
  {
    title: 'Evening Melody',
    name: 'evening-melody.wav',
    mime: 'audio/wav',
    data: () => melody(30, 3),
    meta: { format: 'music', rating: 'all', durationSeconds: 30 },
    creator: CREATORS.ada,
    topics: ['music'],
    tags: ['ambient', 'synth', 'calm'],
    art: 11,
    description: 'A short pentatonic melody over a warm drone. Streams in three 1 MiB chunks.',
  },
  {
    title: 'Ambient Drift',
    name: 'ambient-drift.wav',
    mime: 'audio/wav',
    data: () => melody(60, 9),
    meta: { format: 'music', rating: 'all', durationSeconds: 60 },
    creator: CREATORS.ada,
    topics: ['music'],
    tags: ['ambient', 'focus'],
    art: 23,
    description: 'One minute of generated ambient music — seek around to see chunked streaming at work.',
  },
  {
    title: 'Welcome to VibeShare',
    name: 'welcome.md',
    mime: 'text/markdown',
    data: () => Buffer.from(WELCOME),
    meta: { format: 'article', rating: 'all' },
    creator: CREATORS.vibeshare,
    topics: ['learning', 'technology'],
    tags: ['guide', 'decentralized'],
    art: 31,
    description: 'What the three node types do and how you stay in control.',
  },
  {
    title: 'How content reaches you',
    name: 'how-it-works.txt',
    mime: 'text/plain',
    data: () => Buffer.from(HOW),
    meta: { format: 'article', rating: 'all' },
    creator: CREATORS.vibeshare,
    topics: ['learning', 'technology'],
    tags: ['guide', 'streaming'],
    art: 47,
    description: 'Manifests, chunks, hashes and fallbacks in four steps.',
  },
];

// Short vertical videos and a landscape video for the Shorts and Videos pages.
const CLIPS: DemoItem[] = [
  {
    title: 'Neon Plasma',
    name: 'neon-plasma.webm',
    mime: 'video/webm',
    data: () => clip('neon'),
    meta: { format: 'short-video', rating: 'all', durationSeconds: 6 },
    creator: CREATORS.studio,
    topics: ['art'],
    tags: ['loop', 'abstract'],
    art: 0,
    thumb: () => plasma('neon', 180, 320),
    description: 'Six seconds of shifting neon colour. Swipe up for the next short.',
  },
  {
    title: 'Ocean Swell',
    name: 'ocean-swell.webm',
    mime: 'video/webm',
    data: () => clip('ocean'),
    meta: { format: 'short-video', rating: 'all', durationSeconds: 6 },
    creator: CREATORS.ada,
    topics: ['nature', 'art'],
    tags: ['waves', 'calm', 'loop'],
    art: 0,
    thumb: () => plasma('ocean', 180, 320),
    description: 'Waves of blue and green rolling down the screen, with a soft chord.',
  },
  {
    title: 'Ember Rings',
    name: 'ember-rings.webm',
    mime: 'video/webm',
    data: () => clip('ember'),
    meta: { format: 'short-video', rating: 'all', durationSeconds: 6 },
    creator: CREATORS.studio,
    topics: ['art'],
    tags: ['rings', 'warm', 'loop'],
    art: 0,
    thumb: () => plasma('ember', 180, 320),
    description: 'Warm rings pulsing out from the centre.',
  },
  {
    title: 'Aurora Sweep',
    name: 'aurora-sweep.webm',
    mime: 'video/webm',
    data: () => clip('aurora'),
    meta: { format: 'video', rating: 'all', durationSeconds: 6 },
    creator: CREATORS.studio,
    topics: ['art', 'nature'],
    tags: ['aurora', 'loop'],
    art: 0,
    thumb: () => plasma('aurora', 400, 225),
    description: 'Curtains of green and violet light, streamed from the demo provider in one chunk.',
  },
];

// Images of different shapes for the Images page.
const IMAGES: DemoItem[] = [
  ['Violet Hour', 101, 900, 1600, 265, CREATORS.studio],
  ['Coral Reef', 202, 1200, 1200, 8, CREATORS.ada],
  ['Night Garden', 303, 1080, 1350, 150, CREATORS.studio],
  ['Glass Dunes', 404, 1600, 900, 32, CREATORS.ada],
  ['Polar Light', 505, 1080, 1620, 190, CREATORS.studio],
  ['Citrus Sky', 606, 1200, 1200, 48, CREATORS.ada],
].map(([title, seed, width, height, hue, creator]) => ({
  title: title as string,
  name: `${String(title).toLowerCase().replace(/ /g, '-')}.svg`,
  mime: 'image/svg+xml',
  data: () => svgArt(seed as number, width as number, height as number, hue as number),
  meta: { format: 'image', rating: 'all' },
  creator: creator as DemoItem['creator'],
  topics: ['art'],
  tags: ['generative', (width as number) < (height as number) ? 'portrait' : (width as number) > (height as number) ? 'landscape' : 'square'],
  art: seed as number,
  thumb: () => artwork(seed as number, Math.round((240 * (width as number)) / Math.max(width as number, height as number)), Math.round((240 * (height as number)) / Math.max(width as number, height as number))),
  description: 'Generative artwork: blurred light over a gradient.',
}));

const EXTERNAL = [
  {
    id: 'yt:aqz-KE-bpKQ~ia:BigBuckBunny_124',
    title: 'Big Buck Bunny',
    format: 'video' as const,
    topics: ['film', 'kids'],
    tags: ['animation', 'blender', 'open-movie'],
    description: 'The Blender Foundation open movie. Not on any provider: it is embedded from YouTube, with the Internet Archive as a second fallback.',
    creator: { id: 'name:blender-foundation', name: 'Blender Foundation', kind: 'company' as const },
    art: 59,
    durationSeconds: 596,
  },
  {
    // A native id no demo provider hosts: the client falls back to the copy named after the "~".
    id: `vs1${base32Encode(sha256('sintel-missing'))}~yt:eRsGyueVLvQ`,
    title: 'Sintel',
    format: 'video' as const,
    topics: ['film'],
    tags: ['animation', 'blender', 'fantasy', 'open-movie'],
    description: 'A native content id whose providers are gone: your client falls back to the YouTube copy carried in the id.',
    creator: { id: 'name:blender-foundation', name: 'Blender Foundation', kind: 'company' as const },
    art: 71,
    rating: '13+' as const,
    durationSeconds: 888,
  },
];

export interface DemoOptions {
  dataDir: string;
  basePort: number;
  guiDir: string | null;
}

export async function startDemo(options: DemoOptions) {
  const { dataDir, basePort, guiDir } = options;
  const provider = new ProviderNode({
    dataDir: join(dataDir, 'provider'),
    guiDir,
    overrides: {
      host: '127.0.0.1',
      port: basePort + 1,
      name: 'Demo Provider',
      description: 'Sample content provider of the VibeShare demo network.',
      signup: { grant: 1000 },
      pricing: { perMiB: 1, freeMiBPerDay: 10 },
      storageService: { challengeIntervalSeconds: 120, auto: { enabled: false } },
    },
  });
  const algorithm = new AlgorithmNode({
    dataDir: join(dataDir, 'algorithm'),
    guiDir,
    overrides: {
      host: '127.0.0.1',
      port: basePort + 2,
      name: 'Demo Curator',
      description: 'Hand-picked sample content of the VibeShare demo network.',
      rewards: { autoAcceptAgreement: 1 },
    },
  });
  await provider.start();
  await algorithm.start();

  // Seeds what is missing, so demo networks made by older versions get the newer samples too.
  const titles = new Set(algorithm.registry.all().map((entry) => entry.title));
  const missing = [...ITEMS, ...CLIPS, ...IMAGES].filter((item) => !titles.has(item.title));
  if (missing.length) {
    for (const [index, item] of missing.entries()) {
      const creator = demoIdentity(item.creator.seed);
      let manifest = await buildManifestFromBuffer(
        item.data(),
        { name: item.name, mime: item.mime, meta: { ...item.meta, title: item.title, topics: item.topics, tags: item.tags } },
        (id, chunk) => provider.store.putChunk(id, chunk)
      );
      manifest = signManifest(manifest, creator, { name: item.creator.name, kind: item.creator.kind });
      await provider.store.addContent(manifest, 'operator');
      const cid = contentIdOf(manifest);
      algorithm.registry.upsertCreator({ id: creator.id, name: item.creator.name, kind: item.creator.kind, keys: [creator.id] });
      algorithm.registry.upsert({
        id: cid,
        status: 'listed',
        title: item.title,
        description: item.description,
        format: item.meta.format ?? 'other',
        rating: item.meta.rating ?? 'all',
        topics: item.topics,
        tags: item.tags,
        durationSeconds: item.meta.durationSeconds,
        creatorId: creator.id,
        providers: [provider.reference()],
        publishedAt: new Date(Date.now() - (index + 1) * 5 * 3600_000).toISOString(),
      });
      algorithm.registry.setThumbnail(cid, dataUrl(item.thumb ? item.thumb() : artwork(item.art, 400, 225)));
      if (item.name === 'ambient-drift.wav') {
        provider.service.createJob({
          cid,
          title: item.title,
          chunks: manifest.chunks,
          replicas: 3,
          durationSeconds: 7 * 86400,
          rewards: { upfront: 5, perRetrieval: 1, perChallenge: 1, completion: 25 },
        });
      }
    }
  }
  if (!titles.has(EXTERNAL[0].title)) {
    for (const item of EXTERNAL) {
      algorithm.registry.upsertCreator(item.creator);
      algorithm.registry.upsert({
        id: item.id,
        status: 'listed',
        title: item.title,
        description: item.description,
        format: item.format,
        rating: item.rating ?? 'all',
        topics: item.topics,
        tags: item.tags,
        durationSeconds: item.durationSeconds,
        creatorId: item.creator.id,
        publishedAt: new Date(Date.now() - 40 * 3600_000).toISOString(),
      });
      algorithm.registry.setThumbnail(item.id, dataUrl(artwork(item.art, 400, 225)));
    }
    algorithm.registry.upsert({ id: 'x:1234567890', status: 'blocked', title: 'Free crypto giveaway', reason: 'Scam' });
  }
  provider.flush();
  algorithm.flush();

  const client = new ClientNode({ dataDir: join(dataDir, 'client'), port: basePort, guiDir });
  await client.start();
  if (!client.nodes.list().length) await client.nodes.add(`${algorithm.reference()}\n${provider.reference()}`);
  const vouchers = provider.payments.createVouchers(500, 2, 'demo');

  return {
    provider,
    algorithm,
    client,
    vouchers,
    async stop() {
      await client.stop();
      await provider.stop();
      await algorithm.stop();
    },
  };
}
