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
}, 30_000);

test('модуль берёт у другого модуля только api и pref (проверка main, Q6)', async () => {
  expect(await lint('src/modules/hdu/core/staff.ts', "import { writeAudit } from '@/modules/hdc/audit';")).toContain('no-restricted-imports');
  expect(await lint('src/modules/hdu/util.ts', "import { rateKey } from '../hdc/util';")).toContain('no-restricted-imports');
  expect(await lint('src/modules/hdt/core.ts', "import { findStaff } from '@/modules/hdu/core/staff';")).toContain('no-restricted-imports');
  expect(await lint('src/modules/hdu/core/staff.ts', "import { writeAudit } from '@/modules/hdc/api';")).not.toContain('no-restricted-imports');
  expect(await lint('src/modules/hdu/api/staff.ts', "import { RATE_RULES } from '@/modules/hdc/pref';")).not.toContain('no-restricted-imports');
  // Свои внутренности модулю видны.
  expect(await lint('src/modules/hdu/api/staff.ts', "import { findStaff } from '@/modules/hdu/core/staff';")).not.toContain('no-restricted-imports');
  // Импорт типа связи во время работы не создаёт.
  expect(await lint('src/modules/hdu/core/staff.ts', "import type { Tx } from '@/modules/hdc/audit';")).not.toContain('no-restricted-imports');
}, 30_000);

test('типы актора видны и вне слоя базы, сам клиент базы нет', async () => {
  expect(await lint('src/cli/commands.ts', "import type { SystemActor } from '@/db/with-actor';")).not.toContain('no-restricted-imports');
  expect(await lint('src/cli/commands.ts', "import { withActor } from '@/db/with-actor';")).toContain('no-restricted-imports');
  expect(await lint('src/cli/main.ts', "import { closeAuthPool } from '@/db/auth-client';")).toContain('no-restricted-imports');
}, 30_000);

test('открытые страницы не читают сессию (CLAUDE.md, группа (public))', async () => {
  const page = 'src/app/[locale]/(public)/legal/privacy/page.tsx';
  expect(await lint(page, "import { requireClientActor } from '@/modules/hdu/api';")).toContain('no-restricted-imports');
  expect(await lint(page, "import { telegramEnabled } from '@/modules/hdu/api/telegram';")).toContain('no-restricted-imports');
  expect(await lint(page, "import { cookies } from 'next/headers';")).toContain('no-restricted-imports');
  expect(await lint(page, "import { getPolicy } from '@/modules/hdc/api';")).not.toContain('no-restricted-imports');
  // Общие запреты на открытых страницах тоже действуют.
  expect(await lint(page, "import { appDb } from '@/db/client';")).toContain('no-restricted-imports');
  // За пределами группы (public) сессию читать можно.
  expect(await lint('src/app/[locale]/(portal)/x/page.tsx', "import { cookies } from 'next/headers';")).not.toContain('no-restricted-imports');
}, 30_000);
