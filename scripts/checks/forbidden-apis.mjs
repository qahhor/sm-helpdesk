// Запреты ТЗ для кода в src:
// - данные арендаторов не кешируются (раздел 9.4, правило 6): нет `use cache`, `unstable_cache`,
//   функций кеша из next/cache, статических настроек сегмента и кеша у fetch;
// - нет вставки разметки строкой и встроенных стилей (раздел 14, политика CSP).

/** @typedef {'use-cache' | 'unstable-cache' | 'cache-api' | 'inner-html' | 'inline-style'} ForbiddenRule */

// Единственный файл, где разрешена вставка разметки: скрипт темы до первой отрисовки.
const INNER_HTML_ALLOWED = new Set(['src/ui/theme/ThemeScript.tsx']);

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
  }
  return found;
}
