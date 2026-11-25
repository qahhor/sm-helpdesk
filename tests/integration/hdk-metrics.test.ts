import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { listSolutions } from '@/modules/hdk/api/editor';
import { getKnowledgeMetrics } from '@/modules/hdk/api/metrics';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Показатели знаний на странице "Показатели" (план M5, задача 11; FR-MET-02, 05, FR-SOL-19; решения 8, 12, 18).
// Числа на наборе с известным ответом; права как у страницы M8 (решение 14): сводку и частые ошибки видят все
// сотрудники, срез по организациям Customer Care, продукт, администратор и руководители линий, "Создать решение" роли
// черновиков; клиент не получает ничего. Список на пересмотр: "не помогло" выше 40% при 10 исходах и больше.

const SYSTEM: SystemActor = { type: 'system', job: 'integration-test' };
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-11-08T00:00:00Z');
const IN = '2026-11-03T10:00:00Z';
const OUT = '2026-10-01T10:00:00Z';
let f: Fixture;
let serial = 0;
const p = (text: string) => ({ type: 'paragraph' as const, attrs: { id: `met${String(++serial).padStart(9, '0')}` }, content: [{ type: 'text' as const, text }] });

beforeEach(async () => {
  f = await seedTwoOrgs();
});

/** Строка исходов с заданным временем показа: триггер отметок ставит время вставки, поэтому он на вставку выключен. */
async function event(member: { userId: string }, orgId: string, outcome: string, createdOn: string) {
  const client = await pools.root.connect();
  try {
    await client.query(`set session_replication_role = replica`);
    await client.query(`insert into hdk_deflection_events (org_id, user_id, session_id, query_hash, outcome, created_on) values ($1, $2, $3, $4, $5, $6)`, [
      orgId,
      member.userId,
      randomUUID(),
      'a'.repeat(64),
      outcome,
      createdOn,
    ]);
  } finally {
    await client.query(`set session_replication_role = origin`);
    client.release();
  }
}

async function seedEvents() {
  const a = f.orgA.orgId;
  const b = f.orgB.orgId;
  for (let i = 0; i < 4; i++) await event(f.aUser, a, 'helped', IN);
  for (let i = 0; i < 2; i++) await event(f.aUser, a, 'not_helped', IN);
  await event(f.aAdmin, a, 'ticket_created', IN);
  for (let i = 0; i < 3; i++) await event(f.aUser, a, 'left', IN);
  await event(f.bUser, b, 'helped', IN);
  await event(f.bUser, b, 'ticket_created', IN);
  // Вне периода: не считаются.
  for (let i = 0; i < 5; i++) await event(f.bUser, b, 'helped', OUT);
}

const sig = (n: number) => n.toString(16).padStart(32, '0');
async function signature(n: number, opts: { articleId?: string; orgs: number; times: number; lastSeen: string | null }) {
  await pools.root.query(`insert into hdk_error_signatures (signature, article_id, sample_code, sample_message, org_count, occurrences, last_seen_on) values ($1, $2, 'ORA-20001', $3, $4, $5, $6)`, [
    sig(n),
    opts.articleId ?? null,
    `ошибка ${n}`,
    opts.orgs,
    opts.times,
    opts.lastSeen,
  ]);
}

async function article(title: string, counts: { shown?: number; helped?: number; notHelped?: number } = {}, archived = false) {
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience: 'clients', doc: { version: 1, blocks: [p(title)] } });
  // Счётчики и архив пишет система (триггер счётчиков, решение 0047, пункт 8).
  await asActor(pools.app, SYSTEM, (c) =>
    c.query(`update hdk_articles set shown_count = $2, helped_count = $3, not_helped_count = $4, status = $5, archived_on = case when $5 = 'archived' then now() end where article_id = $1`, [
      created.articleId,
      counts.shown ?? 0,
      counts.helped ?? 0,
      counts.notHelped ?? 0,
      archived ? 'archived' : 'active',
    ]),
  );
  return created;
}

const range = { from: FROM, to: TO };

test('доля самостоятельно решённых: показы, помогло, не помогло, обращения и ушедшие за период сходятся с ручным подсчётом', async () => {
  await seedEvents();
  const care = await getKnowledgeMetrics(staffCtx(f.care), range);
  expect(care.deflection).toEqual({ shown: 12, helped: 5, notHelped: 2, ticketCreated: 2, left: 3, selfServicePercent: 41.7, ticketPercent: 16.7 });
  expect(care.byOrg).toEqual([
    { orgId: f.orgA.orgId, name: f.orgA.name, shown: 10, helped: 4, notHelped: 2, ticketCreated: 1, left: 3, selfServicePercent: 40, ticketPercent: 10 },
    { orgId: f.orgB.orgId, name: f.orgB.name, shown: 2, helped: 1, notHelped: 0, ticketCreated: 1, left: 0, selfServicePercent: 50, ticketPercent: 50 },
  ]);
  // Период без показов: нули и пустые доли, деления на ноль нет.
  const empty = await getKnowledgeMetrics(staffCtx(f.care), { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-01-08T00:00:00Z') });
  expect(empty.deflection).toEqual({ shown: 0, helped: 0, notHelped: 0, ticketCreated: 0, left: 0, selfServicePercent: null, ticketPercent: null });
  expect(empty.byOrg).toEqual([]);
});

test('частые сигнатуры без решения: без решения или с решением в архиве, встречались в периоде, больше организаций первыми', async () => {
  const active = await article('Действующее решение');
  const archived = await article('Снятое решение', {}, true);
  await signature(1, { orgs: 5, times: 9, lastSeen: IN });
  await signature(2, { orgs: 2, times: 20, lastSeen: IN });
  await signature(3, { articleId: active.articleId, orgs: 9, times: 99, lastSeen: IN });
  await signature(4, { articleId: archived.articleId, orgs: 1, times: 3, lastSeen: IN });
  await signature(5, { orgs: 7, times: 7, lastSeen: OUT });
  // Привязана сотрудником, у клиентов не встречалась.
  await signature(6, { orgs: 0, times: 0, lastSeen: null });
  const result = await getKnowledgeMetrics(staffCtx(f.l1), range);
  expect(result.unsolved.map((row) => [row.sampleMessage, row.orgCount, row.occurrences])).toEqual([
    ['ошибка 1', 5, 9],
    ['ошибка 2', 2, 20],
    ['ошибка 4', 1, 3],
  ]);
  // Сигнатура не раскрывается целиком: в строке пример, код и числа, а не названия организаций.
  expect(JSON.stringify(result.unsolved)).not.toContain(f.orgA.name);
});

test('права как у страницы показателей M8: срез по организациям только тем, кому положены срезы; "Создать решение" ролям черновиков; клиенту ничего', async () => {
  await seedEvents();
  const lead = (member: { userId: string; name: string; actor: StaffContext['actor'] }): StaffContext => ({ ...staffCtx(member), isLead: true });
  const l1 = await getKnowledgeMetrics(staffCtx(f.l1), range);
  expect(l1.byOrg).toBeNull();
  expect(l1.canCreate).toBe(true);
  expect(l1.deflection.shown).toBe(12);
  expect((await getKnowledgeMetrics(lead(f.l1), range)).byOrg).toHaveLength(2);
  const product = await getKnowledgeMetrics(staffCtx(await staffWithRole('product')), range);
  expect(product.byOrg).toHaveLength(2);
  expect(product.canCreate).toBe(false);
  expect((await getKnowledgeMetrics(staffCtx(f.adminStaff), range)).byOrg).toHaveLength(2);
  expect((await getKnowledgeMetrics(staffCtx(await staffWithRole('agent_l2')), range)).byOrg).toBeNull();
  await expect(getKnowledgeMetrics((await clientCtx(f.aUser)) as never, range)).rejects.toMatchObject({ code: 'forbidden' });
  // Негодный период: конец раньше начала, длиннее года, не даты.
  for (const bad of [{ from: TO, to: FROM }, { from: new Date('2024-01-01T00:00:00Z'), to: TO }, { from: '2026-11-01', to: '2026-11-08' }, {}])
    await expect(getKnowledgeMetrics(staffCtx(f.care), bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' });
});

test('список на пересмотр: "не помогло" выше 40% при не менее чем 10 исходах; показы и исходы у каждого решения', async () => {
  const bad = await article('Не помогает половине', { shown: 30, helped: 5, notHelped: 5 });
  const border = await article('Ровно сорок процентов', { shown: 20, helped: 6, notHelped: 4 });
  const few = await article('Мало исходов', { shown: 12, helped: 0, notHelped: 9 });
  const all = await listSolutions(staffCtx(f.l1), {});
  const row = (number: number) => all.find((r) => r.number === number);
  expect(row(bad.number)).toMatchObject({ needsReview: true, shownCount: 30, helpedCount: 5, notHelpedCount: 5 });
  expect(row(border.number)).toMatchObject({ needsReview: false, shownCount: 20, helpedCount: 6, notHelpedCount: 4 });
  expect(row(few.number)).toMatchObject({ needsReview: false, notHelpedCount: 9 });
  const review = await listSolutions(staffCtx(f.l1), { review: true });
  expect(review.map((r) => r.number)).toEqual([bad.number]);
  // "Мои задачи" автора тоже держат решение на пересмотре (план M5, задача 3).
  expect((await listSolutions(staffCtx(f.l1), { mine: true })).map((r) => r.number)).toContain(bad.number);
});
