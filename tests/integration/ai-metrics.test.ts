import { beforeEach, expect, test } from 'vitest';
import { assistantRunStats, assistantUseCounts } from '@/modules/hda/api/metrics';
import { getAssistantMetrics, getMetrics } from '@/modules/hdt/api/metrics';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Показатели AI-помощника (план M5b, задача 10; FR-MET-06, FR-AI-18, FR-LINE-08, FR-SOL-19). Сверка с ручным
// пересчётом на наборе из 200 обращений с известными исходами помощника и проверка планов запросов по индексу.

let f: Fixture;
const NOW = new Date('2026-11-10T10:00:00Z');
const WEEK = { period: 'custom', from: '2026-11-02', to: '2026-11-08' };
const ARTICLE_A = '01900000-0000-7000-8000-0000000000a1';
const ARTICLE_B = '01900000-0000-7000-8000-0000000000b2';

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hda_runs`);
});

type Row = {
  i: number;
  kind: 'helped' | 'not_helped' | 'topic' | 'none' | 'waiting';
  created: Date;
  firstAiSec: number | null;
  score: number | null;
  reopened: boolean;
};

/** Набор: пять исходов по кругу, по 40 обращений каждого, создание 02.11 с шагом 30 минут. */
function dataset(): Row[] {
  const kinds = ['helped', 'not_helped', 'topic', 'none', 'waiting'] as const;
  return Array.from({ length: 200 }, (_, i) => {
    const kind = kinds[i % 5]!;
    const created = new Date(Date.UTC(2026, 10, 2, 3, 0) + i * 30 * 60_000);
    const firstAiSec = kind === 'none' ? null : kind === 'helped' ? 30 + (i % 7) : kind === 'not_helped' ? 45 : kind === 'topic' ? 5 : 20;
    const score = kind === 'helped' ? (i % 10 === 0 ? 5 : 3) : kind === 'not_helped' && i % 3 === 0 ? 2 : null;
    return { i, kind, created, firstAiSec, score, reopened: kind === 'helped' && i % 20 === 0 };
  });
}

async function seed(rows: Row[]) {
  const client = await pools.root.connect();
  try {
    await client.query(`set session_replication_role = replica`);
    for (const r of rows) {
      const state = r.kind === 'helped' ? 'resolved_by_ai' : r.kind === 'none' ? 'none' : r.kind === 'waiting' ? 'active' : 'handed_off';
      const status = r.kind === 'helped' ? (r.reopened ? 'in_progress' : 'resolved') : r.kind === 'waiting' ? 'waiting_customer' : r.kind === 'none' ? 'new' : 'in_progress';
      const reason = r.kind === 'not_helped' ? 'not_helped' : r.kind === 'topic' ? 'restricted_topic' : null;
      const resolvedOn = r.kind === 'helped' && !r.reopened ? new Date(r.created.getTime() + 10 * 60_000) : null;
      const { ticket_id: ticketId } = (
        await client.query(
          `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, queue, created_on, modified_on,
                                    ai_state, ai_reply_count, ai_handoff_reason, ai_handoff_on, resolved_on, resolution_type, csat_score)
           values ($1, $2, 'question', 'minor', 'p3', 'org', $3, 'Описание', 'ru', 'portal', $4, 'l1', $5, $5, $6, $7, $8, $9, $10, $11, $12) returning ticket_id`,
          [
            f.orgA.orgId,
            f.aUser.userId,
            `AI-${r.i}`,
            status,
            r.created,
            state,
            r.kind === 'none' ? 0 : 1,
            reason,
            reason ? new Date(r.created.getTime() + 60_000) : null,
            resolvedOn,
            resolvedOn ? 'solved' : null,
            r.score,
          ],
        )
      ).rows[0];
      const at = (sec: number) => new Date(r.created.getTime() + sec * 1000);
      if (r.firstAiSec !== null) {
        const kind = r.kind === 'topic' ? 'handoff' : 'answer';
        await client.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, ai_payload, created_on, modified_on) values ($1, $2, 'ai', 'Тез', $3, $4, $4)`, [
          f.orgA.orgId,
          ticketId,
          JSON.stringify({ kind }),
          at(r.firstAiSec),
        ]);
        // Второе сообщение позже первого не влияет на время первого ответа.
        await client.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, ai_payload, created_on, modified_on) values ($1, $2, 'ai', 'Тез', '{"kind":"handoff"}', $3, $3)`, [
          f.orgA.orgId,
          ticketId,
          at(r.firstAiSec + 600),
        ]);
      }
      const event = (kind: string, payload: unknown, sec: number) =>
        client.query(`insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, payload, is_internal, created_on, modified_on) values ($1, $2, $3, 'system', $4, true, $5, $5)`, [
          f.orgA.orgId,
          ticketId,
          kind,
          JSON.stringify(payload),
          at(sec),
        ]);
      if (r.kind !== 'none') await event('ai_state', { to: 'active' }, 0);
      if (reason) await event('ai_handoff', { reason }, 60);
      if (r.kind === 'helped') {
        await event('ai_feedback', { choice: 'helped' }, 300);
        await event('status', { from: 'waiting_customer', to: 'resolved' }, 600);
        if (r.reopened) await event('status', { from: 'resolved', to: 'in_progress' }, 7200);
      }
    }
  } finally {
    await client.query(`set session_replication_role = origin`).catch(() => undefined);
    client.release();
  }
}

test('показатели помощника сходятся с ручным пересчётом на 200 обращениях (FR-MET-06, FR-AI-18)', async () => {
  const rows = dataset();
  await seed(rows);
  const m = await getAssistantMetrics(staffCtx(f.l1), WEEK, NOW);
  // Ручной пересчёт по набору.
  const handled = rows.filter((r) => r.kind !== 'none');
  const helped = rows.filter((r) => r.kind === 'helped');
  const firsts = handled.map((r) => r.firstAiSec!).sort((a, b) => a - b);
  const helpedScores = helped.map((r) => r.score).filter((s): s is number => s !== null);
  expect(m.handled).toBe(handled.length);
  expect(m.resolvedByAi).toBe(helped.length);
  expect(m.resolvedByAiPercent).toBeCloseTo((helped.length / handled.length) * 100, 5);
  expect(m.handoffs).toEqual([
    { reason: 'not_helped', count: rows.filter((r) => r.kind === 'not_helped').length },
    { reason: 'restricted_topic', count: rows.filter((r) => r.kind === 'topic').length },
  ]);
  expect(m.firstReply.count).toBe(firsts.length);
  expect(m.firstReply.averageSeconds).toBeCloseTo(firsts.reduce((a, b) => a + b, 0) / firsts.length, 5);
  expect(m.firstReply.medianSeconds).toBe((firsts[firsts.length / 2 - 1]! + firsts[firsts.length / 2]!) / 2);
  expect(m.csat).toEqual({ count: helpedScores.length, average: helpedScores.reduce((a, b) => a + b, 0) / helpedScores.length });
  expect(m.reopenedAfterHelped).toBe(rows.filter((r) => r.reopened).length);

  // Линия AI-помощника в показателях линий (FR-LINE-08): решённые, пока помощник вёл обращение.
  const view = await getMetrics(staffCtx(f.l1), WEEK, NOW);
  const resolvedHelped = helped.filter((r) => !r.reopened).length;
  expect(view.lines.rows.find((r) => r.line === 'assistant')).toMatchObject({ resolved: resolvedHelped });
  expect(view.lines.rows.map((r) => r.line)).toEqual(['assistant', 'first', 'second', 'development']);
});

test('журнал вызовов: отмеченные неверными, ответы, расход за месяц; использование решений помощником (FR-SOL-19)', async () => {
  const insert = (decision: string | null, solution: string | null, flagged: boolean, cost: number) =>
    pools.root.query(
      `insert into hda_runs (org_id, purpose, model, outcome, decision, solution_id, cost_usd, flagged_by, flagged_on, flag_reason) values ($1, 'first_line', 'stub-model', 'ok', $2, $3, $4, $5, $6, $7)`,
      [f.orgA.orgId, decision, solution, cost, flagged ? f.l1.userId : null, flagged ? new Date() : null, flagged ? 'wrong_solution' : null],
    );
  for (let i = 0; i < 12; i++) await insert('answer', i < 8 ? ARTICLE_A : ARTICLE_B, i % 4 === 0, 0.01);
  await insert('handoff', null, false, 0.02);
  await insert('clarify', null, false, 0.01);
  const stats = await assistantRunStats(staffCtx(f.l1), { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });
  expect(stats).toMatchObject({ answers: 12, flagged: 3 });
  expect(stats.flaggedPercent).toBeCloseTo(25, 5);
  expect(stats.spentMonthUsd).toBeCloseTo(0.15, 5);
  expect(Object.fromEntries(await assistantUseCounts(staffCtx(f.l1), [ARTICLE_A, ARTICLE_B, '01900000-0000-7000-8000-0000000000c3']))).toEqual({ [ARTICLE_A]: 8, [ARTICLE_B]: 4 });
  await expect(assistantRunStats({ actor: f.aUser.actor } as never, { from: new Date(), to: new Date() })).rejects.toMatchObject({ code: 'forbidden' });
});

test('планы запросов: обращения периода по индексу даты создания, ответы помощника по решению по своему индексу', async () => {
  const plan = async (sql: string, params: unknown[]) => {
    const client = await pools.root.connect();
    try {
      await client.query('set enable_seqscan = off');
      return (await client.query(`explain (costs off) ${sql}`, params)).rows.map((row) => Object.values(row)[0]).join('\n');
    } finally {
      await client.query('reset enable_seqscan');
      client.release();
    }
  };
  expect(await plan(`select count(*) from hdt_tickets where created_on >= $1 and created_on < $2 and ai_state <> 'none'`, [WEEK.from, WEEK.to])).toMatch(/hdt_tickets_i25/);
  expect(await plan(`select solution_id, count(*) from hda_runs where decision = 'answer' and solution_id = any($1::uuid[]) group by solution_id`, [[ARTICLE_A]])).toMatch(/hda_runs_i9/);
  expect(await plan(`select count(*) from hda_runs where decision is not null and created_on >= $1 and created_on < $2`, [WEEK.from, WEEK.to])).toMatch(/hda_runs_i10/);
});
