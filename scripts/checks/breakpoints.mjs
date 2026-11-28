// Правило dead-breakpoint: класс с префиксом стандартной точки перелома Tailwind (sm:, md:, lg:, xl:, 2xl:),
// которой нет в src/ui/tokens.css, молча не даёт CSS. Файл токенов сбрасывает стандартные точки
// (`--breakpoint-*: initial`) и задаёт точки Smartup Web (раздел 8.11 ТЗ, docs/design/smartup-breakpoints.scss).
// Правило читает сам файл токенов: если сброс уберут или точку зададут заново, оно перестанет на неё падать.

const STANDARD = ['sm', 'md', 'lg', 'xl', '2xl'];

/**
 * @param {string} tokensCss текст src/ui/tokens.css
 * @returns {{ reset: boolean; names: string[] }} сброшены ли стандартные точки и какие точки заданы
 */
export function definedBreakpoints(tokensCss) {
  const reset = /--breakpoint-\*\s*:\s*initial/.test(tokensCss);
  const names = [...tokensCss.matchAll(/--breakpoint-([a-z0-9]+)\s*:/g)].map((m) => m[1]);
  return { reset, names: [...new Set(names)] };
}

// Префикс стоит в начале класса или после другого варианта (dark:lg:flex), допускаются not-, max- и min-.
// После двоеточия сразу идёт класс (буква, скобка, !, -) или следующий вариант (*, @container): так не задеваются
// ключи объектов вида `sm: 'h-8'` и `{md:1}`. Перед префиксом нет @ (варианты контейнера @md: и @max-md: дают CSS,
// их шкала --container-* не сброшена), скобки, запятой и знака равенства (`{md:1,lg:2}`, `data-[x=md:1]:flex`).
const PREFIX = /(?<![\w@{,(=[-])(?:not-)?(?:max-|min-)?(sm|md|lg|xl|2xl):(?=[a-z[!*@-])/g;

// Точка перелома числом в скобках (min-[700px]:, max-[900px]:, min-[theme(...)]:) даёт CSS, но это размер мимо
// токенов и ещё одна точка перелома, которой в портале нет (раздел 8.11 ТЗ). Варианты контейнера (@min-[...]:) не
// задеваются.
const ARBITRARY = /(?<![\w@.-])(?:not-)?(?:min|max)-\[[^\]\s]*\]:/;

/**
 * @param {string} text текст файла .ts или .tsx
 * @returns {{ line: number; rule: string }[]}
 */
export function findArbitraryBreakpoints(text) {
  /** @type {{ line: number; rule: string }[]} */
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if (ARBITRARY.test(lines[i])) found.push({ line: i + 1, rule: 'arbitrary-breakpoint' });
  return found;
}

/**
 * @param {string} text текст файла .ts или .tsx
 * @param {{ reset: boolean; names: string[] }} defined итог definedBreakpoints
 * @returns {{ line: number; rule: string }[]}
 */
export function findDeadBreakpoints(text, defined) {
  /** @type {{ line: number; rule: string }[]} */
  const found = [];
  if (!defined.reset) return found;
  const dead = new Set(STANDARD.filter((name) => !defined.names.includes(name)));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const seen = new Set();
    for (const match of lines[i].matchAll(PREFIX)) {
      const name = match[1];
      if (!dead.has(name) || seen.has(name)) continue;
      seen.add(name);
      found.push({ line: i + 1, rule: `dead-breakpoint ${name}:` });
    }
  }
  return found;
}
