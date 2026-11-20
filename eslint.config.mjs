import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const DB_BOUNDARY = 'К базе ходят только сервисы модулей (ТЗ 9.4, правило 2)';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Клиент базы виден только слою базы и сервисам модулей.
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
          ],
        },
      ],
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
