import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { listCandidates } from '@/modules/hda/api/candidate-actions';
import { AGENT_READ_TOOLS } from '@/modules/hda/pref';
import { listAudit } from '@/modules/hdc/api';
import { filterValues } from '@/modules/hdc/search/typesense';
import { listIdeas } from '@/modules/hdi/api/board';
import { listSolutions } from '@/modules/hdk/api/editor';
import { searchIdeaDocuments } from '@/modules/hdk/api/idea-search';
import { getKnowledgeMetrics } from '@/modules/hdk/api/metrics';
import { searchSolutions, suggestForClient } from '@/modules/hdk/api/suggest';
import { listProblems } from '@/modules/hdp/api/problems';
import { listTemplates, saveTemplate } from '@/modules/hdr/api';
import { getTicket, listFilters, listQueue, listTickets, replyToTicket, saveFilter } from '@/modules/hdt/api';
import { exportMetrics, getMetrics } from '@/modules/hdt/api/metrics';
import { findUserIds, searchOrganizations } from '@/modules/hdu/api';
import { listMacros, saveMacro } from '@/modules/hdw/api/macros';
import { listRules, saveRule } from '@/modules/hdw/api/rules';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { seedCodeCatalog } from './helpers/code';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Защита от SQL-инъекций (ТЗ 14.3, V2 ASVS): ввод доходит до базы только параметром. Строки атак в полях поиска
// и текста не меняют запрос: ничего не удаляется, чужое не находится, ошибки базы нет.

const PAYLOADS = [
  "' or '1'='1",
  "'; drop table hdt_tickets; --",
  "1; update hdt_tickets set org_id = null; --",
  "%' union select ticket_id, title from hdt_tickets --",
  '\\%_\\',
  "SUP-1' or 1=1 --",
  '$1',
];

const counts = async () =>
  (await pools.root.query(`select (select count(*)::int from hdt_tickets) as tickets, (select count(*)::int from hdu_organizations) as orgs`)).rows[0];

test('строки атак в поиске клиента, очереди сотрудника, поиске организаций и шаблонов не меняют запрос', async () => {
  const f = await seedTwoOrgs();
  const before = await counts();
  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  for (const q of PAYLOADS) {
    const mine = await listTickets(client, { q });
    // Клиент организации А не находит обращения организации Б ни при каком тексте.
    expect(JSON.stringify(mine)).not.toContain('Секрет Б');
    expect((await listQueue(l1, { queue: 'all', q })).items.length).toBeLessThanOrEqual(1);
    expect((await searchOrganizations(l1, { query: q })).items).toEqual([]);
    expect(await listTemplates(l1, { q })).toEqual([]);
  }
  expect(await counts()).toEqual(before);
});

test('строка атаки в тексте сохраняется как текст и возвращается без изменений', async () => {
  const f = await seedTwoOrgs();
  const client = await clientCtx(f.aUser);
  const body = "Robert'); drop table hdt_ticket_messages; -- и %_ знаки";
  await replyToTicket(client, { number: f.tickets.aOrg.number, body });
  expect((await getTicket(client, f.tickets.aOrg.number))?.messages.map((m) => m.body)).toContain(body);
  await saveTemplate(staffCtx(f.adminStaff), { shortcut: 'safe', title: "'; drop table hdr_reply_templates; --", body: { ru: "' or '1'='1" }, moduleId: null, isEnabled: true });
  expect((await listTemplates(staffCtx(f.l1), {})).map((t) => [t.title, t.body.ru])).toEqual([["'; drop table hdr_reply_templates; --", "' or '1'='1"]]);
});

// --- Волна 7, S-T: остальные входы со строкой от человека или агента ---

beforeEach(() => setLogSinkForTests(() => undefined));
afterEach(() => setLogSinkForTests(null));

/** Строки атак на полнотекстовый поиск (операторы tsquery), LIKE (метазнаки) и условия Typesense. */
const SEARCH_PAYLOADS = [
  ...PAYLOADS,
  "a & b | !c",
  "'заказ':* & !'склад'",
  'заказ <-> склад',
  '((( & | ! :* )))',
  "'",
  '"',
  '\\',
  '%%%',
  '___',
  "заказ'); delete from hdk_articles; --",
  'id:[1,2] || org_id:*',
  '`) && audience:=internal',
];

/** Код ошибки PostgreSQL (SQLSTATE) у ошибки или её причины. */
function sqlState(error: unknown): string | null {
  for (const e of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Вызов с вводом атаки: отказ схемы или прав допустим, ошибка базы нет. */
async function probe<T>(label: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    const state = sqlState(error);
    if (state) throw new Error(`${label}: ошибка базы ${state}: ${(error as Error).message}`, { cause: error });
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' || (error as Error).name === 'ZodError') return null;
    throw error;
  }
}

const wideCounts = async () =>
  (
    await pools.root.query(`select (select count(*)::int from hdt_tickets) as tickets, (select count(*)::int from hdu_organizations) as orgs, (select count(*)::int from hdk_articles) as articles,
      (select count(*)::int from hdi_ideas) as ideas, (select count(*)::int from hdp_problems) as problems, (select count(*)::int from hdc_audit_log where action not like 'rule.%' and action not like 'macro.%' and action not like 'filter.%' and action not like 'metrics.%') as audit,
      (select count(*)::int from auth."user") as users, (select count(*)::int from hda_code_error_entries) as entries`)
  ).rows[0];

test('поиск решений, идей, известных проблем, кандидатов, людей и организаций: операторы tsquery и метазнаки остаются текстом', async () => {
  const f = await seedTwoOrgs();
  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const before = await wideCounts();
  for (const q of SEARCH_PAYLOADS) {
    await pools.root.query(`delete from hdc_rate_limits`);
    for (const locale of ['ru', 'uz', 'en'] as const) {
      const found = await probe(`searchSolutions ${q}`, () => searchSolutions(client.actor, { text: q, signature: null, moduleId: null, locale, audiences: ['clients'] }));
      // Клиент не получает внутренних решений ни при каком тексте.
      expect(JSON.stringify(found ?? {})).not.toContain('"audience":"internal"');
    }
    await probe(`suggestForClient ${q}`, () => suggestForClient(client, { text: q, sessionId: randomUUID(), locale: 'ru' }));
    for (const tab of ['popular', 'new'] as const) await probe(`listIdeas ${q}`, () => listIdeas(client, { tab, locale: 'ru', q }));
    await probe(`searchIdeaDocuments ${q}`, () => searchIdeaDocuments(client.actor, { text: q, locale: 'ru', limit: 5 }));
    expect(await probe(`listProblems ${q}`, () => listProblems(l1, { q })) ?? []).toEqual([]);
    expect(await probe(`listCandidates ${q}`, () => listCandidates(l2, { q })) ?? []).toEqual([]);
    expect(await probe(`findUserIds ${q}`, () => findUserIds(l1, q)) ?? []).toEqual([]);
    // Запасной путь поиска организаций (ILIKE): Typesense в тестах нет.
    expect((await probe(`searchOrganizations ${q}`, () => searchOrganizations(l1, { query: q })))?.items ?? []).toEqual([]);
  }
  expect(await wideCounts()).toEqual(before);
});

test('очереди: фильтры, сортировка, ключ страницы и сохранённые фильтры принимают только значения перечней, текст остаётся текстом', async () => {
  const f = await seedTwoOrgs();
  const before = await wideCounts();
  const l1 = staffCtx(f.l1);
  for (const q of SEARCH_PAYLOADS) {
    for (const field of ['queue', 'sort', 'tag', 'after', 'page'] as const) {
      // Значение вне перечня отклоняет схема: до базы оно не доходит.
      await expect(listQueue(l1, { queue: 'all', [field]: q }), `${field} ${q}`).rejects.toMatchObject({ code: 'invalid_input' });
    }
    const page = await probe(`listQueue ${q}`, () => listQueue(l1, { queue: 'all', sort: 'client_waiting', q }));
    expect((page?.items ?? []).length).toBeLessThanOrEqual(1);
    await probe(`saveFilter ${q}`, () => saveFilter(l1, { name: q, query: { queue: 'all', sort: 'sla', q }, isShared: false }));
  }
  // Сохранённые фильтры возвращают строку атаки как текст и применяются как обычный поиск.
  const filters = await listFilters(l1);
  expect(filters.map((filter) => filter.name)).toEqual(expect.arrayContaining(["'; drop table hdt_tickets; --"]));
  for (const filter of filters) {
    const query = filter.query as { queue: string; sort?: string; q?: string };
    expect((await probe(`фильтр ${filter.name}`, () => listQueue(l1, query)))?.items.length ?? 0).toBeLessThanOrEqual(1);
  }
  expect(await wideCounts()).toEqual(before);
});

test('правила и макросы: строка атаки в названии и тексте действия хранится текстом; чужое значение перечня отклоняется', async () => {
  const f = await seedTwoOrgs();
  const before = await wideCounts();
  const admin = staffCtx(f.adminStaff);
  const attack = "'; drop table hdw_rules; --";
  await saveRule(admin, { name: attack, event: 'sla_breached', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: "' or '1'='1 %_\\" }] });
  await saveMacro(admin, { name: attack, actions: [{ action: 'add_note', text: "'); delete from hdt_tickets; --" }] });
  expect((await listRules(admin)).map((rule) => rule.name)).toContain(attack);
  expect((await listMacros(admin)).map((macro) => macro.name)).toContain(attack);
  for (const q of SEARCH_PAYLOADS) {
    await expect(saveRule(admin, { name: 'x', event: q, conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: 'x' }] }), q).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(saveRule(admin, { name: 'x', event: 'sla_breached', conditions: { match: q, items: [] }, actions: [{ action: 'add_note', text: 'x' }] }), q).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(saveMacro(admin, { name: 'x', actions: [{ action: q }] }), q).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(saveMacro(admin, { name: 'x', actions: [{ action: 'set_status', status: q }] }), q).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect((await pools.root.query(`select count(*)::int as n from hdw_rules`)).rows[0].n).toBeGreaterThan(0);
  expect(await wideCounts()).toEqual(before);
});

test('показатели и выгрузка CSV: period, from и to принимают только даты и перечень', async () => {
  const f = await seedTwoOrgs();
  const before = await wideCounts();
  const care = staffCtx(f.care);
  const now = new Date('2026-11-28T10:00:00Z');
  for (const q of SEARCH_PAYLOADS) {
    for (const input of [{ period: q }, { period: 'custom', from: q, to: '2026-11-28' }, { period: 'custom', from: '2026-11-01', to: q }, { period: '7', line: q }, { period: '7', orgId: q }]) {
      const view = await probe(`getMetrics ${JSON.stringify(input)}`, () => getMetrics(care, input, now));
      // Неверный период не выполняет запроса с этим значением: отказ или период по умолчанию.
      expect(view === null || typeof view === 'object').toBe(true);
      await probe(`exportMetrics ${JSON.stringify(input)}`, () => exportMetrics(care, { report: 'pilot', ...input }, now));
    }
    await probe(`exportMetrics report ${q}`, () => exportMetrics(care, { report: q, period: '7' }, now));
    await probe(`getKnowledgeMetrics ${q}`, () => getKnowledgeMetrics(care, { from: q, to: q }));
  }
  expect(await wideCounts()).toEqual(before);
});

test('список решений редактора и фильтры журнала аудита: строки атак остаются значениями', async () => {
  const f = await seedTwoOrgs();
  const before = await wideCounts();
  const l1 = staffCtx(f.l1);
  const admin = staffCtx(f.adminStaff);
  for (const q of SEARCH_PAYLOADS) {
    expect(await probe(`listSolutions ${q}`, () => listSolutions(l1, { original: { locale: 'ru', title: q } })) ?? []).toEqual([]);
    for (const field of ['status', 'moduleId', 'locale'] as const) await expect(listSolutions(l1, { [field]: q }), `${field} ${q}`).rejects.toMatchObject({ code: 'invalid_input' });
    for (const input of [{ actorId: q }, { objectId: q }]) {
      const page = await probe(`listAudit ${JSON.stringify(input)}`, () => listAudit(admin, input));
      expect(page?.items ?? []).toEqual([]);
    }
    for (const input of [{ action: q }, { orgId: q }, { cursor: q }]) await expect(listAudit(admin, input), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid_input' });
    // Вид объекта: только строчные буквы и подчёркивание; такая строка уходит параметром и ничего не находит.
    expect((await probe(`listAudit objectType ${q}`, () => listAudit(admin, { objectType: q })))?.items ?? []).toEqual([]);
  }
  expect(await wideCounts()).toEqual(before);
});

test('инструменты MCP search_* и каталог кода: текст поиска параметром, метазнаки LIKE не подстановка', async () => {
  const f = await seedTwoOrgs();
  const token = await seedAgentToken({ tools: [...AGENT_READ_TOOLS.filter((tool) => tool !== 'signature_spikes')] });
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  const before = await wideCounts();
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: { items?: unknown[]; entries?: { untrusted_key: string }[] } };
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool(name, args)) as Result;
  await pools.root.query(`update hda_agent_tokens set rate_limit_per_min = 100000 where token_id = $1`, [token.tokenId]).catch(() => undefined);
  for (const q of SEARCH_PAYLOADS) {
    await pools.root.query(`delete from hdc_rate_limits`);
    for (const [name, args] of [
      ['search_tickets', { text: q }],
      ['search_tickets', { queue: q }],
      ['search_tickets', { signature: q }],
      ['search_solutions', { text: q }],
      ['search_solutions', { module: q }],
      ['list_ideas', { status: q }],
      ['list_known_problems', { status: q }],
      ['list_candidates', { status: q }],
      ['unsolved_signatures', { module: q }],
      ['search_code_catalog', { text: q }],
      ['search_code_catalog', { key: q }],
      ['search_code_catalog', { module: q }],
    ] as const) {
      const result = await call(name, args);
      // Отказ схемы или "не найдено" допустимы; внутренняя ошибка (в том числе ошибка базы) нет.
      if (result.isError) expect(JSON.parse(result.content[0]!.text).error, `${name} ${JSON.stringify(args)}`).toMatch(/^(invalid_arguments|not_found)$/);
    }
    // Метазнаки LIKE в тексте поиска каталога не находят записей, в которых этих знаков нет.
    if (/^[%_\\]+$/.test(q)) expect((await call('search_code_catalog', { text: q })).structuredContent?.entries ?? []).toEqual([]);
  }
  // Обычный поиск по каталогу по-прежнему находит запись.
  expect((await call('search_code_catalog', { text: 'контроле остатков' })).structuredContent?.entries?.map((e) => e.untrusted_key)).toContain(catalog.approvedKey);
  expect(await wideCounts()).toEqual(before);
});

test('filterValues Typesense: значение с оператором, скобкой, пробелом или кавычкой в условие не попадает', () => {
  for (const q of [...SEARCH_PAYLOADS.filter((p) => p !== '___'), 'a,b', 'a]', '[a', 'a b', 'a&&b', 'a||b', 'a`b', '', 'x'.repeat(201), 'a\u0000b']) expect(() => filterValues([q]), q).toThrow();
  expect(filterValues(['01900000-0000-7000-8000-000000000001', 'ru', 'orders.print'])).toBe('[01900000-0000-7000-8000-000000000001,ru,orders.print]');
});

// Нулевой байт PostgreSQL в тексте не принимает (ошибка 22021): вход убирает его до запроса, а не отвечает ошибкой 500.
test('нулевой байт в строке поиска не доходит до базы ни в одном входе', async () => {
  const f = await seedTwoOrgs();
  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const admin = staffCtx(f.adminStaff);
  const care = staffCtx(f.care);
  const token = await seedAgentToken({ tools: [...AGENT_READ_TOOLS.filter((tool) => tool !== 'signature_spikes')] });
  const mcp = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const q = 'зак\u0000аз';
  const now = new Date('2026-11-28T10:00:00Z');
  const calls: [string, () => Promise<unknown>][] = [
    ['listTickets', () => listTickets(client, { q })],
    ['searchSolutions', () => searchSolutions(client.actor, { text: q, signature: null, moduleId: null, locale: 'ru', audiences: ['clients'] })],
    ['suggestForClient', () => suggestForClient(client, { text: q, sessionId: randomUUID(), locale: 'ru' })],
    ['listIdeas', () => listIdeas(client, { tab: 'popular', locale: 'ru', q })],
    ['searchIdeaDocuments', () => searchIdeaDocuments(client.actor, { text: q, locale: 'ru', limit: 5 })],
    ['listProblems', () => listProblems(l1, { q })],
    ['listCandidates', () => listCandidates(l2, { q })],
    ['findUserIds', () => findUserIds(l1, q)],
    ['searchOrganizations', () => searchOrganizations(l1, { query: q })],
    ['listTemplates', () => listTemplates(l1, { q })],
    ['listQueue', () => listQueue(l1, { queue: 'all', q })],
    ['saveFilter', () => saveFilter(l1, { name: q, query: { queue: 'all', q }, isShared: false })],
    ['listSolutions', () => listSolutions(l1, { original: { locale: 'ru', title: q } })],
    ['listAudit actorId', () => listAudit(admin, { actorId: q })],
    ['listAudit objectId', () => listAudit(admin, { objectId: q })],
    ['getMetrics', () => getMetrics(care, { period: q }, now)],
    ['saveRule', () => saveRule(admin, { name: q, event: 'sla_breached', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: q }] })],
    ['saveMacro', () => saveMacro(admin, { name: q, actions: [{ action: 'add_note', text: q }] })],
    ['replyToTicket', () => replyToTicket(client, { number: f.tickets.aOrg.number, body: q })],
  ];
  const failed: string[] = [];
  for (const [label, call] of calls) {
    await pools.root.query(`delete from hdc_rate_limits`);
    await probe(label, call).catch((error: Error) => failed.push(`${label}: ${error.message.slice(0, 60)}`));
  }
  for (const [name, args] of [
    ['search_tickets', { text: q }],
    ['search_solutions', { text: q }],
    ['search_code_catalog', { text: q }],
  ] as const) {
    const result = (await mcp.callTool(name, args)) as { isError?: boolean; content: { text: string }[] };
    if (result.isError && JSON.parse(result.content[0]!.text).error === 'internal') failed.push(`mcp ${name}: internal`);
  }
  expect(failed).toEqual([]);
});
