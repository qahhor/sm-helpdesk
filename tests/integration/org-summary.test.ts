import { expect, test } from 'vitest';
import { orgTicketSummary } from '@/modules/hdt/api';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Сводка по обращениям организации для администратора клиента (ТЗ 5.1; волна 7, T8). Числа по статусам считаются
// под актором клиента: организация берётся из актора, а не из запроса; политика RLS не даёт строк другой организации.

test('администратор клиента видит числа по статусам только своей организации', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now(), resolution_type = 'solved' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  const summary = await orgTicketSummary(await clientCtx(f.aAdmin));
  const expected = (await pools.root.query(`select status, count(*)::int as n from hdt_tickets where org_id = $1 group by status`, [f.orgA.orgId])).rows as { status: string; n: number }[];
  expect(summary.total).toBe(expected.reduce((sum, row) => sum + row.n, 0));
  expect(summary.total).toBeGreaterThanOrEqual(3);
  for (const row of expected) expect(summary.byStatus[row.status as keyof typeof summary.byStatus], row.status).toBe(row.n);
  expect(summary.byStatus.in_progress).toBeGreaterThanOrEqual(1);
  expect(summary.byStatus.resolved).toBeGreaterThanOrEqual(1);
  expect(summary.open).toBe(expected.filter((row) => !['resolved', 'closed'].includes(row.status)).reduce((sum, row) => sum + row.n, 0));
  // Организация Б считается отдельно, и её числа не совпадают с общими.
  const other = await orgTicketSummary(await clientCtx(f.bAdmin));
  const all = (await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n as number;
  expect(summary.total + other.total).toBe(all);
});

test('обычный участник сводку не получает; лишний ввод не принимается', async () => {
  const f = await seedTwoOrgs();
  await expect(orgTicketSummary(await clientCtx(f.aUser))).rejects.toMatchObject({ code: 'forbidden' });
  // Организацию нельзя подсказать вводом: у функции нет параметров, кроме контекста.
  expect(orgTicketSummary.length).toBe(1);
});
