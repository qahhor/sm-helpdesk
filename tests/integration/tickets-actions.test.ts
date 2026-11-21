import { expect, test } from 'vitest';
import { confirmResolution, getTicket, rateTicket, reopenTicket, replyToTicket, setTicketVisibility, unwatchTicket, watchTicket } from '@/modules/hdt/api';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Ответ и действия клиента над обращением (FR-TK-08..12, решения 0026; план M2, задача 4).

const setStatus = (ticketId: string, status: string, closedDaysAgo?: number) =>
  pools.root.query(
    `update hdt_tickets set status = $2, closed_on = case when $3::int is null then closed_on else now() - make_interval(days => $3::int) end where ticket_id = $1`,
    [ticketId, status, closedDaysAgo ?? null],
  );
const statusOf = async (ticketId: string) => (await pools.root.query(`select status from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0].status;
const events = async (ticketId: string, kind = 'status') =>
  (await pools.root.query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = $2 order by created_on, event_id`, [ticketId, kind])).rows.map(
    (r) => r.payload,
  );

test('ответ в "Ждём вашего ответа" переводит в "В работе", в закрытое обращение ответить нельзя', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const t = f.tickets.aOrg;
  await setStatus(t.ticketId, 'waiting_customer');
  await replyToTicket(ctx, { number: t.number, body: 'Отчёт за ноябрь' });
  expect(await statusOf(t.ticketId)).toBe('in_progress');
  expect(await events(t.ticketId)).toEqual([{ from: 'waiting_customer', to: 'in_progress' }]);
  const last = (await pools.root.query(`select author_id, author_type, body, is_internal from hdt_ticket_messages where ticket_id = $1 order by created_on desc limit 1`, [t.ticketId])).rows[0];
  expect(last).toEqual({ author_id: f.aUser.userId, author_type: 'client', body: 'Отчёт за ноябрь', is_internal: false });
  expect((await pools.root.query(`select last_client_message_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].last_client_message_on).not.toBeNull();
  // В обращении "В работе" ответ статус не меняет.
  await replyToTicket(ctx, { number: t.number, body: 'Ещё деталь' });
  expect(await events(t.ticketId)).toHaveLength(1);
  await setStatus(t.ticketId, 'closed', 1);
  await expect(replyToTicket(ctx, { number: t.number, body: 'Ещё' })).rejects.toMatchObject({ code: 'transition_refused' });
  await expect(replyToTicket(ctx, { number: t.number, body: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('ответ на решённое обращение открывает его заново (решение 4)', async () => {
  const f = await seedTwoOrgs();
  await setStatus(f.tickets.aOrg.ticketId, 'resolved');
  await replyToTicket(await clientCtx(f.aUser), { number: f.tickets.aOrg.number, body: 'Не помогло' });
  expect(await statusOf(f.tickets.aOrg.ticketId)).toBe('in_progress');
});

test('решение подошло: resolved → closed один раз, второе одновременное нажатие transition_refused, событие одно (на что смотреть, 3)', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await setStatus(t.ticketId, 'resolved');
  const ctx = await clientCtx(f.aUser);
  const results = await Promise.allSettled([confirmResolution(ctx, t.number), confirmResolution(ctx, t.number)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'transition_refused' } });
  expect(await statusOf(t.ticketId)).toBe('closed');
  expect(await events(t.ticketId)).toEqual([{ from: 'resolved', to: 'closed' }]);
  expect((await pools.root.query(`select closed_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].closed_on).not.toBeNull();
  await expect(confirmResolution(ctx, f.tickets.aMine.number)).rejects.toMatchObject({ code: 'transition_refused' });
});

test('открыть заново в пределах 14 дней можно, на 15-й день reopen_expired; срок меняется настройкой', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const t = f.tickets.aOrg;
  await setStatus(t.ticketId, 'closed', 13);
  await reopenTicket(ctx, { number: t.number, body: 'Ошибка вернулась' });
  expect(await statusOf(t.ticketId)).toBe('in_progress');
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and body = 'Ошибка вернулась'`, [t.ticketId])).rows[0].n).toBe(1);
  await setStatus(t.ticketId, 'closed', 15);
  await expect(reopenTicket(ctx, { number: t.number })).rejects.toMatchObject({ code: 'reopen_expired' });
  await pools.root.query(`insert into hdc_settings (code, value) values ('tickets.reopen_days', '30')`);
  await reopenTicket(ctx, { number: t.number });
  expect(await statusOf(t.ticketId)).toBe('in_progress');
  // Решённое тоже можно вернуть в работу, новое нельзя.
  await setStatus(t.ticketId, 'resolved');
  await reopenTicket(ctx, { number: t.number });
  expect(await statusOf(t.ticketId)).toBe('in_progress');
  await expect(reopenTicket(ctx, { number: f.tickets.aMine.number })).rejects.toMatchObject({ code: 'transition_refused' });
});

test('оценка только у закрытого, один раз, причина обязательна при 1-3', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const t = f.tickets.aOrg;
  await expect(rateTicket(ctx, { number: t.number, score: 5 })).rejects.toMatchObject({ code: 'transition_refused' });
  await setStatus(t.ticketId, 'closed', 0);
  await expect(rateTicket(ctx, { number: t.number, score: 2 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(rateTicket(ctx, { number: t.number, score: 6 })).rejects.toMatchObject({ code: 'invalid_input' });
  await rateTicket(ctx, { number: t.number, score: 2, reason: 'slow', comment: 'Ждали два дня' });
  expect((await pools.root.query(`select csat_score, csat_reason, csat_comment from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0]).toEqual({
    csat_score: 2,
    csat_reason: 'slow',
    csat_comment: 'Ждали два дня',
  });
  expect(await events(t.ticketId, 'rated')).toEqual([{ score: 2 }]);
  await expect(rateTicket(ctx, { number: t.number, score: 5 })).rejects.toMatchObject({ code: 'already_rated' });
});

test('видимость меняет автор или администратор клиента; личное обращение коллегам не видно, подписки коллег снимаются (решение 17 плана)', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await watchTicket(await clientCtx(f.aAdmin), t.number);
  await expect(setTicketVisibility(await clientCtx(f.aAdmin), { number: f.tickets.aMine.number, visibility: 'org' })).resolves.toBeUndefined();
  await pools.root.query(`update hdt_tickets set visibility = 'org' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  await expect(setTicketVisibility(await clientCtx(f.aUser), { number: f.tickets.aPrivate.number, visibility: 'private' })).rejects.toMatchObject({ code: 'forbidden' });
  await setTicketVisibility(await clientCtx(f.aUser), { number: t.number, visibility: 'private' });
  expect(await events(t.ticketId, 'visibility')).toEqual([{ from: 'org', to: 'private' }]);
  // Подписка коллеги снята: администратор клиента видит личное обращение, но больше за ним не следит.
  expect((await getTicket(await clientCtx(f.aAdmin), String(t.number)))?.watching).toBe(false);
  const watchers = () => pools.root.query(`select user_id, source from hdt_ticket_watchers where ticket_id = $1 order by source`, [t.ticketId]).then((r) => r.rows);
  expect(await watchers()).toEqual([{ user_id: f.aUser.userId, source: 'author' }]);
  // Обращение снова открыто коллегам: прежняя подписка молча не возвращается.
  await setTicketVisibility(await clientCtx(f.aUser), { number: t.number, visibility: 'org' });
  expect((await getTicket(await clientCtx(f.aAdmin), String(t.number)))?.watching).toBe(false);
  expect(await getTicket(await clientCtx(f.aUser), String(f.tickets.aPrivate.number))).not.toBeNull();
});

test('подписка: только на обращение организации, автор не отписывается', async () => {
  const f = await seedTwoOrgs();
  const admin = await clientCtx(f.aAdmin);
  await watchTicket(admin, f.tickets.aOrg.number);
  await watchTicket(admin, f.tickets.aOrg.number);
  expect((await getTicket(admin, String(f.tickets.aOrg.number)))?.watching).toBe(true);
  await unwatchTicket(admin, f.tickets.aOrg.number);
  expect((await getTicket(admin, String(f.tickets.aOrg.number)))?.watching).toBe(false);
  await expect(watchTicket(admin, f.tickets.aMine.number)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(unwatchTicket(await clientCtx(f.aUser), f.tickets.aOrg.number)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(watchTicket(admin, f.tickets.bOrg.number)).rejects.toMatchObject({ code: 'not_found' });
});

test('сообщение в обращение Б отклоняется not_found (15.2)', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  for (const t of [f.tickets.bOrg, f.tickets.aPrivate]) {
    await expect(replyToTicket(ctx, { number: t.number, body: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(confirmResolution(ctx, t.number)).rejects.toMatchObject({ code: 'not_found' });
  }
});

test('ответ с файлами прикрепляет свои загрузки к сообщению, чужие отклоняются', async () => {
  const f = await seedTwoOrgs();
  const upload = async (userId: string) =>
    (
      await pools.root.query(
        `insert into hdt_attachments (org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, 'quarantine/' || gen_random_uuid(), 'log.txt', 'text/plain', 10) returning attachment_id`,
        [f.orgA.orgId, userId],
      )
    ).rows[0].attachment_id as string;
  const mine = await upload(f.aUser.userId);
  await replyToTicket(await clientCtx(f.aUser), { number: f.tickets.aOrg.number, body: 'Журнал', attachmentIds: [mine] });
  const row = (await pools.root.query(`select a.ticket_id, m.body from hdt_attachments a join hdt_ticket_messages m using (message_id) where a.attachment_id = $1`, [mine])).rows[0];
  expect(row).toEqual({ ticket_id: f.tickets.aOrg.ticketId, body: 'Журнал' });
  await expect(replyToTicket(await clientCtx(f.aUser), { number: f.tickets.aOrg.number, body: 'x', attachmentIds: [await upload(f.aAdmin.userId)] })).rejects.toMatchObject({
    code: 'invalid_input',
  });
});

test('каждое изменение статуса и видимости записано в журнал аудита без текста сообщения', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const t = f.tickets.aOrg;
  await setStatus(t.ticketId, 'waiting_customer');
  await replyToTicket(ctx, { number: t.number, body: 'Секретный текст ответа' });
  await setTicketVisibility(ctx, { number: t.number, visibility: 'private' });
  const rows = (await pools.root.query(`select action, object_id, org_id, diff from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [t.ticketId])).rows;
  expect(rows).toEqual([
    { action: 'ticket.status_changed', object_id: t.ticketId, org_id: f.orgA.orgId, diff: { from: 'waiting_customer', to: 'in_progress' } },
    { action: 'ticket.visibility_changed', object_id: t.ticketId, org_id: f.orgA.orgId, diff: { from: 'org', to: 'private' } },
  ]);
  expect(JSON.stringify(rows)).not.toContain('Секретный');
});
