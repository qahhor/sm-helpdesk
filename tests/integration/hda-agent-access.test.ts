import { expect, test } from 'vitest';
import { rootWithoutTriggers, seedAgentBot, seedAgentToken } from './helpers/agent';
import { asActor, pools } from './helpers/db';
import { seedEverything } from './isolation/seed-everything';
import { DOMAIN_OBJECTS } from './isolation/tables';

// Таблицы токенов, журнала вызовов и сводок и актор agent (веха M8b, задача 1; ТЗ 10.4, 10.5; план M8b, решения 5,
// 10, 14, 15, 23). Запросы идут напрямую под hub_app с переменными актора: проверяется сама политика.

const rows = async (actor: Parameters<typeof asActor>[1], query: string, params: unknown[] = []) =>
  asActor(pools.app, actor, (c) => c.query(query, params)).then(
    (r) => r.rows,
    (error) => {
      expect(String(error)).toMatch(/permission denied/);
      return [];
    },
  );

const fails = (actor: Parameters<typeof asActor>[1], query: string, params: unknown[] = []) =>
  expect(asActor(pools.app, actor, (c) => c.query(query, params))).rejects.toThrow(/row-level security|permission denied|violates check|не меня/);

const ACTIVE = `select app.agent_token_active() as active`;


test('агент с действующим токеном не читает ни одной строки базовых таблиц предметной области', async () => {
  await seedEverything();
  const { actor } = await seedAgentToken();
  // Справочники без данных клиентов (agent: 'reference') и каталог знаний из кода (agent: 'code-catalog', выводы без
  // данных клиентов) агент читает: это проверяет registry.test.ts по таблице CODE_AGENT.
  for (const [name] of Object.entries(DOMAIN_OBJECTS).filter(([n, rule]) => !n.startsWith('hda_agent_') && rule.agent !== 'reference' && rule.agent !== 'code-catalog')) {
    // Представления клиента отдают строки только клиенту; столбец 1, а не *: на секретные столбцы прав нет.
    expect(await rows(actor, `select 1 from ${name}`), name).toEqual([]);
  }
});

test('агент не пишет в базовые таблицы обращений, решений, проблем и идей', async () => {
  const f = await seedEverything();
  const { actor, userId } = await seedAgentToken();
  await fails(actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'agent', 'Заметка', true)`, [
    f.orgA.orgId,
    f.tickets.aOrg.ticketId,
    userId,
  ]);
  await fails(actor, `insert into hdk_articles (audience, original_locale) values ('internal', 'ru')`);
  await fails(actor, `insert into hdp_problems (internal_title) values ('Проблема')`);
  await fails(actor, `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, payload, is_internal) values ($1, $2, 'status_changed', 'agent', '{}', true)`, [
    f.orgA.orgId,
    f.tickets.aOrg.ticketId,
  ]);
  for (const name of ['hdt_tickets', 'hdt_ticket_messages', 'hdk_articles', 'hdp_problems', 'hdi_ideas', 'hda_solution_candidates']) {
    const updated = await asActor(pools.app, actor, (c) => c.query(`update ${name} set created_on = created_on`)).then(
      (r) => r.rowCount,
      () => 0,
    );
    expect(updated, name).toBe(0);
  }
});

test('клиент не читает токены, журнал вызовов и сводки', async () => {
  const f = await seedEverything();
  const token = await seedAgentToken();
  await pools.root.query(`insert into hda_agent_tool_calls (token_id, tool, status) values ($1, 'get_ticket', 'ok')`, [token.tokenId]);
  await pools.root.query(`insert into hda_agent_reports (kind, title, body, token_id) values ('morning', 'Утро', 'Текст', $1)`, [token.tokenId]);
  for (const actor of [f.aUser.actor, f.aAdmin.actor])
    for (const name of ['hda_agent_tokens', 'hda_agent_tool_calls', 'hda_agent_reports']) expect(await rows(actor, `select 1 from ${name}`), name).toEqual([]);
});

test('токены читает и меняет администратор портала и система, другие сотрудники и агент нет', async () => {
  const f = await seedEverything();
  const token = await seedAgentToken();
  const all = (await pools.root.query(`select token_id from hda_agent_tokens order by token_id`)).rows;
  expect(all).toContainEqual({ token_id: token.tokenId });
  expect(await rows(f.adminStaff.actor, `select token_id from hda_agent_tokens order by token_id`)).toEqual(all);
  expect(await rows({ type: 'system', job: 'test' }, `select token_id from hda_agent_tokens order by token_id`)).toEqual(all);
  for (const actor of [f.l1.actor, f.care.actor, token.actor]) expect(await rows(actor, `select token_id from hda_agent_tokens`)).toEqual([]);

  const insert = `insert into hda_agent_tokens (name, staff_user_id, token_hash, token_last4, tools, allowed_ips, expires_at)
                  values ('Hermes: код', $1, repeat('e', 64), 'abcd', '{search_tickets}', '{10.0.3.12/32}', now() + interval '30 days')`;
  await fails(f.l1.actor, insert, [token.userId]);
  await fails(token.actor, insert, [token.userId]);
  await asActor(pools.app, f.adminStaff.actor, (c) => c.query(insert, [token.userId]));

  const revoke = `update hda_agent_tokens set revoked_at = now() where token_id = $1`;
  expect((await asActor(pools.app, f.care.actor, (c) => c.query(revoke, [token.tokenId]))).rowCount).toBe(0);
  expect((await asActor(pools.app, token.actor, (c) => c.query(revoke, [token.tokenId]))).rowCount).toBe(0);
  expect((await asActor(pools.app, f.adminStaff.actor, (c) => c.query(revoke, [token.tokenId]))).rowCount).toBe(1);
  // Отзыв не снимается, хеш и учётная запись токена не меняются.
  await fails(f.adminStaff.actor, `update hda_agent_tokens set revoked_at = null where token_id = $1`, [token.tokenId]);
  await fails(f.adminStaff.actor, `update hda_agent_tokens set token_hash = repeat('d', 64) where token_id = $1`, [token.tokenId]);
  // Отметку последнего вызова ставит система.
  expect(
    (await asActor(pools.app, { type: 'system', job: 'test' }, (c) => c.query(`update hda_agent_tokens set last_used_at = now() where token_id = $1`, [token.tokenId]))).rowCount,
  ).toBe(1);
});

test('журнал вызовов пишет агент только своим токеном и система; читает администратор; строки не меняются', async () => {
  const f = await seedEverything();
  const mine = await seedAgentToken();
  const other = await seedAgentToken({ userId: mine.userId, name: 'Hermes: код' });
  const insert = `insert into hda_agent_tool_calls (token_id, tool, args_digest, object_refs, status, duration_ms) values ($1, 'get_ticket', repeat('a', 64), '[{"ticket": 1}]', 'ok', 12)`;
  await asActor(pools.app, mine.actor, (c) => c.query(insert, [mine.tokenId]));
  await fails(mine.actor, insert, [other.tokenId]);
  await asActor(pools.app, { type: 'system', job: 'test' }, (c) => c.query(insert, [other.tokenId]));
  await fails(f.adminStaff.actor, insert, [mine.tokenId]);
  // Отозванный токен не пишет даже свою строку.
  await pools.root.query(`update hda_agent_tokens set revoked_at = now() where token_id = $1`, [other.tokenId]);
  await fails(other.actor, insert, [other.tokenId]);

  expect(await rows(f.adminStaff.actor, `select token_id from hda_agent_tool_calls where token_id in ($1, $2) order by token_id`, [mine.tokenId, other.tokenId])).toHaveLength(2);
  expect((await rows(f.adminStaff.actor, `select 1 from hda_agent_tool_calls`)).length).toBe((await pools.root.query(`select 1 from hda_agent_tool_calls`)).rowCount);
  for (const actor of [mine.actor, f.l1.actor, f.care.actor]) expect(await rows(actor, `select 1 from hda_agent_tool_calls`)).toEqual([]);
  // Изменить строку нельзя никому; свежую строку не удаляет даже система.
  await fails(f.adminStaff.actor, `update hda_agent_tool_calls set status = 'error'`);
  await fails({ type: 'system', job: 'test' }, `update hda_agent_tool_calls set status = 'error'`);
  expect((await asActor(pools.app, { type: 'system', job: 'test' }, (c) => c.query(`delete from hda_agent_tool_calls`))).rowCount).toBe(0);
  await rootWithoutTriggers(`update hda_agent_tool_calls set created_on = now() - interval '366 days' where token_id = $1`, [mine.tokenId]);
  expect((await pools.root.query(`select 1 from hda_agent_tool_calls where token_id = $1`, [mine.tokenId])).rowCount).toBe(1);
  expect((await asActor(pools.app, f.adminStaff.actor, (c) => c.query(`delete from hda_agent_tool_calls`).then((r) => r.rowCount, () => 0)))).toBe(0);
  expect((await asActor(pools.app, { type: 'system', job: 'test' }, (c) => c.query(`delete from hda_agent_tool_calls`))).rowCount).toBe(1);
});

test('сводки пишет агент основным токеном, читают сотрудники, отметку "просмотрено" ставит сотрудник', async () => {
  const f = await seedEverything();
  const main = await seedAgentToken();
  const run = await seedAgentToken({ userId: main.userId, parentTokenId: main.tokenId, ticketId: f.tickets.aOrg.ticketId });
  // Без returning: строку после записи агент не читает (политики чтения у него нет).
  const insert = `insert into hda_agent_reports (kind, title, body, period_from, period_to, chat_fields, token_id) values ('morning', 'Утро', 'Текст', now() - interval '1 day', now(), '{"new_tickets": 3}', $1)`;
  await asActor(pools.app, main.actor, (c) => c.query(insert, [main.tokenId]));
  const reportId = (await pools.root.query(`select report_id from hda_agent_reports where token_id = $1`, [main.tokenId])).rows[0].report_id as string;
  await fails(run.actor, insert, [run.tokenId]);
  await fails(main.actor, `insert into hda_agent_reports (kind, title, body, token_id, status) values ('morning', 'Утро', 'Текст', $1, 'reviewed')`, [main.tokenId]);
  await fails(f.l1.actor, insert, [main.tokenId]);

  for (const actor of [f.l1.actor, f.care.actor, f.adminStaff.actor]) expect(await rows(actor, `select report_id from hda_agent_reports where token_id = $1`, [main.tokenId])).toEqual([{ report_id: reportId }]);
  expect(await rows(main.actor, `select 1 from hda_agent_reports`)).toEqual([]);

  // Агент свою сводку не меняет; сотрудник меняет только отметку, и только от своего имени.
  expect((await asActor(pools.app, main.actor, (c) => c.query(`update hda_agent_reports set status = status`))).rowCount).toBe(0);
  await fails(f.l1.actor, `update hda_agent_reports set body = 'Подмена' where report_id = $1`, [reportId]);
  await fails(f.l1.actor, `update hda_agent_reports set status = 'reviewed', reviewed_by = $2, reviewed_on = now() where report_id = $1`, [reportId, f.care.userId]);
  await asActor(pools.app, f.l1.actor, (c) =>
    c.query(`update hda_agent_reports set status = 'reviewed', reviewed_by = $2, reviewed_on = now() where report_id = $1`, [reportId, f.l1.userId]),
  );
  const row = (await pools.root.query(`select status, reviewed_by, created_by from hda_agent_reports where report_id = $1`, [reportId])).rows[0];
  expect(row).toEqual({ status: 'reviewed', reviewed_by: f.l1.userId, created_by: main.userId });
});

test('токен действует, пока не отозван, не истёк, учётная запись активна и родитель токена запуска действует', async () => {
  const f = await seedEverything();
  const main = await seedAgentToken();
  const run = await seedAgentToken({ userId: main.userId, parentTokenId: main.tokenId, ticketId: f.tickets.aOrg.ticketId });
  const active = async (actor: Parameters<typeof asActor>[1]) => (await asActor(pools.app, actor, (c) => c.query(ACTIVE))).rows[0].active as boolean;
  expect(await active(main.actor)).toBe(true);
  expect(await active(run.actor)).toBe(true);
  // Подмена учётной записи, токена или обращения в переменных не даёт действующего токена.
  expect(await active({ ...main.actor, userId: f.l1.userId })).toBe(false);
  expect(await active({ ...run.actor, ticketId: null })).toBe(false);
  expect(await active({ ...main.actor, ticketId: f.tickets.aOrg.ticketId })).toBe(false);
  // Не агент: ложно, даже если переменная токена задана.
  expect(await active(f.adminStaff.actor)).toBe(false);

  const expired = await seedAgentToken({ userId: main.userId, expiresIn: '-1 minute' });
  expect(await active(expired.actor)).toBe(false);
  const revoked = await seedAgentToken({ userId: main.userId, revoked: true });
  expect(await active(revoked.actor)).toBe(false);

  await pools.root.query(`update hda_agent_tokens set revoked_at = now() where token_id = $1`, [main.tokenId]);
  expect(await active(run.actor)).toBe(false);

  const blocked = await seedAgentToken();
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [blocked.userId]);
  expect(await active(blocked.actor)).toBe(false);
});

test('проверки базы: пустой перечень, неизвестный инструмент, нет адресов, срок больше 365 суток, токен запуска сверх перечня', async () => {
  const f = await seedEverything();
  const userId = await seedAgentBot();
  const insert = (tools: string, ips: string, expires: string, extra = '', extraValues = '') =>
    asActor(pools.app, f.adminStaff.actor, (c) =>
      c.query(
        `insert into hda_agent_tokens (name, staff_user_id, token_hash, token_last4, tools, allowed_ips, expires_at${extra})
         values ('Hermes', $1, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'abcd', $2::text[], $3::cidr[], now() + $4::interval${extraValues})`,
        [userId, tools, ips, expires],
      ),
    );
  await insert('{search_tickets}', '{10.0.3.12/32}', '30 days');
  await expect(insert('{}', '{10.0.3.12/32}', '30 days')).rejects.toThrow(/hda_agent_tokens_c/);
  await expect(insert('{drop_everything}', '{10.0.3.12/32}', '30 days')).rejects.toThrow(/hda_agent_tokens_c/);
  await expect(insert('{reply_to_client}', '{10.0.3.12/32}', '30 days')).rejects.toThrow(/hda_agent_tokens_c/);
  await expect(insert('{search_tickets}', '{}', '30 days')).rejects.toThrow(/hda_agent_tokens_c/);
  await expect(insert('{search_tickets}', '{10.0.3.12/32}', '366 days')).rejects.toThrow(/365/);
  // Продлить срок дальше 365 суток от сегодняшнего дня тоже нельзя.
  const token = await seedAgentToken({ userId });
  await expect(
    asActor(pools.app, f.adminStaff.actor, (c) => c.query(`update hda_agent_tokens set expires_at = now() + interval '400 days' where token_id = $1`, [token.tokenId])),
  ).rejects.toThrow(/365/);
  // Токен запуска: только чтение обращения и заметка, с обращением и пределом заметок.
  await expect(seedAgentToken({ userId, parentTokenId: token.tokenId, ticketId: f.tickets.aOrg.ticketId, tools: ['get_ticket', 'create_report'] })).rejects.toThrow(/hda_agent_tokens_c/);
  await expect(seedAgentToken({ userId, parentTokenId: token.tokenId })).rejects.toThrow(/hda_agent_tokens_c/);
  // Учётная запись токена: только agent_bot.
  await expect(seedAgentToken({ userId: f.l1.userId })).rejects.toThrow(/agent_bot/);
});

test('токен "для событий" один среди неотозванных', async () => {
  const main = await seedAgentToken({ isEventParent: true });
  await expect(seedAgentToken({ userId: main.userId, isEventParent: true })).rejects.toThrow(/hda_agent_tokens_u2/);
  await pools.root.query(`update hda_agent_tokens set revoked_at = now() where token_id = $1`, [main.tokenId]);
  await seedAgentToken({ userId: main.userId, isEventParent: true });
});
