// Reddit: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Reddit.
import { formatSource, sourceFromUrl } from '../../../../shared/sources.js';

import { Json, apiAdapter, basic, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso, videoFormat } from '../../types.js';
import type { Rating } from '../../../../shared/taxonomy.js';

export const reddit = apiAdapter({
  ...hostMatcher(['reddit.com', 'redd.it']),
  id: 'reddit',
  label: 'Reddit',
  description: 'Hot posts of chosen subreddits, and posts matching searches: images, videos and links to other platforms.',
  api: {
    signupUrl: 'https://www.reddit.com/prefs/apps',
    credentials: [
      { key: 'clientId', label: 'Client ID (script or web app)' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    note: "Free for non-commercial use within 100 requests a minute; commercial use needs an agreement with Reddit (Data API terms).",
    defaultDailyLimit: 5000,
  },
  defaults: { clientId: '', clientSecret: '', subreddits: ['EarthPorn', 'pics', 'space', 'Art', 'videos', 'aww'] as string[] },
  extraTargets: (config) => (config.subreddits ?? []).map((name) => `r/${name}`),
  async find(ctx, config, query) {
    const token = await ctx.token(async () => {
      const data = (
        await ctx.api('https://www.reddit.com/api/v1/access_token', {
          headers: { authorization: basic(config.clientId, config.clientSecret) },
          form: { grant_type: 'client_credentials' },
        })
      ).json<Json>();
      return { token: String(data.access_token), expiresIn: num(data.expires_in) };
    });
    const subreddit = query.match(/^r\/([\w-]+)$/)?.[1];
    const url = subreddit
      ? `https://oauth.reddit.com/r/${q(subreddit)}/hot?limit=25&raw_json=1`
      : `https://oauth.reddit.com/search?q=${q(query)}&limit=25&sort=relevance&type=link&raw_json=1`;
    const data = (await ctx.api(url, { headers: { authorization: `bearer ${token}` } })).json<Json>();
    return list<Json>(obj(data.data).children).flatMap(({ data: raw }): Discovered[] => {
      const post = obj(raw);
      const title = str(post.title);
      const permalink = str(post.permalink);
      if (!title || !permalink || post.is_self || post.stickied) return [];
      const page = `https://www.reddit.com${permalink}`;
      const target = str(post.url) ?? '';
      const preview = obj(list<Json>(obj(post.preview).images)[0]);
      const source = obj(preview.source);
      const thumbnail = list<Json>(preview.resolutions).filter((size) => (num(size.width) ?? 0) <= 640).at(-1);
      const base = {
        title,
        rating: (post.over_18 ? '18+' : undefined) as Rating | undefined,
        publishedAt: toIso(num(post.created_utc)),
        creator: str(post.author) ? { id: `reddit:u/${post.author}`, name: `u/${post.author}`, url: `https://www.reddit.com/user/${post.author}` } : undefined,
        thumbnailUrl: str(thumbnail?.url) ?? str(source.url),
        pageUrl: page,
        stats: { likes: num(post.score) },
        tags: str(post.subreddit) ? [String(post.subreddit).toLowerCase()] : [],
        adapter: 'reddit',
      };
      const external = target && !/redd\.it|reddit\.com/.test(target) ? sourceFromUrl(target) : null;
      if (external && external.scheme !== 'url') return [item({ ...base, id: formatSource(external), format: 'video' })];
      if (str(post.post_hint) === 'image' || /^https:\/\/i\.redd\.it\//.test(target)) {
        return [item({ ...base, id: `url:${q(page)}`, format: 'image', media: { url: target, type: 'image', width: num(source.width), height: num(source.height) } })];
      }
      if (post.is_video) {
        const video = obj(obj(post.media).reddit_video);
        return [item({ ...base, id: `url:${q(page)}`, format: videoFormat(num(video.width), num(video.height)), durationSeconds: num(video.duration) })];
      }
      return [];
    });
  },
});
