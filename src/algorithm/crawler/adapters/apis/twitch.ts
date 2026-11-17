// Twitch: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Twitch.

import { Json, apiAdapter, item, list, num, q, str } from './common.js';
import { type Discovered, schemeMatcher, toIso } from '../../types.js';

export const twitch = apiAdapter({
  ...schemeMatcher('twitch'),
  id: 'twitch',
  label: 'Twitch',
  description: 'Live channels matching a search; top videos of the game or category a query names.',
  api: {
    signupUrl: 'https://dev.twitch.tv/console/apps',
    credentials: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    note: 'Register an application; the crawler uses an app access token (client credentials).',
    defaultDailyLimit: 5000,
  },
  defaults: { clientId: '', clientSecret: '' },
  async find(ctx, config, query) {
    const token = await ctx.token(async () => {
      const data = (
        await ctx.api('https://id.twitch.tv/oauth2/token', {
          form: { client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'client_credentials' },
        })
      ).json<Json>();
      return { token: String(data.access_token), expiresIn: num(data.expires_in) };
    });
    const headers = { 'client-id': config.clientId, authorization: `Bearer ${token}` };
    const live = (await ctx.api(`https://api.twitch.tv/helix/search/channels?query=${q(query)}&live_only=true&first=10`, { headers })).json<Json>();
    const items: Discovered[] = list(live.data).flatMap((channel): Discovered[] => {
      const login = str(channel.broadcaster_login);
      if (!login) return [];
      return [
        item({
          id: `twitch:${login}`,
          title: str(channel.title) ?? str(channel.display_name) ?? login,
          format: 'live',
          tags: list<string>(channel.tags).slice(0, 10),
          publishedAt: toIso(str(channel.started_at)),
          creator: { id: `twitch:${login}`, name: str(channel.display_name) ?? login, url: `https://www.twitch.tv/${login}` },
          thumbnailUrl: str(channel.thumbnail_url),
          pageUrl: `https://www.twitch.tv/${login}`,
          adapter: 'twitch',
        }),
      ];
    });
    const category = list(
      (await ctx.api(`https://api.twitch.tv/helix/search/categories?query=${q(query)}&first=1`, { headers })).json<Json>().data
    )[0];
    if (str(category?.id)) {
      const videos = (await ctx.api(`https://api.twitch.tv/helix/videos?game_id=${q(String(category.id))}&first=20&sort=views`, { headers })).json<Json>();
      for (const video of list(videos.data)) {
        const id = str(video.id);
        const title = str(video.title);
        if (!id || !title) continue;
        const duration = str(video.duration)?.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
        items.push(
          item({
            id: `twitch:v${id}`,
            title,
            description: str(video.description),
            format: 'video',
            durationSeconds: duration ? Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0) : undefined,
            publishedAt: toIso(str(video.created_at)),
            creator: str(video.user_login) ? { id: `twitch:${video.user_login}`, name: str(video.user_name) ?? String(video.user_login), url: `https://www.twitch.tv/${video.user_login}` } : undefined,
            thumbnailUrl: str(video.thumbnail_url)?.replace('%{width}', '640').replace('%{height}', '360'),
            pageUrl: str(video.url),
            stats: { views: num(video.view_count) },
            adapter: 'twitch',
          })
        );
      }
    }
    return items;
  },
});
