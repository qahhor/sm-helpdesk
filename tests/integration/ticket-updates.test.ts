import { beforeEach, expect, test } from 'vitest';
import { getAgentTicket, postStaffMessage, replyToTicket, setPriority, setStatus, takeTicket, transferToL2 } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { captureQueries } from './helpers/bulk';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Одно обновление строки обращения на действие (аудит 23.11.2026, находка P8; план W2, задача 3). Каждое обновление
// строки переписывает её целиком и трогает индексы таблицы: четыре обновления на один ответ это четыре версии строки.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';
/** Сколько команд UPDATE по таблице обращений отправило действие. */
async function ticketUpdates(action: () => Promise<unknown>): Promise<string[]> {
  const { queries } = await captureQueries(action);
  return queries.map((q) => q.text.replace(/\s+/g, ' ')).filter((text) => /^update "hdt_tickets"/i.test(text));
}

test('первый ответ сотрудника на новое обращение обновляет строку один раз: ответ, исполнитель, статус и сроки вместе', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const seenVersion = await versionOf(t.number);
  const updates = await ticketUpdates(() => postStaffMessage(l1, { number: t.number, body: 'Проверьте настройки печати', internal: false, seenVersion }));
  expect(updates, updates.join('\n')).toHaveLength(1);
  const row = (await pools.root.query(`select status, assignee_id, first_responded_on, client_waiting_since from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  expect(row).toMatchObject({ status: 'in_progress', assignee_id: f.l1.userId, client_waiting_since: null });
  expect(row.first_responded_on).not.toBeNull();
});

test('ответ сотрудника с "Ждём вашего ответа" обновляет строку один раз, пауза срока поставлена', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const seenVersion = await versionOf(t.number);
  const updates = await ticketUpdates(() => postStaffMessage(l1, { number: t.number, body: 'Пришлите номер документа', internal: false, seenVersion, waitForClient: true }));
  expect(updates, updates.join('\n')).toHaveLength(1);
  const row = (await pools.root.query(`select status, sla_paused_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  expect(row.status).toBe('waiting_customer');
  expect(row.sla_paused_on).not.toBeNull();
});

test('ответ клиента: одно обновление, когда статус не меняется; два, когда снимается пауза срока', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  const ctx = await clientCtx(f.aUser);
  const plain = await ticketUpdates(() => replyToTicket(ctx, { number: t.number, body: 'Ещё подробность' }));
  expect(plain, plain.join('\n')).toHaveLength(1);
  await postStaffMessage(l1, { number: t.number, body: 'Пришлите номер документа', internal: false, seenVersion: await versionOf(t.number), waitForClient: true });
  // Сроки клиент менять не может (защита базы): их вторым обновлением пересчитывает система.
  const resumed = await ticketUpdates(() => replyToTicket(ctx, { number: t.number, body: 'Номер 15' }));
  expect(resumed.length, resumed.join('\n')).toBeLessThanOrEqual(2);
  const row = (await pools.root.query(`select status, sla_paused_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  expect(row).toEqual({ status: 'in_progress', sla_paused_on: null });
});

test('смена приоритета обновляет строку один раз вместе со сроками', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const before = (await pools.root.query(`select resolution_due_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].resolution_due_on;
  const updates = await ticketUpdates(() => setPriority(l1, { number: t.number, priority: 'p2', reason: 'Не проводятся документы' }));
  expect(updates, updates.join('\n')).toHaveLength(1);
  const row = (await pools.root.query(`select priority, priority_confirmed, resolution_due_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  expect(row).toMatchObject({ priority: 'p2', priority_confirmed: true });
  expect(row.resolution_due_on?.getTime()).not.toBe(before?.getTime());
  // Поднятие до P1 ставит ещё отметку "дежурные оповещены": она пишется после постановки сообщения в очередь.
  const urgent = await ticketUpdates(() => setPriority(l1, { number: t.number, priority: 'p1', reason: 'Остановлена отгрузка' }));
  expect(urgent.length, urgent.join('\n')).toBeLessThanOrEqual(2);
});

test('смена статуса и передача на вторую линию обновляют строку один раз', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  const status = await ticketUpdates(() => setStatus(l1, { number: t.number, to: 'waiting_customer' }));
  expect(status, status.join('\n')).toHaveLength(1);
  const back = await ticketUpdates(() => setStatus(l1, { number: t.number, to: 'in_progress' }));
  expect(back, back.join('\n')).toHaveLength(1);
  const transfer = await ticketUpdates(() => transferToL2(l1, { number: t.number, reason: 'suspected_bug', checked: 'Проверил настройки печати', needed: 'Посмотреть журнал сервера' }));
  expect(transfer, transfer.join('\n')).toHaveLength(1);
});

test('взятие в работу обновляет строку один раз', async () => {
  const updates = await ticketUpdates(() => takeTicket(staffCtx(f.l1), f.tickets.aOrg.number));
  expect(updates, updates.join('\n')).toHaveLength(1);
});
