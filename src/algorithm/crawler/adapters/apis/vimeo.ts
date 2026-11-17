// Vimeo: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Vimeo.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, schemeMatcher, toIso, videoFormat } from '../../types.js';
import type { Rating } from '../../../../shared/taxonomy.js';

export const vimeo = apiAdapter({
  ...schemeMatcher('vimeo'),
  id: 'vimeo',
  label: 'Vimeo',
  description: 'Videos matching the queries, through the Vimeo API.',
  api: {
    signupUrl: 'https://developer.vimeo.com/apps',
    credentials: [{ key: 'accessToken', label: 'Access token (public scope)', secret: true }],
    note: 'Create an app and generate an unauthenticated (public) access token. Rate limits depend on your Vimeo plan.',
    defaultDailyLimit: 1000,
  },
  defaults: { accessToken: '' },
  async find(ctx, config, query) {
    const fields = 'uri,name,description,link,duration,width,height,created_time,pictures.sizes,user.name,user.link,user.uri,stats.plays,metadata.connections.likes.total,content_rating';
    const data = (
      await ctx.api(`https://api.vimeo.com/videos?query=${q(query)}&per_page=20&sort=relevant&fields=${fields}`, {
        headers: { authorization: `bearer ${config.accessToken}`, accept: 'application/vnd.vimeo.*+json;version=3.4' },
      })
    ).json<Json>();
    return list(data.data).flatMap((video): Discovered[] => {
      const id = str(video.uri)?.match(/\/videos\/(\d+)/)?.[1];
      const title = str(video.name);
      if (!id || !title) return [];
      const sizes = list<Json>(obj(video.pictures).sizes).filter((size) => (num(size.width) ?? 0) <= 1280);
      const ratings = list<string>(video.content_rating);
      const rating: Rating | undefined = ratings.includes('nudity') ? '18+' : ratings.some((r) => r !== 'safe' && r !== 'unrated') ? '16+' : ratings.includes('safe') ? 'all' : undefined;
      const user = obj(video.user);
      const userId = str(user.uri)?.match(/\/users\/(\d+)/)?.[1];
      return [
        item({
          id: `vimeo:${id}`,
          title,
          description: str(video.description)?.slice(0, 5000),
          format: videoFormat(num(video.width), num(video.height)),
          rating,
          durationSeconds: num(video.duration),
          publishedAt: toIso(str(video.created_time)),
          creator: userId ? { id: `vimeo:user/${userId}`, name: str(user.name) ?? userId, url: str(user.link) } : undefined,
          thumbnailUrl: str(sizes.at(-1)?.link),
          pageUrl: str(video.link),
          stats: { views: num(obj(video.stats).plays), likes: num(obj(obj(obj(video.metadata).connections).likes).total) },
          adapter: 'vimeo',
        }),
      ];
    });
  },
});
