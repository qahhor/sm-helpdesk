import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import {
  agentToolCalls,
  issueAgentToken,
  listAgentTokens,
  readAgentToken,
  readTeamChat,
  revokeAgentToken,
  saveTeamChat,
  setEventParent,
  updateAgentToken,
} from '@/modules/hda/api/agent-admin';
import { ensureAgentBot } from '@/modules/hdu/api/agent-bots';
import { listAssignableStaff, listStaffDirectory } from '@/modules/hdu/api/staff-lookup';
import { listStaff } from '@/modules/hdu/api/staff-manage';
import { seedAgentToken } from './helpers/agent';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Учётные записи AI-сотрудников и токены (веха M8b, задача 3; FR-AGT-02, 09, FR-ADM-13, экран 8.12 "AI-сотрудники";
// план M8b, решения 10, 16, 27, 28, 29). Выпуск, правка, отзыв и отметка "для событий" делает администратор портала со
// свежим входом, каждое действие с записью журнала аудита в той же транзакции. Значение токена показывается один раз.

let f: Fixture;
let admin: ReturnType<typeof staffCtx>;
const events: { event: string; fields: unknown }[] = [];

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
  events.length = 0;
  setLogSinkForTests((_level, event, fields) => void events.push({ event, fields }));
});
afterEach(() => setLogSinkForTests(null));

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const input = (over: Record<string, unknown> = {}) => ({
  name: 'Hermes: поддержка',
  tools: ['search_tickets', 'get_ticket', 'add_internal_note'],
  allowedIps: ['10.0.3.12', '2001:db8:1:2::/64'],
  expiresAt: inDays(90),
  dailyLimit: 2000,
  ...over,
});
const audit = async (action: string) =>
  (await pools.root.query(`select object_id, diff, actor_id, created_on from hdc_audit_log where action = $1 order by created_on`, [action])).rows;
const tokenRow = async (tokenId: string) => (await pools.root.query(`select * from hda_agent_tokens where token_id = $1`, [tokenId])).rows[0];

test('выпуск: значение возвращается один раз, в базе только хеш и последние 4 знака, нет в журналах', async () => {
  const issued = await issueAgentToken(admin, input());
  expect(issued.value).toMatch(/^hub_at_[A-Za-z0-9_-]{43}$/);
  const row = await tokenRow(issued.tokenId);
  expect(row.token_last4).toBe(issued.value.slice(-4));
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.tools).toEqual(['search_tickets', 'get_ticket', 'add_internal_note']);
  expect(row.allowed_ips).toEqual(['10.0.3.12/32', '2001:db8:1:2::/64']);
  expect(row.daily_limit).toBe(2000);
  // Значения нет ни в одной колонке ни одной таблицы токенов и журналов, ни в журнале работы.
  const dump = JSON.stringify([
    (await pools.root.query(`select * from hda_agent_tokens`)).rows,
    (await pools.root.query(`select * from hdc_audit_log`)).rows,
    events,
  ]);
  expect(dump).not.toContain(issued.value);
  expect(dump).not.toContain(issued.value.slice(7));
  // Запись журнала в той же транзакции: время транзакции у строки токена и у записи одно.
  const [entry] = await audit('agent.token_issued');
  expect(entry.object_id).toBe(issued.tokenId);
  expect(entry.actor_id).toBe(f.adminStaff.userId);
  expect(new Date(entry.created_on).getTime()).toBe(new Date(row.created_on).getTime());
  expect(entry.diff).toMatchObject({ name: 'Hermes: поддержка', tools: ['search_tickets', 'get_ticket', 'add_internal_note'], dailyLimit: 2000 });
  // Список значения не отдаёт.
  const list = await listAgentTokens(admin);
  expect(JSON.stringify(list)).not.toContain(issued.value);
  expect(list).toEqual([
    expect.objectContaining({ tokenId: issued.tokenId, name: 'Hermes: поддержка', last4: issued.value.slice(-4), readTools: 2, writeTools: 1, state: 'active', callsToday: 0, dailyLimit: 2000 }),
  ]);
});

test('учётная запись agent_bot создаётся один раз на имя, не видна среди сотрудников и исполнителей, входа у неё нет', async () => {
  const first = await issueAgentToken(admin, input());
  await revokeAgentToken(admin, { tokenId: first.tokenId });
  const again = await issueAgentToken(admin, input());
  const other = await issueAgentToken(admin, input({ name: 'Hermes: код', tools: ['search_tickets'] }));
  const owner = async (id: string) => (await tokenRow(id)).staff_user_id as string;
  expect(await owner(again.tokenId)).toBe(await owner(first.tokenId));
  expect(await owner(other.tokenId)).not.toBe(await owner(first.tokenId));
  const bot = await owner(first.tokenId);
  const user = (await pools.root.query(`select name, email from auth."user" where id = $1`, [bot])).rows[0];
  expect(user.name).toBe('AI-сотрудник: Hermes: поддержка');
  expect(user.email).toMatch(/@users\.invalid$/);
  expect((await pools.root.query(`select role, state from hdu_staff where user_id = $1`, [bot])).rows).toEqual([{ role: 'agent_bot', state: 'active' }]);
  // Ни пароля, ни другого способа входа.
  expect((await pools.root.query(`select 1 from auth.account where "userId" = $1`, [bot])).rows).toEqual([]);
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'staff.created' and object_id = $1`, [bot])).rowCount).toBe(1);
  expect((await ensureAgentBot('Hermes: поддержка')).userId).toBe(bot);

  expect((await listStaff(admin)).map((s) => s.userId)).not.toContain(bot);
  expect((await listAssignableStaff(admin)).map((s) => s.userId)).not.toContain(bot);
  expect((await listStaffDirectory(admin)).map((s) => s.userId)).not.toContain(bot);
});

test('правка, отзыв и отметка "для событий" пишут журнал аудита той же транзакцией', async () => {
  const issued = await issueAgentToken(admin, input());
  await updateAgentToken(admin, { tokenId: issued.tokenId, tools: ['search_tickets', 'create_report'], allowedIps: ['10.0.3.0/24'], dailyLimit: 500, expiresAt: inDays(30) });
  const changed = await tokenRow(issued.tokenId);
  expect(changed.tools).toEqual(['search_tickets', 'create_report']);
  expect(changed.allowed_ips).toEqual(['10.0.3.0/24']);
  expect(changed.daily_limit).toBe(500);
  const [change] = await audit('agent.token_changed');
  expect(change.object_id).toBe(issued.tokenId);
  expect(change.diff).toMatchObject({ tools: ['search_tickets', 'create_report'], allowedIps: ['10.0.3.0/24'], dailyLimit: 500 });
  expect(new Date(change.created_on).getTime()).toBe(new Date(changed.modified_on).getTime());

  await setEventParent(admin, { tokenId: issued.tokenId });
  expect((await tokenRow(issued.tokenId)).is_event_parent).toBe(true);
  const second = await issueAgentToken(admin, input({ name: 'Hermes: код' }));
  await setEventParent(admin, { tokenId: second.tokenId });
  expect((await tokenRow(issued.tokenId)).is_event_parent).toBe(false);
  expect((await tokenRow(second.tokenId)).is_event_parent).toBe(true);
  await setEventParent(admin, { tokenId: null });
  expect((await tokenRow(second.tokenId)).is_event_parent).toBe(false);
  expect((await audit('agent.event_parent_set')).map((r) => r.object_id)).toEqual([issued.tokenId, second.tokenId, null]);
});

test('отзыв ставит revoked_at, отзывает токены запуска и снимает отметку "для событий"; отозванный не меняется', async () => {
  const issued = await issueAgentToken(admin, input());
  await setEventParent(admin, { tokenId: issued.tokenId });
  const userId = (await tokenRow(issued.tokenId)).staff_user_id as string;
  const run = await seedAgentToken({ userId, parentTokenId: issued.tokenId, ticketId: f.tickets.aOrg.ticketId });
  await revokeAgentToken(admin, { tokenId: issued.tokenId });
  const row = await tokenRow(issued.tokenId);
  expect(row.revoked_at).not.toBeNull();
  expect(row.is_event_parent).toBe(false);
  expect((await tokenRow(run.tokenId)).revoked_at).not.toBeNull();
  const [entry] = await audit('agent.token_revoked');
  expect(entry).toMatchObject({ object_id: issued.tokenId, diff: { name: 'Hermes: поддержка', runRevoked: 1 } });
  expect(new Date(entry.created_on).getTime()).toBe(new Date(row.revoked_at).getTime());
  expect((await listAgentTokens(admin))[0]).toMatchObject({ state: 'revoked' });
  await expect(updateAgentToken(admin, { tokenId: issued.tokenId, tools: ['search_tickets'], allowedIps: ['10.0.3.12'], dailyLimit: 10, expiresAt: inDays(5) })).rejects.toMatchObject({ code: 'not_found' });
  await expect(setEventParent(admin, { tokenId: issued.tokenId })).rejects.toMatchObject({ code: 'not_found' });
  // Повторный отзыв ничего не меняет и не пишет второй записи.
  await revokeAgentToken(admin, { tokenId: issued.tokenId });
  expect(await audit('agent.token_revoked')).toHaveLength(1);
});

test('не admin получает forbidden, admin без свежего входа stale_session', async () => {
  const issued = await issueAgentToken(admin, input());
  const care = staffCtx(f.care);
  const stale = { ...admin, freshAuthAt: new Date(Date.now() - 3_600_000) };
  for (const ctx of [care, staffCtx(f.l1)]) {
    await expect(issueAgentToken(ctx, input())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(revokeAgentToken(ctx, { tokenId: issued.tokenId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listAgentTokens(ctx)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(agentToolCalls(ctx, { tokenId: issued.tokenId })).rejects.toMatchObject({ code: 'forbidden' });
  }
  await expect(issueAgentToken(stale, input())).rejects.toMatchObject({ code: 'stale_session' });
  await expect(updateAgentToken(stale, { tokenId: issued.tokenId, tools: ['search_tickets'], allowedIps: ['10.0.3.12'], dailyLimit: 10, expiresAt: inDays(5) })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(revokeAgentToken(stale, { tokenId: issued.tokenId })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(setEventParent(stale, { tokenId: issued.tokenId })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(saveTeamChat(stale, { chatId: '-1001234567890' })).rejects.toMatchObject({ code: 'stale_session' });
  // Чтение не требует свежего входа.
  expect(await listAgentTokens(stale)).toHaveLength(1);
});

test('схема отклоняет срок больше 365 суток, прошедший срок, пустые и неверные адреса, неизвестный инструмент', async () => {
  for (const bad of [
    { expiresAt: inDays(366) },
    { expiresAt: inDays(-1) },
    { allowedIps: [] },
    { allowedIps: ['example.com'] },
    { allowedIps: ['10.0.3.12/33'] },
    { tools: [] },
    { tools: ['reply_to_client'] },
    { tools: ['search_tickets', 'code_catalog_upsert'] },
    { dailyLimit: 0 },
    { dailyLimit: 10_001 },
    { name: '' },
    { name: 'x'.repeat(81) },
  ])
    await expect(issueAgentToken(admin, input(bad)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(issueAgentToken(admin, { ...input(), extra: true })).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await pools.root.query(`select 1 from hda_agent_tokens`)).rowCount).toBe(0);
  // Срок ровно 365 суток принимается.
  await issueAgentToken(admin, input({ expiresAt: inDays(365) }));
});

test('журнал вызовов токена страницами по 50 вместе с его токенами запуска, без аргументов; счёт вызовов за сутки', async () => {
  const issued = await issueAgentToken(admin, input());
  const userId = (await tokenRow(issued.tokenId)).staff_user_id as string;
  const run = await seedAgentToken({ userId, parentTokenId: issued.tokenId, ticketId: f.tickets.aOrg.ticketId });
  await pools.root.query(
    `insert into hda_agent_tool_calls (token_id, tool, args_digest, object_refs, status, duration_ms)
     select $1, 'search_tickets', repeat('a', 64), '[{"kind": "ticket", "ref": 7}]', 'ok', g from generate_series(1, 54) g`,
    [issued.tokenId],
  );
  await pools.root.query(`insert into hda_agent_tool_calls (token_id, tool, status) values ($1, 'get_ticket', 'refused')`, [run.tokenId]);
  const first = await agentToolCalls(admin, { tokenId: issued.tokenId });
  expect(first.items).toHaveLength(50);
  expect(first.items[0]).toMatchObject({ tool: 'get_ticket', status: 'refused', isRun: true });
  expect(Object.keys(first.items[0]!).sort()).toEqual(['callId', 'createdOn', 'durationMs', 'isRun', 'objectRefs', 'status', 'tool']);
  const second = await agentToolCalls(admin, { tokenId: issued.tokenId, cursor: first.nextCursor });
  expect(second.items).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(second.items.at(-1)).toMatchObject({ objectRefs: [{ kind: 'ticket', ref: 7 }] });
  expect((await listAgentTokens(admin))[0]).toMatchObject({ callsToday: 55 });
  expect((await readAgentToken(admin, issued.tokenId))?.tokenId).toBe(issued.tokenId);
  expect(await readAgentToken(admin, run.tokenId)).toBeNull();
  expect(await readAgentToken(admin, 'не идентификатор')).toBeNull();
  await expect(agentToolCalls(admin, { tokenId: issued.tokenId, cursor: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('чат команды: настройка agent.team_chat_id, пустое значение убирает её, неверное отклоняется', async () => {
  expect(await readTeamChat(admin)).toBeNull();
  await saveTeamChat(admin, { chatId: ' -1001234567890 ' });
  expect(await readTeamChat(admin)).toBe('-1001234567890');
  expect((await audit('settings.changed')).at(-1)).toMatchObject({ object_id: 'agent.team_chat_id' });
  await saveTeamChat(admin, { chatId: '' });
  expect(await readTeamChat(admin)).toBeNull();
  await expect(saveTeamChat(admin, { chatId: 'чат команды' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveTeamChat(staffCtx(f.care), { chatId: '-1001234567890' })).rejects.toMatchObject({ code: 'forbidden' });
});

test('"вызовов за сутки" считает только вызовы самого токена и его токенов запуска, не чужие', async () => {
  const one = await issueAgentToken(admin, input());
  const two = await issueAgentToken(admin, input({ name: 'Hermes: код' }));
  await pools.root.query(`insert into hda_agent_tool_calls (token_id, tool, status) select $1, 'get_ticket', 'ok' from generate_series(1, 3)`, [one.tokenId]);
  const list = await listAgentTokens(admin);
  expect(list.find((t) => t.tokenId === one.tokenId)).toMatchObject({ callsToday: 3 });
  expect(list.find((t) => t.tokenId === two.tokenId)).toMatchObject({ callsToday: 0 });
});
