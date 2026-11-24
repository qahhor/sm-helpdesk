// Запреты ТЗ для кода в src:
// - данные арендаторов не кешируются (раздел 9.4, правило 6): нет `use cache`, `unstable_cache`,
//   функций кеша из next/cache, статических настроек сегмента и кеша у fetch;
// - нет вставки разметки строкой и встроенных стилей (раздел 14, политика CSP);
// - нет склейки текста SQL: значения идут в базу только параметрами (защита от SQL-инъекций, ТЗ 14.3);
// - системный актор видит все организации, поэтому в обработчиках запросов (src/app, src/ui) его нет: фоновые и
//   служебные действия живут в модулях и фоновом процессе (аудит 23.11.2026, находка A7).

// - модуль не называет таблицу другого модуля в тексте запроса: нужное даёт api модуля-владельца (аудит
//   23.11.2026, находка A2). Линтер импортов такую связь не видит.
// - поиск по шаблону (LIKE, ILIKE) только через src/db/contains.ts, где шаблон экранируется (решение 0041).

/** @typedef {'use-cache' | 'unstable-cache' | 'cache-api' | 'inner-html' | 'inline-style' | 'raw-sql' | 'system-actor' | 'cross-module-sql' | 'like-pattern'} ForbiddenRule */

// Единственный файл, где разрешена вставка разметки: скрипт темы до первой отрисовки.
const INNER_HTML_ALLOWED = new Set(['src/ui/theme/ThemeScript.tsx']);

const SYSTEM_ACTOR = /\btype\s*:\s*['"]system['"]/;
const REQUEST_CODE = /^src\/(?:app|ui)\//;

// Таблицы модулей названы с приставкой модуля (docs/naming.md): hdt_tickets, hdn_outbox. Таблицы библиотеки входа
// лежат в схеме auth, их читает только модуль пользователей (hdu).
const MODULE_FILE = /^src\/modules\/(hd[a-z])\//;
const TABLE_NAME = /\b(hd[a-z])_[a-z][a-z0-9_]*\b/g;
const AUTH_TABLE = /\bauth\s*\.\s*"?[a-zA-Z]/;

/**
 * Называет ли строка кода модуля таблицу другого модуля. Комментарии не считаются.
 * @param {string} owner
 * @param {string} line
 */
function namesForeignTable(owner, line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
  const code = line.replace(/\/\/.*$/, '');
  for (const match of code.matchAll(TABLE_NAME)) if (match[1] !== owner) return true;
  return owner !== 'hdu' && AUTH_TABLE.test(code);
}

// Поиск по шаблону собирает только src/db/contains.ts (решение 0041): вызов ilike и like построителя запросов,
// оператор в тексте запроса (ilike, like, ~~, ~~*) в остальном коде запрещены. Шаблон, записанный в коде строкой
// ('files/%'), от человека не приходит и допускается.
const LIKE_HOME = 'src/db/contains.ts';
const LIKE_CALL = /\b(?:ilike|like|notIlike|notLike)\(/;
const LIKE_CONSTANT = /\b(?:ilike|like)\([^,()]+,\s*'[^'$]*'\)/g;
const LIKE_RAW_CONSTANT = /\si?like\s+'[^'$]*'(?!\s*\|\|)/gi;
const LIKE_RAW = /(?:\s(?:not\s+)?i?like\s+(?:\$|'|\(|:)|~~\*?)/i;

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
    const owner = MODULE_FILE.exec(path)?.[1];
    if (owner && namesForeignTable(owner, lines[i])) found.push({ line: i + 1, rule: 'cross-module-sql' });
    // Шаблон поиска собирает только общий помощник: иначе экранирование легко забыть (решение 0041).
    if (path !== LIKE_HOME && !/^\s*(\/\/|\*|\/\*)/.test(lines[i])) {
      const code = lines[i].replace(/\/\/.*$/, '').replace(LIKE_CONSTANT, '').replace(LIKE_RAW_CONSTANT, '');
      if (LIKE_CALL.test(code) || (/sql`|\.query\(|\.execute\(/.test(text) && LIKE_RAW.test(code))) found.push({ line: i + 1, rule: 'like-pattern' });
    }
  }
  return found;
}
