import { expect, test } from 'vitest';
import { getAgentTicket, getTicket, listQueue, listTickets, queueSidebar } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { countTransactions } from './helpers/bulk';
import { seedTwoOrgs } from './isolation/fixture';

// Бюджет транзакций загрузчиков страниц (аудит 23.11.2026, находки A3 и P5; план W1, задача 6). Каждая транзакция
// занимает соединение пула: рост этих чисел приближает очередь за соединениями. Тест падает, если загрузчик стал
// открывать больше транзакций, чем здесь записано.

test('страница очередей: список и боковая панель', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const counted = await countTransactions(() => Promise.all([listQueue(l1, { queue: 'new' }), queueSidebar(l1)]));
  const [, sidebar] = counted.result;
  expect(sidebar.counts.new).toBeGreaterThan(0);
  expect(sidebar.counts.all).toBeNull();
  expect(Array.isArray(sidebar.filters)).toBe(true);
  expect(sidebar.unidentified).toBe(0);
  // Было 6: счётчики, фильтры и "Неопознанные" шли тремя транзакциями.
  expect(counted.app).toBeLessThanOrEqual(4);
  expect(counted.auth).toBe(0);
});

test('обращение в рабочем месте, обращение и список клиента', async () => {
  const f = await seedTwoOrgs();
  const agent = await countTransactions(() => getAgentTicket(staffCtx(f.l1), f.tickets.aOrg.number));
  expect(agent.result).not.toBeNull();
  expect([agent.app, agent.auth]).toEqual([4, 2]);
  const ctx = await clientCtx(f.aUser);
  const ticket = await countTransactions(() => getTicket(ctx, f.tickets.aOrg.number));
  expect([ticket.app, ticket.auth]).toEqual([4, 0]);
  const list = await countTransactions(() => listTickets(ctx, {}));
  expect([list.app, list.auth]).toEqual([1, 0]);
});
