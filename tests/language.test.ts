import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Settings } from '../src/shared/clientapi.js';
import { applySettingsPatch, defaultSettings, normalizeSettings } from '../src/shared/clientdefaults.js';
import { couldBeLanguage, matchesLanguages } from '../src/shared/language.js';
import type { ContentItem, Page } from '../src/shared/protocol.js';
import { admin, clientFor, startAlgorithm } from './helpers.js';

describe('language of titles', () => {
  it('rules out titles whose letters cannot be in the language, and nothing else', () => {
    const cases: [string, string, boolean][] = [
      ['Mountain trip', 'en', true],
      ['Pokémon café — jalapeño, naïve, über', 'en', true],
      ['Travel guide to Łódź, Poland', 'en', true],
      ['🎵🎶 2024 !!!', 'en', true],
      ['Naruto ナルト opening', 'en', true],
      ['Привет, мир', 'en', false],
      ['Cool video привет друзья мои', 'en', false],
      ['東京タワーに行ってみた', 'en', false],
      ['مرحبا بالعالم', 'en', false],
      ['Hướng dẫn nấu phở bò ngon tuyệt', 'en', false],
      ['Zażółć gęślą jaźń', 'en', false],
      ['東京タワーに行ってみた', 'ja', true],
      ['iPhone 15 Pro レビュー', 'ja', true],
      ['Amazing Tokyo trip', 'ja', false],
      ['北京烤鸭', 'zh', true],
      ['서울 여행 vlog', 'ko', true],
      ['Hướng dẫn nấu phở bò ngon tuyệt', 'vi', true],
      ['Zażółć gęślą jaźń', 'pl', true],
      ['Schöne Grüße aus München', 'de', true],
      ['Привет, мир', 'ru', true],
      ['Привіт, світе! Їжак', 'uk', true],
      ['Ελληνικά νέα', 'el', true],
      ['anything at all', 'tlh', true],
    ];
    for (const [title, language, expected] of cases) assert.equal(couldBeLanguage(title, language), expected, `${title} (${language})`);
  });

  it('trusts a declared language and judges the title otherwise', () => {
    assert.equal(matchesLanguages({ title: 'Привет', language: 'en-US' }, ['en']), true);
    assert.equal(matchesLanguages({ title: 'Hello', language: 'fr' }, ['en']), false);
    assert.equal(matchesLanguages({ title: 'Привет', language: 'und' }, ['en']), false);
    assert.equal(matchesLanguages({ title: 'Привет' }, ['en', 'ru']), true);
    assert.equal(matchesLanguages({ title: 'Привет' }, []), true, 'no languages: everything');
  });

  it('defaults to English, once, for settings from before the filter', () => {
    assert.deepEqual(defaultSettings().preferences.languages, ['en']);
    const old = { ...defaultSettings(), revision: undefined, preferences: { ...defaultSettings().preferences, languages: [] } } as Partial<Settings>;
    assert.deepEqual(normalizeSettings(old).preferences.languages, ['en']);
    const chosen = { ...old, preferences: { ...old.preferences!, languages: ['fr'] } };
    assert.deepEqual(normalizeSettings(chosen).preferences.languages, ['fr']);
    const everything = applySettingsPatch(normalizeSettings(old), { preferences: { languages: [] } } as Partial<Settings>);
    assert.deepEqual(everything.preferences.languages, []);
    assert.deepEqual(normalizeSettings(everything).preferences.languages, [], 'an explicit choice of all languages stays');
    const cleaned = applySettingsPatch(defaultSettings(), { preferences: { languages: ['EN-gb', 'en', 'pt_BR', '<script>'] } } as Partial<Settings>);
    assert.deepEqual(cleaned.preferences.languages, ['en', 'pt']);
  });
});

describe('an algorithm node filtering by language', async () => {
  const node = await startAlgorithm({ ranking: { strategy: 'new' } });
  after(() => node.stop());
  const items = [
    { id: 'yt:en1', title: 'Cooking pasta at home', format: 'video' },
    { id: 'yt:ru1', title: 'Готовим пасту дома', format: 'video' },
    { id: 'yt:ja1', title: '家でパスタを作る', format: 'video' },
    { id: 'yt:fr1', title: 'Pâtes maison', format: 'video', language: 'fr' },
  ];
  for (const item of items) await admin(node.url(), '/v1/admin/content', { method: 'PUT', body: item });

  it('keeps titles that could be in the languages asked for', async () => {
    const client = clientFor(node.url());
    const feed = async (languages?: string[]) =>
      (await client.json<Page<ContentItem>>('/v1/feed', { body: { preferences: { languages } }, auth: false })).items.map((item) => item.id).sort();
    assert.deepEqual(await feed(), ['yt:en1', 'yt:fr1', 'yt:ja1', 'yt:ru1']);
    assert.deepEqual(await feed(['en']), ['yt:en1']);
    assert.deepEqual(await feed(['ru', 'ja']), ['yt:ja1', 'yt:ru1']);
    assert.deepEqual(await feed(['fr']), ['yt:en1', 'yt:fr1'], 'lenient: an English title could be French');
    const search = await client.json<Page<ContentItem>>('/v1/search', { body: { query: 'pasta', filters: { languages: ['en'] } }, auth: false });
    assert.deepEqual(search.items.map((item) => item.id), ['yt:en1']);
  });
});
