// Platforms reached through their official APIs with the operator's own credentials.
// Each one is off until its credentials are filled in (dashboard → Crawler → API keys).
// Their calls follow each API's terms and rate limits and are counted against a daily
// budget the operator sets: crawling uses part of it, the rest is kept for searching the
// platform when clients search this node.
import { formatSource, sourceFromUrl } from '../../../shared/sources.js';
import type { Format, Rating } from '../../../shared/taxonomy.js';
import { cleanText } from '../html.js';
import type { Adapter, ApiBudget, ApiInfo, CrawlContext, Discovered } from '../types.js';
import { inferTopics, shorten, toIso, videoFormat } from '../types.js';

type Json = Record<string, unknown>;
type Keyed<C> = C & ApiBudget & { enabled: boolean };

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};
const list = <T = Json>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const q = encodeURIComponent;

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/** A page link as a content id: the platform's own id when the link is to one we embed. */
function linkId(url: string): string {
  const source = sourceFromUrl(url);
  return source ? formatSource(source) : `url:${q(url)}`;
}

function item(fields: Omit<Discovered, 'topics'> & { topics?: string[] }): Discovered {
  return { ...fields, title: shorten(fields.title, 300), topics: fields.topics ?? inferTopics(`${fields.title} ${fields.description ?? ''}`, fields.tags ?? []) };
}

interface Spec<C> {
  id: string;
  label: string;
  description: string;
  api: ApiInfo;
  defaults: C;
  /** Looks a query up on the platform. */
  find(ctx: CrawlContext, config: Keyed<C>, query: string): Promise<Discovered[]>;
  /** Discovery work other than the node's queries (subreddits, hashtags…). */
  extraTargets?(config: Keyed<C>): string[];
}

function apiAdapter<C extends Json>(spec: Spec<C>): Adapter<Keyed<C>> {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    api: spec.api,
    defaults: { enabled: true, dailyLimit: spec.api.defaultDailyLimit, searchShare: 0.5, ...spec.defaults } as Keyed<C>,
    targets: (config, queries) => [...(spec.extraTargets?.(config) ?? []), ...queries].map((query) => `q:${query}`),
    discover: async (ctx, config, target) => ({ items: await spec.find(ctx, config, target.replace(/^q:/, '')) }),
    search: (ctx, config, query) => spec.find(ctx, config, query),
  };
}

// ---------------------------------------------------------------------------- video

export const vimeo = apiAdapter({
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

export const twitch = apiAdapter({
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

// ---------------------------------------------------------------------------- images and GIFs

export const unsplash = apiAdapter({
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

export const pexels = apiAdapter({
  id: 'pexels',
  label: 'Pexels',
  description: 'Free photos and videos matching the queries.',
  api: {
    signupUrl: 'https://www.pexels.com/api/new/',
    credentials: [{ key: 'apiKey', label: 'API key', secret: true }],
    note: '200 requests an hour, 20,000 a month by default; Pexels asks for a link back and credit to the creator.',
    defaultDailyLimit: 600,
  },
  defaults: { apiKey: '' },
  async find(ctx, config, query) {
    const headers = { authorization: config.apiKey };
    const photos = (await ctx.api(`https://api.pexels.com/v1/search?query=${q(query)}&per_page=20`, { headers })).json<Json>();
    const videos = (await ctx.api(`https://api.pexels.com/videos/search?query=${q(query)}&per_page=15`, { headers })).json<Json>();
    const items: Discovered[] = [];
    for (const photo of list(photos.photos)) {
      const page = str(photo.url);
      const src = obj(photo.src);
      if (!page || !str(src.large2x)) continue;
      items.push(
        item({
          id: `url:${q(page)}`,
          title: str(photo.alt) ?? `Photo by ${str(photo.photographer) ?? 'Pexels'}`,
          format: 'image',
          rating: 'all',
          creator: num(photo.photographer_id) !== undefined ? { id: `pexels:${photo.photographer_id}`, name: str(photo.photographer) ?? 'Pexels', url: str(photo.photographer_url) } : undefined,
          thumbnailUrl: str(src.medium),
          media: { url: String(src.large2x), type: 'image', width: num(photo.width), height: num(photo.height) },
          pageUrl: page,
          adapter: 'pexels',
        })
      );
    }
    for (const video of list(videos.videos)) {
      const page = str(video.url);
      const files = list<Json>(video.video_files).filter((file) => str(file.file_type) === 'video/mp4' && (num(file.width) ?? 0) <= 1920);
      const best = files.sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0))[0];
      if (!page || !best) continue;
      const user = obj(video.user);
      const slug = page.match(/\/video\/([^/]+?)-?\d*\/?$/)?.[1]?.replace(/-/g, ' ');
      items.push(
        item({
          id: `url:${q(page)}`,
          title: slug && slug.length > 3 ? slug.charAt(0).toUpperCase() + slug.slice(1) : `Video by ${str(user.name) ?? 'Pexels'}`,
          format: videoFormat(num(video.width), num(video.height)),
          rating: 'all',
          durationSeconds: num(video.duration),
          creator: num(user.id) !== undefined ? { id: `pexels:${user.id}`, name: str(user.name) ?? 'Pexels', url: str(user.url) } : undefined,
          thumbnailUrl: str(video.image),
          media: { url: String(best.link), type: 'video', width: num(best.width), height: num(best.height) },
          pageUrl: page,
          adapter: 'pexels',
        })
      );
    }
    return items;
  },
});

const GIPHY_RATINGS: Record<string, Rating> = { g: 'all', pg: '10+', 'pg-13': '13+', r: '16+' };

export const giphy = apiAdapter({
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

export const tenor = apiAdapter({
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

export const imgur = apiAdapter({
  id: 'imgur',
  label: 'Imgur',
  description: 'Top gallery posts matching the queries.',
  api: {
    signupUrl: 'https://api.imgur.com/oauth2/addclient',
    credentials: [{ key: 'clientId', label: 'Client ID' }],
    note: 'About 12,500 requests a day per app. Commercial use needs a paid plan with Imgur.',
    defaultDailyLimit: 5000,
  },
  defaults: { clientId: '' },
  async find(ctx, config, query) {
    const data = (await ctx.api(`https://api.imgur.com/3/gallery/search/top/all/0?q=${q(query)}`, { headers: { authorization: `Client-ID ${config.clientId}` } })).json<Json>();
    return list(data.data).flatMap((post): Discovered[] => {
      const image = post.is_album ? list<Json>(post.images)[0] : post;
      const link = str(image?.link);
      const id = str(post.id);
      if (!image || !link || !id) return [];
      const video = str(image.mp4) ?? (str(image.type)?.startsWith('video/') ? link : undefined);
      const width = num(image.width);
      const height = num(image.height);
      return [
        item({
          id: `url:${q(`https://imgur.com/gallery/${id}`)}`,
          title: str(post.title) ?? 'Imgur post',
          format: video ? videoFormat(width, height) : 'image',
          rating: post.nsfw ? '18+' : undefined,
          tags: list<Json>(post.tags).map((tag) => String(tag.name)).filter(Boolean).slice(0, 10),
          publishedAt: toIso(num(post.datetime)),
          creator: str(post.account_url) ? { id: `imgur:${post.account_url}`, name: String(post.account_url), url: `https://imgur.com/user/${post.account_url}` } : undefined,
          thumbnailUrl: video ? `https://i.imgur.com/${str(image.id) ?? id}h.jpg` : link.replace(/(\.\w+)$/, 'h$1'),
          media: { url: video ?? link, type: video ? 'video' : 'image', width, height },
          pageUrl: `https://imgur.com/gallery/${id}`,
          stats: { views: num(post.views), likes: num(post.ups) },
          adapter: 'imgur',
        }),
      ];
    });
  },
});

export const deviantart = apiAdapter({
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

export const europeana = apiAdapter({
  id: 'europeana',
  label: 'Europeana',
  description: "Openly licensed images, video and sound from Europe's museums, libraries and archives.",
  api: {
    signupUrl: 'https://pro.europeana.eu/page/get-api',
    credentials: [{ key: 'apiKey', label: 'API key (wskey)', secret: true }],
    note: 'Free key; 10,000 calls a day.',
    defaultDailyLimit: 5000,
  },
  defaults: { apiKey: '' },
  async find(ctx, config, query) {
    const data = (
      await ctx.api(`https://api.europeana.eu/record/v2/search.json?wskey=${q(config.apiKey)}&query=${q(query)}&rows=20&media=true&thumbnail=true&reusability=open`)
    ).json<Json>();
    const kinds: Record<string, { format: Format; type: 'image' | 'video' | 'audio' }> = {
      IMAGE: { format: 'image', type: 'image' },
      VIDEO: { format: 'video', type: 'video' },
      SOUND: { format: 'audio', type: 'audio' },
    };
    return list(data.items).flatMap((record): Discovered[] => {
      const kind = kinds[str(record.type) ?? ''];
      const page = str(record.guid) ?? str(list<string>(record.edmIsShownAt)[0]);
      const title = str(list<string>(record.title)[0]);
      if (!kind || !page || !title) return [];
      const media = str(list<string>(record.edmIsShownBy)[0]);
      const creator = str(list<string>(record.dcCreator)[0]);
      return [
        item({
          id: `url:${q(page)}`,
          title,
          description: str(list<string>(record.dcDescription)[0])?.slice(0, 2000),
          format: kind.format,
          rating: 'all',
          publishedAt: toIso(str(list<string>(record.year)[0]) ? `${list<string>(record.year)[0]}-01-01` : undefined),
          creator: creator ? { id: `europeana:${creator.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}`, name: creator } : undefined,
          thumbnailUrl: str(list<string>(record.edmPreview)[0]),
          media: media && /^https?:\/\//.test(media) ? { url: media, type: kind.type } : undefined,
          pageUrl: page,
          adapter: 'europeana',
        }),
      ];
    });
  },
});

// ---------------------------------------------------------------------------- social

export const reddit = apiAdapter({
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

export const tumblr = apiAdapter({
  id: 'tumblr',
  label: 'Tumblr',
  description: 'Photo and video posts tagged with the queries.',
  api: {
    signupUrl: 'https://www.tumblr.com/oauth/apps',
    credentials: [{ key: 'apiKey', label: 'OAuth consumer key (API key)', secret: true }],
    note: '1,000 requests an hour and 5,000 a day per app.',
    defaultDailyLimit: 4000,
  },
  defaults: { apiKey: '' },
  async find(ctx, config, query) {
    const tag = query.trim().toLowerCase();
    const data = (await ctx.api(`https://api.tumblr.com/v2/tagged?tag=${q(tag)}&api_key=${q(config.apiKey)}&filter=text`)).json<Json>();
    return list(data.response).flatMap((post): Discovered[] => {
      const page = str(post.post_url);
      if (!page) return [];
      const blog = str(post.blog_name);
      const base = {
        id: `url:${q(page)}`,
        title: str(post.summary) ?? str(post.caption) ?? `${blog ?? 'Tumblr'} post`,
        tags: list<string>(post.tags).slice(0, 10),
        publishedAt: toIso(num(post.timestamp)),
        creator: blog ? { id: `tumblr:${blog}`, name: blog, url: `https://${blog}.tumblr.com/` } : undefined,
        pageUrl: page,
        stats: { likes: num(post.note_count) },
        adapter: 'tumblr',
      };
      if (post.type === 'photo') {
        const photo = obj(list<Json>(post.photos)[0]);
        const original = obj(photo.original_size);
        if (!str(original.url)) return [];
        const small = list<Json>(photo.alt_sizes).find((size) => (num(size.width) ?? 0) <= 500);
        return [item({ ...base, format: 'image', thumbnailUrl: str(small?.url) ?? String(original.url), media: { url: String(original.url), type: 'image', width: num(original.width), height: num(original.height) } })];
      }
      if (post.type === 'video') {
        const embedded = str(post.permalink_url) ? sourceFromUrl(String(post.permalink_url)) : null;
        const width = num(post.thumbnail_width);
        const height = num(post.thumbnail_height);
        if (embedded && embedded.scheme !== 'url') return [item({ ...base, id: formatSource(embedded), format: videoFormat(width, height), thumbnailUrl: str(post.thumbnail_url) })];
        if (!str(post.video_url)) return [];
        return [item({ ...base, format: videoFormat(width, height), thumbnailUrl: str(post.thumbnail_url), media: { url: String(post.video_url), type: 'video', width, height } })];
      }
      return [];
    });
  },
});

export const x = apiAdapter({
  id: 'x',
  label: 'Twitter (X)',
  description: 'Recent posts with photos or video matching the queries.',
  api: {
    signupUrl: 'https://developer.x.com/en/portal/dashboard',
    credentials: [{ key: 'bearerToken', label: 'Bearer token', secret: true }],
    note: 'Searching needs a paid X API tier; each tier caps how many posts you can read a month.',
    defaultDailyLimit: 100,
  },
  defaults: { bearerToken: '' },
  async find(ctx, config, query) {
    const search = `${query} has:media -is:retweet -is:reply`;
    const url =
      `https://api.twitter.com/2/tweets/search/recent?query=${q(search)}&max_results=20&expansions=attachments.media_keys,author_id` +
      '&media.fields=type,url,preview_image_url,width,height,duration_ms,variants&user.fields=name,username&tweet.fields=created_at,public_metrics,possibly_sensitive';
    const data = (await ctx.api(url, { headers: { authorization: `Bearer ${config.bearerToken}` } })).json<Json>();
    const includes = obj(data.includes);
    const media = new Map(list<Json>(includes.media).map((entry) => [String(entry.media_key), entry]));
    const users = new Map(list<Json>(includes.users).map((entry) => [String(entry.id), entry]));
    return list(data.data).flatMap((post): Discovered[] => {
      const id = str(post.id);
      const attached = media.get(String(list<string>(obj(post.attachments).media_keys)[0]));
      if (!id || !attached) return [];
      const user = users.get(String(post.author_id));
      const text = (str(post.text) ?? '').replace(/https:\/\/t\.co\/\S+/g, '').trim();
      const width = num(attached.width);
      const height = num(attached.height);
      const mp4 = list<Json>(attached.variants)
        .filter((variant) => variant.content_type === 'video/mp4')
        .sort((a, b) => (num(b.bit_rate) ?? 0) - (num(a.bit_rate) ?? 0))[0];
      const photo = attached.type === 'photo';
      return [
        item({
          id: `x:${id}`,
          title: text || `Post by @${str(user?.username) ?? 'x'}`,
          format: photo ? 'image' : videoFormat(width, height),
          rating: post.possibly_sensitive ? '18+' : undefined,
          durationSeconds: num(attached.duration_ms) !== undefined ? Number(attached.duration_ms) / 1000 : undefined,
          publishedAt: toIso(str(post.created_at)),
          creator: user ? { id: `x:${user.username}`, name: str(user.name) ?? String(user.username), url: `https://x.com/${user.username}` } : undefined,
          thumbnailUrl: str(attached.preview_image_url) ?? str(attached.url),
          media: photo && str(attached.url) ? { url: String(attached.url), type: 'image', width, height } : mp4 ? { url: String(mp4.url), type: 'video', width, height } : undefined,
          pageUrl: user ? `https://x.com/${user.username}/status/${id}` : `https://x.com/i/status/${id}`,
          stats: { likes: num(obj(post.public_metrics).like_count) },
          adapter: 'x',
        }),
      ];
    });
  },
});

export const instagram = apiAdapter({
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

// ---------------------------------------------------------------------------- music and sound

export const spotify = apiAdapter({
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

export const jamendo = apiAdapter({
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

export const freesound = apiAdapter({
  id: 'freesound',
  label: 'Freesound',
  description: 'Sounds and field recordings matching the queries.',
  api: {
    signupUrl: 'https://freesound.org/apiv2/apply',
    credentials: [{ key: 'token', label: 'API key (token)', secret: true }],
    note: '2,000 requests a day per key.',
    defaultDailyLimit: 2000,
  },
  defaults: { token: '' },
  async find(ctx, config, query) {
    const fields = 'id,name,description,username,url,duration,previews,images,tags,created';
    const data = (await ctx.api(`https://freesound.org/apiv2/search/text/?query=${q(query)}&page_size=20&fields=${fields}&token=${q(config.token)}`)).json<Json>();
    return list(data.results).flatMap((sound): Discovered[] => {
      const page = str(sound.url);
      const preview = str(obj(sound.previews)['preview-hq-mp3']);
      if (!page || !preview) return [];
      return [
        item({
          id: `url:${q(page)}`,
          title: str(sound.name) ?? 'Sound',
          description: str(sound.description) ? cleanText(String(sound.description), 2000) : undefined,
          format: 'audio',
          tags: list<string>(sound.tags).slice(0, 10),
          durationSeconds: num(sound.duration),
          publishedAt: toIso(str(sound.created)),
          creator: str(sound.username) ? { id: `freesound:${sound.username}`, name: String(sound.username), url: `https://freesound.org/people/${sound.username}/` } : undefined,
          thumbnailUrl: str(obj(sound.images).waveform_m),
          media: { url: preview, type: 'audio' },
          pageUrl: page,
          adapter: 'freesound',
        }),
      ];
    });
  },
});

export const API_ADAPTERS = [vimeo, twitch, unsplash, pexels, giphy, tenor, imgur, deviantart, europeana, reddit, tumblr, x, instagram, spotify, jamendo, freesound];
