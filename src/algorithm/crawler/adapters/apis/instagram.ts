// Instagram: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Instagram.
import { formatSource, sourceFromUrl } from '../../../../shared/sources.js';

import { Json, apiAdapter, item, list, num, q, str } from './common.js';
import { type Discovered, schemeMatcher, toIso } from '../../types.js';

export const instagram = apiAdapter({
  ...schemeMatcher('ig'),
  id: 'instagram',
  label: 'Instagram',
  description: 'Top posts of hashtags (Instagram Graph API hashtag search).',
  api: {
    signupUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/hashtag-search',
    credentials: [
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'userId', label: 'Instagram professional account ID' },
    ],
    note: 'Needs an Instagram professional account linked to a Facebook Page, an app with the Instagram Public Content Access feature, and an access token. An account can query 30 different hashtags a week.',
    defaultDailyLimit: 100,
  },
  defaults: { accessToken: '', userId: '', hashtags: ['photography', 'nature', 'art'] as string[], graphUrl: 'https://graph.facebook.com/v21.0' },
  extraTargets: (config) => config.hashtags ?? [],
  async find(ctx, config, query) {
    const tag = query.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '');
    if (!tag) return [];
    const auth = `user_id=${q(config.userId)}&access_token=${q(config.accessToken)}`;
    const found = (await ctx.api(`${config.graphUrl}/ig_hashtag_search?q=${q(tag)}&${auth}`)).json<Json>();
    const hashtag = str(list<Json>(found.data)[0]?.id);
    if (!hashtag) return [];
    const fields = 'id,caption,media_type,media_url,permalink,timestamp,like_count';
    const data = (await ctx.api(`${config.graphUrl}/${q(hashtag)}/top_media?fields=${fields}&limit=25&${auth}`)).json<Json>();
    return list(data.data).flatMap((post): Discovered[] => {
      const permalink = str(post.permalink);
      const source = permalink ? sourceFromUrl(permalink) : null;
      if (!permalink || !source || source.scheme !== 'ig') return [];
      const caption = str(post.caption) ?? '';
      return [
        item({
          id: formatSource(source),
          title: caption.split('\n')[0] || `#${tag}`,
          description: caption.slice(0, 2000),
          format: post.media_type === 'VIDEO' ? 'short-video' : 'image',
          tags: [...caption.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((match) => match[1].toLowerCase()).slice(0, 10),
          publishedAt: toIso(str(post.timestamp)),
          // (Instagram's media URLs expire after a while; the embed keeps working.)
          thumbnailUrl: post.media_type === 'VIDEO' ? undefined : str(post.media_url),
          pageUrl: permalink,
          stats: { likes: num(post.like_count) },
          adapter: 'instagram',
        }),
      ];
    });
  },
});
