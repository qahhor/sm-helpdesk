import { ARTICLE_NUMBER_MAX } from './pref';

// Адрес решения /help/a/{номер}-{slug} (правка 11 раздела 10.6; план M5, задача 4). slug пишется из заголовка при
// публикации: латиница, цифры, дефисы (ограничение hdk_article_translations_c2 и hdk_published_c6). Страница находит
// решение по номеру; slug только для чтения человеком и поисковиков этапа 2, неверный slug перенаправляется на верный.

const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: 'o',
  қ: 'q',
  ғ: 'g',
  ҳ: 'h',
};
const SLUG_MAX = 80;

export function solutionSlug(title: string): string {
  const latin = [...title.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join('');
  const slug = latin
    .normalize('NFKD')
    // Узбекские o' и g' пишутся без апострофа, ударения и знаки над буквами уходят.
    .replace(/[̀-ͯ'ʻʼ‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'solution';
}

/** Часть адреса после /help/a/: номер и необязательный slug. Не адрес решения: null. */
export function parseSolutionRef(ref: string): { number: number; slug: string } | null {
  const match = /^([1-9]\d{0,11})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/.exec(ref);
  if (!match) return null;
  const number = Number(match[1]);
  if (number > ARTICLE_NUMBER_MAX) return null;
  return { number, slug: match[2] ?? '' };
}
