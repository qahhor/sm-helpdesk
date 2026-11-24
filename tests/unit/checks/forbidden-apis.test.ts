import { expect, test } from 'vitest';
import { findForbiddenApis } from '../../../scripts/checks/forbidden-apis.mjs';

test.each([
  ["'use cache';\nexport async function f() {}", 'use-cache'],
  ['export async function f() {\n  "use cache: private";\n}', 'use-cache'],
  ["import { unstable_cache } from 'next/cache';", 'unstable-cache'],
  ["import { cacheLife, cacheTag } from 'next/cache';", 'cache-api'],
  ['export const revalidate = 60;', 'cache-api'],
  ["export const dynamic = 'force-static';", 'cache-api'],
  ["await fetch(url, { cache: 'force-cache' });", 'cache-api'],
  ['await fetch(url, { next: { revalidate: 30 } });', 'cache-api'],
  ['<div dangerouslySetInnerHTML={{ __html: x }} />', 'inner-html'],
  ['<div style={{ color: "red" }} />', 'inline-style'],
])('находит %s', (text, rule) => {
  expect(findForbiddenApis('src/app/x.tsx', text).map((v) => v.rule)).toEqual([rule]);
});

test('номер строки указывает на нарушение', () => {
  expect(findForbiddenApis('src/app/x.ts', "const a = 1;\n\nimport { unstable_cache } from 'next/cache';")).toEqual([
    { line: 3, rule: 'unstable-cache' },
  ]);
});

test('revalidatePath из next/cache разрешён', () => {
  expect(findForbiddenApis('src/app/x.ts', "import { revalidatePath } from 'next/cache';")).toEqual([]);
});

test('отключение кеша разрешено', () => {
  const text = "export const dynamic = 'force-dynamic';\nexport const revalidate = 0;\nawait fetch(url, { cache: 'no-store' });";
  expect(findForbiddenApis('src/app/x.ts', text)).toEqual([]);
});

test('встроенный скрипт темы в списке исключений', () => {
  expect(
    findForbiddenApis('src/ui/theme/ThemeScript.tsx', '<script dangerouslySetInnerHTML={{ __html: s }} />'),
  ).toEqual([]);
});

// Защита от SQL-инъекций (ТЗ 14.3, V2 ASVS): в базу уходят только параметры. Склейка текста запроса запрещена.
test.each([
  ['await tx.execute(sql.raw(`select * from t where id = ${id}`));', 'raw-sql'],
  ["const q = sql.raw('drop table ' + name);", 'raw-sql'],
  ['await client.query(`select * from t where name = ${name}`);', 'raw-sql'],
  ["await pool.query('select * from t where name = ' + name);", 'raw-sql'],
  ['await tx.execute(`select 1 from t where id = ${id}`);', 'raw-sql'],
  ["await db.execute('delete from t where id = ' + id);", 'raw-sql'],
])('склейку SQL находит: %s', (text, rule) => {
  expect(findForbiddenApis('src/modules/x/core/y.ts', text).map((v) => v.rule)).toEqual([rule]);
});

test('параметры SQL разрешены', () => {
  const text = [
    'await tx.execute(sql`select * from t where id = ${id}`);',
    "await client.query('select * from t where id = $1', [id]);",
    'await client.query(`select 1 from pg_roles where rolname = current_user`);',
    "tx.select().from(t).where(eq(t.id, id));",
  ].join('\n');
  expect(findForbiddenApis('src/modules/x/core/y.ts', text)).toEqual([]);
});

test('системный актор запрещён в обработчиках запросов: src/app и src/ui (аудит 23.11.2026, A7)', () => {
  const text = "const actor = { type: 'system', job: 'x' } as const;";
  expect(findForbiddenApis('src/app/api/x/route.ts', text).map((v) => v.rule)).toEqual(['system-actor']);
  expect(findForbiddenApis('src/ui/x.tsx', 'withActor({ type: "system", job: "x" }, fn)').map((v) => v.rule)).toEqual(['system-actor']);
  expect(findForbiddenApis('src/modules/hdt/core/x.ts', text)).toEqual([]);
  expect(findForbiddenApis('src/worker/main.ts', text)).toEqual([]);
});

// Чужие таблицы прямым SQL (аудит 23.11.2026, находка A2; план W2, задача 9): модуль читает и пишет только свои
// таблицы. Нужное из чужой таблицы даёт функция api модуля-владельца. Линтер импортов такую связь не видит:
// имя таблицы стоит в тексте запроса.

test('код модуля не называет таблицу другого модуля', () => {
  const rules = (path: string, text: string) => findForbiddenApis(path, text).map((v) => v.rule);
  expect(rules('src/modules/hdn/core/notifications.ts', 'await tx.execute(sql`select org_id from hdt_tickets where ticket_id = ${id}`);')).toEqual(['cross-module-sql']);
  expect(rules('src/modules/hdt/core/housekeeping.ts', "sql`select 1 from hdn_notifications where kind = 'x'`")).toEqual(['cross-module-sql']);
  expect(rules('src/modules/hdc/audit.ts', 'sql`(select p.name from hdu_user_profiles p where p.user_id::text = hdc_audit_log.actor_id)`')).toEqual(['cross-module-sql']);
  expect(rules('src/modules/hdt/core/x.ts', 'sql`select 1 from auth."user" where id = ${id}`')).toEqual(['cross-module-sql']);
});

test('свои таблицы, комментарии, схема и код вне модулей под запрет не попадают', () => {
  const rules = (path: string, text: string) => findForbiddenApis(path, text).map((v) => v.rule);
  expect(rules('src/modules/hdt/core/x.ts', 'sql`select 1 from hdt_tickets t join hdt_ticket_messages m using (ticket_id)`')).toEqual([]);
  expect(rules('src/modules/hdt/core/x.ts', '// Раньше здесь читалась таблица hdn_notifications напрямую.')).toEqual([]);
  expect(rules('src/modules/hdt/core/x.ts', ' * Таблица hdn_outbox принадлежит модулю уведомлений.')).toEqual([]);
  expect(rules('src/modules/hdt/core/x.ts', "const x = 1; // hdu_memberships")).toEqual([]);
  // Таблицы библиотеки входа читает только модуль пользователей.
  expect(rules('src/modules/hdu/core/x.ts', 'sql`select 1 from auth."user" where id = ${id}`')).toEqual([]);
  // Имя ограничения или индекса в сообщении об ошибке своего модуля.
  expect(rules('src/modules/hdu/core/x.ts', "if (error.constraint === 'hdu_servers_u1') return;")).toEqual([]);
  // Тесты, миграции и проверки называют любые таблицы.
  expect(rules('tests/integration/x.test.ts', 'pools.root.query(`select 1 from hdt_tickets`)')).toEqual([]);
  expect(rules('src/worker/main.ts', "console.info('hdn_outbox');")).toEqual([]);
});

// Шаблон поиска собирает только код (решение 0041, вопрос 19 владельца). Оператор ILIKE отмечен в базе как
// безопасный для выполнения раньше политик RLS. Это честно, пока шаблон не может кончаться знаком экранирования:
// такая ошибка зависела бы от содержимого невидимой строки. Поэтому файл с поиском по шаблону обязан экранировать.

test('шаблон поиска собирает только src/db/contains.ts', () => {
  const rules = (path: string, text: string) => findForbiddenApis(path, text).map((v) => v.rule);
  const file = 'src/modules/hdt/core/x.ts';
  expect(rules(file, 'const rows = await tx.select().from(t).where(ilike(t.title, `%${query}%`));')).toEqual(['like-pattern']);
  expect(rules(file, 'where(like(t.title, pattern))')).toEqual(['like-pattern']);
  // Экранирование рядом правило не снимает: помощник один, свой шаблон собирать нельзя.
  expect(rules(file, 'const p = `%${likeEscape(q)}%`;\nwhere(ilike(t.title, p))')).toEqual(['like-pattern']);
  // Оператор в тексте запроса: параметр, склейка, сокращённая запись.
  expect(rules(file, 'sql`${t.title} ilike ${pattern}`')).toEqual(['like-pattern']);
  expect(rules(file, "sql`select 1 from t where title ilike '%' || ${q} || '%'`")).toEqual(['like-pattern']);
  expect(rules(file, 'sql`${t.title} ~~* ${pattern}`')).toEqual(['like-pattern']);
  expect(rules(file, 'await db.query("select 1 from t where title ilike $1", [p])')).toEqual(['like-pattern']);
  // Две проверки в строке: константа не прикрывает шаблон из переменной.
  expect(rules(file, "and(like(a.key, 'files/%'), ilike(a.name, pattern))")).toEqual(['like-pattern']);
  // Разрешено: общий помощник, шаблон строкой в коде, слово в комментарии, сам файл помощника.
  expect(rules(file, 'where(containsText(t.title, query))')).toEqual([]);
  expect(rules(file, "where(like(attachments.storageKey, 'files/%'))")).toEqual([]);
  expect(rules(file, '// оператор ILIKE не отмечен как безопасный')).toEqual([]);
  expect(rules(file, "sql`${attachments.storageKey} like 'files/%'`")).toEqual([]);
  expect(rules('src/db/contains.ts', 'return ilike(column, `%${escapeLike(text)}%`);')).toEqual([]);
});
