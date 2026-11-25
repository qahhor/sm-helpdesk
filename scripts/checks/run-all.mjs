// Машинные проверки правил ТЗ. Запуск: node scripts/checks/run-all.mjs (входит в pnpm check).
// Печатает строки вида `путь:строка правило` и завершается с кодом 1 при любом нарушении.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkContrast } from './contrast.mjs';
import { findDashes, isDashCheckedFile } from './dashes.mjs';
import { missingInEnvExample } from './env-example.mjs';
import { mailTokensDrift } from './mail-tokens.mjs';
import { checkCompleteness, checkIcu, checkWords } from './messages.mjs';
import { findForbiddenApis } from './forbidden-apis.mjs';
import { findMissingServerOnly } from './server-only.mjs';
import { findUiRuleViolations } from './ui-rules.mjs';
import { fontsOutOfDate } from '../fonts/build.mjs';
import { widgetOutOfDate } from '../widget-build.mjs';

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
    // контраст пар "текст, фон" в обеих темах
    name: 'contrast',
    run: () => {
      const pairs = JSON.parse(readFileSync(resolve(root, 'scripts/checks/contrast-pairs.json'), 'utf8'));
      const failed = checkContrast(readFileSync(resolve(root, 'src/ui/tokens.css'), 'utf8'), pairs);
      if (failed.length === 0) console.log('Контраст: все пары не ниже 4,5:1 в обеих темах');
      return failed.map((f) => `${f.pair}, тема ${f.theme}: ${f.ratio}:1, нужно не ниже 4,5:1`);
    },
  },
  {
    // файлы шрифта для веба собраны из шрифта пакета бренда
    name: 'fonts',
    run: async () => (await fontsOutOfDate()).map((name) => `${name}: выполните pnpm fonts:build`),
  },
  {
    // загрузчик виджета собран из исходника, текстов и токенов (план M6, решение 9)
    name: 'widget',
    run: () => widgetOutOfDate(),
  },
  {
    // файлы сообщений: полнота, ICU, запрещённые слова
    name: 'messages',
    run: () => {
      const dir = resolve(root, 'messages');
      const sources = Object.fromEntries(
        readdirSync(dir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => [name.replace('.json', ''), JSON.parse(readFileSync(resolve(dir, name), 'utf8'))]),
      );
      const problems = [...checkCompleteness(sources), ...checkIcu(sources), ...checkWords(sources)];
      if (problems.length === 0) {
        const count = Object.keys(sources).length;
        const word = { one: 'язык', few: 'языка', many: 'языков', other: 'языка' }[new Intl.PluralRules('ru').select(count)];
        console.log(`Переводы: ${count} ${word}, недостающих ключей нет`);
      }
      return problems.map((p) => `messages/${p.locale}.json ${p.key} ${p.problem}`);
    },
  },
  {
    // цвета и размеры писем совпадают с токенами портала (решение 4 вехи M4)
    name: 'mail-tokens',
    run: () =>
      mailTokensDrift(readFileSync(resolve(root, 'src/ui/tokens.css'), 'utf8'), readFileSync(resolve(root, 'src/modules/hdn/mail/mail-tokens.json'), 'utf8')),
  },
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
