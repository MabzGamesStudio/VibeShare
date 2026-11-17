// GIPHY: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows GIPHY.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';
import type { Rating } from '../../../../shared/taxonomy.js';

const GIPHY_RATINGS: Record<string, Rating> = { g: 'all', pg: '10+', 'pg-13': '13+', r: '16+' };

export const giphy = apiAdapter({
  ...hostMatcher(['giphy.com']),
  id: 'giphy',
  label: 'GIPHY',
  description: 'GIFs matching the queries (up to PG-13).',
  api: {
    signupUrl: 'https://developers.giphy.com/dashboard/',
    credentials: [{ key: 'apiKey', label: 'API key', secret: true }],
    note: 'Beta keys are limited to 100 calls an hour; apply for a production key for more.',
    defaultDailyLimit: 1000,
  },
  defaults: { apiKey: '' },
  async find(ctx, config, query) {
    const data = (await ctx.api(`https://api.giphy.com/v1/gifs/search?api_key=${q(config.apiKey)}&q=${q(query)}&limit=20&rating=pg-13`)).json<Json>();
    return list(data.data).flatMap((gif): Discovered[] => {
      const images = obj(gif.images);
      const full = obj(images.downsized_large ?? images.original);
      const page = str(gif.url);
      if (!page || !str(full.url)) return [];
      const user = obj(gif.user);
      return [
        item({
          id: `url:${q(page)}`,
          title: str(gif.title) ?? 'GIF',
          format: 'image',
          rating: GIPHY_RATINGS[str(gif.rating) ?? ''] ?? '13+',
          publishedAt: toIso(str(gif.import_datetime)?.replace(' ', 'T') + 'Z'),
          creator: str(gif.username) ? { id: `giphy:${gif.username}`, name: str(user.display_name) ?? String(gif.username), url: str(user.profile_url) } : undefined,
          thumbnailUrl: str(obj(images.fixed_height_still).url) ?? str(obj(images.downsized_still).url),
          media: { url: String(full.url), type: 'image', width: num(full.width), height: num(full.height) },
          pageUrl: page,
          adapter: 'giphy',
        }),
      ];
    });
  },
});
