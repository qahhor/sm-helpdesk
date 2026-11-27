import { beforeEach, expect, test } from 'vitest';
import { candidateMetrics } from '@/modules/hda/api/candidate-metrics';
import { problemMetrics } from '@/modules/hdp/api/metrics';
import { getMetrics } from '@/modules/hdt/api/metrics';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Показатели известных проблем и кандидатов (ТЗ FR-MET-08, 09, FR-CAND-08, FR-KP-13; план M5c, задача 11): сверка с
// ручным пересчётом на наборе из 50 проблем и 100 кандидатов с известными датами; фильтр "без известных проблем"
// меняет показатели обращений и SLA.

let f: Fixture;
const HOUR = 3_600_000;
const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-11-01T00:00:00Z');
const at = (days: number, hours = 0) => new Date(from.getTime() + days * 86_400_000 + hours * HOUR);

/** Вставка с заданными датами: служебные триггеры (created_on, пересчёт счётчиков) на время вставки выключены. */
async function raw(text: string, params: unknown[]): Promise<void> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(text, params);
    await client.query('commit');
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hda_candidate_sources`);
  await pools.root.query(`delete from hda_solution_candidates`);
});

test('FR-MET-08: активные проблемы с обращениями и организациями, время от первого обращения до исправления', async () => {
  const statuses = ['investigating', 'cause_found', 'fixing', 'fixed', 'closed'] as const;
  const expected = { active: [] as { tickets: number; orgs: number }[], fixHours: [] as number[] };
  for (let i = 0; i < 50; i++) {
    const status = statuses[i % 5]!;
    const first = at(i % 20, 1);
    const fixedOn = status === 'fixed' || status === 'closed' ? new Date(first.getTime() + (i + 1) * HOUR) : null;
    const tickets = i + 1;
    const orgs = Math.min(tickets, (i % 3) + 1);
    await raw(
      `insert into hdp_problems (internal_title, status, first_seen_on, last_seen_on, fixed_on, closed_on, ticket_count, org_count) values ($1, $2, $3, $3, $4, $5, $6, $7)`,
      [`Проблема ${i}`, status, first, fixedOn, status === 'closed' ? fixedOn : null, tickets, orgs],
    );
    if (status !== 'fixed' && status !== 'closed') expected.active.push({ tickets, orgs });
    else if (fixedOn! >= from && fixedOn! < to) expected.fixHours.push((fixedOn!.getTime() - first.getTime()) / HOUR);
  }
  const m = await problemMetrics(staffCtx(f.l1), { from, to });
  expect(m.activeCount).toBe(expected.active.length);
  expect(m.active.map((r) => ({ tickets: r.ticketCount, orgs: r.orgCount })).sort((a, b) => b.tickets - a.tickets)).toEqual(expected.active.sort((a, b) => b.tickets - a.tickets).slice(0, m.active.length));
  expect(m.fixedCount).toBe(expected.fixHours.length);
  expect(m.averageHoursToFix).toBeCloseTo(expected.fixHours.reduce((a, b) => a + b, 0) / expected.fixHours.length, 6);
});

test('FR-MET-09, FR-CAND-08: кандидаты создано, принято, объединено, отклонено и время от появления до публикации', async () => {
  const article = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ('clients', 'ru') returning article_id, number`)).rows[0];
  const expected = { created: 0, accepted: 0, merged: 0, rejected: 0, hours: [] as number[] };
  for (let i = 0; i < 100; i++) {
    const created = i < 90 ? at(i % 28) : new Date(from.getTime() - 5 * 86_400_000);
    const status = (['new', 'accepted', 'merged', 'rejected'] as const)[i % 4]!;
    const decided = status === 'new' ? null : new Date(created.getTime() + 2 * HOUR);
    let articleId: string | null = null;
    if (status === 'accepted' || status === 'merged') articleId = article.article_id;
    await raw(
      `insert into hda_solution_candidates (locale, title, status, article_id, decided_on, created_on, reject_reason, rejected_at_source_count) values ('ru', $1, $2, $3, $4, $5, $6, $7)`,
      [`Кандидат ${i}`, status, articleId, decided, created, status === 'rejected' ? 'other' : null, status === 'rejected' ? 0 : null],
    );
    if (created >= from && created < to) expected.created++;
    if (decided && decided >= from && decided < to) expected[status as 'accepted' | 'merged' | 'rejected']++;
  }
  // Решение из принятых кандидатов опубликовано на 10-й день: время до публикации считается от появления кандидата.
  const doc = { version: 1, blocks: [] };
  const v = (await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'ru', 1, 'x', $2, 'published') returning version_id`, [article.article_id, doc])).rows[0].version_id;
  const publishedOn = at(10);
  await pools.root.query(`insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale, published_on) values ($1, $2, 'ru', $3, 'clients', 'x', $4, 'x', 'x', 'ru', $5)`, [
    article.article_id,
    article.number,
    v,
    doc,
    publishedOn,
  ]);
  const accepted = (await pools.root.query(`select created_on from hda_solution_candidates where status = 'accepted' and created_on >= $1 and created_on < $2 and created_on <= $3`, [from, to, publishedOn])).rows;
  for (const row of accepted) expected.hours.push((publishedOn.getTime() - row.created_on.getTime()) / HOUR);
  const m = await candidateMetrics(staffCtx(f.l1), { from, to });
  expect({ created: m.created, accepted: m.accepted, merged: m.merged, rejected: m.rejected }).toEqual({ created: expected.created, accepted: expected.accepted, merged: expected.merged, rejected: expected.rejected });
  expect(m.averageHoursToPublish).toBeCloseTo(expected.hours.reduce((a, b) => a + b, 0) / expected.hours.length, 6);
});

test('FR-KP-13: фильтр "без известных проблем" меняет показатели обращений и SLA', async () => {
  const problem = (await pools.root.query(`insert into hdp_problems (internal_title) values ('Массовая') returning problem_id`)).rows[0].problem_id;
  await pools.root.query(`update hdt_tickets set known_problem_id = $1, first_response_breached_on = now() where ticket_id = $2`, [problem, f.tickets.aOrg.ticketId]);
  const all = await getMetrics(staffCtx(f.l1), { period: '30' });
  const clean = await getMetrics(staffCtx(f.l1), { period: '30', noProblems: 'on' });
  expect(clean.overview.created).toBe(all.overview.created - 1);
  expect(clean.overview.firstResponse.total).toBe(all.overview.firstResponse.total - 1);
  expect(clean.overview.firstResponse.ok).toBe(all.overview.firstResponse.ok);
  expect(clean.withoutProblems).toBe(true);
});
