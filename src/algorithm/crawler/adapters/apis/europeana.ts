// Europeana: content matching this node's queries, through the platform's
// official API with the operator's own credentials. The shared factory and the
// budget rules live in ./common.ts; this module only knows Europeana.

import { Json, apiAdapter, item, list, q, str } from './common.js';
import { type Discovered, hostMatcher, toIso } from '../../types.js';
import type { Format } from '../../../../shared/taxonomy.js';

export const europeana = apiAdapter({
  ...hostMatcher(['europeana.eu']),
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
