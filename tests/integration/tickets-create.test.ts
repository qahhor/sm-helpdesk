import { expect, test } from 'vitest';
import { createTicket } from '@/modules/hdt/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Создание обращения клиентом (FR-TK-01..05, раздел 10.3, план M2, задача 2).

const input = (extra: Record<string, unknown> = {}) => ({
  description: 'При сохранении заказа выходит ошибка: нет остатка на складе. Что делать?',
  type: 'bug',
  impact: 'blocker',
  locale: 'ru',
  ...extra,
});

const ticketByNumber = async (number: number) =>
  (await pools.root.query(`select * from hdt_tickets where number = $1`, [number])).rows[0] as Record<string, unknown>;

test('обращение создаётся в организации актора с номером от 1001, приоритетом из влияния, событием и записью журнала', async () => {
  const f = await seedTwoOrgs();
  const { number } = await createTicket(await clientCtx(f.aUser), input());
  expect(number).toBeGreaterThanOrEqual(1001);
  const t = await ticketByNumber(number);
  expect(t).toMatchObject({ org_id: f.orgA.orgId, author_id: f.aUser.userId, status: 'new', queue: 'l1', priority: 'p1', impact: 'blocker', type: 'bug', visibility: 'org', source: 'portal', locale: 'ru' });
  expect((await pools.root.query(`select kind, actor_type, actor_id from hdt_ticket_events where ticket_id = $1`, [t.ticket_id])).rows).toEqual([
    { kind: 'created', actor_type: 'client', actor_id: f.aUser.userId },
  ]);
  expect((await pools.root.query(`select user_id, source from hdt_ticket_watchers where ticket_id = $1`, [t.ticket_id])).rows).toEqual([
    { user_id: f.aUser.userId, source: 'author' },
  ]);
  const audit = (await pools.root.query(`select org_id, object_id, diff from hdc_audit_log where action = 'ticket.created'`)).rows;
  expect(audit).toEqual([{ org_id: f.orgA.orgId, object_id: t.ticket_id, diff: { type: 'bug', priority: 'p1' } }]);
});

test('подставленная организация Б отбрасывается: обращение в А, в Б ничего не появилось (15.2)', async () => {
  const f = await seedTwoOrgs();
  const before = (await pools.root.query(`select count(*)::int as n from hdt_tickets where org_id = $1`, [f.orgB.orgId])).rows[0].n;
  const { number } = await createTicket(await clientCtx(f.aUser), input({ orgId: f.orgB.orgId, org_id: f.orgB.orgId, authorId: f.bUser.userId }));
  expect(await ticketByNumber(number)).toMatchObject({ org_id: f.orgA.orgId, author_id: f.aUser.userId });
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where org_id = $1`, [f.orgB.orgId])).rows[0].n).toBe(before);
});

test('тема из первых слов описания, своя тема сохраняется', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  expect(await ticketByNumber((await createTicket(ctx, input())).number)).toMatchObject({
    title: 'При сохранении заказа выходит ошибка: нет остатка на складе',
  });
  expect(await ticketByNumber((await createTicket(ctx, input({ title: '  Свой заголовок  ', visibility: 'private', impact: 'question' }))).number)).toMatchObject({
    title: 'Свой заголовок',
    visibility: 'private',
    priority: 'p4',
  });
});

test('неверные поля отклоняются invalid_input', async () => {
  const ctx = await clientCtx((await seedTwoOrgs()).aUser);
  for (const bad of [{ description: '' }, { description: '   ' }, { type: 'feature' }, { impact: 'huge' }, { visibility: 'public' }, { description: 'я'.repeat(20001) }, { title: 'я'.repeat(201) }])
    await expect(createTicket(ctx, input(bad)), JSON.stringify(bad).slice(0, 60)).rejects.toMatchObject({ code: 'invalid_input' });
});

test('чужое или уже прикреплённое вложение не прикрепляется, больше 10 файлов отклоняется', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const upload = async (uploaderId: string, orgId: string) =>
    (
      await pools.root.query(
        `insert into hdt_attachments (org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, 'quarantine/' || gen_random_uuid(), 'a.png', 'image/png', 10) returning attachment_id`,
        [orgId, uploaderId],
      )
    ).rows[0].attachment_id as string;
  const mine = await upload(f.aUser.userId, f.orgA.orgId);
  const { number } = await createTicket(ctx, input({ attachmentIds: [mine] }));
  const t = await ticketByNumber(number);
  expect((await pools.root.query(`select ticket_id from hdt_attachments where attachment_id = $1`, [mine])).rows[0].ticket_id).toBe(t.ticket_id);
  // Уже прикреплённое и чужое: отказ "файл недоступен", обращение не создаётся.
  const colleague = await upload(f.aAdmin.userId, f.orgA.orgId);
  for (const ids of [[mine], [colleague]]) await expect(createTicket(ctx, input({ attachmentIds: ids }))).rejects.toMatchObject({ code: 'file_unavailable' });
  const many = await Promise.all(Array.from({ length: 11 }, () => upload(f.aUser.userId, f.orgA.orgId)));
  await expect(createTicket(ctx, input({ attachmentIds: many }))).rejects.toMatchObject({ code: 'too_many_files' });
});

test('модуль только действующий, связанное обращение только видимое клиенту', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const mod = async (code: string, state: string) =>
    (await pools.root.query(`insert into hdr_product_modules (code, name, state) values ($1, '{"ru":"Заказы"}', $2) returning module_id`, [code, state])).rows[0]
      .module_id as string;
  const active = await mod(`orders-${Date.now()}`, 'active');
  const passive = await mod(`old-${Date.now()}`, 'passive');
  expect(await ticketByNumber((await createTicket(ctx, input({ moduleId: active }))).number)).toMatchObject({ module_id: active });
  await expect(createTicket(ctx, input({ moduleId: passive }))).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await ticketByNumber((await createTicket(ctx, input({ relatedNumber: f.tickets.aOrg.number }))).number)).toMatchObject({
    related_ticket_id: f.tickets.aOrg.ticketId,
  });
  for (const hidden of [f.tickets.bOrg.number, f.tickets.aPrivate.number])
    await expect(createTicket(ctx, input({ relatedNumber: hidden }))).rejects.toMatchObject({ code: 'invalid_input' });
});

test('одиннадцатое обращение за час отклоняется rate_limited', async () => {
  const ctx = await clientCtx((await seedTwoOrgs()).aUser);
  for (let i = 0; i < RATE_RULES.ticketCreatePerUser.limit; i++) await createTicket(ctx, input());
  await expect(createTicket(ctx, input())).rejects.toMatchObject({ code: 'rate_limited' });
});
