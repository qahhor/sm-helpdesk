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

// Слои модулей (аудит 23.11.2026, находка A1; план W2, задача 8): зависимость идёт в одну сторону.
// hdc ни от кого не зависит, hdn только от hdc, hdu от hdc и hdn. Раньше hdu и hdn брали api друг друга:
// модули нельзя было менять и проверять порознь, порядок загрузки был хрупким.

test('модуль уведомлений не берёт api модуля пользователей, общий модуль не берёт ничей', async () => {
  for (const source of ['@/modules/hdu/api', '@/modules/hdu/api/recipients', '@/modules/hdu/api/session', '@/modules/hdt/api', '@/modules/hdr/api'])
    expect(await lint('src/modules/hdn/core/outbox.ts', `import { x } from '${source}';`), source).toContain('no-restricted-imports');
  for (const source of ['@/modules/hdu/api', '@/modules/hdn/api', '@/modules/hdt/api', '@/modules/hdr/api'])
    expect(await lint('src/modules/hdc/contacts.ts', `import { x } from '${source}';`), source).toContain('no-restricted-imports');
  // Даже типом: общие понятия (контекст сотрудника, справочник контактов) объявлены в hdc.
  expect(await lint('src/modules/hdn/api/mail-settings.ts', "import type { StaffContext } from '@/modules/hdu/api';")).toContain('no-restricted-imports');
  // Модуль правил стоит ниже обращений и пользователей не трогает.
  expect(await lint('src/modules/hdr/api.ts', "import { isFresh } from '@/modules/hdu/api/session';")).toContain('no-restricted-imports');
  expect(await lint('src/modules/hdr/api.ts', "import { listQueue } from '@/modules/hdt/api';")).toContain('no-restricted-imports');
}, 30_000);

test('разрешённое направление слоёв не задето', async () => {
  expect(await lint('src/modules/hdn/core/outbox.ts', "import { contacts } from '@/modules/hdc/api';")).not.toContain('no-restricted-imports');
  expect(await lint('src/modules/hdu/api/invitations.ts', "import { queueMail } from '@/modules/hdn/api';")).not.toContain('no-restricted-imports');
  expect(await lint('src/modules/hdt/core/notify.ts', "import { notifyTx } from '@/modules/hdn/api';")).not.toContain('no-restricted-imports');
  expect(await lint('src/modules/hdt/api/agent.ts', "import { namesOf } from '@/modules/hdu/api';")).not.toContain('no-restricted-imports');
  expect(await lint('src/modules/hdt/core/sla.ts', "import { readSlaConfig } from '@/modules/hdr/api';")).not.toContain('no-restricted-imports');
  // Константы (pref) слоями не ограничены: это общий словарь, обращений к базе в нём нет.
  expect(await lint('src/modules/hdr/input.ts', "import { TICKET_TYPES } from '@/modules/hdt/pref';")).not.toContain('no-restricted-imports');
}, 30_000);

test('настоящий код модулей проходит правило слоёв', async () => {
  const results = await eslint.lintFiles(['src/modules/hdn', 'src/modules/hdc', 'src/modules/hdr', 'src/modules/hdu']);
  const broken = results.flatMap((result) => result.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => `${result.filePath.split('/src/')[1]}:${m.line}`));
  expect(broken).toEqual([]);
}, 120_000);
