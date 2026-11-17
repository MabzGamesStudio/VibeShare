// Spotify: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Spotify.

import { Json, apiAdapter, basic, item, list, num, obj, q, str } from './common.js';
import { type Discovered, schemeMatcher, toIso } from '../../types.js';

export const spotify = apiAdapter({
  ...schemeMatcher('spotify'),
  id: 'spotify',
  label: 'Spotify',
  description: 'Songs and podcast episodes matching the queries (played through the Spotify embed).',
  api: {
    signupUrl: 'https://developer.spotify.com/dashboard',
    credentials: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    note: 'Create an app; the crawler uses the client-credentials flow. Spotify limits requests per 30 seconds.',
    defaultDailyLimit: 5000,
  },
  defaults: { clientId: '', clientSecret: '', market: 'US' },
  async find(ctx, config, query) {
    const token = await ctx.token(async () => {
      const data = (
        await ctx.api('https://accounts.spotify.com/api/token', {
          headers: { authorization: basic(config.clientId, config.clientSecret) },
          form: { grant_type: 'client_credentials' },
        })
      ).json<Json>();
      return { token: String(data.access_token), expiresIn: num(data.expires_in) };
    });
    const data = (
      await ctx.api(`https://api.spotify.com/v1/search?q=${q(query)}&type=track,episode&limit=10&market=${q(config.market || 'US')}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<Json>();
    const items: Discovered[] = [];
    for (const track of list(obj(data.tracks).items)) {
      const id = str(track.id);
      const title = str(track.name);
      if (!id || !title) continue;
      const artist = list<Json>(track.artists)[0];
      const album = obj(track.album);
      const images = list<Json>(album.images);
      items.push(
        item({
          id: `spotify:track:${id}`,
          title,
          format: 'music',
          rating: track.explicit ? '16+' : 'all',
          durationSeconds: num(track.duration_ms) !== undefined ? Math.round(Number(track.duration_ms) / 1000) : undefined,
          publishedAt: toIso(str(album.release_date)),
          creator: artist && str(artist.id) ? { id: `spotify:artist:${artist.id}`, name: str(artist.name) ?? 'Artist', url: `https://open.spotify.com/artist/${artist.id}` } : undefined,
          thumbnailUrl: str((images[1] ?? images[0])?.url),
          pageUrl: str(obj(track.external_urls).spotify),
          topics: ['music'],
          adapter: 'spotify',
        })
      );
    }
    for (const episode of list(obj(data.episodes).items)) {
      if (!episode) continue;
      const id = str(episode.id);
      const title = str(episode.name);
      if (!id || !title) continue;
      const images = list<Json>(episode.images);
      items.push(
        item({
          id: `spotify:episode:${id}`,
          title,
          description: str(episode.description)?.slice(0, 5000),
          format: 'podcast',
          rating: episode.explicit ? '16+' : undefined,
          durationSeconds: num(episode.duration_ms) !== undefined ? Math.round(Number(episode.duration_ms) / 1000) : undefined,
          publishedAt: toIso(str(episode.release_date)),
          thumbnailUrl: str((images[1] ?? images[0])?.url),
          pageUrl: str(obj(episode.external_urls).spotify),
          adapter: 'spotify',
        })
      );
    }
    return items;
  },
});
