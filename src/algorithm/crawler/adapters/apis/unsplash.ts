// Unsplash: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Unsplash.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';

export const unsplash = apiAdapter({
  ...hostMatcher(['unsplash.com']),
  id: 'unsplash',
  label: 'Unsplash',
  description: 'Free photos matching the queries.',
  api: {
    signupUrl: 'https://unsplash.com/oauth/applications',
    credentials: [{ key: 'accessKey', label: 'Access key', secret: true }],
    note: 'Demo apps get 50 requests an hour (apply for production for more). Unsplash asks apps to hotlink its images and credit the photographer, as VibeShare does.',
    defaultDailyLimit: 1000,
  },
  defaults: { accessKey: '' },
  async find(ctx, config, query) {
    const data = (
      await ctx.api(`https://api.unsplash.com/search/photos?query=${q(query)}&per_page=20&content_filter=high`, {
        headers: { authorization: `Client-ID ${config.accessKey}`, 'accept-version': 'v1' },
      })
    ).json<Json>();
    return list(data.results).flatMap((photo): Discovered[] => {
      const urls = obj(photo.urls);
      const page = str(obj(photo.links).html);
      const image = str(urls.regular);
      if (!page || !image) return [];
      const user = obj(photo.user);
      const width = num(photo.width);
      const height = num(photo.height);
      return [
        item({
          id: `url:${q(page)}`,
          title: str(photo.description) ?? str(photo.alt_description) ?? `Photo by ${str(user.name) ?? 'Unsplash'}`,
          format: 'image',
          rating: 'all',
          publishedAt: toIso(str(photo.created_at)),
          creator: str(user.username) ? { id: `unsplash:${user.username}`, name: str(user.name) ?? String(user.username), url: str(obj(user.links).html) } : undefined,
          thumbnailUrl: str(urls.small),
          media: { url: image, type: 'image', width: 1080, height: width && height ? Math.round((1080 * height) / width) : undefined },
          pageUrl: page,
          stats: { likes: num(photo.likes) },
          adapter: 'unsplash',
        }),
      ];
    });
  },
});
