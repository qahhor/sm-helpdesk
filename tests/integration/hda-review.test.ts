import { afterEach, beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { aiReviewList, flagAiAnswer, reviewAiAnswer } from '@/modules/hda/api/review';
import { aiHandoff, postAiMessage } from '@/modules/hdt/api/ai';
import { createTicket, getAgentTicket, getTicket, listQueue, postStaffMessage, queueCounts } from '@/modules/hdt/api';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Очереди "После AI" и "AI ответил, клиент молчит", отметка неверных ответов и правило на передачу (план M5b, задача
// 8; FR-AG-19, FR-AI-16, решение 19). Отметку ставит сотрудник с правом записи, она пишется в журнал аудита; клиент
// отметок не видит; сотрудник не меняет в строке журнала вызовов ничего, кроме отметки и итога разбора.

const SYSTEM = { type: 'system', job: 'ai.first_line' } as const;
const ARTICLE = '01900000-0000-7000-8000-0000000000a1';
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true'::jsonb)`);
  await pools.root.query(`delete from hdc_rate_limits`);
});
afterEach(() => setJobQueueForTests(null));

const idOf = (number: number) => pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number]).then((r) => r.rows[0].ticket_id as string);
async function portalTicket(description = 'При печати накладной выходит пустой лист') {
  const { number } = await createTicket(await clientCtx(f.aUser), { description, type: 'bug', impact: 'minor', locale: 'ru' });
  return { number, ticketId: await idOf(number) };
}
/** Ответ помощника с решением и строка журнала вызова первой линии с решением кода, как пишет задача первой линии. */
async function answered() {
  const t = await portalTicket();
  const messageId = await postAiMessage(SYSTEM, { ticketId: t.ticketId, payload: { kind: 'answer', introId: 'likely_solution', articleId: ARTICLE, articleNumber: 7, locale: 'ru' } });
  const runId = (
    await pools.root.query(`insert into hda_runs (org_id, purpose, model, outcome, ticket_id, user_id, decision, solution_id) values ($1, 'first_line', 'stub-model', 'ok', $2, $3, 'answer', $4) returning run_id`, [
      f.orgA.orgId,
      t.ticketId,
      f.aUser.userId,
      ARTICLE,
    ])
  ).rows[0].run_id as string;
  return { ...t, messageId, runId };
}
const queue = async (key: string) => (await listQueue(staffCtx(f.l1), { queue: key })).items;

test('очереди решения 19: "После AI" с причиной и счётчиком, "AI ответил, клиент молчит" без счётчика', async () => {
  const waiting = await answered();
  const handed = await portalTicket('Отчёт по продажам не строится');
  await aiHandoff(SYSTEM, { ticketId: handed.ticketId, reason: 'restricted_topic', questionIds: [] });
  const replied = await portalTicket('Не открывается касса');
  await aiHandoff(SYSTEM, { ticketId: replied.ticketId, reason: 'no_solution', questionIds: [] });
  const l1 = staffCtx(f.l1);
  const view = await getAgentTicket(l1, replied.number);
  await postStaffMessage(l1, { number: replied.number, body: 'Смотрю', internal: false, seenVersion: view!.version });
  const plain = await portalTicket('Обычное обращение');
  await pools.root.query(`update hdt_tickets set ai_state = 'none' where ticket_id = $1`, [plain.ticketId]);

  const after = await queue('after_ai');
  expect(after.map((r) => r.number)).toEqual([handed.number]);
  expect(after[0]!.aiHandoffReason).toBe('restricted_topic');
  // Переданное помощником одновременно стоит в "Новых" первой линии.
  expect((await queue('new')).map((r) => r.number)).toContain(handed.number);
  expect((await queue('ai_waiting')).map((r) => r.number)).toEqual([waiting.number]);
  const counts = await queueCounts(l1);
  expect(counts.after_ai).toBe(1);
  expect(counts.ai_waiting).toBeNull();
});

test('отметка "неверно": сотрудник с правом записи, причина из списка, журнал аудита; product и клиент не могут', async () => {
  const a = await answered();
  const product = staffCtx(await staffWithRole('product'));
  await expect(flagAiAnswer(product, { messageId: a.messageId, reason: 'wrong_solution', comment: '' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(flagAiAnswer(staffCtx(f.l1), { messageId: a.messageId, reason: 'nonsense', comment: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  await flagAiAnswer(staffCtx(f.l1), { messageId: a.messageId, reason: 'wrong_solution', comment: 'Решение про другой склад' });
  const run = (await pools.root.query(`select flagged_by, flag_reason, flag_comment, flagged_on from hda_runs where run_id = $1`, [a.runId])).rows[0];
  expect(run).toMatchObject({ flagged_by: f.l1.userId, flag_reason: 'wrong_solution', flag_comment: 'Решение про другой склад' });
  expect(run.flagged_on).not.toBeNull();
  const audit = (await pools.root.query(`select actor_id, diff from hdc_audit_log where action = 'ticket.ai_answer_flagged' and object_id = $1`, [a.ticketId])).rows;
  expect(audit).toEqual([{ actor_id: f.l1.userId, diff: { runId: a.runId, reason: 'wrong_solution' } }]);
  // Клиент не видит ни журнала вызовов, ни отметки в обращении.
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select * from hda_runs`))).rowCount).toBe(0);
  expect(JSON.stringify(await getTicket(await clientCtx(f.aUser), a.number))).not.toContain('wrong_solution');
  // Сотрудник меняет в строке журнала только отметку и итог разбора.
  const tryUpdate = (sql: string, params: unknown[]) => asActor(pools.app, f.l1.actor, (c) => c.query(sql, params)).then((r) => r.rowCount, (e: Error) => e.message);
  expect(await tryUpdate(`update hda_runs set cost_usd = 1 where run_id = $1`, [a.runId])).toMatch(/только отметку/);
  expect(await tryUpdate(`update hda_runs set flagged_by = $2 where run_id = $1`, [a.runId, f.care.userId])).toMatch(/от своего имени/);
  expect(await tryUpdate(`update hda_runs set review_result = 'no_change' where run_id = $1`, [a.runId])).toMatch(/итог разбора/);
  expect((await pools.root.query(`select cost_usd::float as c, flagged_by, review_result from hda_runs where run_id = $1`, [a.runId])).rows[0]).toEqual({ c: 0, flagged_by: f.l1.userId, review_result: null });
  // Сообщение не помощника отметить нельзя.
  const clientMessage = (await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body) values ($1, $2, $3, 'client', 'текст') returning message_id`, [f.orgA.orgId, a.ticketId, f.aUser.userId])).rows[0].message_id;
  await expect(flagAiAnswer(staffCtx(f.l1), { messageId: clientMessage, reason: 'wrong_solution', comment: '' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('/agent/ai-review: отмеченные, ответы в обращениях с оценкой ниже 4, выборка; итог разбора пишется в журнал', async () => {
  const flagged = await answered();
  await flagAiAnswer(staffCtx(f.l1), { messageId: flagged.messageId, reason: 'should_handoff', comment: '' });
  const low = await answered();
  await pools.root.query(`update hdt_tickets set csat_score = 2 where ticket_id = $1`, [low.ticketId]);
  const plain = await answered();
  const list = await aiReviewList(staffCtx(f.l1));
  expect(list.flagged.map((r) => r.number)).toEqual([flagged.number]);
  expect(list.flagged[0]).toMatchObject({ flagReason: 'should_handoff', solutionId: ARTICLE });
  expect(list.lowRated.map((r) => r.number)).toEqual([low.number]);
  expect(list.lowRated[0]!.rating).toBe(2);
  expect(list.sample.map((r) => r.number)).toEqual(expect.arrayContaining([flagged.number, low.number, plain.number]));

  await expect(reviewAiAnswer(staffCtx(f.l1), { runId: flagged.runId, result: 'solution_fixed' })).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  await expect(reviewAiAnswer(l2, { runId: flagged.runId, result: 'anything' })).rejects.toMatchObject({ code: 'invalid_input' });
  await reviewAiAnswer(l2, { runId: flagged.runId, result: 'solution_fixed' });
  expect((await pools.root.query(`select review_result from hda_runs where run_id = $1`, [flagged.runId])).rows[0].review_result).toBe('solution_fixed');
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'ticket.ai_answer_reviewed'`)).rowCount).toBe(1);
  expect((await aiReviewList(l2)).flagged[0]!.reviewResult).toBe('solution_fixed');
  await expect(aiReviewList({ actor: f.aUser.actor } as never)).rejects.toMatchObject({ code: 'forbidden' });
});

test('правило на событие "AI передал обращение" с условием "причина передачи": обязательная тема уходит в care', async () => {
  const admin = staffCtx(f.adminStaff);
  const { ruleId } = await saveRule(admin, {
    name: 'Обязательные темы в care',
    event: 'ai_handoff',
    conditions: { match: 'all', items: [{ field: 'ai_reason', op: 'is', values: ['restricted_topic'] }] },
    actions: [{ action: 'set_queue', queue: 'care' }],
    isStop: false,
  });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const topic = await portalTicket('Хотим расторгнуть договор');
  await aiHandoff(SYSTEM, { ticketId: topic.ticketId, reason: 'restricted_topic', questionIds: [] });
  const other = await portalTicket('Не печатается накладная');
  await aiHandoff(SYSTEM, { ticketId: other.ticketId, reason: 'no_solution', questionIds: [] });
  const run = newRuleRun();
  await processEvents({ type: 'system', job: 'automation.process' }, (tx, event) => handleRuleEvent(tx, event, run));
  const queues = (await pools.root.query(`select ticket_id, queue from hdt_tickets where ticket_id = any($1)`, [[topic.ticketId, other.ticketId]])).rows;
  expect(Object.fromEntries(queues.map((r) => [r.ticket_id, r.queue]))).toEqual({ [topic.ticketId]: 'care', [other.ticketId]: 'l1' });
  expect((await pools.root.query(`select result from hdw_rule_runs where rule_id = $1`, [ruleId])).rows.map((r) => r.result)).toEqual(['applied']);
});
