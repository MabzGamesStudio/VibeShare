// DeviantArt: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows DeviantArt.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';

export const deviantart = apiAdapter({
  ...hostMatcher(['deviantart.com']),
  id: 'deviantart',
  label: 'DeviantArt',
  description: 'Artwork tagged with the queries (mature content excluded).',
  api: {
    signupUrl: 'https://www.deviantart.com/developers/apps',
    credentials: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    note: 'Register an application; the crawler uses the client-credentials grant.',
    defaultDailyLimit: 2000,
  },
  defaults: { clientId: '', clientSecret: '' },
  async find(ctx, config, query) {
    const token = await ctx.token(async () => {
      const data = (
        await ctx.api('https://www.deviantart.com/oauth2/token', {
          form: { grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret },
        })
      ).json<Json>();
      return { token: String(data.access_token), expiresIn: num(data.expires_in) };
    });
    const tag = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!tag) return [];
    const data = (await ctx.api(`https://www.deviantart.com/api/v1/oauth2/browse/tags?tag=${q(tag)}&limit=24&mature_content=false&access_token=${q(token)}`)).json<Json>();
    return list(data.results).flatMap((art): Discovered[] => {
      const content = obj(art.content);
      const page = str(art.url);
      if (!page || !str(content.src) || art.is_mature) return [];
      const thumbs = list<Json>(art.thumbs);
      const author = obj(art.author);
      return [
        item({
          id: `url:${q(page)}`,
          title: str(art.title) ?? 'Artwork',
          format: 'image',
          tags: [tag],
          publishedAt: toIso(num(art.published_time)),
          creator: str(author.username) ? { id: `deviantart:${author.username}`, name: String(author.username), url: `https://www.deviantart.com/${author.username}` } : undefined,
          thumbnailUrl: str(thumbs.at(-1)?.src),
          media: { url: String(content.src), type: 'image', width: num(content.width), height: num(content.height) },
          pageUrl: page,
          stats: { likes: num(obj(art.stats).favourites) },
          adapter: 'deviantart',
        }),
      ];
    });
  },
});
