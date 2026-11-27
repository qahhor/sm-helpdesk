import { expect, test } from 'vitest';
import { seedAgentToken } from '../helpers/agent';
import { asActor, pools } from '../helpers/db';
import { seedEverything } from './seed-everything';
import { DOMAIN_OBJECTS, type Write } from './tables';

/** Опубликованная идея (решение 2 плана M7): видна клиентам всех организаций. */
const PUBLISHED = (alias: string) => `(${alias}.status not in ('pending_review', 'declined') and ${alias}.published_on is not null)`;

/**
 * Вид published-or-own (веха M7): какие строки клиент видит законно. column: что читается под клиентом; violations:
 * запрос суперпользователя, который из прочитанных строк ($1) возвращает те, что клиенту ($2) видеть нельзя.
 */
const PUBLISHED_OR_OWN: Record<string, { column: string; violations: string }> = {
  hdi_ideas: {
    column: 'idea_id as id',
    violations: `select x.idea_id from hdi_ideas x where x.idea_id = any($1::uuid[]) and not (${PUBLISHED('x')} or x.author_id = $2::uuid)`,
  },
  hdi_idea_translations: {
    column: 'translation_id as id',
    violations: `select x.translation_id from hdi_idea_translations x join hdi_ideas i on i.idea_id = x.idea_id
                  where x.translation_id = any($1::uuid[]) and (x.status in ('outdated', 'rejected') or not (${PUBLISHED('i')} or i.author_id = $2::uuid))`,
  },
  hdi_comments: {
    column: 'comment_id as id',
    violations: `select x.comment_id from hdi_comments x join hdi_ideas i on i.idea_id = x.idea_id
                  where x.comment_id = any($1::uuid[]) and not (x.author_id = $2::uuid or (x.status = 'published' and (${PUBLISHED('i')} or i.author_id = $2::uuid)))`,
  },
  hdi_attachments: {
    column: 'attachment_id as id',
    violations: `select x.attachment_id from hdi_attachments x left join hdi_ideas i on i.idea_id = x.idea_id
                  where x.attachment_id = any($1::uuid[]) and not (x.uploader_id = $2::uuid or (x.scan_status = 'clean' and i.published_on is not null))`,
  },
};

const rowsOrDenied = (query: Promise<{ rows: Record<string, unknown>[] }>) =>
  query.then(
    (result) => result.rows,
    (error) => {
      expect(String(error)).toMatch(/permission denied/);
      return [] as Record<string, unknown>[];
    },
  );

test('у каждой таблицы и представления предметной области есть строка в наборе изоляции', async () => {
  const r = await pools.owner.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by 1`);
  expect(r.rows.map((x) => x.relname)).toEqual(Object.keys(DOMAIN_OBJECTS).sort());
});

test('в каждой таблице набора есть данные для проверки', async () => {
  const f = await seedEverything();
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS)) {
    // Представление само отбирает строки по актору, поэтому без актора пусто даже у суперпользователя.
    // Представления агента (веха M8b) отдают строки только актору agent с действующим токеном.
    const found =
      rule.agent === 'via-view'
        ? await asActor(pools.app, f.agent, (c) => c.query(`select 1 from ${name} limit 1`))
        : name === 'hdu_user_profiles' || name === 'hdp_problems_public'
          ? await asActor(pools.app, { type: 'system', job: 'test' }, (c) => c.query(`select 1 from ${name} limit 1`))
          : await pools.root.query(`select 1 from ${name} limit 1`);
    expect(found.rowCount, name).toBe(1);
  }
});

test('запрос без актора не возвращает ни одной строки ни под одной ролью приложения', async () => {
  await seedEverything();
  for (const name of Object.keys(DOMAIN_OBJECTS))
    for (const [role, pool] of [
      ['hub_app', pools.app],
      ['hub_auth', pools.auth],
    ] as const)
      expect(await rowsOrDenied(pool.query(`select * from ${name}`)), `${name} без актора под ролью ${role}`).toEqual([]);
});

test('клиент видит в каждой таблице ровно то, что записано в наборе', async () => {
  const f = await seedEverything();
  const people = new Set(
    (await pools.root.query(`select user_id from hdu_memberships where org_id = $1 union select user_id from hdu_staff where state = 'active'`, [f.orgA.orgId])).rows.map(
      (row) => row.user_id as string,
    ),
  );
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS)) {
    let seen = 0;
    for (const actor of [f.aUser.actor, f.aAdmin.actor]) {
      // Столбец, по которому видно принадлежность. Не select *: у hub_app нет права на секретные столбцы
      // (например, хеш токена приглашения), и отказ выглядел бы как "клиент ничего не видит".
      const column =
        rule.client === 'published-or-own'
          ? PUBLISHED_OR_OWN[name]!.column
          : { none: '1', all: '1', 'own-org': 'org_id', 'org-people': 'user_id', 'own-user': 'user_id', 'clients-audience': 'audience', 'decided-only': 'status', 'shown-only': 'number, locale', 'active-audience': 'announcement_id' }[rule.client];
      const rows = await rowsOrDenied(asActor(pools.app, actor, (c) => c.query(`select ${column} from ${name}`)));
      seen += rows.length;
      const label = `${name} для ${actor.orgRole}`;
      if (rule.client === 'none') expect(rows, label).toEqual([]);
      if (rule.client === 'all') expect(rows.length, label).toBeGreaterThan(0);
      if (rule.client === 'own-org') expect(rows.filter((row) => row.org_id !== f.orgA.orgId), label).toEqual([]);
      if (rule.client === 'org-people') expect(rows.filter((row) => !people.has(row.user_id as string)), label).toEqual([]);
      if (rule.client === 'own-user') expect(rows.filter((row) => row.user_id !== actor.userId), label).toEqual([]);
      if (rule.client === 'clients-audience') expect(rows.filter((row) => row.audience !== 'clients'), label).toEqual([]);
      if (rule.client === 'decided-only') expect(rows.filter((row) => row.status !== 'decided' && row.status !== 'lapsed'), label).toEqual([]);
      if (rule.client === 'shown-only') {
        // Суперпользователь проверяет по таблицам, что каждая прочитанная строка показана законно (решение 2).
        const bad = await pools.root.query(
          `select p.number, t.locale from hdp_problems p join hdp_problem_translations t on t.problem_id = p.problem_id
            where (p.number, t.locale) in (select (x ->> 'number')::bigint, x ->> 'locale' from jsonb_array_elements($1::jsonb) x)
              and not (p.show_to_clients and p.status <> 'closed' and (p.status <> 'fixed' or p.fixed_on > now() - interval '30 days')
                       and t.public_title <> '' and (not t.is_machine or t.accepted_by is not null))`,
          [JSON.stringify(rows)],
        );
        expect(bad.rows, label).toEqual([]);
      }
      if (rule.client === 'active-audience') {
        // Суперпользователь проверяет, что каждое прочитанное объявление начато, не старше архива и своей аудитории.
        const bad = await pools.root.query(
          `select a.announcement_id from hdp_announcements a
            where a.announcement_id = any($1::uuid[])
              and not (a.starts_on <= now() and a.ends_on > now() - interval '90 days'
                       and (a.audience <> 'server' or a.server_id = (select o.server_id from hdu_organizations o where o.org_id = $2)))`,
          [rows.map((row) => row.announcement_id), actor.orgId],
        );
        expect(bad.rows, label).toEqual([]);
        // Непринятый машинный перевод клиенту не виден ни одной строкой.
        if (name === 'hdp_announcement_translations')
          expect((await asActor(pools.app, actor, (c) => c.query(`select 1 from hdp_announcement_translations where is_machine and accepted_by is null`))).rows, label).toEqual([]);
      }
      if (rule.client === 'published-or-own') {
        const probe = PUBLISHED_OR_OWN[name];
        expect(probe, `${name}: нет проверки published-or-own`).toBeDefined();
        const bad = await pools.root.query(probe!.violations, [rows.map((row) => row.id), actor.userId]);
        expect(bad.rows, label).toEqual([]);
      }
    }
    // Проверка "только своё" ничего не значит, если клиент не видит вообще ничего (проверка main, Q2).
    if (rule.client !== 'none') expect(seen, `${name}: клиент видит свои строки`).toBeGreaterThan(0);
  }
});

test('агент с действующим токеном не читает ни одной строки, кроме своих представлений, и ничего не меняет и не удаляет', async () => {
  const f = await seedEverything();
  // Основной токен и токен запуска по обращению организации A (веха M8b, решения 5, 15).
  const main = await seedAgentToken();
  const run = await seedAgentToken({ userId: main.userId, parentTokenId: main.tokenId, ticketId: f.tickets.aOrg.ticketId });
  const firstColumn = new Map(
    (
      await pools.owner.query(`select table_name, column_name from information_schema.columns where table_schema = 'public' and ordinal_position = 1`)
    ).rows.map((row) => [row.table_name as string, row.column_name as string]),
  );
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS)) {
    if (rule.agent === 'via-view') continue;
    for (const actor of [main.actor, run.actor]) {
      const label = `${name} для агента${actor.ticketId ? ' (токен запуска)' : ''}`;
      const seen = await rowsOrDenied(asActor(pools.app, actor, (c) => c.query(`select 1 from ${name}`)));
      if (rule.agent === 'reference') expect(seen.length, label).toBe((await pools.root.query(`select 1 from ${name}`)).rowCount);
      else expect(seen, label).toEqual([]);
      // Изменение и удаление: отказ правом или ни одной строки по политике.
      for (const statement of [`update ${name} set ${firstColumn.get(name)} = ${firstColumn.get(name)}`, `delete from ${name}`]) {
        const changed = await asActor(pools.app, actor, (c) => c.query(statement)).then(
          (r) => r.rowCount ?? 0,
          (error) => {
            expect(String(error), `${statement} под агентом`).toMatch(/permission denied|cannot (update|delete from) view/);
            return 0;
          },
        );
        expect(changed, `${statement} под агентом`).toBe(0);
      }
    }
  }
});

const WRITES: Write[] = ['insert', 'update', 'delete'];

test('права ролей приложения на изменение совпадают с набором', async () => {
  const actual = await pools.owner.query(`select c.relname as name, r.role, lower(p.priv) as priv
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('hub_app'), ('hub_auth')) r(role) cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(r.role, c.oid, p.priv)`);
  const granted = (name: string, role: string) =>
    actual.rows.filter((row) => row.name === name && row.role === role).map((row) => row.priv as Write).sort();
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS)) {
    expect(granted(name, 'hub_app'), `${name} hub_app`).toEqual([...(rule.app ?? [])].sort());
    expect(granted(name, 'hub_auth'), `${name} hub_auth`).toEqual([...(rule.auth ?? [])].sort());
  }
});

test('изменения, которых нет в наборе, закрыты при любом акторе', async () => {
  const f = await seedEverything();
  const actors = [f.aAdmin.actor, f.adminStaff.actor, { type: 'system', job: 'test' } as const];
  // Первый столбец каждого объекта: обновление без изменения значения, только проверка права.
  const firstColumn = new Map(
    (
      await pools.owner.query(`select table_name, column_name from information_schema.columns where table_schema = 'public' and ordinal_position = 1`)
    ).rows.map((row) => [row.table_name as string, row.column_name as string]),
  );
  const statement = {
    update: (t: string) => `update ${t} set ${firstColumn.get(t)} = ${firstColumn.get(t)}`,
    delete: (t: string) => `delete from ${t}`,
  };
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS))
    for (const [role, pool, allowed] of [
      ['hub_app', pools.app, rule.app ?? []],
      ['hub_auth', pools.auth, rule.auth ?? []],
    ] as const)
      for (const write of WRITES.filter((w) => w !== 'insert' && !allowed.includes(w)) as ('update' | 'delete')[])
        for (const actor of actors)
          await expect(
            asActor(pool, actor, (c) => c.query(statement[write](name))),
            `${write} ${name} под ${role}`,
          ).rejects.toThrow(/permission denied|cannot (update|delete from) view/);
  expect(f.orgA.orgId).not.toBe(f.orgB.orgId);
});
