import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { MemoryStorage, setStorageForTests } from '@/modules/hdc/testing';
import { getTicket } from '@/modules/hdt/api';
import { runClientDataRetention } from '@/modules/hdt/api/retention';
import { anonymizeIdeaAuthor } from '@/modules/hdi/api/anonymize';
import { anonymizeAccount } from '@/modules/hdu/api/accounts';
import { setOrgContractEnd } from '@/modules/hdu/api/orgs';
import { clientCtx, staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Сроки хранения и обезличивание учётной записи (ТЗ 14.6, решение 78; волна 7, T2; решение 0162).

const SYSTEM = { type: 'system', job: 'retention.client_data' } as const;
let f: Fixture;
let storage: MemoryStorage;

beforeEach(async () => {
  f = await seedTwoOrgs();
  storage = new MemoryStorage();
  setStorageForTests(storage);
  setLogSinkForTests(() => undefined);
  await pools.root.query(`delete from hdc_settings where code like 'retention.%'`);
});
afterEach(() => {
  setStorageForTests(null);
  setLogSinkForTests(null);
});

const audit = (action: string) => pools.root.query(`select actor_id, object_id, org_id, diff from hdc_audit_log where action = $1 order by created_on`, [action]).then((r) => r.rows);

test('обезличивание учётной записи: только администратор со свежим входом; имя и адрес заменены, вход закрыт, тексты обращений остаются; журнал в той же транзакции', async () => {
  const admin = staffCtx(f.adminStaff);
  const before = (await pools.root.query(`select name, email from auth."user" where id = $1`, [f.aUser.userId])).rows[0] as { name: string; email: string };
  await pools.root.query(`insert into auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values (uuidv7(), now() + interval '1 day', 'tok-' || uuidv7()::text, now(), now(), $1)`, [f.aUser.userId]);
  for (const ctx of [staffCtx(f.l1), staffCtx(f.care)]) await expect(anonymizeAccount(ctx, { userId: f.aUser.userId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(anonymizeAccount({ ...admin, freshAuthAt: new Date(Date.now() - 3_600_000) }, { userId: f.aUser.userId })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(anonymizeAccount(admin, { userId: 'нет' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(anonymizeAccount(admin, { userId: '01900000-0000-7000-8000-000000000001' })).rejects.toMatchObject({ code: 'not_found' });
  // Сотрудник так не обезличивается: у него свой порядок отключения.
  await expect(anonymizeAccount(admin, { userId: f.l1.userId })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await audit('user.anonymized')).toEqual([]);

  await anonymizeAccount(admin, { userId: f.aUser.userId });
  const after = (await pools.root.query(`select name, email, "emailVerified", image, "claimedEmail" from auth."user" where id = $1`, [f.aUser.userId])).rows[0];
  expect(after.name).not.toBe(before.name);
  expect(after.name).toMatch(/^#[0-9a-f]{8}$/);
  expect(after.email).toMatch(/^anon-[0-9a-f-]{36}@anonymized\.invalid$/);
  expect(after).toMatchObject({ emailVerified: false, image: null, claimedEmail: null });
  // Вход закрыт: сессий и связей входа нет, членство отключено.
  expect((await pools.root.query(`select (select count(*) from auth.session where "userId" = $1)::int as sessions, (select count(*) from auth.account where "userId" = $1)::int as accounts`, [f.aUser.userId])).rows[0]).toEqual({ sessions: 0, accounts: 0 });
  expect((await pools.root.query(`select state from hdu_memberships where user_id = $1`, [f.aUser.userId])).rows.map((r) => r.state)).toEqual(['passive']);
  // Тексты обращений остаются у организации: администратор клиента по-прежнему видит обращение и его текст.
  const view = await getTicket(await clientCtx(f.aAdmin), String(f.tickets.aOrg.number));
  expect(view?.description).toBeTruthy();
  expect(JSON.stringify(view)).not.toContain(before.name);
  // Запись журнала одна, от имени администратора, без имени и адреса.
  const rows = await audit('user.anonymized');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_id: f.adminStaff.userId, object_id: f.aUser.userId });
  expect(JSON.stringify(rows[0])).not.toContain(before.email);
  expect(JSON.stringify(rows[0])).not.toContain(before.name);
  // Снимок имени автора в идеях получает то же обезличенное имя.
  await pools.root.query(`insert into hdi_ideas (org_id, author_id, author_name, original_locale, status) values ($1, $2, $3, 'ru', 'pending_review')`, [f.orgA.orgId, f.aUser.userId, before.name]);
  await expect(anonymizeIdeaAuthor(staffCtx(f.care), { userId: f.aUser.userId, name: after.name })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(anonymizeIdeaAuthor(admin, { userId: f.aUser.userId, name: 'Настоящее Имя' })).rejects.toMatchObject({ code: 'invalid_input' });
  // Имя правильного вида, но не имя этой учётной записи: снимок не меняется.
  await expect(anonymizeIdeaAuthor(admin, { userId: f.aUser.userId, name: '#00000000' })).rejects.toMatchObject({ code: 'invalid_input' });
  // Учётная запись не обезличена: снимок имени её идей не меняется никем (проверка W7, R11).
  await pools.root.query(`insert into hdi_ideas (org_id, author_id, author_name, original_locale, status) values ($1, $2, 'Дильноза', 'ru', 'pending_review')`, [f.orgA.orgId, f.aAdmin.userId]);
  await expect(anonymizeIdeaAuthor(admin, { userId: f.aAdmin.userId, name: '#deadbeef' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await pools.root.query(`select author_name from hdi_ideas where author_id = $1`, [f.aAdmin.userId])).rows.map((r) => r.author_name)).toEqual(['Дильноза']);
  expect(await audit('user.ideas_anonymized')).toEqual([]);
  // Журнал и замена одной транзакцией: не записался журнал, не изменился снимок.
  await pools.root.query(`alter table hdc_audit_log add constraint w7_block check (action <> 'user.ideas_anonymized') not valid`);
  try {
    await expect(anonymizeIdeaAuthor(admin, { userId: f.aUser.userId, name: after.name })).rejects.toThrow();
  } finally {
    await pools.root.query(`alter table hdc_audit_log drop constraint w7_block`);
  }
  expect((await pools.root.query(`select author_name from hdi_ideas where author_id = $1`, [f.aUser.userId])).rows.map((r) => r.author_name)).toEqual([before.name]);
  expect(await anonymizeIdeaAuthor(admin, { userId: f.aUser.userId, name: after.name })).toEqual({ ideas: 1 });
  expect((await pools.root.query(`select author_name from hdi_ideas where author_id = $1`, [f.aUser.userId])).rows.map((r) => r.author_name)).toEqual([after.name]);
  // Запись журнала: от имени системы, с числом идей, без имён. Повтор ничего не меняет и не пишет.
  expect(await anonymizeIdeaAuthor(admin, { userId: f.aUser.userId, name: after.name })).toEqual({ ideas: 0 });
  const ideaRows = await audit('user.ideas_anonymized');
  expect(ideaRows).toEqual([expect.objectContaining({ actor_id: null, object_id: f.aUser.userId, diff: { ideas: 1 } })]);
  expect(JSON.stringify(ideaRows)).not.toContain(before.name);
  // Повтор ничего не меняет и второй записи не пишет.
  await anonymizeAccount(admin, { userId: f.aUser.userId });
  expect(await audit('user.anonymized')).toHaveLength(1);
});

test('журнал и обезличивание одной транзакцией: не записался журнал, не изменилась учётная запись', async () => {
  const before = (await pools.root.query(`select name, email from auth."user" where id = $1`, [f.aUser.userId])).rows[0];
  // Журнал отклоняет запись: имя ограничения делает вставку невозможной на время теста.
  await pools.root.query(`alter table hdc_audit_log add constraint w7_block check (action <> 'user.anonymized') not valid`);
  try {
    await expect(anonymizeAccount(staffCtx(f.adminStaff), { userId: f.aUser.userId })).rejects.toThrow();
  } finally {
    await pools.root.query(`alter table hdc_audit_log drop constraint w7_block`);
  }
  expect((await pools.root.query(`select name, email from auth."user" where id = $1`, [f.aUser.userId])).rows[0]).toEqual(before);
  expect((await pools.root.query(`select state from hdu_memberships where user_id = $1`, [f.aUser.userId])).rows.map((r) => r.state)).toEqual(['active']);
});

test('дата окончания договора: задаёт и снимает только администратор со свежим входом, журнал в той же транзакции; клиент её не видит', async () => {
  const admin = staffCtx(f.adminStaff);
  await expect(setOrgContractEnd(staffCtx(f.care), { orgId: f.orgA.orgId, contractEndsOn: '2026-12-31' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(setOrgContractEnd({ ...admin, freshAuthAt: new Date(Date.now() - 3_600_000) }, { orgId: f.orgA.orgId, contractEndsOn: '2026-12-31' })).rejects.toMatchObject({ code: 'stale_session' });
  for (const bad of ['31.12.2026', '2026-13-01', '', '1899-01-01']) await expect(setOrgContractEnd(admin, { orgId: f.orgA.orgId, contractEndsOn: bad }), bad).rejects.toMatchObject({ code: 'invalid_input' });
  await setOrgContractEnd(admin, { orgId: f.orgA.orgId, contractEndsOn: '2026-12-31' });
  expect((await pools.root.query(`select contract_ends_on::text as d from hdu_organizations where org_id = $1`, [f.orgA.orgId])).rows[0].d).toBe('2026-12-31');
  expect(await audit('org.contract_end_set')).toEqual([expect.objectContaining({ actor_id: f.adminStaff.userId, object_id: f.orgA.orgId, org_id: f.orgA.orgId, diff: { from: null, to: '2026-12-31' } })]);
  // То же значение второй записи не пишет; снятие пишет.
  await setOrgContractEnd(admin, { orgId: f.orgA.orgId, contractEndsOn: '2026-12-31' });
  await setOrgContractEnd(admin, { orgId: f.orgA.orgId, contractEndsOn: null });
  expect((await audit('org.contract_end_set')).map((r) => r.diff)).toEqual([{ from: null, to: '2026-12-31' }, { from: '2026-12-31', to: null }]);
  // База: сотрудник care дату не меняет даже прямым запросом под своей ролью.
  await expect(asActor(pools.auth, f.care.actor, (c) => c.query(`update hdu_organizations set contract_ends_on = '2020-01-01' where org_id = $1`, [f.orgA.orgId]))).rejects.toThrow(/договор/);
});

/** Закрытое обращение с чистым файлом в хранилище. closedDaysAgo: сколько суток назад закрыто. */
async function closedWithFile(ticketId: string, orgId: string, closedDaysAgo: number): Promise<string> {
  await pools.root.query(`update hdt_tickets set status = 'closed', resolved_on = now() - make_interval(days => $2), closed_on = now() - make_interval(days => $2), resolution_type = 'solved' where ticket_id = $1`, [ticketId, closedDaysAgo]);
  const id = (await pools.root.query(`select attachment_id from hdt_attachments where ticket_id = $1 and scan_status = 'clean' and not is_internal limit 1`, [ticketId])).rows[0].attachment_id as string;
  await storage.put(`files/${orgId}/${id}`, Buffer.from('файл'), 'text/plain');
  await pools.root.query(`update hdt_attachments set storage_key = $2 where attachment_id = $1`, [id, `files/${orgId}/${id}`]);
  return id;
}

test('задача хранения выключена по умолчанию: пробный прогон только считает и ничего не меняет', async () => {
  const old = await closedWithFile(f.tickets.aOrg.ticketId, f.orgA.orgId, 400);
  await pools.root.query(`update hdu_organizations set contract_ends_on = current_date - 1200 where org_id = $1`, [f.orgB.orgId]);
  const snapshot = async () => JSON.stringify((await pools.root.query(`select attachment_id, scan_status, storage_key from hdt_attachments order by attachment_id`)).rows);
  const before = await snapshot();
  const tickets = (await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n;
  const report = await runClientDataRetention(SYSTEM);
  expect(report.mode).toBe('dry_run');
  expect(report.attachmentsDue).toBeGreaterThanOrEqual(1);
  expect(report.attachmentsExpired).toBe(0);
  // Обращения организации Б: договор кончился больше трёх лет назад.
  expect(report.orgsDue).toBe(1);
  expect(report.ticketsDue).toBe((await pools.root.query(`select count(*)::int as n from hdt_tickets where org_id = $1`, [f.orgB.orgId])).rows[0].n);
  expect(report.ticketsDeleted).toBe(0);
  expect(await snapshot()).toBe(before);
  expect(await storage.head(`files/${f.orgA.orgId}/${old}`)).toBeTruthy();
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n).toBe(tickets);
  expect(await audit('retention.attachments_expired')).toEqual([]);
});

test('задача хранения включена настройкой: файл обращения, закрытого больше года назад, удалён и помечен; свежие не тронуты; обращения только считаются', async () => {
  const old = await closedWithFile(f.tickets.aOrg.ticketId, f.orgA.orgId, 400);
  const fresh = await closedWithFile(f.tickets.bOrg.ticketId, f.orgB.orgId, 100);
  await pools.root.query(`update hdu_organizations set contract_ends_on = current_date - 1200 where org_id = $1`, [f.orgB.orgId]);
  await pools.root.query(`insert into hdc_settings (code, value) values ('retention.client_data_enabled', 'true'::jsonb)`);
  for (const status of ['infected', 'rejected']) {
    await pools.root.query(
      `insert into hdt_attachments (org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status) values ($1, $2, $3, $4, 'virus.png', 'image/png', 10, $5)`,
      [f.orgA.orgId, f.tickets.aOrg.ticketId, f.aUser.userId, `quarantine/${f.orgA.orgId}/${status}`, status],
    );
    await storage.put(`quarantine/${f.orgA.orgId}/${status}`, Buffer.from('x'), 'image/png');
  }
  const colleagueBefore = await getTicket(await clientCtx(f.aAdmin), String(f.tickets.aOrg.number)).then((view) => [...view!.attachments, ...view!.messages.flatMap((m) => m.attachments)]);
  const tickets = (await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n;
  const report = await runClientDataRetention(SYSTEM);
  expect(report).toMatchObject({ mode: 'delete', ticketsDeleted: 0, orgsDue: 1 });
  // К удалению подошли только чистые файлы старого обращения: файл клиента и внутренний файл сотрудника.
  expect(report).toMatchObject({ attachmentsDue: 2, attachmentsExpired: 2, attachmentsFailed: 0 });
  expect((await pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [old])).rows[0].scan_status).toBe('expired');
  expect(await storage.head(`files/${f.orgA.orgId}/${old}`)).toBeFalsy();
  // Файл обращения, закрытого меньше года назад, остаётся.
  expect((await pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [fresh])).rows[0].scan_status).toBe('clean');
  expect(await storage.head(`files/${f.orgB.orgId}/${fresh}`)).toBeTruthy();
  // Обращения не удаляются этой версией задачи (решение 0162): число строк прежнее.
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n).toBe(tickets);
  // Журнал аудита: одна запись на прогон с числом файлов, без имён файлов.
  const rows = await audit('retention.attachments_expired');
  expect(rows).toHaveLength(1);
  expect(rows[0].diff).toEqual({ count: 2, olderThanDays: 365 });
  // Загрузивший видит строку с отметкой "удалён по сроку хранения" вместо ссылки.
  const filesOf = (view: Awaited<ReturnType<typeof getTicket>>) => [...view!.attachments, ...view!.messages.flatMap((m) => m.attachments)];
  const seen = filesOf(await getTicket(await clientCtx(f.aUser), String(f.tickets.aOrg.number))).find((a) => a.attachmentId === old);
  expect(seen).toBeDefined();
  expect(seen!.scanStatus).toBe('expired');
  // Коллега, который файл не загружал, строки не видит вовсе (политика отдаёт клиенту только файлы clean).
  expect(colleagueBefore.map((a) => a.attachmentId)).toContain(old);
  expect(filesOf(await getTicket(await clientCtx(f.aAdmin), String(f.tickets.aOrg.number))).map((a) => a.attachmentId)).not.toContain(old);
  // Непроверенный, заражённый и отклонённый файлы того же обращения задача не трогает (их ведёт проверка файлов).
  expect((await pools.root.query(`select scan_status, count(*)::int as n from hdt_attachments where ticket_id = $1 and scan_status <> 'expired' group by 1 order by 1`, [f.tickets.aOrg.ticketId])).rows).toEqual([
    { scan_status: 'infected', n: 1 },
    { scan_status: 'pending', n: 1 },
    { scan_status: 'rejected', n: 1 },
  ]);
  expect(await storage.head(`quarantine/${f.orgA.orgId}/infected`)).toBeTruthy();
  // Повторный прогон: нечего удалять, новой записи журнала нет.
  expect((await runClientDataRetention(SYSTEM)).attachmentsExpired).toBe(0);
  expect(await audit('retention.attachments_expired')).toHaveLength(1);
});

test('сбой хранилища: строка не помечается, пока файл не удалён; в журнале число удалённых; следующий прогон добирает файл', async () => {
  const old = await closedWithFile(f.tickets.aOrg.ticketId, f.orgA.orgId, 400);
  const key = `files/${f.orgA.orgId}/${old}`;
  await pools.root.query(`insert into hdc_settings (code, value) values ('retention.client_data_enabled', 'true'::jsonb)`);
  // Хранилище отказывает в удалении одного файла.
  let broken = true;
  const remove = storage.remove.bind(storage);
  storage.remove = async (target: string) => {
    if (broken && target === key) throw new Error('хранилище недоступно');
    await remove(target);
  };
  const first = await runClientDataRetention(SYSTEM);
  expect(first).toMatchObject({ mode: 'delete', attachmentsDue: 2, attachmentsExpired: 1, attachmentsFailed: 1 });
  // Файл на месте, строка по-прежнему clean: клиенту ссылка работает, задача вернётся к файлу.
  expect(await storage.head(key)).toBeTruthy();
  expect((await pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [old])).rows[0].scan_status).toBe('clean');
  expect((await audit('retention.attachments_expired')).map((r) => r.diff)).toEqual([{ count: 1, olderThanDays: 365 }]);
  // Хранилище снова работает: следующий прогон удаляет файл и помечает строку.
  broken = false;
  const second = await runClientDataRetention(SYSTEM);
  expect(second).toMatchObject({ attachmentsDue: 1, attachmentsExpired: 1, attachmentsFailed: 0 });
  expect(await storage.head(key)).toBeFalsy();
  expect((await pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [old])).rows[0].scan_status).toBe('expired');
  expect((await audit('retention.attachments_expired')).map((r) => r.diff)).toEqual([
    { count: 1, olderThanDays: 365 },
    { count: 1, olderThanDays: 365 },
  ]);
});

test('файл удалён, а отметка не записалась (процесс упал): повторный прогон помечает строку, удаление повторяется без ошибки', async () => {
  const old = await closedWithFile(f.tickets.aOrg.ticketId, f.orgA.orgId, 400);
  await pools.root.query(`insert into hdc_settings (code, value) values ('retention.client_data_enabled', 'true'::jsonb)`);
  // Журнал отклоняет запись: транзакция отметки откатывается уже после удаления файла.
  await pools.root.query(`alter table hdc_audit_log add constraint w7_block check (action <> 'retention.attachments_expired') not valid`);
  try {
    await expect(runClientDataRetention(SYSTEM)).rejects.toThrow();
  } finally {
    await pools.root.query(`alter table hdc_audit_log drop constraint w7_block`);
  }
  expect(await storage.head(`files/${f.orgA.orgId}/${old}`)).toBeFalsy();
  expect((await pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [old])).rows[0].scan_status).toBe('clean');
  expect(await runClientDataRetention(SYSTEM)).toMatchObject({ attachmentsDue: 2, attachmentsExpired: 2, attachmentsFailed: 0 });
  expect((await pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [old])).rows[0].scan_status).toBe('expired');
  expect(await audit('retention.attachments_expired')).toHaveLength(1);
});
