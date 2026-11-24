import { expect, test } from 'vitest';
import { assignTicket, getAgentTicket, isHdtError, postStaffMessage, replyToTicket, setPriority, setStatus, takeTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Действие со старой страницы (FR-AG-12, UX-A-06; итоговая проверка M3, мелкое 5; план W3, задача 3). Форма действия
// передаёт версию обращения, которую видел сотрудник. Если после неё обращение изменили другие, действие не
// выполняется, сотрудник видит, что изменилось. Свои действия изменением не считаются.

const status = (ticketId: string) => pools.root.query(`select status, priority, assignee_id from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const changedOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (error) {
    if (!isHdtError(error) || error.code !== 'changed') throw error;
    return error.changed ?? null;
  }
};

test('клиент ответил, пока страница была открыта: смена статуса не выполняется и называет изменение', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  const seen = (await getAgentTicket(l1, t.number))?.version ?? '';
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Подождите, ошибка осталась' });
  const before = await status(t.ticketId);
  expect(await changedOf(() => setStatus(l1, { number: t.number, to: 'resolved', resolution: 'solved', seenVersion: seen }))).toEqual({ newMessages: 1, statusChanged: false, assigneeChanged: false });
  expect(await status(t.ticketId)).toEqual(before);
  // После обновления страницы версия свежая: действие проходит.
  const fresh = (await getAgentTicket(l1, t.number))?.version ?? '';
  await setStatus(l1, { number: t.number, to: 'resolved', resolution: 'solved', seenVersion: fresh });
  expect((await status(t.ticketId)).status).toBe('resolved');
});

test('другой сотрудник сменил статус и исполнителя: приоритет и исполнитель со старой страницы не меняются', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const other = staffCtx(await staffWithRole('agent_l1'));
  const t = f.tickets.aOrg;
  const seen = (await getAgentTicket(l1, t.number))?.version ?? '';
  await takeTicket(other, t.number);
  const before = await status(t.ticketId);
  expect(await changedOf(() => setPriority(l1, { number: t.number, priority: 'p1', reason: 'Стоит склад', seenVersion: seen }))).toEqual({ newMessages: 0, statusChanged: true, assigneeChanged: true });
  expect(await changedOf(() => assignTicket(l1, { number: t.number, assigneeId: f.l1.userId, seenVersion: seen }))).toMatchObject({ assigneeChanged: true });
  expect(await status(t.ticketId)).toEqual(before);
});

test('свои действия изменением не считаются; без версии действие работает как раньше', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const seen = (await getAgentTicket(l1, t.number))?.version ?? '';
  await takeTicket(l1, t.number);
  await postStaffMessage(l1, { number: t.number, body: 'Смотрю', internal: true, seenVersion: seen });
  // Версия старая, но менял только сам сотрудник.
  await setStatus(l1, { number: t.number, to: 'waiting_customer', seenVersion: seen });
  expect((await status(t.ticketId)).status).toBe('waiting_customer');
  // Вызов без версии (массовые действия, палитра): проверки нет.
  await setPriority(l1, { number: t.number, priority: 'p2', reason: 'Уточнил у клиента' });
  expect((await status(t.ticketId)).priority).toBe('p2');
});
