// Tenor: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Tenor.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';

export const tenor = apiAdapter({
  ...hostMatcher(['tenor.com']),
  id: 'tenor',
  label: 'Tenor',
  description: 'GIFs matching the queries (content filter: medium).',
  api: {
    signupUrl: 'https://developers.google.com/tenor/guides/quickstart',
    credentials: [{ key: 'apiKey', label: 'Google Cloud API key (Tenor API enabled)', secret: true }],
    note: 'Enable the Tenor API in a Google Cloud project and create an API key.',
    defaultDailyLimit: 5000,
  },
  defaults: { apiKey: '' },
  async find(ctx, config, query) {
    const data = (
      await ctx.api(`https://tenor.googleapis.com/v2/search?q=${q(query)}&key=${q(config.apiKey)}&client_key=vibeshare&limit=20&contentfilter=medium&media_filter=gif,tinygif`)
    ).json<Json>();
    return list(data.results).flatMap((gif): Discovered[] => {
      const formats = obj(gif.media_formats);
      const full = obj(formats.gif);
      const page = str(gif.itemurl);
      if (!page || !str(full.url)) return [];
      const dims = list<number>(full.dims);
      return [
        item({
          id: `url:${q(page)}`,
          title: str(gif.content_description) ?? str(gif.title) ?? 'GIF',
          format: 'image',
          rating: '13+',
          tags: list<string>(gif.tags).slice(0, 10),
          publishedAt: toIso(num(gif.created)),
          thumbnailUrl: str(obj(formats.tinygif).url),
          media: { url: String(full.url), type: 'image', width: dims[0], height: dims[1] },
          pageUrl: page,
          adapter: 'tenor',
        }),
      ];
    });
  },
});
