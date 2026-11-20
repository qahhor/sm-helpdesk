// Правило проекта: длинное тире (U+2014) и среднее тире (U+2013) не используются нигде.
// Вместо них ставится дефис. Знак минуса (U+2212) разрешён.

const DASHES = { '\u2014': 'U+2014', '\u2013': 'U+2013' };

// Файлы, которые пишет не команда проекта.
const SKIPPED = new Set([
  'pnpm-lock.yaml',
  // Блок правил Next.js: его пишет и восстанавливает сам `next dev`.
  'AGENTS.md',
]);

/**
 * @param {string} path путь от корня репозитория
 * @returns {boolean} проверяется ли файл на тире
 */
export function isDashCheckedFile(path) {
  return !SKIPPED.has(path);
}

/**
 * @param {string} text
 * @returns {{ line: number; column: number; char: 'U+2014' | 'U+2013' }[]}
 */
export function findDashes(text) {
  /** @type {{ line: number; column: number; char: 'U+2014' | 'U+2013' }[]} */
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(/[\u2014\u2013]/g)) {
      found.push({ line: i + 1, column: match.index + 1, char: DASHES[match[0]] });
    }
  }
  return found;
}
