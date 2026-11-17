// Jamendo: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Jamendo.

import { Json, apiAdapter, item, list, num, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';

export const jamendo = apiAdapter({
  ...hostMatcher(['jamendo.com']),
  id: 'jamendo',
  label: 'Jamendo',
  description: 'Free, Creative Commons music matching the queries (streams directly).',
  api: {
    signupUrl: 'https://devportal.jamendo.com/',
    credentials: [{ key: 'clientId', label: 'Client ID' }],
    note: 'Free for non-commercial use: 35,000 requests a month.',
    defaultDailyLimit: 1000,
  },
  defaults: { clientId: '' },
  async find(ctx, config, query) {
    const data = (
      await ctx.api(`https://api.jamendo.com/v3.0/tracks/?client_id=${q(config.clientId)}&format=json&limit=20&search=${q(query)}&imagesize=300&audioformat=mp32`)
    ).json<Json>();
    return list(data.results).flatMap((track): Discovered[] => {
      const page = str(track.shareurl);
      const title = str(track.name);
      if (!page || !title || !str(track.audio)) return [];
      return [
        item({
          id: `url:${q(page)}`,
          title,
          format: 'music',
          rating: 'all',
          durationSeconds: num(track.duration),
          publishedAt: toIso(str(track.releasedate)),
          creator: str(track.artist_id) ? { id: `jamendo:${track.artist_id}`, name: str(track.artist_name) ?? 'Artist', url: `https://www.jamendo.com/artist/${track.artist_id}` } : undefined,
          thumbnailUrl: str(track.image) ?? str(track.album_image),
          media: { url: String(track.audio), type: 'audio' },
          pageUrl: page,
          topics: ['music'],
          adapter: 'jamendo',
        }),
      ];
    });
  },
});
