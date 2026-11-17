// Twitter (X): content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Twitter (X).

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, schemeMatcher, toIso, videoFormat } from '../../types.js';

export const x = apiAdapter({
  ...schemeMatcher('x'),
  id: 'x',
  label: 'Twitter (X)',
  description: 'Recent posts with photos or video matching the queries.',
  api: {
    signupUrl: 'https://developer.x.com/en/portal/dashboard',
    credentials: [{ key: 'bearerToken', label: 'Bearer token', secret: true }],
    note: 'Searching needs a paid X API tier; each tier caps how many posts you can read a month.',
    defaultDailyLimit: 100,
  },
  defaults: { bearerToken: '' },
  async find(ctx, config, query) {
    const search = `${query} has:media -is:retweet -is:reply`;
    const url =
      `https://api.twitter.com/2/tweets/search/recent?query=${q(search)}&max_results=20&expansions=attachments.media_keys,author_id` +
      '&media.fields=type,url,preview_image_url,width,height,duration_ms,variants&user.fields=name,username&tweet.fields=created_at,public_metrics,possibly_sensitive';
    const data = (await ctx.api(url, { headers: { authorization: `Bearer ${config.bearerToken}` } })).json<Json>();
    const includes = obj(data.includes);
    const media = new Map(list<Json>(includes.media).map((entry) => [String(entry.media_key), entry]));
    const users = new Map(list<Json>(includes.users).map((entry) => [String(entry.id), entry]));
    return list(data.data).flatMap((post): Discovered[] => {
      const id = str(post.id);
      const attached = media.get(String(list<string>(obj(post.attachments).media_keys)[0]));
      if (!id || !attached) return [];
      const user = users.get(String(post.author_id));
      const text = (str(post.text) ?? '').replace(/https:\/\/t\.co\/\S+/g, '').trim();
      const width = num(attached.width);
      const height = num(attached.height);
      const mp4 = list<Json>(attached.variants)
        .filter((variant) => variant.content_type === 'video/mp4')
        .sort((a, b) => (num(b.bit_rate) ?? 0) - (num(a.bit_rate) ?? 0))[0];
      const photo = attached.type === 'photo';
      return [
        item({
          id: `x:${id}`,
          title: text || `Post by @${str(user?.username) ?? 'x'}`,
          format: photo ? 'image' : videoFormat(width, height),
          rating: post.possibly_sensitive ? '18+' : undefined,
          durationSeconds: num(attached.duration_ms) !== undefined ? Number(attached.duration_ms) / 1000 : undefined,
          publishedAt: toIso(str(post.created_at)),
          creator: user ? { id: `x:${user.username}`, name: str(user.name) ?? String(user.username), url: `https://x.com/${user.username}` } : undefined,
          thumbnailUrl: str(attached.preview_image_url) ?? str(attached.url),
          media: photo && str(attached.url) ? { url: String(attached.url), type: 'image', width, height } : mp4 ? { url: String(mp4.url), type: 'video', width, height } : undefined,
          pageUrl: user ? `https://x.com/${user.username}/status/${id}` : `https://x.com/i/status/${id}`,
          stats: { likes: num(obj(post.public_metrics).like_count) },
          adapter: 'x',
        }),
      ];
    });
  },
});
