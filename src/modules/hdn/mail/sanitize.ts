// Модуль hdn: значения, которые попадают в письмо от людей и серверов (имена, названия, темы обращений).
// Общие для писем M1 (mail-text.ts) и писем вехи M4 (render.ts).

/** Похоже на ссылку или адрес: схема, www., домен, email. */
// Домен узнаётся по буквам одного регистра после точки: инициалы "А.Каримов" ссылкой не считаются,
// а "evil.example" и "EVIL.COM" считаются. Схема и www. в любом регистре.
const SCHEME_OR_WWW = /[a-z][a-z0-9+.-]*:\/\/|www\./i;
const DOMAIN_OR_EMAIL = /[\p{L}\p{N}-]+\.(?:\p{Ll}{2,}|\p{Lu}{2,}(?!\p{Ll}))|@/u;
export const LINK_LIKE = { test: (value: string) => SCHEME_OR_WWW.test(value) || DOMAIN_OR_EMAIL.test(value) };

/** Без управляющих знаков и знаков направления текста, пробелы схлопнуты, длина не больше предела. */
export function plain(value: string, max: number): string {
  const text = value.replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : text;
}

/**
 * Имя человека из Smartup или профиля для письма (проверка main, S8). Имя со ссылкой или адресом
 * заменяется общим словом: иначе приглашение служило бы приманкой с чужим адресом от имени портала.
 */
export function personName(value: string, max: number, fallback: string): string {
  const name = plain(value, max);
  return name && !LINK_LIKE.test(name) ? name : fallback;
}

/**
 * Название организации или тема обращения: текст не заменяется, но точки и знак @ в похожем на ссылку тексте
 * заменяются похожими знаками: почтовая программа не сделает из него ссылку.
 */
export function noLinks(value: string, max: number): string {
  const text = plain(value, max);
  return LINK_LIKE.test(text) ? text.replaceAll('.', '․').replaceAll('@', '＠').replaceAll('://', ' ') : text;
}
