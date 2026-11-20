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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Страницы, обработчики, интерфейс, команда консоли: клиент базы и внутренности модулей им не видны.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/db/**', 'src/modules/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: DB_BOUNDARY },
            { name: 'drizzle-orm/node-postgres', message: DB_BOUNDARY },
          ],
          patterns: [
            {
              group: ['@/db/client', '@/db/with-actor', '**/db/client', '**/db/with-actor'],
              message: DB_BOUNDARY,
            },
            AUTH_DB_PATTERN,
            {
              // Разрешён только слой api модуля: файл api.ts и файлы каталога api/.
              // Импорт типов не ограничен: он не создаёт связи во время работы.
              group: ['@/modules/*/*', '!@/modules/*/api', '**/modules/*/*', '!**/modules/*/api'],
              message: MODULE_BOUNDARY,
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Остальные модули работают с базой только под ролью hub_app.
    files: ['src/modules/**/*.{ts,tsx}'],
    ignores: ['src/modules/hdu/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [AUTH_DB_PATTERN] }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
