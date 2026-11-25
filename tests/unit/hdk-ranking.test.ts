import { expect, test } from 'vitest';
import type { SearchHit } from '@/modules/hdk/core/search';
import { rankHits } from '@/modules/hdk/ranking';

// Отбор подсказки (ТЗ 11.6, FR-SOL-08, 09, 10; план M5, решение 17): точное совпадение сигнатуры первым и всегда;
// остальное, только если документ нашёлся в двух списках из трёх или совпадение сильное; прибавка за модуль 1.1;
// одно решение один раз, не больше трёх.

let n = 0;
const hit = (over: Partial<SearchHit>): SearchHit => ({
  articleId: `a${++n}`,
  locale: 'ru',
  moduleId: null,
  audience: 'clients',
  number: 1000 + n,
  slug: 's',
  title: 't',
  rrf: 1 / 61,
  lists: 1,
  allWords: false,
  distance: null,
  ...over,
});
const ids = (list: { articleId: string }[]) => list.map((h) => h.articleId);

test('неуверенное из одного списка не показывается; два списка, все слова или близкий смысл показываются', () => {
  const weak = hit({ articleId: 'weak', rrf: 1 / 61 });
  const two = hit({ articleId: 'two', rrf: 1 / 62 + 1 / 63, lists: 2 });
  const words = hit({ articleId: 'words', rrf: 1 / 65, allWords: true });
  const close = hit({ articleId: 'close', rrf: 1 / 64, distance: 0.2 });
  const far = hit({ articleId: 'far', rrf: 1 / 61, distance: 0.4 });
  expect(ids(rankHits([weak, two, words, close, far], { exact: null, moduleId: null, locales: ['ru', 'uz', 'en'] }))).toEqual(['two', 'close', 'words']);
});

test('ничего уверенного: пустой список, блок не показывается (FR-SOL-09)', () => {
  expect(rankHits([hit({}), hit({ distance: 0.44 })], { exact: null, moduleId: null, locales: ['ru'] })).toEqual([]);
});

test('точное совпадение первым, даже если в гибридном поиске его нет, и не повторяется', () => {
  const exact = { articleId: 'exact', locale: 'ru' as const, moduleId: null, audience: 'clients' as const, number: 7, slug: 'x', title: 'Точное' };
  const other = hit({ articleId: 'other', lists: 3, rrf: 3 / 61 });
  const same = hit({ articleId: 'exact', lists: 3, rrf: 3 / 61 });
  const ranked = rankHits([other, same], { exact, moduleId: null, locales: ['ru'] });
  expect(ranked.map((r) => [r.articleId, r.exact])).toEqual([
    ['exact', true],
    ['other', false],
  ]);
});

test('прибавка за модуль меняет порядок близких документов', () => {
  const a = hit({ articleId: 'a', lists: 2, rrf: 0.0325 });
  const b = hit({ articleId: 'b', lists: 2, rrf: 0.031, moduleId: 'm1' });
  expect(ids(rankHits([a, b], { exact: null, moduleId: null, locales: ['ru'] }))).toEqual(['a', 'b']);
  expect(ids(rankHits([a, b], { exact: null, moduleId: 'm1', locales: ['ru'] }))).toEqual(['b', 'a']);
});

test('одно решение на нескольких языках один раз; при равной оценке язык пользователя (FR-SOL-10)', () => {
  const ru = hit({ articleId: 'x', locale: 'ru', lists: 2, rrf: 0.03, title: 'По-русски' });
  const uz = hit({ articleId: 'x', locale: 'uz', lists: 2, rrf: 0.03, title: "O'zbekcha" });
  const ranked = rankHits([ru, uz], { exact: null, moduleId: null, locales: ['uz', 'ru', 'en'] });
  expect(ranked.map((r) => [r.articleId, r.locale, r.title])).toEqual([['x', 'uz', "O'zbekcha"]]);
});

test('не больше трёх', () => {
  const many = Array.from({ length: 6 }, (_, i) => hit({ articleId: `m${i}`, lists: 2, rrf: 0.03 - i / 1000 }));
  expect(ids(rankHits(many, { exact: null, moduleId: null, locales: ['ru'] }))).toEqual(['m0', 'm1', 'm2']);
});
