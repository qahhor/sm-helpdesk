import { beforeEach, expect, test } from 'vitest';
import { staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Доступ к таблицам известных проблем напрямую в базу под ролью hub_app (план M5c, задача 1, решения 2, 3, 7; ТЗ 15.2
// "Клиент запрашивает известную проблему без признака показа: Не найдено"). Сервисы не участвуют: проверяется сама база.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const SIG_A = 'a'.repeat(32);

async function problem(opts: { title?: string; shown?: boolean; status?: string; fixedDaysAgo?: number } = {}): Promise<{ problemId: string; number: number }> {
  const row = (
    await pools.root.query(`insert into hdp_problems (internal_title, show_to_clients) values ($1, $2) returning problem_id, number`, [opts.title ?? 'Внутреннее: ACME накладные', opts.shown ?? true])
  ).rows[0];
  if (opts.status) await pools.root.query(`update hdp_problems set status = $2 where problem_id = $1`, [row.problem_id, opts.status]);
  if (opts.fixedDaysAgo !== undefined) await pools.root.query(`update hdp_problems set fixed_on = now() - make_interval(days => $2) where problem_id = $1`, [row.problem_id, opts.fixedDaysAgo]);
  await pools.root.query(`insert into hdp_problem_translations (problem_id, locale, public_title, public_body) values ($1, 'ru', 'Не проводятся накладные', 'Исправляем')`, [row.problem_id]);
  return { problemId: row.problem_id, number: Number(row.number) };
}

const clientView = (actor = f.aUser.actor) => asActor(pools.app, actor, (c) => c.query(`select number, locale from hdp_problems_public order by number`)).then((r) => r.rows);

test('клиент не читает ни одной строки таблиц проблем, текстов и сигнатур', async () => {
  const p = await problem();
  await pools.root.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [p.problemId, SIG_A]);
  for (const actor of [f.aUser.actor, f.aAdmin.actor])
    for (const table of ['hdp_problems', 'hdp_problem_translations', 'hdp_problem_signatures'])
      expect((await asActor(pools.app, actor, (c) => c.query(`select 1 from ${table}`))).rows, table).toEqual([]);
  // Сотрудник любой роли читает.
  const product = await staffWithRole('product');
  for (const actor of [f.l1.actor, product.actor]) expect((await asActor(pools.app, actor, (c) => c.query(`select 1 from hdp_problems`))).rowCount).toBe(1);
});

test('клиент через представление видит показанную проблему; скрытую, закрытую и исправленную больше 30 суток назад не видит', async () => {
  const shown = await problem();
  await problem({ shown: false });
  await problem({ status: 'closed' });
  const fixedRecent = await problem({ status: 'fixed' });
  await problem({ status: 'fixed', fixedDaysAgo: 31 });
  expect(await clientView()).toEqual([
    { number: String(shown.number), locale: 'ru' },
    { number: String(fixedRecent.number), locale: 'ru' },
  ]);
  // Без актора и под hub_auth пусто.
  expect((await pools.app.query(`select 1 from hdp_problems_public`)).rows).toEqual([]);
  await expect(pools.auth.query(`select 1 from hdp_problems_public`)).rejects.toThrow(/permission denied/);
});

test('машинный перевод клиент видит только принятым, пустой текст не видит', async () => {
  const p = await problem();
  await pools.root.query(`insert into hdp_problem_translations (problem_id, locale, public_title, public_body, is_machine) values ($1, 'en', 'Invoices', 'Fixing', true), ($1, 'uz', '', '', false)`, [p.problemId]);
  expect((await clientView()).map((r) => r.locale)).toEqual(['ru']);
  await pools.root.query(`update hdp_problem_translations set accepted_by = $2, accepted_on = now() where problem_id = $1 and locale = 'en'`, [p.problemId, f.adminStaff.userId]);
  expect((await clientView()).map((r) => r.locale).sort()).toEqual(['en', 'ru']);
});

test('в представлении нет внутреннего названия, владельца, задачи разработки, счётчиков и моментов появления', async () => {
  const columns = (await pools.owner.query(`select column_name from information_schema.columns where table_name = 'hdp_problems_public' order by ordinal_position`)).rows.map((r) => r.column_name);
  expect(columns).toEqual(['problem_id', 'number', 'status', 'module_id', 'workaround_solution_id', 'fixed_on', 'locale', 'public_title', 'public_body']);
  for (const hidden of ['internal_title', 'owner_id', 'dev_task_id', 'ticket_count', 'org_count', 'first_seen_on', 'last_seen_on', 'show_to_clients']) expect(columns).not.toContain(hidden);
});

test('agent_l1 и product не создают и не меняют проблему; agent_l2, care и admin могут', async () => {
  const product = await staffWithRole('product');
  for (const actor of [f.l1.actor, product.actor, f.aAdmin.actor])
    await expect(asActor(pools.app, actor, (c) => c.query(`insert into hdp_problems (internal_title) values ('Проблема')`))).rejects.toThrow(/row-level security|permission/);
  const p = await problem({ shown: false });
  // Первая линия может обновить строку только пересчётом счётчиков: другие поля закрывает триггер.
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`update hdp_problems set internal_title = 'Другое' where problem_id = $1`, [p.problemId]))).rejects.toThrow(/только вторая линия/);
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`update hdp_problems set show_to_clients = true where problem_id = $1`, [p.problemId]))).rejects.toThrow(/только вторая линия/);
  expect((await asActor(pools.app, product.actor, (c) => c.query(`update hdp_problems set internal_title = 'Другое' where problem_id = $1`, [p.problemId]))).rowCount).toBe(0);
  for (const table of ['hdp_problem_translations', 'hdp_problem_signatures'])
    await expect(
      asActor(pools.app, f.l1.actor, (c) => c.query(table === 'hdp_problem_signatures' ? `insert into ${table} (problem_id, signature) values ($1, '${SIG_A}')` : `insert into ${table} (problem_id, locale) values ($1, 'en')`, [p.problemId])),
    ).rejects.toThrow(/row-level security/);
  for (const role of ['agent_l2', 'care', 'admin'] as const) {
    const actor = (await staffWithRole(role)).actor;
    const created = await asActor(pools.app, actor, (c) => c.query(`insert into hdp_problems (internal_title) values ('Проблема ' || $1) returning problem_id`, [role]));
    const id = created.rows[0].problem_id;
    await asActor(pools.app, actor, async (c) => {
      await c.query(`update hdp_problems set status = 'fixing' where problem_id = $1`, [id]);
      await c.query(`insert into hdp_problem_translations (problem_id, locale, public_title, public_body) values ($1, 'ru', 'Название', 'Описание')`, [id]);
    });
  }
});

test('счётчики и моменты появления считает база по привязанным обращениям; задать их нельзя', async () => {
  const p = await problem();
  await pools.root.query(`update hdt_tickets set known_problem_id = $1 where ticket_id = any($2)`, [p.problemId, [f.tickets.aOrg.ticketId, f.tickets.aMine.ticketId, f.tickets.bOrg.ticketId]]);
  // Первая линия пересчитывает: подставленное значение заменяется настоящим.
  await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdp_problems set ticket_count = 99, org_count = 50 where problem_id = $1`, [p.problemId]));
  const row = (await pools.root.query(`select ticket_count, org_count, first_seen_on, last_seen_on from hdp_problems where problem_id = $1`, [p.problemId])).rows[0];
  expect(row).toMatchObject({ ticket_count: 3, org_count: 2 });
  expect(row.first_seen_on).not.toBeNull();
  expect(row.last_seen_on.getTime()).toBeGreaterThanOrEqual(row.first_seen_on.getTime());
});

test('номер не меняется, закрытая проблема не меняется, момент исправления ставит база', async () => {
  const admin = f.adminStaff.actor;
  const p = await problem({ shown: false });
  await expect(asActor(pools.app, admin, (c) => c.query(`update hdp_problems set number = number + 100 where problem_id = $1`, [p.problemId]))).rejects.toThrow(/номер не меняется/);
  await asActor(pools.app, admin, (c) => c.query(`update hdp_problems set status = 'fixed', fixed_on = '2001-01-01' where problem_id = $1`, [p.problemId]));
  const fixed = (await pools.root.query(`select fixed_on from hdp_problems where problem_id = $1`, [p.problemId])).rows[0].fixed_on as Date;
  expect(Date.now() - fixed.getTime()).toBeLessThan(60_000);
  await asActor(pools.app, admin, (c) => c.query(`update hdp_problems set status = 'closed' where problem_id = $1`, [p.problemId]));
  expect((await pools.root.query(`select closed_on from hdp_problems where problem_id = $1`, [p.problemId])).rows[0].closed_on).not.toBeNull();
  await expect(asActor(pools.app, admin, (c) => c.query(`update hdp_problems set status = 'fixing' where problem_id = $1`, [p.problemId]))).rejects.toThrow(/закрытая проблема не меняется/);
});

test('клиент не может задать обращению известную проблему', async () => {
  const p = await problem();
  await expect(asActor(pools.app, f.aUser.actor, (c) => c.query(`update hdt_tickets set known_problem_id = $1 where ticket_id = $2`, [p.problemId, f.tickets.aOrg.ticketId]))).rejects.toThrow(/клиенту менять эти поля нельзя/);
  await expect(
    asActor(pools.app, f.aUser.actor, (c) =>
      c.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, known_problem_id)
         values ($1, $2, 'bug', 'major', 'p2', 'org', 'Тема', 'Описание', 'ru', 'portal', $3)`,
        [f.orgA.orgId, f.aUser.userId, p.problemId],
      ),
    ),
  ).rejects.toThrow(/без полей сотрудника/);
});

test('сигнатура уникальна среди активных проблем: вторая активная отклоняется, исправленная не мешает', async () => {
  const admin = f.adminStaff.actor;
  const first = await problem();
  const second = await problem();
  await asActor(pools.app, admin, (c) => c.query(`insert into hdp_problem_signatures (problem_id, signature, is_active) values ($1, $2, false)`, [first.problemId, SIG_A]));
  // Присланный признак отброшен: активность из статуса проблемы.
  expect((await pools.root.query(`select is_active from hdp_problem_signatures where problem_id = $1`, [first.problemId])).rows).toEqual([{ is_active: true }]);
  await expect(asActor(pools.app, admin, (c) => c.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [second.problemId, SIG_A]))).rejects.toThrow(/hdp_problem_signatures_u1/);
  // Исправленная проблема отпускает сигнатуру той же транзакцией смены статуса.
  await asActor(pools.app, admin, (c) => c.query(`update hdp_problems set status = 'fixed' where problem_id = $1`, [first.problemId]));
  expect((await pools.root.query(`select is_active from hdp_problem_signatures where problem_id = $1`, [first.problemId])).rows).toEqual([{ is_active: false }]);
  await asActor(pools.app, admin, (c) => c.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [second.problemId, SIG_A]));
  // Вернуть исправленную в работу нельзя, пока сигнатура у другой активной.
  await expect(asActor(pools.app, admin, (c) => c.query(`update hdp_problems set status = 'fixing' where problem_id = $1`, [first.problemId]))).rejects.toThrow(/hdp_problem_signatures_u1/);
});
