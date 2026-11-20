import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const eslint = new ESLint();
const lint = async (filePath: string, code: string) =>
  (await eslint.lintText(code, { filePath }))[0].messages.map((m) => m.ruleId);

test('страница не может импортировать клиент базы (ТЗ 9.4, правило 2)', async () => {
  expect(await lint('src/app/x.ts', "import { appDb } from '@/db/client';")).toContain('no-restricted-imports');
  expect(await lint('src/app/x.ts', "import { withActor } from '@/db/with-actor';")).toContain('no-restricted-imports');
  expect(await lint('src/app/a/b/x.ts', "import { appDb } from '../../../db/client';")).toContain('no-restricted-imports');
  expect(await lint('src/ui/x.ts', "import { Pool } from 'pg';")).toContain('no-restricted-imports');
  expect(await lint('src/ui/x.ts', "import { drizzle } from 'drizzle-orm/node-postgres';")).toContain('no-restricted-imports');
}, 30_000);

test('сервис модуля и слой базы могут', async () => {
  expect(await lint('src/modules/hdt/core.ts', "import { withActor } from '@/db/with-actor';")).not.toContain('no-restricted-imports');
  expect(await lint('src/db/client.ts', "import { Pool } from 'pg';")).not.toContain('no-restricted-imports');
}, 30_000);
