import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { AGENT_READ_TOOLS } from '@/modules/hda/pref';
import { getAssistantMetrics } from '@/modules/hdt/api/metrics';
import { createMcpClient } from '../helpers/mcp-client';
import { rootWithoutTriggers, seedAgentToken } from './helpers/agent';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedEverything } from './isolation/seed-everything';

// Инструменты чтения сервера MCP (веха M8b, задача 5; FR-AGT-03, 06, 14, 15; строка 15.2 "Сервер MCP отдаёт обращение
// агенту" и строка приёмки M8b; план M8b, решения 6-9, 17; решение 0114). Вызовы идут тестовым клиентом MCP через
// обработчик маршрута, как у настоящего агента.

beforeEach(() => setLogSinkForTests(() => undefined));
afterEach(() => setLogSinkForTests(null));

type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function setup() {
  const f = await seedEverything();
  // Инструмент signature_spikes появляется вместе с таблицей всплесков (задача 8).
  const tools = AGENT_READ_TOOLS.filter((tool) => tool !== 'signature_spikes');
  const token = await seedAgentToken({ tools });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool(name, args)) as Result;
  const data = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name}: ${result.content[0]!.text}`);
    expect(result.structuredContent!.notice, name).toMatch(/untrusted_/);
    return result.structuredContent as Record<string, unknown> & { items?: Record<string, unknown>[] };
  };
  const errorOf = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    return result.isError ? (JSON.parse(result.content[0]!.text) as { error: string }).error : null;
  };
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  await pools.root.query(`update hdu_organizations set category = 'B', inn = '301234567' where org_id = $1`, [f.orgA.orgId]);
  return { f, token, call, data, errorOf };
}

test('get_ticket: ни имён, ни почты, ни телефонов клиента, ни названия и ИНН организации; текст людей только в untrusted_*', async () => {
  const { f, data } = await setup();
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set title = $2, description = $3 where ticket_id = $1`, [
    t.ticketId,
    'Алишер: ACME Trade не видит отчёт',
    'Звоните +998 90 123 45 67, пишите alisher@acme.uz, ИНН 301234567. Дильноза в курсе, "ACME Trade" ждёт.',
  ]);
  const add = (authorId: string, authorType: string, body: string, internal: boolean) =>
    pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, $4, $5, $6)`, [
      f.orgA.orgId,
      t.ticketId,
      authorId,
      authorType,
      body,
      internal,
    ]);
  await add(f.aUser.userId, 'client', 'Я Алишер из ACME Trade, мой телефон +998901234567', false);
  await add(f.l1.userId, 'staff', 'Здравствуйте, Алишер! На связи Азиз.', false);
  await add(f.care.userId, 'staff', 'Дильноза просила перезвонить на 8 (90) 765-43-21, почта dilnoza@acme.uz', true);

  const out = await data('get_ticket', { number: t.number });
  const ticket = out.ticket as Record<string, unknown>;
  const text = JSON.stringify(out);
  for (const secret of ['Алишер', 'Дильноза', 'Азиз', 'ACME', 'acme.uz', '301234567', '123 45 67', '901234567', '765-43-21', f.server.code])
    expect(text, secret).not.toContain(secret);
  expect(ticket).toMatchObject({ number: t.number, org: { id: f.orgA.orgId, category: 'B' }, status: 'new', priority: 'p2' });
  // Тема и описание только в untrusted_customer_text, обезличенными.
  expect(ticket.untrusted_customer_text).toMatchObject({ title: expect.stringContaining('[организация]'), description: expect.stringContaining('[телефон]') });
  expect(Object.keys(ticket)).not.toContain('title');
  expect(Object.keys(ticket)).not.toContain('description');
  const messages = ticket.messages as Record<string, unknown>[];
  const client = messages.filter((m) => m.author === 'client:1');
  expect(client.length).toBeGreaterThan(0);
  for (const m of client) {
    expect(m.untrusted_customer_text).toEqual(expect.any(String));
    expect(m.untrusted_text).toBeUndefined();
  }
  // Внутренняя заметка сотрудника видна обезличенной в untrusted_text (решение 0114).
  const note = messages.find((m) => m.kind === 'internal_note' && String(m.untrusted_text).includes('перезвонить'));
  expect(note).toMatchObject({ author: expect.stringMatching(/^staff:\d$/), untrusted_text: expect.stringContaining('[email]') });
  for (const m of messages) for (const key of Object.keys(m)) expect(['author', 'kind', 'created_on', 'ai_kind', 'solution_number', 'problem_number', 'untrusted_customer_text', 'untrusted_text']).toContain(key);
  // Поля передачи на вторую линию: тексты сотрудников в untrusted_text.
  expect(ticket.transfers).toEqual([expect.objectContaining({ from_line: 'l1', to_line: 'l2', reason_code: 'other', untrusted_text: { checked: 'Проверено', needed: 'Нужно', explanation: null } })]);
});

test('обращение организации с выключенной AI-обработкой: not_found во всех инструментах и нет в списках', async () => {
  const { f, data, errorOf } = await setup();
  const b = f.tickets.bOrg;
  expect(await errorOf('get_ticket', { number: b.number })).toBe('not_found');
  expect(await errorOf('similar_tickets', { number: b.number })).toBe('not_found');
  expect(await errorOf('get_ticket', { number: 999_999 })).toBe('not_found');
  const numbers = (await data('search_tickets', {})).items!.map((item) => item.number);
  expect(numbers).toEqual(expect.arrayContaining([f.tickets.aOrg.number, f.tickets.aPrivate.number]));
  expect(numbers).not.toContain(b.number);
  expect(numbers).not.toContain(f.tickets.bPrivate.number);
  expect((await data('sla_risk_tickets', { hours: 72 })).items!.map((item) => item.number)).not.toContain(b.number);
});

test('search_tickets: фильтры и предел; лишний аргумент и предел больше 50 отклоняются схемой', async () => {
  const { f, data, errorOf } = await setup();
  await pools.root.query(`update hdt_tickets set status = 'in_progress', queue = 'l2', error_signature = $2 where ticket_id = $1`, [f.tickets.aPrivate.ticketId, 'c'.repeat(32)]);
  expect((await data('search_tickets', { status: ['in_progress'] })).items!.map((i) => i.number)).toEqual([f.tickets.aPrivate.number]);
  expect((await data('search_tickets', { queue: 'l2' })).items!.map((i) => i.number)).toEqual([f.tickets.aPrivate.number]);
  expect((await data('search_tickets', { signature: 'c'.repeat(32) })).items!.map((i) => i.number)).toEqual([f.tickets.aPrivate.number]);
  expect((await data('search_tickets', { text: 'Личное обращение пользователя' })).items!.map((i) => i.number)).toEqual([f.tickets.aMine.number]);
  expect((await data('search_tickets', { limit: 1 })).items).toHaveLength(1);
  expect(await errorOf('search_tickets', { limit: 51 })).toBe('invalid_arguments');
  expect(await errorOf('search_tickets', { org_id: f.orgB.orgId })).toBe('invalid_arguments');
  const item = (await data('search_tickets', { limit: 1 })).items![0]!;
  expect(item.org).toEqual({ id: f.orgA.orgId, category: 'B' });
  expect(item.untrusted_customer_text).toEqual({ title: expect.any(String) });
});

test('similar_tickets: у другой организации тема и выдержка не длиннее 300 знаков после обезличивания (FR-AGT-15)', async () => {
  const { f, data } = await setup();
  const signature = 'd'.repeat(32);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = true, ai_consent_on = current_date, ai_consent_ref = 'Тестовое согласие ' || clock_timestamp()::text where org_id = $1`, [f.orgB.orgId]);
  await pools.root.query(`update hdt_tickets set error_signature = $2 where ticket_id = any($1)`, [[f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId], signature]);
  await pools.root.query(`update hdt_tickets set description = $2 where ticket_id = $1`, [f.tickets.bOrg.ticketId, `Тимур из Globex пишет: ${'накладная не проводится. '.repeat(40)}`]);
  const items = (await data('similar_tickets', { number: f.tickets.aOrg.number })).items!;
  const other = items.find((item) => item.number === f.tickets.bOrg.number)!;
  expect(other).toMatchObject({ same_org: false, signature_match: true });
  const excerpt = (other.untrusted_customer_text as { excerpt: string }).excerpt;
  expect(excerpt.length).toBeLessThanOrEqual(301);
  expect(JSON.stringify(other)).not.toMatch(/Тимур|Globex/);
  expect(items.map((item) => item.number)).not.toContain(f.tickets.aOrg.number);
  expect(items.length).toBeLessThanOrEqual(10);
});

test('sla_risk_tickets совпадает с ручным расчётом сроков', async () => {
  const { f, data } = await setup();
  const set = (ticketId: string, values: string) => rootWithoutTriggers(`update hdt_tickets set ${values} where ticket_id = $1`, [ticketId]);
  await set(f.tickets.aOrg.ticketId, `first_response_due_on = now() + interval '1 hour'`);
  await set(f.tickets.aPrivate.ticketId, `first_response_due_on = now() + interval '10 hours', resolution_due_on = now() + interval '20 hours'`);
  await set(f.tickets.aMine.ticketId, `first_responded_on = now() - interval '3 hours', resolution_due_on = now() - interval '1 hour', resolution_breached_on = now() - interval '1 hour'`);
  const items = (await data('sla_risk_tickets', { hours: 4 })).items!;
  expect(items.map((item) => [item.number, item.risk, item.breached])).toEqual([
    [f.tickets.aMine.number, 'resolution', true],
    [f.tickets.aOrg.number, 'first_response', false],
  ]);
  // Решённое обращение в риск не входит.
  await set(f.tickets.aOrg.ticketId, `status = 'resolved', resolved_on = now()`);
  expect((await data('sla_risk_tickets', { hours: 4 })).items!.map((item) => item.number)).toEqual([f.tickets.aMine.number]);
});

test('unsolved_signatures: только сигнатуры без решения, образец обезличен', async () => {
  const { f, data } = await setup();
  const article = (await pools.root.query(`select article_id from hdk_articles limit 1`)).rows[0].article_id;
  await pools.root.query(
    `insert into hdk_error_signatures (signature, sample_code, sample_message, org_count, occurrences, article_id) values
     ($1, 'E-17', 'Ошибка проведения, звоните +998 90 111 22 33', 3, 12, null), ($2, 'E-18', 'Решённая ошибка', 5, 20, $3)`,
    ['e'.repeat(32), 'f'.repeat(32), article],
  );
  await pools.root.query(`insert into hdk_signature_orgs (org_id, signature_id) select $1, signature_id from hdk_error_signatures where signature = $2`, [f.orgA.orgId, 'e'.repeat(32)]);
  const items = (await data('unsolved_signatures', {})).items!;
  const signatures = items.map((item) => item.signature);
  expect(signatures).toContain('e'.repeat(32));
  expect(signatures).not.toContain('f'.repeat(32));
  const unsolved = items.find((item) => item.signature === 'e'.repeat(32))!;
  expect(unsolved).toMatchObject({ org_count: 3, occurrences: 12, sample_code: 'E-17' });
  expect(JSON.stringify(unsolved)).not.toContain('111 22 33');
});

test('search_solutions и get_solution: только опубликованные, черновика и кандидата нет; статистика решения', async () => {
  const { data, errorOf } = await setup();
  const draft = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ('internal', 'ru') returning number`)).rows[0].number;
  const items = (await data('search_solutions', {})).items!;
  expect(items.map((item) => item.audience).sort()).toEqual(['clients', 'internal']);
  expect(items.map((item) => item.number)).not.toContain(Number(draft));
  expect(items[0]).toMatchObject({ stats: { shown: expect.any(Number), helped: expect.any(Number), not_helped: expect.any(Number), staff_useful: expect.any(Number) } });
  const one = await data('get_solution', { number: items[0]!.number });
  expect((one.solution as Record<string, unknown>).untrusted_text).toMatchObject({ title: expect.any(String), body: expect.any(String) });
  expect(await errorOf('get_solution', { number: Number(draft) })).toBe('not_found');
  const candidates = (await data('list_candidates', {})).items!;
  expect(candidates.map((c) => (c.untrusted_text as { title: string }).title)).toEqual(['Кандидат: накладная']);
});

test('list_known_problems без разбивки по организациям; list_ideas без авторов; пределы списков', async () => {
  const { f, data } = await setup();
  const problems = (await data('list_known_problems', {})).items!;
  expect(problems.length).toBeGreaterThan(0);
  for (const p of problems) for (const key of Object.keys(p)) expect(key).not.toMatch(/org_id|orgs|author|owner/);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = true, ai_consent_on = current_date, ai_consent_ref = 'Тестовое согласие ' || clock_timestamp()::text where org_id = $1`, [f.orgB.orgId]);
  const ideas = (await data('list_ideas', {})).items!;
  expect(ideas).toHaveLength(1);
  expect(JSON.stringify(ideas)).not.toMatch(/author|org_id|Тимур|Зарина/);
  expect((await data('list_ideas', { limit: 1 })).items!.length).toBeLessThanOrEqual(1);
});

test('assistant_metrics совпадает с показателями помощника на /agent/metrics за тот же период', async () => {
  const { f, data } = await setup();
  await rootWithoutTriggers(`update hdt_tickets set ai_state = 'resolved_by_ai' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const metrics = await data('assistant_metrics', { from, to });
  const staff = await getAssistantMetrics(staffCtx(f.adminStaff), { period: 'custom', from, to });
  expect(metrics.metrics).toEqual({
    handled: staff.handled,
    resolved_by_ai: staff.resolvedByAi,
    handoffs: staff.handoffs.map((h) => ({ reason: h.reason, count: h.count })),
    first_reply_count: staff.firstReply.count,
    first_reply_median_sec: staff.firstReply.medianSeconds,
    csat_count: staff.csat.count,
    csat_average: staff.csat.average,
    reopened_after_helped: staff.reopenedAfterHelped,
  });
});

test('имена людей вне участников: гость из письма, бывший участник, приглашённый и имя в Telegram не доходят до агента (находка I1)', async () => {
  const { f, data } = await setup();
  const signature = 'a1'.repeat(16);
  const person = async (name: string) =>
    (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ($1, $2, false) returning id`, [name, `i1-${randomUUID()}@users.invalid`])).rows[0].id as string;
  const guest = await person('Шахноза Юсупова');
  const former = await person('Бахтиёр Ахмедов');
  await pools.root.query(`insert into hdu_memberships (org_id, user_id, source, state) values ($1, $2, 'smartup', 'passive')`, [f.orgA.orgId, former]);
  await pools.root.query(
    `insert into hdu_invitations (org_id, email, role, name, token_hash, expires_on) values ($1, 'lola@example.invalid', 'client_user', 'Лола Каримова', repeat('9', 64), now() + interval '1 day')`,
    [f.orgA.orgId],
  );
  await pools.root.query(
    `insert into hdu_contact_identities (user_id, kind, external_id, display_name, verified, verified_on) values ($1, 'telegram', $2, 'Sardorbek', 'linked', now()) on conflict do nothing`,
    [f.aUser.userId, String(Date.now()).slice(-12)],
  );
  await pools.root.query(`update hdu_contact_identities set display_name = 'Sardorbek' where user_id = $1`, [f.aUser.userId]);
  // Письмо гостя, который не участник организации: обращение организации А по домену отправителя.
  const mail = (
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, error_signature)
       values ($1, $2, 'question', 'minor', 'p3', 'org', 'Письмо от Шахноза Юсупова', 'Добрый день! Бахтиёр и Лола Каримова в копии, Sardorbek тоже. С уважением, Шахноза Юсупова', 'ru', 'email', $3)
       returning ticket_id, number`,
      [f.orgA.orgId, guest, signature],
    )
  ).rows[0] as { ticket_id: string; number: number };
  await pools.root.query(`update hdt_tickets set error_signature = $2 where ticket_id = $1`, [f.tickets.aOrg.ticketId, signature]);
  const add = (authorId: string, authorType: string, body: string, internal: boolean) =>
    pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, $4, $5, $6)`, [
      f.orgA.orgId,
      mail.ticket_id,
      authorId,
      authorType,
      body,
      internal,
    ]);
  await add(guest, 'client', 'Шахноза снова пишет: Юсупова на связи', false);
  await add(f.care.userId, 'staff', 'Звонила Шахноза, просила Бахтиёра перезвонить, Лола Каримова в копии; Sardorbek в чате', true);

  const names = ['Шахноза', 'Юсупов', 'Бахтиёр', 'Ахмедов', 'Лола', 'Каримов', 'Sardorbek'];
  const ticket = JSON.stringify(await data('get_ticket', { number: Number(mail.number) }));
  for (const name of names) expect(ticket, `get_ticket ${name}`).not.toContain(name);
  expect(ticket).toContain('Клиент');
  const similar = await data('similar_tickets', { number: f.tickets.aOrg.number });
  expect(similar.items!.map((item) => item.number)).toContain(Number(mail.number));
  for (const name of names) expect(JSON.stringify(similar), `similar_tickets ${name}`).not.toContain(name);
  const search = JSON.stringify(await data('search_tickets', { signature }));
  for (const name of names) expect(search, `search_tickets ${name}`).not.toContain(name);
});

test('названия проблем, тексты идей и кандидатов обезличены словами своих организаций; проблема только организаций без AI-обработки не выдаётся (находка I2)', async () => {
  const { f, data } = await setup();
  const problem = async (title: string) => (await pools.root.query(`insert into hdp_problems (internal_title) values ($1) returning problem_id, number`, [title])).rows[0] as { problem_id: string; number: number };
  const visible = await problem('ACME Trade: Азиз и Алишер разбирают сбой');
  const hidden = await problem('Только Globex: сбой у Тимура');
  const empty = await problem('Новая проблема без обращений');
  await rootWithoutTriggers(`update hdt_tickets set known_problem_id = $2 where ticket_id = $1`, [f.tickets.aOrg.ticketId, visible.problem_id]);
  await rootWithoutTriggers(`update hdt_tickets set known_problem_id = $2 where ticket_id = $1`, [f.tickets.bOrg.ticketId, hidden.problem_id]);
  const problems = (await data('list_known_problems', {})).items!;
  const numbers = problems.map((p) => p.number);
  expect(numbers).toEqual(expect.arrayContaining([Number(visible.number), Number(empty.number)]));
  expect(numbers).not.toContain(Number(hidden.number));
  const title = (problems.find((p) => p.number === Number(visible.number))!.untrusted_text as { internal_title: string }).internal_title;
  for (const word of ['ACME', 'Азиз', 'Алишер']) expect(title, word).not.toContain(word);
  expect(title).toContain('[организация]');

  await pools.root.query(`update hda_solution_candidates set title = 'Кандидат: накладная ACME Trade', problem = 'Алишер и Дильноза не видят накладную, помог Азиз'`);
  const candidates = JSON.stringify((await data('list_candidates', {})).items);
  for (const word of ['ACME', 'Алишер', 'Дильноза', 'Азиз']) expect(candidates, word).not.toContain(word);

  await pools.root.query(`update hdu_organizations set is_ai_enabled = true, ai_consent_on = current_date, ai_consent_ref = 'Тестовое согласие ' || clock_timestamp()::text where org_id = $1`, [f.orgB.orgId]);
  await pools.root.query(
    `update hdi_idea_translations set title = 'Идея Globex от Тимура', body = 'Зарина из Globex просит отчёт, Камила обещала' where idea_id in (select idea_id from hdi_ideas where status = 'open')`,
  );
  const ideas = JSON.stringify((await data('list_ideas', {})).items);
  for (const word of ['Globex', 'Тимур', 'Зарина', 'Камила']) expect(ideas, word).not.toContain(word);
  expect(ideas).not.toContain('org_id');
});

test('search_tickets ищет текст в обезличенной теме: имя человека не находится, остальные слова находятся (долг M8b M7)', async () => {
  const { f, data } = await setup();
  await pools.root.query(`update hdt_tickets set title = 'Алишер не может провести накладную' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  // По числу совпадений агент не узнаёт, встречается ли имя в обращениях.
  expect((await data('search_tickets', { text: 'Алишер' })).items).toEqual([]);
  expect((await data('search_tickets', { text: 'алишер' })).items).toEqual([]);
  const found = (await data('search_tickets', { text: 'провести накладную' })).items!;
  expect(found.map((i) => i.number)).toEqual([f.tickets.aOrg.number]);
  expect(JSON.stringify(found)).not.toContain('Алишер');
  // Текст ищется без учёта регистра и вместе с другими фильтрами и пределом.
  expect((await data('search_tickets', { text: 'НАКЛАДНУЮ', limit: 1 })).items!.map((i) => i.number)).toEqual([f.tickets.aOrg.number]);
});
