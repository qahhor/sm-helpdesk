// Открытая зона портала: страницы группы маршрутов (public), одинаковые для всех посетителей.
// Ответы открытой зоны не ставят кук, прокси сессию на них не трогает (ТЗ 18.10, правило 4 кеширования
// публичных страниц): иначе ответ с кукой одного человека мог бы попасть в кеш Cloudflare.
//
// Разделы открытой зоны по первому отрезку после языка. Этап 2 добавит сюда kb и releases.
const PUBLIC_SECTIONS = ['legal'] as const;

const PUBLIC_PATH = new RegExp(`^/[a-z]{2}/(?:${PUBLIC_SECTIONS.join('|')})(?:/|$)`);

/** Относится ли адрес страницы к открытой зоне. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH.test(pathname);
}
