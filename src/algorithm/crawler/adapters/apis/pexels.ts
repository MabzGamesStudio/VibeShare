// Pexels: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Pexels.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, videoFormat } from '../../types.js';

export const pexels = apiAdapter({
  ...hostMatcher(['pexels.com']),
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
