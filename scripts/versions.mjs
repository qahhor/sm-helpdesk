// Собирает docs/versions.md: прямые зависимости с точной версией и лицензией.
// Запуск: node scripts/versions.mjs          - записать файл
//         node scripts/versions.mjs --check  - упасть, если файл отстал от package.json
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

function installed(name) {
  // package.json пакета лежит в node_modules/<имя>/ при любой раскладке pnpm
  const manifest = JSON.parse(read(`node_modules/${name}/package.json`));
  const license = typeof manifest.license === 'string' ? manifest.license : (manifest.license?.type ?? 'не указана');
  return { version: manifest.version, license };
}

function rows(deps) {
  return Object.keys(deps ?? {})
    .sort()
    .map((name) => {
      const { version, license } = installed(name);
      if (version !== deps[name])
        throw new Error(`${name}: в package.json ${deps[name]}, установлено ${version}. Выполните pnpm install.`);
      return `| \`${name}\` | ${version} | ${license} |`;
    });
}

process.on('uncaughtException', (error) => {
  console.error(error.message);
  process.exit(1);
});

const table = (deps) => ['| Пакет | Версия | Лицензия |', '|---|---|---|', ...rows(deps)].join('\n');

const text = `# Версии

Файл собирает \`node scripts/versions.mjs\`. Руками не правится.

## Среда

| Что | Версия | Где задано |
|---|---|---|
| Node.js | ${read('.node-version').trim()} (LTS, ветка 26) | \`.node-version\`, \`engines\` в \`package.json\` |
| pnpm | ${pkg.packageManager.replace('pnpm@', '')} | \`packageManager\` в \`package.json\` |
| PostgreSQL | 18 с расширениями pgvector и pg_trgm, образ \`pgvector/pgvector:pg18\` | \`compose.yaml\` |
| Typesense | 30.2, образ \`typesense/typesense:30.2\` по digest (план W6) | \`compose.prod.yaml\`, \`tests/integration/setup/global-setup.ts\` |

## Зависимости приложения

${table(pkg.dependencies)}

## Зависимости разработки

${table(pkg.devDependencies)}

Лицензии всех пакетов, включая транзитивные: \`pnpm licenses list\`.
Почему выбраны именно эти версии: \`docs/decisions/0001-stack-pins.md\`.
`;

const target = 'docs/versions.md';
if (process.argv.includes('--check')) {
  if (read(target) !== text) {
    console.error(`${target} отстал от package.json. Выполните: node scripts/versions.mjs`);
    process.exit(1);
  }
  console.log(`${target}: актуален`);
} else {
  writeFileSync(resolve(root, target), text);
  console.log(`${target}: записан`);
}
