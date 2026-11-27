import { beforeEach, expect, test } from 'vitest';
import { acceptProblemDraft, linkProposedTickets, problemCard, rejectProblemDraft, setProblemShown, setProblemStatus } from '@/modules/hdp/api/problems';
import { createProblemDraft } from '@/modules/hdp/api/translate-jobs';
import { staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Черновик известной проблемы от AI-сотрудника и всплеска (веха M8b, задача 6; FR-AGT-04, 05, T23; план M8b, решение
// 20). Черновик не меняет обращений: сигнатура неактивна, обращения только предложены. Принимает, привязывает
// предложенные и отклоняет сотрудник с правом ведения проблем (agent_l2, care, admin), каждое действие с журналом аудита.

let f: Fixture;
const SIG = 'b'.repeat(32);

beforeEach(async () => {
  f = await seedTwoOrgs();
});

const problemRow = (number: number) => pools.root.query(`select * from hdp_problems where number = $1`, [number]).then((r) => r.rows[0]);
const audit = (action: string) => pools.root.query(`select object_id, diff, actor_id, created_on from hdc_audit_log where action = $1 order by created_on`, [action]).then((r) => r.rows);

async function draft() {
  return createProblemDraft(system, { internalTitle: 'Всплеск сигнатуры', description: 'Три организации за час', signature: SIG, ticketIds: [f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId] });
}

test('черновик: статус draft, сигнатура неактивна, обращения только предложены, клиент не видит', async () => {
  const { number } = await draft();
  const row = await problemRow(number);
  expect(row).toMatchObject({ status: 'draft', show_to_clients: false, ticket_count: 0, internal_description: 'Три организации за час' });
  expect((await pools.root.query(`select is_active from hdp_problem_signatures where problem_id = $1`, [row.problem_id])).rows).toEqual([{ is_active: false }]);
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where known_problem_id = $1`, [row.problem_id])).rows[0].n).toBe(0);
  expect((await pools.root.query(`select ticket_id from hdp_problem_proposals where problem_id = $1 order by ticket_id`, [row.problem_id])).rows.map((r) => r.ticket_id).sort()).toEqual(
    [f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId].sort(),
  );
  // Признак показа в статусе draft база не принимает.
  await expect(pools.root.query(`update hdp_problems set show_to_clients = true where problem_id = $1`, [row.problem_id])).rejects.toThrow();
  // Клиент не читает ни предложений, ни черновика.
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hdp_problem_proposals`))).rowCount).toBe(0);
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hdp_problems_public where problem_id = $1`, [row.problem_id]))).rowCount).toBe(0);
  const card = await problemCard(staffCtx(f.l1), number);
  expect(card).toMatchObject({ status: 'draft', proposals: [expect.objectContaining({ number: expect.any(Number) }), expect.objectContaining({ number: expect.any(Number) })] });
});

test('"Принять черновик" делает проблему активной и сигнатуру действующей, пишет журнал аудита; первая линия и product не принимают', async () => {
  const { number } = await draft();
  for (const role of ['agent_l1', 'product'] as const) await expect(acceptProblemDraft(staffCtx(await staffWithRole(role)), { number })).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  expect(await acceptProblemDraft(l2, { number })).toEqual({ signatureActive: true });
  const row = await problemRow(number);
  expect(row.status).toBe('investigating');
  expect((await pools.root.query(`select is_active from hdp_problem_signatures where problem_id = $1`, [row.problem_id])).rows).toEqual([{ is_active: true }]);
  const [entry] = await audit('problem.draft_accepted');
  expect(entry).toMatchObject({ object_id: row.problem_id, actor_id: l2.user.id, diff: { number } });
  // Повтор ничего не меняет.
  await expect(acceptProblemDraft(l2, { number })).rejects.toMatchObject({ code: 'not_draft' });
});

test('сигнатуру уже ведёт другая активная проблема: черновик принимается, сигнатура остаётся у той', async () => {
  const { number } = await draft();
  const other = (await pools.root.query(`insert into hdp_problems (internal_title) values ('Другая') returning problem_id`)).rows[0].problem_id;
  await pools.root.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [other, SIG]);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  expect(await acceptProblemDraft(l2, { number })).toEqual({ signatureActive: false });
  expect((await problemRow(number)).status).toBe('investigating');
});

test('"Привязать предложенные" даёт итог по каждому обращению и журнал аудита; до принятия недоступно', async () => {
  const { number } = await draft();
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  await expect(linkProposedTickets(l2, { number })).rejects.toMatchObject({ code: 'not_accepted' });
  await acceptProblemDraft(l2, { number });
  await pools.root.query(`update hdt_tickets set status = 'closed', closed_on = now(), resolved_on = now() where ticket_id = $1`, [f.tickets.bOrg.ticketId]);
  const result = await linkProposedTickets(l2, { number });
  expect(result.items.sort((a, b) => a.number - b.number)).toEqual(
    [
      { number: f.tickets.aOrg.number, outcome: 'linked' },
      { number: f.tickets.bOrg.number, outcome: 'ticket_closed' },
    ].sort((a, b) => a.number - b.number),
  );
  const row = await problemRow(number);
  expect(row.ticket_count).toBe(1);
  expect((await audit('ticket.problem_linked')).length).toBe(1);
  expect((await audit('problem.proposals_linked'))[0]).toMatchObject({ object_id: row.problem_id, diff: { linked: 1, skipped: 1 } });
  expect((await pools.root.query(`select count(*)::int as n from hdp_problem_proposals where problem_id = $1`, [row.problem_id])).rows[0].n).toBe(0);
});

test('"Отклонить черновик": статус closed без рассылки и журнал аудита', async () => {
  const { number } = await draft();
  const care = staffCtx(f.care);
  await expect(rejectProblemDraft(staffCtx(f.l1), { number, reason: 'Ложная тревога' })).rejects.toMatchObject({ code: 'forbidden' });
  await rejectProblemDraft(care, { number, reason: 'Ложная тревога' });
  const row = await problemRow(number);
  expect(row.status).toBe('closed');
  expect((await pools.root.query(`select count(*)::int as n from hdp_broadcasts`)).rows[0].n).toBe(0);
  expect((await audit('problem.draft_rejected'))[0]).toMatchObject({ object_id: row.problem_id, diff: { number, reason: 'Ложная тревога' } });
});

test('два черновика с одной сигнатурой принимаются одновременно без сбоя: сигнатура у одного (находка M2)', async () => {
  const one = await draft();
  const two = await draft();
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  // Запись сигнатур задержана блокировкой таблицы: оба принятия проходят проверку занятости до записи.
  const blocker = await pools.root.connect();
  await blocker.query('begin');
  await blocker.query('lock table hdp_problem_signatures in share row exclusive mode');
  const pending = Promise.allSettled([acceptProblemDraft(l2, { number: one.number }), acceptProblemDraft(l2, { number: two.number })]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await blocker.query('commit');
  blocker.release();
  const results = await pending;
  expect(results.map((r) => (r.status === 'fulfilled' ? 'ok' : String((r.reason as { code?: string }).code ?? r.reason)))).toEqual(['ok', 'ok']);
  const values = results.map((r) => (r.status === 'fulfilled' ? r.value.signatureActive : null));
  expect(values.sort()).toEqual([false, true]);
  expect((await problemRow(one.number)).status).toBe('investigating');
  expect((await problemRow(two.number)).status).toBe('investigating');
  expect((await pools.root.query(`select count(*)::int as n from hdp_problem_signatures where signature = $1 and is_active`, [SIG])).rows[0].n).toBe(1);
});

test('смена статуса и признака показа у черновика: not_accepted, черновик принимается только кнопкой (находка M3)', async () => {
  const { number } = await draft();
  const admin = staffCtx(f.adminStaff);
  await expect(setProblemStatus(admin, { number, status: 'fixing' })).rejects.toMatchObject({ code: 'not_accepted' });
  await expect(setProblemShown(admin, { number, shown: true })).rejects.toMatchObject({ code: 'not_accepted' });
  await expect(setProblemShown(admin, { number, shown: false })).rejects.toMatchObject({ code: 'not_accepted' });
  expect(await problemRow(number)).toMatchObject({ status: 'draft', show_to_clients: false });
});
