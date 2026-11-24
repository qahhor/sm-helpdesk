import { expect, test } from 'vitest';
import { getAgentTicket, listQueue, postStaffMessage, setStatus, snoozeTicket, takeTicket, ticketsMinute } from '@/modules/hdt/api';
import { staffCtx } from './helpers/auth';
import { seedTwoOrgs } from './isolation/fixture';

// Пометка "вернулось из отложенных" в строке очереди (FR-AG-13, UX-A-11; итоговая проверка M3, мелкое 7;
// план W3, задача 2). Ставит её задача возврата, снимает первое действие сотрудника. Чтение не снимает.

const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
const MINUTE = 60_000;

async function snoozedAndReturned() {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  const until = new Date(Date.now() + 60 * MINUTE);
  await snoozeTicket(l1, { number: t.number, until: until.toISOString() });
  const rowOf = async () => (await listQueue(l1, { queue: 'mine' })).items.find((item) => item.number === t.number);
  const before = await rowOf();
  await ticketsMinute(SYSTEM, new Date(until.getTime() + MINUTE));
  return { f, l1, t, rowOf, before };
}

test('обращение вернулось из отложенных: строка очереди и страница несут пометку, чтение её не снимает', async () => {
  const { l1, t, rowOf, before } = await snoozedAndReturned();
  expect(before?.snoozeReturned).toBe(false);
  expect((await rowOf())?.snoozeReturned).toBe(true);
  expect((await getAgentTicket(l1, t.number))?.snoozeReturned).toBe(true);
  // Открытие страницы и повторный проход задачи пометку не трогают.
  await ticketsMinute(SYSTEM, new Date(Date.now() + 120 * MINUTE));
  expect((await rowOf())?.snoozeReturned).toBe(true);
});

test('пометку снимает первое действие сотрудника: заметка', async () => {
  const { l1, t, rowOf } = await snoozedAndReturned();
  await postStaffMessage(l1, { number: t.number, body: 'Проверил, жду разработку', internal: true, seenVersion: (await getAgentTicket(l1, t.number))?.version ?? '' });
  expect((await rowOf())?.snoozeReturned).toBe(false);
});

test('пометку снимают смена статуса и новое откладывание', async () => {
  const first = await snoozedAndReturned();
  await setStatus(first.l1, { number: first.t.number, to: 'waiting_customer' });
  expect((await getAgentTicket(first.l1, first.t.number))?.snoozeReturned).toBe(false);
  const second = await snoozedAndReturned();
  await snoozeTicket(second.l1, { number: second.t.number, until: new Date(Date.now() + 300 * MINUTE).toISOString() });
  expect((await getAgentTicket(second.l1, second.t.number))?.snoozeReturned).toBe(false);
});

test('решённому и закрытому обращению пометка не ставится и не показывается (проверка волны 3)', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  const until = new Date(Date.now() + 60 * MINUTE);
  await snoozeTicket(l1, { number: t.number, until: until.toISOString() });
  // Сотрудник решил обращение, не снимая отложения: завтрашний возврат пометку ставить не должен.
  await setStatus(l1, { number: t.number, to: 'resolved', resolution: 'solved' });
  await ticketsMinute(SYSTEM, new Date(until.getTime() + MINUTE));
  expect((await getAgentTicket(l1, t.number))?.snoozeReturned).toBe(false);
  expect((await listQueue(l1, { queue: 'all', sort: 'updated' })).items.find((item) => item.number === t.number)?.snoozeReturned).toBe(false);
});

test('пометка стояла, обращение закрыли без действия сотрудника: у закрытого её не видно (проверка волны 3)', async () => {
  const { f, l1, t } = await snoozedAndReturned();
  expect((await getAgentTicket(l1, t.number))?.snoozeReturned).toBe(true);
  // Закрытие системой или клиентом через сервис сотрудника не идёт: здесь состояние задаётся напрямую.
  const { pools } = await import('./helpers/db');
  await pools.root.query(`update hdt_tickets set status = 'closed', closed_on = now(), resolved_on = now() where ticket_id = $1`, [t.ticketId]);
  expect((await getAgentTicket(l1, t.number))?.snoozeReturned).toBe(false);
  expect((await listQueue(l1, { queue: 'all', sort: 'updated' })).items.find((item) => item.number === t.number)?.snoozeReturned).toBe(false);
  expect(f.orgA.orgId).toBeTruthy();
});
