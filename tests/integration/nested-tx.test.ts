import { beforeEach, expect, test } from 'vitest';
import { createTicket, createTicketForClient, getAgentTicket, postStaffMessage, setStatus, ticketsMinute } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools, system } from './helpers/db';
import { countTx } from './helpers/tx';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Транзакция записи обращения не открывает вторую транзакцию (проверка качества, Q2): роли получателей, привязка
// Telegram и название организации читаются до неё. Раньше каждое уведомление клиенту держало соединение hub_app и
// блокировку обращения, пока ждало соединение пула hub_auth.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';
const mailsOf = (ticketId: string, template: string) =>
  pools.root.query(`select recipient_user_id from hdn_outbox where ticket_id = $1 and template = $2`, [ticketId, template]).then((r) => r.rows.map((row) => row.recipient_user_id as string));

test('клиент создаёт обращение: вложенных транзакций нет, письмо автору стоит', async () => {
  const ctx = await clientCtx(f.aUser);
  const { result, nested } = await countTx(() => createTicket(ctx, { description: 'Не печатается накладная', type: 'bug', impact: 'minor', locale: 'ru' }));
  expect(nested).toEqual([]);
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [result.number])).rows[0].ticket_id as string;
  expect(await mailsOf(ticketId, 'ticket_created')).toEqual([f.aUser.userId]);
});

test('сотрудник создаёт обращение за клиента, отвечает и решает: вложенных транзакций нет, письма стоят', async () => {
  const staff = staffCtx(f.l1);
  const created = await countTx(() =>
    createTicketForClient(staff, { orgId: f.orgA.orgId, authorId: f.aUser.userId, description: 'Клиент позвонил: не открывается отчёт', type: 'question', impact: 'minor', visibility: 'org', locale: 'ru', intakeChannel: 'phone' }),
  );
  expect(created.nested).toEqual([]);

  const t = f.tickets.aOrg;
  const seenVersion = await versionOf(t.number);
  const reply = await countTx(() => postStaffMessage(staff, { number: t.number, body: 'Проверьте настройки печати.', internal: false, seenVersion }));
  expect(reply.nested).toEqual([]);
  expect(await mailsOf(t.ticketId, 'ticket_reply')).toEqual([f.aUser.userId]);

  const status = await countTx(async () => setStatus(staff, { number: t.number, to: 'resolved', resolution: 'solved', seenVersion: await versionOf(t.number) }));
  expect(status.nested).toEqual([]);
  expect(await mailsOf(t.ticketId, 'ticket_resolved')).toEqual([f.aUser.userId]);
});

test('автозакрытие минутной задачей: вложенных транзакций нет, письмо о закрытии стоит', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now() - interval '30 days', resolution_type = 'solved' where ticket_id = $1`, [t.ticketId]);
  const { result, nested } = await countTx(() => ticketsMinute(system));
  expect(result.closed).toBe(1);
  expect(nested).toEqual([]);
  expect(await mailsOf(t.ticketId, 'ticket_status')).toEqual([f.aUser.userId]);
});

test('подписчик, добавленный после чтения получателей, получает уведомление: чтение из базы остаётся запасным путём', async () => {
  // Снимка нет вовсе (прямой вызов без обёртки невозможен снаружи), поэтому проверяется итог: коллега-подписчик
  // обращения организации получает письмо об ответе вместе с автором.
  const t = f.tickets.aOrg;
  await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`, [f.orgA.orgId, t.ticketId, f.aAdmin.userId]);
  await postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Ответ двоим.', internal: false, seenVersion: await versionOf(t.number) });
  expect((await mailsOf(t.ticketId, 'ticket_reply')).sort()).toEqual([f.aUser.userId, f.aAdmin.userId].sort());
});
