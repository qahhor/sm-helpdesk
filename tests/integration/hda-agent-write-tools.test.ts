import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { getAgentTicket } from '@/modules/hdt/api/agent';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedEverything } from './isolation/seed-everything';

// Инструменты записи сервера MCP (веха M8b, задача 6; FR-AGT-04, 05, 07, 10, 14.3; сценарий 19 раздела 15.3; план
// M8b, решения 18-23). Агент пишет только то, что видят сотрудники: внутреннюю заметку, записку второй линии, черновик
// решения, черновик известной проблемы, сводку. Ни одна запись не меняет обращения, сроков и того, что видит клиент.

beforeEach(() => setLogSinkForTests(() => undefined));
afterEach(() => setLogSinkForTests(null));

type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function setup() {
  const f = await seedEverything();
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]') on conflict (code) do update set value = excluded.value`);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  const token = await seedAgentToken({ tools: ['get_ticket', 'add_internal_note', 'draft_solution', 'draft_known_problem', 'create_report'] });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool(name, args)) as Result;
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name}: ${result.content[0]!.text}`);
    return result.structuredContent!;
  };
  const errorOf = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    return result.isError ? (JSON.parse(result.content[0]!.text) as { error: string }).error : null;
  };
  return { f, token, call, ok, errorOf };
}

/** Всё, что могла бы задеть запись агента: строка обращения, события, исходящие, уведомления, события предметной области, срабатывания правил. */
async function sideEffects(ticketId: string) {
  const q = async (sql: string, params: unknown[] = []) => (await pools.root.query(sql, params)).rows;
  return JSON.stringify({
    ticket: await q(`select * from hdt_tickets where ticket_id = $1`, [ticketId]),
    events: await q(`select count(*)::int as n from hdt_ticket_events`),
    outbox: await q(`select count(*)::int as n from hdn_outbox`),
    notifications: await q(`select count(*)::int as n from hdn_notifications`),
    domain: await q(`select count(*)::int as n from hdc_domain_events`),
    rules: await q(`select count(*)::int as n from hdw_rule_runs`),
    watchers: await q(`select count(*)::int as n from hdt_ticket_watchers`),
  });
}

test('заметка агента видна сотруднику с пометкой, клиенту не видна; обращение, сроки, уведомления и правила не меняются', async () => {
  const { f, token, ok } = await setup();
  const t = f.tickets.aOrg;
  const before = await sideEffects(t.ticketId);
  const out = await ok('add_internal_note', { ticket_number: t.number, kind: 'note', body: 'Похоже на ошибку проведения: проверьте настройку склада.' });
  expect(out).toMatchObject({ notice: expect.any(String), note: { ticket_number: t.number, kind: 'note' } });
  expect(await sideEffects(t.ticketId)).toBe(before);

  const [row] = (await pools.root.query(`select * from hdt_ticket_messages where author_type = 'agent'`)).rows;
  expect(row).toMatchObject({ ticket_id: t.ticketId, is_internal: true, author_id: token.userId, agent_note_kind: 'note', is_auto: false });
  // Клиент своей организации не видит заметку ни в одном запросе (портал, виджет, письмо и Telegram читают эти же строки).
  for (const member of [f.aUser, f.aAdmin]) {
    const seen = (await asActor(pools.app, member.actor, (c) => c.query(`select body from hdt_ticket_messages where ticket_id = $1`, [t.ticketId]))).rows;
    expect(seen.map((r) => r.body)).not.toContain(row.body);
  }
  // Сотрудник видит заметку в ленте с видом автора agent и видом заметки.
  const view = await getAgentTicket(staffCtx(f.l1), t.number);
  expect(view!.timeline.find((e) => e.type === 'message' && e.authorType === 'agent')).toMatchObject({ isInternal: true, agentNoteKind: 'note' });
  // Журнал аудита той же транзакцией с номером обращения.
  const [audit] = (await pools.root.query(`select diff, actor_type, actor_id, created_on from hdc_audit_log where action = 'agent.tool_called'`)).rows;
  expect(audit).toMatchObject({ actor_type: 'agent', actor_id: token.userId, diff: { tool: 'add_internal_note', objects: [{ kind: 'ticket', ref: t.number }] } });
  expect(new Date(audit.created_on).getTime()).toBe(new Date(row.created_on).getTime());
});

test('записка второй линии видна в окне передачи как черновик и не заполняет поля передачи', async () => {
  const { f, ok } = await setup();
  const t = f.tickets.aOrg;
  await ok('add_internal_note', { ticket_number: t.number, kind: 'handoff_memo', body: 'Проверено: настройки склада. Нужно: выгрузка проводок.' });
  const view = await getAgentTicket(staffCtx(f.l1), t.number);
  expect(view!.agentMemo).toMatchObject({ body: 'Проверено: настройки склада. Нужно: выгрузка проводок.' });
  const transfers = (await pools.root.query(`select count(*)::int as n from hdt_ticket_line_transfers where ticket_id = $1`, [t.ticketId])).rows[0].n;
  expect(transfers).toBe(1);
});

test('HTML, скрипт, ссылка вне разрешённых доменов и невидимые знаки вырезаются; длинный текст отклоняется схемой', async () => {
  const { f, ok, errorOf } = await setup();
  const t = f.tickets.aOrg;
  await ok('add_internal_note', {
    ticket_number: t.number,
    kind: 'note',
    body: 'Текст<script>alert(1)</script> <b>жирный</b> https://evil.example/steal и https://docs.smartup.uz/a​‮конец',
  });
  const body = (await pools.root.query(`select body from hdt_ticket_messages where author_type = 'agent'`)).rows[0].body as string;
  expect(body).not.toMatch(/<script|<b>|alert\(1\)|evil\.example|​|‮/);
  expect(body).toContain('жирный');
  expect(body).toContain('https://docs.smartup.uz/a');
  expect(await errorOf('add_internal_note', { ticket_number: t.number, kind: 'note', body: 'x'.repeat(4001) })).toBe('invalid_arguments');
  expect(await errorOf('add_internal_note', { ticket_number: t.number, kind: 'note', body: '<p></p>' })).toBe('invalid_arguments');
});

// Проверка на AI-инъекции (волна 7, S-I4; FR-CODE-12): агент с доступом к коду не переносит исходный код в портал.
test('S-I4: текст, похожий на исходный код, отклоняется во всех инструментах записи и ничего не записывает', async () => {
  const { f, token, errorOf, ok } = await setup();
  const t = f.tickets.aOrg;
  const plsql = 'Причина в процедуре:\nv_total := v_total + r.amount;\nif v_total > 0 then raise_application_error(-20001, x); end if;';
  const query = 'Запрос: select doc_id from trade_documents where status = 1 and filial_id = 5';
  const minified = `Код: ${'a=b;'.repeat(30)}`;
  const longLine = `Строка ${'слово '.repeat(60)}`;
  const count = async () => (await pools.root.query(`select (select count(*) from hdt_ticket_messages where author_type = 'agent')::int + (select count(*) from hdk_articles where is_untrusted)::int + (select count(*) from hdp_problems)::int + (select count(*) from hda_agent_reports)::int as n`)).rows[0].n as number;
  const before = await count();
  for (const code of [plsql, query, minified, longLine]) {
    expect(await errorOf('add_internal_note', { ticket_number: t.number, kind: 'note', body: code }), code).toBe('invalid_arguments');
    expect(await errorOf('draft_solution', { title: 'Заголовок', body: code }), code).toBe('invalid_arguments');
    expect(await errorOf('draft_known_problem', { internal_title: 'Проблема', description: code }), code).toBe('invalid_arguments');
    expect(await errorOf('create_report', { kind: 'morning', title: 'Сводка', body: code }), code).toBe('invalid_arguments');
  }
  expect(await errorOf('draft_solution', { title: 'v_x := 1; begin null; end;', body: 'Текст' })).toBe('invalid_arguments');
  expect(await count()).toBe(before);
  // Обычный текст в несколько строк, с длинной разрешённой ссылкой и точкой с запятой проходит.
  await ok('add_internal_note', {
    ticket_number: t.number,
    kind: 'note',
    body: `Клиент выбрал закрытый период; документ не проводится.\nПроверить: настройки периода; права роли.\nСправка: https://docs.smartup.uz/${'a'.repeat(120)}\n${Array.from({ length: 14 }, (_, i) => `Шаг ${i + 1}: проверить настройку`).join('\n')}`,
  });
  expect(token.value).toBeTruthy();
});

test('обращение вне видимости агента: not_found, ничего не записано', async () => {
  const { f, token, errorOf } = await setup();
  expect(await errorOf('add_internal_note', { ticket_number: f.tickets.bOrg.number, kind: 'note', body: 'Заметка' })).toBe('not_found');
  expect((await pools.root.query(`select 1 from hdt_ticket_messages where author_type = 'agent'`)).rowCount).toBe(0);
  // Напрямую под hub_app с переменными агента: заметка в обращение без AI-обработки, публичная заметка и сообщение от
  // имени клиента отклоняются политикой; сотрудник не пишет от имени агента.
  const insert = (actor: Parameters<typeof asActor>[1], orgId: string, ticketId: string, authorType: string, internal: boolean, authorId: string) =>
    asActor(pools.app, actor, (c) =>
      c.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, agent_note_kind) values ($1, $2, $3, $4, 'x', $5, $6)`, [
        orgId,
        ticketId,
        authorId,
        authorType,
        internal,
        authorType === 'agent' ? 'note' : null,
      ]),
    );
  await expect(insert(token.actor, f.orgB.orgId, f.tickets.bOrg.ticketId, 'agent', true, token.userId)).rejects.toThrow();
  await expect(insert(token.actor, f.orgA.orgId, f.tickets.aOrg.ticketId, 'agent', false, token.userId)).rejects.toThrow();
  await expect(insert(token.actor, f.orgA.orgId, f.tickets.aOrg.ticketId, 'client', false, f.aUser.userId)).rejects.toThrow();
  await expect(insert(f.l1.actor, f.orgA.orgId, f.tickets.aOrg.ticketId, 'agent', true, token.userId)).rejects.toThrow();
});

test('черновик решения агента: internal, недоверенный, черновик, источники только видимые агенту, не в поиске и подсказке', async () => {
  const { f, ok, errorOf } = await setup();
  const out = await ok('draft_solution', {
    title: 'Накладная не проводится',
    body: 'Шаг 1. Откройте настройки склада.\nШаг 2. Включите проведение.',
    module: 'orders',
    source_ticket_numbers: [f.tickets.aOrg.number],
  });
  const number = (out.draft as { number: number }).number;
  const [article] = (await pools.root.query(`select * from hdk_articles where number = $1`, [number])).rows;
  expect(article).toMatchObject({ audience: 'internal', is_untrusted: true, is_agent_draft: true, status: 'active' });
  const versions = (await pools.root.query(`select state, title from hdk_article_versions where article_id = $1`, [article.article_id])).rows;
  expect(versions).toEqual([{ state: 'draft', title: 'Накладная не проводится' }]);
  expect((await pools.root.query(`select ticket_id from hdk_article_sources where article_id = $1`, [article.article_id])).rows).toEqual([{ ticket_id: f.tickets.aOrg.ticketId }]);
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1`, [article.article_id])).rowCount).toBe(0);
  // Обращение другой организации без AI-обработки источником не берётся.
  expect(await errorOf('draft_solution', { title: 'Ещё', body: 'Текст', source_ticket_numbers: [f.tickets.bOrg.number] })).toBe('not_found');
  // Предложение правки опубликованного решения: новый черновик со ссылкой, чужая статья не меняется.
  const published = (await pools.root.query(`select a.number, a.article_id, a.modified_on from hdk_articles a join hdk_published p using (article_id) limit 1`)).rows[0];
  const revision = await ok('draft_solution', { title: 'Правка', body: 'Новый шаг', revises_solution_number: Number(published.number) });
  const revised = (await pools.root.query(`select revises_article_id from hdk_articles where number = $1`, [(revision.draft as { number: number }).number])).rows[0];
  expect(revised.revises_article_id).toBe(published.article_id);
  expect((await pools.root.query(`select modified_on from hdk_articles where article_id = $1`, [published.article_id])).rows[0].modified_on).toEqual(published.modified_on);
});

test('черновик проблемы не меняет ни одного обращения: сигнатура неактивна, привязки предложены, клиент не видит', async () => {
  const { f, ok, errorOf } = await setup();
  const signature = 'a'.repeat(32);
  const before = await sideEffects(f.tickets.aOrg.ticketId);
  const out = await ok('draft_known_problem', {
    internal_title: 'Накладные не проводятся у нескольких организаций',
    description: 'Ошибка E-17 при проведении.',
    signature,
    proposed_ticket_numbers: [f.tickets.aOrg.number, f.tickets.aMine.number],
  });
  const number = (out.draft as { number: number }).number;
  expect(await sideEffects(f.tickets.aOrg.ticketId)).toBe(before);
  const [problem] = (await pools.root.query(`select * from hdp_problems where number = $1`, [number])).rows;
  expect(problem).toMatchObject({ status: 'draft', show_to_clients: false, ticket_count: 0, internal_description: 'Ошибка E-17 при проведении.' });
  expect((await pools.root.query(`select is_active from hdp_problem_signatures where problem_id = $1`, [problem.problem_id])).rows).toEqual([{ is_active: false }]);
  expect((await pools.root.query(`select count(*)::int as n from hdp_problem_proposals where problem_id = $1`, [problem.problem_id])).rows[0].n).toBe(2);
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where known_problem_id = $1`, [problem.problem_id])).rows[0].n).toBe(0);
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hdp_problems_public where problem_id = $1`, [problem.problem_id]))).rowCount).toBe(0);
  expect(await errorOf('draft_known_problem', { internal_title: 'X', description: '', signature, proposed_ticket_numbers: [f.tickets.bOrg.number] })).toBe('not_found');
});

test('сводку пишет основной токен; токен запуска получает tool_not_allowed; запись с журналом аудита', async () => {
  const { f, token, ok } = await setup();
  const out = await ok('create_report', { kind: 'morning', title: 'Утро 27.11', body: 'Новых обращений: 12.' });
  const [report] = (await pools.root.query(`select * from hda_agent_reports where token_id = $1`, [token.tokenId])).rows;
  expect(report).toMatchObject({ kind: 'morning', title: 'Утро 27.11', status: 'unverified', token_id: token.tokenId, report_id: (out.report as { id: string }).id });
  const run = await seedAgentToken({ userId: token.userId, parentTokenId: token.tokenId, ticketId: f.tickets.aOrg.ticketId });
  const runner = createMcpClient({ token: run.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const refused = (await runner.callTool('create_report', { kind: 'morning', title: 'X', body: 'Y' })) as Result;
  expect(JSON.parse(refused.content[0]!.text)).toEqual({ error: 'tool_not_allowed' });
  const actions = (await pools.root.query(`select action, diff from hdc_audit_log where action like 'agent.tool_%' order by created_on`)).rows;
  expect(actions.map((a) => [a.action, a.diff.tool])).toEqual([
    ['agent.tool_called', 'create_report'],
    ['agent.tool_refused', 'create_report'],
  ]);
});
