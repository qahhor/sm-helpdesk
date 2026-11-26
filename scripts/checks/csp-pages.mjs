// Полнота обхода политики содержимого (план подготовки M9, задача 2, решение 2). Браузерный тест
// tests/e2e/csp-all-pages.spec.ts проверяет заголовок CSP на каждой странице и каждом обработчике из списка
// tests/e2e/helpers/csp-pages.ts. Эта проверка сверяет список с каталогом приложения: новая страница без строки
// обхода не проходит pnpm check.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const LIST = 'tests/e2e/helpers/csp-pages.ts';

/**
 * Маршруты приложения: путь каталога от src/app, у страниц файл page.tsx, у обработчиков route.ts. Группы маршрутов
 * "(portal)" сохраняются: по ним обход выбирает страницы для браузера.
 *
 * @param {string} [appDir]
 * @returns {{ pages: string[]; handlers: string[] }}
 */
export function appRoutes(appDir = resolve(root, 'src/app')) {
  /** @type {string[]} */
  const pages = [];
  /** @type {string[]} */
  const handlers = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'page.tsx') pages.push(relative(appDir, dir).split(sep).join('/'));
      else if (entry.name === 'route.ts') handlers.push(relative(appDir, dir).split(sep).join('/'));
    }
  };
  walk(appDir);
  return { pages: pages.sort(), handlers: handlers.sort() };
}

/**
 * Расхождения списка обхода с приложением: маршрут без строки обхода и строка без маршрута.
 *
 * @param {{ pages: string[]; handlers: string[] }} routes
 * @param {{ pages: string[]; handlers: string[] }} listed
 * @returns {string[]}
 */
export function cspCoverageGaps(routes, listed) {
  const pages = new Set(listed.pages);
  const handlers = new Set(listed.handlers);
  const known = new Set([...routes.pages, ...routes.handlers]);
  return [
    ...routes.pages.filter((route) => !pages.has(route)).map((route) => `страница ${route} не входит в обход ${LIST}`),
    ...routes.handlers.filter((route) => !handlers.has(route)).map((route) => `обработчик ${route} не входит в обход ${LIST}`),
    ...[...listed.pages, ...listed.handlers].filter((route) => !known.has(route)).map((route) => `в обходе ${LIST} нет такой страницы: ${route}`),
  ];
}

/**
 * Маршруты списка обхода, прочитанные из текста файла: значения полей route у CSP_PAGES и CSP_HANDLERS. Шаблон
 * `${A}` раскрывается из константы A того же файла.
 *
 * @param {string} source
 * @returns {{ pages: string[]; handlers: string[] }}
 */
export function listedRoutes(source) {
  const prefix = /^const A = '([^']+)';$/m.exec(source)?.[1] ?? '';
  const routesOf = (/** @type {string} */ part) => [...part.matchAll(/route: (?:'([^']+)'|`([^`]+)`)/g)].map((m) => m[1] ?? m[2].replaceAll('${A}', prefix));
  const handlersAt = source.indexOf('export const CSP_HANDLERS');
  return { pages: routesOf(source.slice(0, handlersAt)), handlers: routesOf(source.slice(handlersAt)) };
}

/** @returns {string[]} расхождения настоящего списка обхода с каталогом приложения */
export function cspPagesGaps() {
  return cspCoverageGaps(appRoutes(), listedRoutes(readFileSync(resolve(root, LIST), 'utf8')));
}
