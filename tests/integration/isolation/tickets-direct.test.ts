import { expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';

// Обращения: политики запросами напрямую в базу под ролью hub_app с переменными актора (ТЗ 15.2, веха M2).
// Сервисы проверяются отдельно: здесь видна ошибка в политике, даже если сервис её маскирует.

const rows = <T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []) =>
  asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rows as T[]);
const run = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rowCount);
const titles = (actor: Actor) => rows<{ title: string }>(actor, 'select title from hdt_tickets order by title').then((r) => r.map((x) => x.title));

test('пользователь А видит обращения А с видимостью "организация" и свои личные, личное коллеги не видит', async () => {
  const f = await seedTwoOrgs();
  expect(await titles(f.aUser.actor)).toEqual([f.tickets.aMine.title, f.tickets.aOrg.title].sort());
  expect(await titles(f.bUser.actor)).toEqual([f.tickets.bOrg.title]);
  // По номеру чужое и личное коллеги не находится.
  for (const t of [f.tickets.bOrg, f.tickets.aPrivate])
    expect(await rows(f.aUser.actor, 'select 1 from hdt_tickets where number = $1', [t.number]), t.title).toEqual([]);
  // Поиск текста обращения Б пуст.
  expect(await rows(f.aUser.actor, `select 1 from hdt_tickets where title ilike '%Секрет Б%' or description ilike '%Секрет Б%'`)).toEqual([]);
});

test('администратор А видит личное обращение коллеги', async () => {
  const f = await seedTwoOrgs();
  expect(await titles(f.aAdmin.actor)).toEqual([f.tickets.aMine.title, f.tickets.aOrg.title, f.tickets.aPrivate.title].sort());
  expect((await titles(f.l1.actor)).length).toBe(5);
});

test('сообщения обращения без внутренних заметок, события без внутренних, вложения только чистые', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  expect(await rows(f.aUser.actor, 'select body from hdt_ticket_messages where ticket_id = $1', [id])).toEqual([{ body: 'Публичное сообщение' }]);
  expect(await rows(f.aUser.actor, 'select kind from hdt_ticket_events where ticket_id = $1', [id])).toEqual([{ kind: 'created' }]);
  // aUser видит только чистое публичное вложение; aAdmin ещё и своё непроверенное.
  expect(await rows(f.aUser.actor, 'select scan_status, is_internal from hdt_attachments where ticket_id = $1', [id])).toEqual([
    { scan_status: 'clean', is_internal: false },
  ]);
  expect((await rows(f.aAdmin.actor, 'select scan_status from hdt_attachments where ticket_id = $1 order by scan_status', [id])).map((r) => r.scan_status)).toEqual([
    'clean',
    'pending',
  ]);
  // Сообщения, события и вложения личного обращения коллеги и обращения Б не видны.
  for (const t of [f.tickets.aPrivate, f.tickets.bOrg])
    for (const table of ['hdt_ticket_messages', 'hdt_ticket_events', 'hdt_attachments'])
      expect(await rows(f.aUser.actor, `select 1 from ${table} where ticket_id = $1`, [t.ticketId]), `${table} ${t.title}`).toEqual([]);
  // Сотрудник видит всё, в том числе заметки.
  expect(await rows(f.l1.actor, 'select 1 from hdt_ticket_messages where ticket_id = $1 and is_internal', [id])).toHaveLength(1);
});

test('сообщение в обращение Б и обращение с организацией Б не вставляются (row-level security)', async () => {
  const f = await seedTwoOrgs();
  await expect(
    run(f.aUser.actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body) values ($1, $2, $3, 'client', 'x')`, [
      f.orgB.orgId,
      f.tickets.bOrg.ticketId,
      f.aUser.userId,
    ]),
  ).rejects.toThrow(/row-level security|violates foreign key/);
  await expect(
    run(f.aUser.actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body) values ($1, $2, $3, 'client', 'x')`, [
      f.orgA.orgId,
      f.tickets.bOrg.ticketId,
      f.aUser.userId,
    ]),
  ).rejects.toThrow(/row-level security|violates foreign key/);
  await expect(
    run(
      f.aUser.actor,
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source)
       values ($1, $2, 'bug', 'major', 'p2', 'x', 'x', 'ru', 'portal')`,
      [f.orgB.orgId, f.aUser.userId],
    ),
  ).rejects.toThrow(/row-level security/);
  // От чужого имени, внутренней заметкой и в личное обращение коллеги тоже нельзя.
  await expect(
    run(f.aUser.actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'client', 'x', true)`, [
      f.orgA.orgId,
      f.tickets.aOrg.ticketId,
      f.aUser.userId,
    ]),
  ).rejects.toThrow(/row-level security/);
  await expect(
    run(f.aUser.actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body) values ($1, $2, $3, 'client', 'x')`, [
      f.orgA.orgId,
      f.tickets.aPrivate.ticketId,
      f.aUser.userId,
    ]),
  ).rejects.toThrow(/row-level security/);
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where org_id = $1`, [f.orgB.orgId])).rows[0].n).toBe(2);
});

test('клиент не меняет приоритет, исполнителя, очередь и организацию своего обращения (42501)', async () => {
  const f = await seedTwoOrgs();
  const set = (sql: string, actor: Actor = f.aUser.actor) => run(actor, `update hdt_tickets set ${sql} where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  for (const change of [`priority = 'p1'`, `queue = 'l2'`, `assignee_id = '${f.l1.userId}'`, `priority_confirmed = true`, `title = 'Подмена'`])
    await expect(set(change), change).rejects.toThrow(/нельзя/);
  await expect(set(`org_id = '${f.orgB.orgId}'`)).rejects.toThrow(/нельзя|row-level security/);
  // Разрешённые колонки клиент меняет.
  expect(await set(`status = 'closed', closed_on = now()`)).toBe(1);
  // Видимость меняют только автор и администратор клиента.
  expect(await set(`visibility = 'private'`)).toBe(1);
  expect(await run(f.aAdmin.actor, `update hdt_tickets set visibility = 'org' where ticket_id = $1`, [f.tickets.aMine.ticketId])).toBe(1);
  await pools.root.query(`update hdt_tickets set visibility = 'org' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  await expect(run(f.aUser.actor, `update hdt_tickets set visibility = 'private' where ticket_id = $1`, [f.tickets.aPrivate.ticketId])).rejects.toThrow(/нельзя/);
  // Клиент создаёт обращение только новым, без исполнителя, первой линии.
  await expect(
    run(
      f.aUser.actor,
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source, status, queue)
       values ($1, $2, 'bug', 'major', 'p2', 'x', 'x', 'ru', 'portal', 'resolved', 'l2')`,
      [f.orgA.orgId, f.aUser.userId],
    ),
  ).rejects.toThrow(/нельзя/);
});

test('удалить обращение, сообщение или событие не может никто из ролей приложения', async () => {
  const f = await seedTwoOrgs();
  for (const table of ['hdt_tickets', 'hdt_ticket_messages', 'hdt_ticket_events'])
    for (const actor of [f.aUser.actor, f.aAdmin.actor, f.l1.actor, { type: 'system', job: 'test' } as const])
      await expect(run(actor, `delete from ${table}`), table).rejects.toThrow(/permission denied/);
});

test('подписка: только своя строка, только в видимом обращении, удалить можно только свою', async () => {
  const f = await seedTwoOrgs();
  const watch = (actor: Actor, ticket: { ticketId: string }, orgId: string, userId: string) =>
    run(actor, `insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`, [orgId, ticket.ticketId, userId]);
  expect(await watch(f.aAdmin.actor, f.tickets.aOrg, f.orgA.orgId, f.aAdmin.userId)).toBe(1);
  await expect(watch(f.aUser.actor, f.tickets.aOrg, f.orgA.orgId, f.aAdmin.userId)).rejects.toThrow(/row-level security|duplicate/);
  await expect(watch(f.aUser.actor, f.tickets.aPrivate, f.orgA.orgId, f.aUser.userId)).rejects.toThrow(/row-level security/);
  await expect(watch(f.aUser.actor, f.tickets.bOrg, f.orgB.orgId, f.aUser.userId)).rejects.toThrow(/row-level security/);
  // Клиент видит только свои подписки, удаляет только свои.
  expect(await rows(f.aUser.actor, 'select user_id from hdt_ticket_watchers where ticket_id = $1', [f.tickets.aOrg.ticketId])).toEqual([{ user_id: f.aUser.userId }]);
  expect(await run(f.aUser.actor, 'delete from hdt_ticket_watchers where user_id = $1', [f.aAdmin.userId])).toBe(0);
  expect(await run(f.aAdmin.actor, 'delete from hdt_ticket_watchers where user_id = $1 and ticket_id = $2', [f.aAdmin.userId, f.tickets.aOrg.ticketId])).toBe(1);
});

test('вложение: клиент создаёт только своё неприкреплённое непроверенное и не меняет состояние проверки', async () => {
  const f = await seedTwoOrgs();
  const insert = (actor: Actor, values: string) =>
    run(actor, `insert into hdt_attachments (org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status) values ${values}`);
  expect(await insert(f.aUser.actor, `('${f.orgA.orgId}', null, '${f.aUser.userId}', 'quarantine/x', 'a.png', 'image/png', 10, 'pending')`)).toBe(1);
  await expect(insert(f.aUser.actor, `('${f.orgA.orgId}', null, '${f.aUser.userId}', 'quarantine/y', 'a.png', 'image/png', 10, 'clean')`)).rejects.toThrow(/row-level security/);
  await expect(insert(f.aUser.actor, `('${f.orgA.orgId}', null, '${f.aAdmin.userId}', 'quarantine/z', 'a.png', 'image/png', 10, 'pending')`)).rejects.toThrow(/row-level security/);
  // Чужое неприкреплённое не видно; своё нельзя объявить чистым.
  expect(await rows(f.aAdmin.actor, `select 1 from hdt_attachments where storage_key = 'quarantine/x'`)).toEqual([]);
  await expect(run(f.aUser.actor, `update hdt_attachments set scan_status = 'clean' where storage_key = 'quarantine/x'`)).rejects.toThrow(/нельзя/);
  // Прикрепить к своему видимому обращению можно, к личному коллеги нельзя.
  await expect(
    run(f.aUser.actor, `update hdt_attachments set ticket_id = $1 where storage_key = 'quarantine/x'`, [f.tickets.aPrivate.ticketId]),
  ).rejects.toThrow(/row-level security/);
  expect(await run(f.aUser.actor, `update hdt_attachments set ticket_id = $1 where storage_key = 'quarantine/x'`, [f.tickets.aOrg.ticketId])).toBe(1);
});

test('удалить вложение может только система и только неприкреплённое старше суток (обход загрузок, решение 0028)', async () => {
  const f = await seedTwoOrgs();
  const insert = (key: string) =>
    pools.root
      .query(
        `insert into hdt_attachments (org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, $3, 'a.png', 'image/png', 10) returning attachment_id`,
        [f.orgA.orgId, f.aUser.userId, key],
      )
      .then((r) => r.rows[0].attachment_id as string);
  const age = async (id: string) => {
    const client = await pools.root.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(`update hdt_attachments set created_on = now() - interval '25 hours' where attachment_id = $1`, [id]);
      await client.query('commit');
    } finally {
      client.release();
    }
  };
  const old = await insert('quarantine/old');
  const fresh = await insert('quarantine/fresh');
  await age(old);
  const attached = (await pools.root.query(`select attachment_id from hdt_attachments where ticket_id = $1 limit 1`, [f.tickets.aOrg.ticketId])).rows[0]
    .attachment_id as string;
  await age(attached);
  const remove = (actor: Actor, id: string) => run(actor, 'delete from hdt_attachments where attachment_id = $1', [id]);
  // Клиент и сотрудник не удаляют ничего, даже старую неприкреплённую загрузку самого клиента.
  for (const actor of [f.aUser.actor, f.aAdmin.actor, f.l1.actor]) expect(await remove(actor, old)).toBe(0);
  const systemActor = { type: 'system', job: 'attachment.sweep' } as const;
  expect(await remove(systemActor, fresh)).toBe(0);
  expect(await remove(systemActor, attached)).toBe(0);
  expect(await remove(systemActor, old)).toBe(1);
});
