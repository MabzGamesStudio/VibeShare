// Freesound: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Freesound.

import { Json, apiAdapter, item, list, num, obj, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';
import { cleanText } from '../../html.js';

export const freesound = apiAdapter({
  ...hostMatcher(['freesound.org']),
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
