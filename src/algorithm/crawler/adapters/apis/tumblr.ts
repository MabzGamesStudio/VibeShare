// Tumblr: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Tumblr.
import { formatSource, sourceFromUrl } from '../../../../shared/sources.js';

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso, videoFormat } from '../../types.js';

export const tumblr = apiAdapter({
  ...hostMatcher(['tumblr.com']),
  id: 'tumblr',
  label: 'Tumblr',
  description: 'Photo and video posts tagged with the queries.',
  api: {
    signupUrl: 'https://www.tumblr.com/oauth/apps',
    credentials: [{ key: 'apiKey', label: 'OAuth consumer key (API key)', secret: true }],
    note: '1,000 requests an hour and 5,000 a day per app.',
    defaultDailyLimit: 4000,
  },
  defaults: { apiKey: '' },
  async find(ctx, config, query) {
    const tag = query.trim().toLowerCase();
    const data = (await ctx.api(`https://api.tumblr.com/v2/tagged?tag=${q(tag)}&api_key=${q(config.apiKey)}&filter=text`)).json<Json>();
    return list(data.response).flatMap((post): Discovered[] => {
      const page = str(post.post_url);
      if (!page) return [];
      const blog = str(post.blog_name);
      const base = {
        id: `url:${q(page)}`,
        title: str(post.summary) ?? str(post.caption) ?? `${blog ?? 'Tumblr'} post`,
        tags: list<string>(post.tags).slice(0, 10),
        publishedAt: toIso(num(post.timestamp)),
        creator: blog ? { id: `tumblr:${blog}`, name: blog, url: `https://${blog}.tumblr.com/` } : undefined,
        pageUrl: page,
        stats: { likes: num(post.note_count) },
        adapter: 'tumblr',
      };
      if (post.type === 'photo') {
        const photo = obj(list<Json>(post.photos)[0]);
        const original = obj(photo.original_size);
        if (!str(original.url)) return [];
        const small = list<Json>(photo.alt_sizes).find((size) => (num(size.width) ?? 0) <= 500);
        return [item({ ...base, format: 'image', thumbnailUrl: str(small?.url) ?? String(original.url), media: { url: String(original.url), type: 'image', width: num(original.width), height: num(original.height) } })];
      }
      if (post.type === 'video') {
        const embedded = str(post.permalink_url) ? sourceFromUrl(String(post.permalink_url)) : null;
        const width = num(post.thumbnail_width);
        const height = num(post.thumbnail_height);
        if (embedded && embedded.scheme !== 'url') return [item({ ...base, id: formatSource(embedded), format: videoFormat(width, height), thumbnailUrl: str(post.thumbnail_url) })];
        if (!str(post.video_url)) return [];
        return [item({ ...base, format: videoFormat(width, height), thumbnailUrl: str(post.thumbnail_url), media: { url: String(post.video_url), type: 'video', width, height } })];
      }
      return [];
    });
  },
});
