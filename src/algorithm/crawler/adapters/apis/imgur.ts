// Imgur: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Imgur.

import { Json, apiAdapter, item, list, num, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso, videoFormat } from '../../types.js';

export const imgur = apiAdapter({
  ...hostMatcher(['imgur.com']),
  id: 'imgur',
  label: 'Imgur',
  description: 'Top gallery posts matching the queries.',
  api: {
    signupUrl: 'https://api.imgur.com/oauth2/addclient',
    credentials: [{ key: 'clientId', label: 'Client ID' }],
    note: 'About 12,500 requests a day per app. Commercial use needs a paid plan with Imgur.',
    defaultDailyLimit: 5000,
  },
  defaults: { clientId: '' },
  async find(ctx, config, query) {
    const data = (await ctx.api(`https://api.imgur.com/3/gallery/search/top/all/0?q=${q(query)}`, { headers: { authorization: `Client-ID ${config.clientId}` } })).json<Json>();
    return list(data.data).flatMap((post): Discovered[] => {
      const image = post.is_album ? list<Json>(post.images)[0] : post;
      const link = str(image?.link);
      const id = str(post.id);
      if (!image || !link || !id) return [];
      const video = str(image.mp4) ?? (str(image.type)?.startsWith('video/') ? link : undefined);
      const width = num(image.width);
      const height = num(image.height);
      return [
        item({
          id: `url:${q(`https://imgur.com/gallery/${id}`)}`,
          title: str(post.title) ?? 'Imgur post',
          format: video ? videoFormat(width, height) : 'image',
          rating: post.nsfw ? '18+' : undefined,
          tags: list<Json>(post.tags).map((tag) => String(tag.name)).filter(Boolean).slice(0, 10),
          publishedAt: toIso(num(post.datetime)),
          creator: str(post.account_url) ? { id: `imgur:${post.account_url}`, name: String(post.account_url), url: `https://imgur.com/user/${post.account_url}` } : undefined,
          thumbnailUrl: video ? `https://i.imgur.com/${str(image.id) ?? id}h.jpg` : link.replace(/(\.\w+)$/, 'h$1'),
          media: { url: video ?? link, type: video ? 'video' : 'image', width, height },
          pageUrl: `https://imgur.com/gallery/${id}`,
          stats: { views: num(post.views), likes: num(post.ups) },
          adapter: 'imgur',
        }),
      ];
    });
  },
});
