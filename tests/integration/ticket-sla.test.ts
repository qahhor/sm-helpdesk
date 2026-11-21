import { expect, test } from 'vitest';
import { saveCalendar } from '@/modules/hdr/api';
import { createTicket, getTicket, needsSlaRefresh, refreshTicketSla, replyToTicket } from '@/modules/hdt/api';
import { addWorkingDays, addWorkingMinutes, TASHKENT_DEFAULT } from '@/modules/hdt/sla';
import { clientCtx, staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Сроки обращения и пауза (ТЗ: 7.4, FR-SLA-03, FR-SLA-05, FR-SLA-08, таблица 11.7; план M3, задача 3).

const SYSTEM = { type: 'system', job: 'test' } as const;
const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00+05:00`);
const sla = (ticketId: string) =>
  pools.root
    .query(
      `select first_response_due_on, resolution_due_on, sla_paused_on, sla_paused_minutes, created_on from hdt_tickets where ticket_id = $1`,
      [ticketId],
    )
    .then((r) => r.rows[0] as { first_response_due_on: Date | null; resolution_due_on: Date | null; sla_paused_on: Date | null; sla_paused_minutes: number; created_on: Date });

/** Без триггеров служебных колонок: обращение и события в заданное время. */
async function rewrite(sqlText: string, params: unknown[]): Promise<void> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(sqlText, params);
    await client.query('commit');
  } finally {
    client.release();
  }
}
const statusEvent = (f: { orgA: { orgId: string } }, ticketId: string, from: string, to: string, when: Date) =>
  rewrite(
    `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, payload, created_on) values ($1, $2, 'status', 'staff', $3, $4)`,
    [f.orgA.orgId, ticketId, JSON.stringify({ from, to }), when],
  );

test('обращение клиента получает сроки сразу после создания', async () => {
  const f = await seedTwoOrgs();
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Не проводится накладная', type: 'bug', impact: 'major', locale: 'ru', attachmentIds: [] });
  const id = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  const row = await sla(id);
  // P2: первый ответ 1 час, решение 8 часов рабочего времени от создания.
  expect(row.first_response_due_on?.toISOString()).toBe(addWorkingMinutes(row.created_on, 60, TASHKENT_DEFAULT).toISOString());
  expect(row.resolution_due_on?.toISOString()).toBe(addWorkingMinutes(row.created_on, 480, TASHKENT_DEFAULT).toISOString());
});

test('агент сменил P3 на P1: сроки пересчитаны от момента создания по правилам P1', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  await rewrite(`update hdt_tickets set priority = 'p3', created_on = $2 where ticket_id = $1`, [id, at('2026-11-24 10:00')]);
  await refreshTicketSla(SYSTEM, id, at('2026-11-24 10:05'));
  expect((await sla(id)).resolution_due_on?.toISOString()).toBe(addWorkingDays(at('2026-11-24 10:00'), 2, TASHKENT_DEFAULT).toISOString());
  await pools.root.query(`update hdt_tickets set priority = 'p1' where ticket_id = $1`, [id]);
  await refreshTicketSla(SYSTEM, id, at('2026-11-24 10:20'));
  const row = await sla(id);
  expect(row.first_response_due_on?.toISOString()).toBe(at('2026-11-24 10:15').toISOString());
  expect(row.resolution_due_on?.toISOString()).toBe(at('2026-11-24 13:00').toISOString());
});

test('пауза "Ждём вашего ответа": срок решения сдвигается на рабочие минуты паузы', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  // P3, создано во вторник в 10:00: решение в четверг 10:00. Ждали клиента с 11:00 до 13:00, это 2 рабочих часа.
  await rewrite(`update hdt_tickets set priority = 'p3', status = 'waiting_customer', created_on = $2 where ticket_id = $1`, [id, at('2026-11-24 10:00')]);
  await statusEvent(f, id, 'in_progress', 'waiting_customer', at('2026-11-24 11:00'));
  await refreshTicketSla(SYSTEM, id, at('2026-11-24 11:01'));
  expect((await sla(id)).sla_paused_on?.toISOString()).toBe(at('2026-11-24 11:00').toISOString());
  await pools.root.query(`update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [id]);
  await statusEvent(f, id, 'waiting_customer', 'in_progress', at('2026-11-24 13:00'));
  // Задача досчитала через несколько минут: пауза считается по времени события, а не по времени досчёта.
  await refreshTicketSla(SYSTEM, id, at('2026-11-24 13:04'));
  const row = await sla(id);
  expect(row.sla_paused_on).toBeNull();
  expect(row.sla_paused_minutes).toBe(120);
  expect(row.resolution_due_on?.toISOString()).toBe(at('2026-11-26 12:00').toISOString());
});

test('ответ клиента выводит из паузы сразу после фиксации, без участия сотрудника', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer' where ticket_id = $1`, [id]);
  await refreshTicketSla(SYSTEM, id);
  expect((await sla(id)).sla_paused_on).not.toBeNull();
  await replyToTicket(await clientCtx(f.aUser), { number: f.tickets.aOrg.number, body: 'Период один месяц', attachmentIds: [] });
  const row = await sla(id);
  expect(row.sla_paused_on).toBeNull();
  expect(row.resolution_due_on).not.toBeNull();
});

test('пересчёт после действия клиента не прошёл: needsSlaRefresh находит обращение', async () => {
  const f = await seedTwoOrgs();
  // Обращения набора созданы без сроков: как будто досчёт после фиксации не прошёл.
  const found = await needsSlaRefresh(SYSTEM, 100);
  expect(found).toEqual(expect.arrayContaining([f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId]));
  await refreshTicketSla(SYSTEM, f.tickets.aOrg.ticketId);
  expect(await needsSlaRefresh(SYSTEM, 100)).not.toContain(f.tickets.aOrg.ticketId);
  // Пауза осталась от "Ждём вашего ответа", а статус уже другой: тоже досчёт.
  await pools.root.query(`update hdt_tickets set sla_paused_on = now() where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  expect(await needsSlaRefresh(SYSTEM, 100)).toContain(f.tickets.aOrg.ticketId);
});

test('администратор сменил календарь: сроки открытого обращения не сдвинулись до его следующего события', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  await refreshTicketSla(SYSTEM, id);
  const before = await sla(id);
  await saveCalendar(staffCtx(f.adminStaff), { timeZone: 'Asia/Tashkent', week: { 0: ['00:00', '23:59'], 1: ['00:00', '23:59'], 2: null, 3: null, 4: null, 5: null, 6: null } });
  expect(await sla(id)).toEqual(before);
  await pools.root.query(`delete from hdr_business_calendars`);
});

test('клиент не может записать колонки сроков (42501)', async () => {
  const f = await seedTwoOrgs();
  // Сроки уже посчитаны: "сделать пустым" это изменение, а не то же значение.
  await refreshTicketSla(SYSTEM, f.tickets.aOrg.ticketId);
  for (const change of [`resolution_due_on = now() + interval '1 year'`, `first_response_due_on = null`, `sla_paused_minutes = 100000`, `sla_paused_on = now()`])
    await expect(
      asActor(pools.app, f.aUser.actor, (c) => c.query(`update hdt_tickets set ${change} where ticket_id = $1`, [f.tickets.aOrg.ticketId])),
      change,
    ).rejects.toThrow(/нельзя/);
});

test('страница клиента: "Ответим до" до первого ответа, срок решения после, ничего на ходу клиента', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const id = f.tickets.aOrg.ticketId;
  await refreshTicketSla(SYSTEM, id);
  const row = await sla(id);
  expect((await getTicket(ctx, String(f.tickets.aOrg.number)))?.nextReply).toEqual({ kind: 'first_response', at: row.first_response_due_on, timeZone: 'Asia/Tashkent' });
  await pools.root.query(`update hdt_tickets set first_responded_on = now(), status = 'in_progress' where ticket_id = $1`, [id]);
  expect((await getTicket(ctx, String(f.tickets.aOrg.number)))?.nextReply).toEqual({ kind: 'resolution', at: row.resolution_due_on, timeZone: 'Asia/Tashkent' });
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer' where ticket_id = $1`, [id]);
  expect((await getTicket(ctx, String(f.tickets.aOrg.number)))?.nextReply).toBeNull();
});
