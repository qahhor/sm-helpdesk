import { isAllowedDomain } from '@/modules/hdk/api/text-checks';

// Модуль hda: вырезание чужих ссылок из текста, который пишет модель или агент (FR-CAND-09, план M5c, решение 27;
// план M8b, решение 18; проверка на AI-инъекции, волна 7, S-I2 и S-M1). Чистые функции без базы.

const URL_TAIL = `[^\\s<>"'«»]*`;
/** Адрес со схемой "://" (любая схема: http, ftp, tg) или со схемой без косых черт из известных опасных. */
const SCHEME_URL = new RegExp(`(?:[a-z][a-z0-9+.-]{1,20}:\\/\\/|(?:javascript|vbscript|data|tg):)${URL_TAIL}`, 'gi');
/** "www." без требования границы слова: "текстwww.узел" тоже адрес. */
const WWW_URL = new RegExp(`www\\.[\\p{L}\\p{N}-]+\\.${URL_TAIL}`, 'giu');
/** Адрес без схемы "//узел/путь": браузер достроит схему сам. */
const RELATIVE_URL = new RegExp(`(?<![:\\p{L}\\p{N}/])\\/\\/[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+${URL_TAIL}`, 'giu');
/** Домен без схемы с путём: "узел.зона/путь". */
const BARE_URL = new RegExp(`(?<![\\p{L}\\p{N}@./:-])(?:[\\p{L}\\p{N}-]+\\.)+\\p{L}{2,}\\/${URL_TAIL}`, 'giu');
/** Ссылка Markdown: текст и содержимое скобок (цель до первого пробела, дальше подпись); одна пара вложенных скобок. */
const MD_LINK = /\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;
export const URL_IN_TEXT = new RegExp([SCHEME_URL, WWW_URL, RELATIVE_URL, BARE_URL].map((r) => r.source).join('|'), 'giu');

/** Узел адреса в любой записи; null: это не адрес http(s) (другая схема, относительный путь, мусор). */
function hostOf(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') return null;
  try {
    return new URL(scheme ? url : url.startsWith('//') ? `https:${url}` : `https://${url}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Ссылки вне разрешённых доменов вырезаются до записи (FR-CAND-09, решение 27). Адресом считается и запись без схемы
 * (ссылка Markdown, "//узел", "www.", домен с путём) и с любой схемой, кроме http и https у разрешённого домена
 * (проверка на AI-инъекции, волна 7, S-I2).
 */
export function stripForeignLinks(text: string, allowedDomains: readonly string[]): string {
  return removeForeignLinks(text, allowedDomains)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** То же без правки пробелов: для текста, строки которого вызывающий нормализует сам (заметка агента, S-M1). */
export function removeForeignLinks(text: string, allowedDomains: readonly string[]): string {
  const allowed = (url: string) => {
    const host = hostOf(url);
    return host !== null && host.includes('.') && isAllowedDomain(host, allowedDomains);
  };
  return text
    .replace(MD_LINK, (link, label: string, inside: string) => (allowed(inside.trim().split(/\s/)[0] ?? '') ? link : label))
    .replace(URL_IN_TEXT, (url) => (allowed(url) ? url : ''));
}
