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

test('подключение hub_auth доступно только слою базы и модулю hdu', async () => {
  const importAuth = "import { getAuthDb } from '@/db/auth-client';";
  const importIdentity = "import { withIdentity } from '@/db/with-identity';";
  expect(await lint('src/modules/hdt/core.ts', importAuth)).toContain('no-restricted-imports');
  expect(await lint('src/modules/hdc/audit.ts', importIdentity)).toContain('no-restricted-imports');
  expect(await lint('src/app/x/page.tsx', importIdentity)).toContain('no-restricted-imports');
  expect(await lint('src/app/x/page.tsx', "import { getAuthDb } from '../../db/auth-client';")).toContain('no-restricted-imports');
  expect(await lint('src/modules/hdu/core/staff.ts', importIdentity)).not.toContain('no-restricted-imports');
  expect(await lint('src/db/with-identity.ts', importAuth)).not.toContain('no-restricted-imports');
}, 30_000);

test('страницы и интерфейс видят модуль только через api', async () => {
  expect(await lint('src/app/x/page.tsx', "import { addServer } from '@/modules/hdu/core';")).toContain('no-restricted-imports');
  expect(await lint('src/app/x/page.tsx', "import { getAuth } from '@/modules/hdu/auth/instance';")).toContain('no-restricted-imports');
  expect(await lint('src/ui/x.tsx', "import { servers } from '@/modules/hdu/schema';")).toContain('no-restricted-imports');
  expect(await lint('src/app/x/page.tsx', "import { listMembers } from '@/modules/hdu/api';")).not.toContain('no-restricted-imports');
  expect(await lint('src/app/api/ready/route.ts', "import { readyResponse } from '@/modules/hdc/util';")).toContain('no-restricted-imports');
  expect(await lint('src/app/x/page.tsx', "import { listMembers } from '../../modules/hdu/core';")).toContain('no-restricted-imports');
  // Файл каталога api тоже слой api: так команда консоли берёт только нужную часть модуля.
  expect(await lint('src/cli/commands.ts', "import { inviteStaff } from '@/modules/hdu/api/staff-admin';")).not.toContain('no-restricted-imports');
  // Импорт типа связи во время работы не создаёт.
  expect(await lint('src/ui/x.tsx', "import type { StaffRole } from '@/modules/hdu/pref';")).not.toContain('no-restricted-imports');
  // Модули между собой этим правилом не ограничены.
  expect(await lint('src/modules/hdu/core/staff.ts', "import { writeAudit } from '@/modules/hdc/audit';")).not.toContain('no-restricted-imports');
}, 30_000);
