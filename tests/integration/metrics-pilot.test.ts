import { beforeEach, expect, test } from 'vitest';
import { createTicketForClient } from '@/modules/hdt/api';
import { exportMetrics, isPilotOrg, pilotSummary, setPilotOrg } from '@/modules/hdt/api/metrics';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Сводка пилота (план M9, задача 3, решение 13; ТЗ 16.7): строки таблицы 16.7 за период по организациям из настройки
// pilot.org_ids. На наборе обращений каждая строка совпадает с ручным счётом ниже; организация вне пилота не входит;
// без пилотных организаций сводка пуста. Видят care и admin; список пилотных организаций меняет администратор.

const NOW = new Date();
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hdc_settings where code = 'pilot.org_ids'`);
});

const staffTicket = async (orgId: string, authorId: string, intakeChannel: string) =>
  (await createTicketForClient(staffCtx(f.l1), { orgId, authorId, type: 'question', impact: 'minor', description: 'Клиент сообщил: не печатается накладная', locale: 'ru', intakeChannel })).number;
const ticketId = async (number: number) => (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;

/**
 * Набор организации А (пилот), 5 обращений: три из набора seedTwoOrgs (портал) и два от сотрудника (telegram, phone).
 * Ручной счёт: мимо портала 2 из 5, в портале 60%; Telegram 1 из 5, 20%. Первый ответ решён у 4 (aOrg, aPrivate,
 * aMine, telegram), в срок 3: 75%. Решение решено у 2 (aOrg решено, aPrivate нарушено), в срок 1: 50%. Оценки 5, 3, 4:
 * высоких 2 из 3, 66,7%. Помощник вёл 2 (aOrg решил сам, aMine передал): 50%. Ответов помощника 3, неверных 1: 33,3%.
 * Расход 1,5 + 2,25 + 0,25 + 1 = 5 долларов. Организация Б с теми же признаками и расходом 50 долларов не входит.
 */
async function seedPilotData(): Promise<void> {
  const telegram = await ticketId(await staffTicket(f.orgA.orgId, f.aUser.userId, 'telegram'));
  await staffTicket(f.orgA.orgId, f.aUser.userId, 'phone');
  // Организация Б: два обращения набора и три от сотрудника (третье играет роль aMine).
  const otherTelegram = await ticketId(await staffTicket(f.orgB.orgId, f.bUser.userId, 'telegram'));
  await staffTicket(f.orgB.orgId, f.bUser.userId, 'phone');
  const otherMine = await ticketId(await staffTicket(f.orgB.orgId, f.bUser.userId, 'other'));
  // Все обращения двух организаций: сроки впереди, ответов, нарушений, оценок и помощника нет.
  await pools.root.query(
    `update hdt_tickets set first_response_due_on = now() + interval '1 day', resolution_due_on = now() + interval '5 days', first_responded_on = null,
       first_response_breached_on = null, resolution_breached_on = null, csat_score = null, ai_state = 'none', status = 'in_progress', resolved_on = null, sla_paused_on = null
     where org_id in ($1, $2)`,
    [f.orgA.orgId, f.orgB.orgId],
  );
  for (const orgTickets of [
    { org: f.tickets.aOrg.ticketId, priv: f.tickets.aPrivate.ticketId, mine: f.tickets.aMine.ticketId, tg: telegram },
    { org: f.tickets.bOrg.ticketId, priv: f.tickets.bPrivate.ticketId, mine: otherMine, tg: otherTelegram },
  ]) {
    await pools.root.query(`update hdt_tickets set first_responded_on = now(), status = 'resolved', resolved_on = now(), csat_score = 5, ai_state = 'resolved_by_ai' where ticket_id = $1`, [orgTickets.org]);
    await pools.root.query(`update hdt_tickets set first_responded_on = now(), first_response_breached_on = now(), resolution_breached_on = now(), csat_score = 3 where ticket_id = $1`, [orgTickets.priv]);
    await pools.root.query(`update hdt_tickets set first_responded_on = now(), csat_score = 4, ai_state = 'handed_off' where ticket_id = $1`, [orgTickets.mine]);
    await pools.root.query(`update hdt_tickets set first_responded_on = now() where ticket_id = $1`, [orgTickets.tg]);
  }
  await pools.root.query(
    `insert into hda_runs (org_id, purpose, model, cost_usd, outcome, decision, ticket_id, flagged_by, flagged_on, flag_reason) values
       ($1, 'first_line', 'claude-sonnet-5-5', 1.5, 'ok', 'answer', $2, $3, now(), 'wrong_solution'),
       ($1, 'first_line', 'claude-sonnet-5-5', 2.25, 'ok', 'answer', $2, null, null, null),
       ($1, 'first_line', 'claude-sonnet-5-5', 0.25, 'ok', 'answer', $2, null, null, null),
       ($1, 'triage', 'claude-haiku-5', 1, 'ok', null, $2, null, null, null),
       ($4, 'first_line', 'claude-sonnet-5-5', 50, 'ok', 'answer', $5, $3, now(), 'wrong_solution')`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId, f.l1.userId, f.orgB.orgId, f.tickets.bOrg.ticketId],
  );
}

const rowsOf = (summary: Awaited<ReturnType<typeof pilotSummary>>) => Object.fromEntries(summary.rows.map((r) => [r.key, { value: r.value === null ? null : Math.round(r.value * 10) / 10, target: r.target, met: r.met }]));

test('без пилотных организаций сводка пуста', async () => {
  await seedPilotData();
  const summary = await pilotSummary(staffCtx(f.care), { period: '7' }, NOW);
  expect(summary).toMatchObject({ orgCount: 0, orgs: [], rows: [] });
});

test('восемь строк таблицы 16.7 и доля Telegram совпадают с ручным счётом; организация Б не входит', async () => {
  await seedPilotData();
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, pilot: true });
  const summary = await pilotSummary(staffCtx(f.care), { period: '7' }, NOW);
  expect(summary.orgCount).toBe(1);
  expect(summary.orgs).toEqual([{ orgId: f.orgA.orgId, name: f.orgA.name }]);
  expect(summary.rows.map((r) => r.key)).toEqual(['portal_share', 'first_response', 'resolution', 'ai_resolved', 'ai_flagged', 'csat_high', 'leaks', 'ai_cost', 'telegram_share']);
  expect(rowsOf(summary)).toEqual({
    portal_share: { value: 60, target: 90, met: false },
    first_response: { value: 75, target: 95, met: false },
    resolution: { value: 50, target: 85, met: false },
    ai_resolved: { value: 50, target: 15, met: true },
    ai_flagged: { value: 33.3, target: 5, met: false },
    csat_high: { value: 66.7, target: 80, met: false },
    leaks: { value: null, target: 0, met: null },
    // Цель расходов 100 долларов в месяц пересчитана на 7 дней периода: 23,33.
    ai_cost: { value: 5, target: 23.33, met: true },
    telegram_share: { value: 20, target: null, met: null },
  });
  // Обе организации в пилоте: у Б 5 обращений, мимо портала 3 (вместе 5 из 10); расход 55 долларов выше цели.
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgB.orgId, pilot: true });
  const both = rowsOf(await pilotSummary(staffCtx(f.adminStaff), { period: '7' }, NOW));
  expect(both.ai_cost).toEqual({ value: 55, target: 23.33, met: false });
  expect(both.portal_share.value).toBe(50);
});

test('сводка только числами: ни тем, ни текстов обращений', async () => {
  await seedPilotData();
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, pilot: true });
  const json = JSON.stringify(await pilotSummary(staffCtx(f.care), { period: '7' }, NOW));
  expect(json).not.toContain(f.tickets.aOrg.title);
  expect(json).not.toContain('накладная');
});

test('права: сводку видят care и admin, список пилота меняет только администратор со свежим входом с журналом', async () => {
  for (const role of ['agent_l1', 'agent_l2', 'product'] as const)
    await expect(pilotSummary(staffCtx(await staffWithRole(role)), { period: '7' }, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(pilotSummary(f.aAdmin as never, { period: '7' }, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(setPilotOrg(staffCtx(f.care), { orgId: f.orgA.orgId, pilot: true })).rejects.toMatchObject({ code: 'forbidden' });
  const stale = { ...staffCtx(f.adminStaff), freshAuthAt: new Date(Date.now() - 60 * 60_000) };
  await expect(setPilotOrg(stale, { orgId: f.orgA.orgId, pilot: true })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(setPilotOrg(staffCtx(f.adminStaff), { orgId: 'нет', pilot: true })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setPilotOrg(staffCtx(f.adminStaff), { orgId: '00000000-0000-7000-8000-00000000abcd', pilot: true })).rejects.toMatchObject({ code: 'not_found' });
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, pilot: true });
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, pilot: true });
  expect(await isPilotOrg(staffCtx(f.care), f.orgA.orgId)).toBe(true);
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, pilot: false });
  expect(await isPilotOrg(staffCtx(f.care), f.orgA.orgId)).toBe(false);
  expect((await pools.root.query(`select diff from hdc_audit_log where action = 'settings.changed' and object_id = 'pilot.org_ids' order by created_on`)).rows.map((r) => r.diff)).toEqual([
    { code: 'pilot.org_ids', to: [f.orgA.orgId] },
    { code: 'pilot.org_ids', to: [] },
  ]);
});

test('выгрузка сводки тем же механизмом: только care и admin, строка на показатель, запись в журнал', async () => {
  await seedPilotData();
  await setPilotOrg(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, pilot: true });
  const out = await exportMetrics(staffCtx(f.care), { report: 'pilot', period: '7' }, NOW);
  expect(out.columns).toEqual(['metric', 'value', 'target', 'met']);
  expect(out.rows[0]).toEqual(['portal_share', '60', '90', 0]);
  expect(out.rows).toHaveLength(9);
  await expect(exportMetrics(staffCtx(await staffWithRole('product')), { report: 'pilot', period: '7' }, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  expect((await pools.root.query(`select diff ->> 'report' as report from hdc_audit_log where action = 'metrics.exported'`)).rows).toEqual([{ report: 'pilot' }]);
});
