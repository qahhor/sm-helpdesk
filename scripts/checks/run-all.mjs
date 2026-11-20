// Машинные проверки правил ТЗ. Запуск: node scripts/checks/run-all.mjs (входит в pnpm check).
// Печатает строки вида `путь:строка правило` и завершается с кодом 1 при любом нарушении.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findDashes, isDashCheckedFile } from './dashes.mjs';
import { missingInEnvExample } from './env-example.mjs';
import { findForbiddenApis } from './forbidden-apis.mjs';
import { findMissingServerOnly } from './server-only.mjs';
import { findUiRuleViolations } from './ui-rules.mjs';

const root = resolve(import.meta.dirname, '../..');

/** @returns {string[]} файлы репозитория: отслеживаемые и новые, без игнорируемых */
function listFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/** @returns {string | null} текст файла или null для двоичного и удалённого файла */
function readText(path) {
  let buffer;
  try {
    buffer = readFileSync(resolve(root, path));
  } catch {
    return null;
  }
  return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString('utf8');
}

/** @type {{ path: string; line: number; rule: string }[]} */
const violations = [];

for (const path of listFiles()) {
  const text = readText(path);
  if (text === null) continue;
  if (isDashCheckedFile(path))
    for (const v of findDashes(text)) violations.push({ path, line: v.line, rule: `dash ${v.char}` });
  if (path.startsWith('src/')) {
    if (/\.(?:ts|tsx)$/.test(path))
      for (const v of findForbiddenApis(path, text)) violations.push({ path, line: v.line, rule: v.rule });
    for (const v of findUiRuleViolations(path, text)) violations.push({ path, line: v.line, rule: v.rule });
    if (findMissingServerOnly(path, text)) violations.push({ path, line: 1, rule: 'server-only' });
  }
}

// Отдельные проверки: каждая возвращает строки с описанием нарушений.
/** @type {{ name: string; run: () => string[] | Promise<string[]> }[]} */
const extraChecks = [
  {
    // каждая переменная схемы src/env.ts описана в .env.example
    name: 'env-example',
    run: async () => (await missingInEnvExample()).map((name) => `в .env.example нет переменной ${name}`),
  },
  {
    // docs/versions.md совпадает с package.json и установленными пакетами
    name: 'versions',
    run: () => {
      try {
        execFileSync(process.execPath, ['scripts/versions.mjs', '--check'], { cwd: root, stdio: 'pipe' });
        return [];
      } catch (error) {
        return [String(error.stderr ?? error.message).trim()];
      }
    },
  },
];

/** @type {string[]} */
const extra = [];
for (const check of extraChecks) for (const message of await check.run()) extra.push(`${check.name}: ${message}`);

for (const v of violations) console.log(`${v.path}:${v.line} ${v.rule}`);
for (const message of extra) console.log(message);

const total = violations.length + extra.length;
if (total > 0) {
  console.error(`Проверки правил ТЗ: нарушений ${total}`);
  process.exit(1);
}
console.log('Проверки правил ТЗ: нарушений нет');
