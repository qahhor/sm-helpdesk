// Запреты ТЗ для кода в src:
// - данные арендаторов не кешируются (раздел 9.4, правило 6): нет `use cache`, `unstable_cache`,
//   функций кеша из next/cache, статических настроек сегмента и кеша у fetch;
// - нет вставки разметки строкой и встроенных стилей (раздел 14, политика CSP);
// - нет склейки текста SQL: значения идут в базу только параметрами (защита от SQL-инъекций, ТЗ 14.3);
// - системный актор видит все организации, поэтому в обработчиках запросов (src/app, src/ui) его нет: фоновые и
//   служебные действия живут в модулях и фоновом процессе (аудит 23.11.2026, находка A7).

/** @typedef {'use-cache' | 'unstable-cache' | 'cache-api' | 'inner-html' | 'inline-style' | 'raw-sql' | 'system-actor'} ForbiddenRule */

// Единственный файл, где разрешена вставка разметки: скрипт темы до первой отрисовки.
const INNER_HTML_ALLOWED = new Set(['src/ui/theme/ThemeScript.tsx']);

const SYSTEM_ACTOR = /\btype\s*:\s*['"]system['"]/;
const REQUEST_CODE = /^src\/(?:app|ui)\//;

/** @type {{ rule: ForbiddenRule; test: RegExp }[]} */
const RULES = [
  { rule: 'use-cache', test: /^\s*['"]use cache(?::[^'"]*)?['"]/ },
  { rule: 'unstable-cache', test: /\bunstable_cache\b/ },
  { rule: 'cache-api', test: /\b(?:unstable_)?cache(?:Life|Tag)\b/ },
  // Настройки сегмента маршрута, которые включают кеш страницы.
  { rule: 'cache-api', test: /\bexport\s+const\s+revalidate\s*=(?!\s*(?:0\s*;?\s*$|false\b))/ },
  { rule: 'cache-api', test: /\bexport\s+const\s+dynamic\s*=\s*['"](?:force-static|error)['"]/ },
  { rule: 'cache-api', test: /\bexport\s+const\s+fetchCache\s*=\s*['"](?!force-no-store|only-no-store|default-no-store)/ },
  // Кеш у fetch.
  { rule: 'cache-api', test: /\bcache\s*:\s*['"]force-cache['"]/ },
  { rule: 'cache-api', test: /\bnext\s*:\s*\{[^}]*\brevalidate\s*:(?!\s*(?:0\b|false\b))/ },
  { rule: 'inner-html', test: /\bdangerouslySetInnerHTML\b/ },
  { rule: 'inline-style', test: /\bstyle=\{/ },
  // Склейка SQL: sql.raw, текст запроса со вставкой ${...} или через +. Параметры ($1, sql`...${x}`) разрешены.
  { rule: 'raw-sql', test: /\bsql\.raw\s*\(/ },
  { rule: 'raw-sql', test: /\.(?:query|execute)\s*(?:<[^>]*>)?\(\s*`[^`]*\$\{/ },
  { rule: 'raw-sql', test: /\.(?:query|execute)\s*(?:<[^>]*>)?\(\s*(['"])[^'"]*\1\s*\+/ },
];

/**
 * @param {string} path путь от корня репозитория
 * @param {string} text
 * @returns {{ line: number; rule: ForbiddenRule }[]}
 */
export function findForbiddenApis(path, text) {
  /** @type {{ line: number; rule: ForbiddenRule }[]} */
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    /** @type {Set<ForbiddenRule>} */
    const seen = new Set();
    for (const { rule, test } of RULES) {
      if (seen.has(rule) || !test.test(lines[i])) continue;
      if (rule === 'inner-html' && INNER_HTML_ALLOWED.has(path)) continue;
      seen.add(rule);
      found.push({ line: i + 1, rule });
    }
    if (REQUEST_CODE.test(path) && SYSTEM_ACTOR.test(lines[i])) found.push({ line: i + 1, rule: 'system-actor' });
  }
  return found;
}
