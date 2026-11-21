import { readdirSync } from 'node:fs';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const DB_BOUNDARY = 'К базе ходят только сервисы модулей (ТЗ 9.4, правило 2)';
const AUTH_DB_BOUNDARY =
  'Подключение hub_auth доступно только слою базы и модулю идентичности hdu (ТЗ 10.3)';
const MODULE_BOUNDARY =
  'Страницы и интерфейс работают с модулем только через его слой api (ТЗ 9.4, правило 1; docs/naming.md, раздел 5)';

// Подключение роли hub_auth: таблицы библиотеки входа и таблицы идентичности.
const AUTH_DB_PATTERN = {
  group: ['@/db/auth-client', '@/db/with-identity', '**/db/auth-client', '**/db/with-identity'],
  message: AUTH_DB_BOUNDARY,
};

const MODULE_TO_MODULE =
  'Модуль берёт у другого модуля только его api (api.ts, api/) и pref.ts, внутренние файлы не видны (docs/naming.md, раздел 5)';

// Модули портала (docs/naming.md, раздел 1) и каталоги src/modules/*. Для каждого своё правило:
// чужие внутренности закрыты, свои открыты. Модуль из перечня получает правило ещё до своего каталога.
const PLANNED_MODULES = ['hdc', 'hdu', 'hdr', 'hdt', 'hdk', 'hdi', 'hdn', 'hdp', 'hda', 'hdw', 'hdh'];
const MODULES = [
  ...new Set([
    ...PLANNED_MODULES,
    ...readdirSync('src/modules', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  ]),
];

const moduleBoundary = (name) => ({
  group: ['@/modules/*/*', `!@/modules/${name}/**`, '!@/modules/*/api', '!@/modules/*/pref', '../hd?/**', '../../hd?/**', '../../../hd?/**'],
  message: MODULE_TO_MODULE,
  allowTypeImports: true,
});

const PUBLIC_BOUNDARY = 'Открытые страницы (public) не читают сессию и не берут актора, кроме public (CLAUDE.md)';

// Общие запреты для страниц, обработчиков, интерфейса и команды консоли.
const APP_PATHS = [
  { name: 'pg', message: DB_BOUNDARY },
  { name: 'drizzle-orm/node-postgres', message: DB_BOUNDARY },
];
const APP_PATTERNS = [
  {
    group: ['@/db/client', '@/db/with-actor', '**/db/client', '**/db/with-actor'],
    message: DB_BOUNDARY,
    // Типы актора нужны и страницам: импорт типа к базе не обращается.
    allowTypeImports: true,
  },
  AUTH_DB_PATTERN,
  {
    // Разрешён только слой api модуля: файл api.ts и файлы каталога api/.
    // Импорт типов не ограничен: он не создаёт связи во время работы.
    group: ['@/modules/*/*', '!@/modules/*/api', '**/modules/*/*', '!**/modules/*/api'],
    message: MODULE_BOUNDARY,
    allowTypeImports: true,
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Страницы, обработчики, интерфейс, команда консоли: клиент базы и внутренности модулей им не видны.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/db/**', 'src/modules/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: APP_PATHS, patterns: APP_PATTERNS }],
    },
  },
  {
    // Группа маршрутов (public): ни сессии, ни куки, ни модуля идентичности. Правило заменяет общее,
    // поэтому общие запреты повторены.
    files: ['src/app/**/\\(public\\)/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...APP_PATHS, { name: 'next/headers', message: PUBLIC_BOUNDARY }, { name: '@/modules/hdu/api', message: PUBLIC_BOUNDARY }],
          patterns: [...APP_PATTERNS, { group: ['@/modules/hdu/**', '**/modules/hdu/**'], message: PUBLIC_BOUNDARY }],
        },
      ],
    },
  },
  // Модули: только api и pref других модулей (проверка main, Q6). Кроме hdu, модули работают с базой
  // только под ролью hub_app.
  ...MODULES.map((name) => ({
    files: [`src/modules/${name}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': ['error', { patterns: [moduleBoundary(name), ...(name === 'hdu' ? [] : [AUTH_DB_PATTERN])] }],
    },
  })),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Собранная команда консоли (scripts/build-cli.mjs).
    'dist/**',
  ]),
]);

export default eslintConfig;
