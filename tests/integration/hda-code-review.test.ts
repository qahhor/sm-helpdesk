import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { issueTicketRunTokenTx } from '@/modules/hda/agent/run-token';
import { approveCodeEntry, codeEntryCard, editCodeEntry, ticketCodeKnowledge } from '@/modules/hda/api/code-knowledge';
import { markAnalysisTimeouts, requestCodeAnalysis, requestCodeAnalysisBySystemTx } from '@/modules/hda/api/code-analysis';
import { codeTemplateSignature } from '@/modules/hda/api/code-match';
import { getAgentTicket } from '@/modules/hdt/api/agent';
import { buildTicketTextDocs } from '@/modules/hdt/api/search-docs';
import { withActor } from '@/db/with-actor';
import { uniqueReport } from '../helpers/code-scan';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentBot, seedAgentToken } from './helpers/agent';
import { staffCtx, staffWithRole } from './helpers/auth';
import { seedCodeCatalog, seedStaff } from './helpers/code';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Независимая проверка вехи M8c "Знания из кода" (находки C1, C2, I1-I7, M1-M5, M7; решение 0134). Каждый тест
// воспроизводит находку проверки и после исправления проходит.

const SYSTEM = { type: 'system', job: 'test.code-review' } as const;
let f: Fixture;

beforeEach(async () => {
  setLogSinkForTests(() => undefined);
  f = await seedTwoOrgs();
});
afterEach(() => setLogSinkForTests(null));

type Actor = Parameters<typeof asActor>[1];
const q = async (sql: string, params: unknown[] = []) => (await pools.root.query(sql, params)).rows;
const fails = (actor: Actor, query: string, params: unknown[] = []) =>
  expect(asActor(pools.app, actor, (c) => c.query(query, params))).rejects.toThrow(/row-level security|permission denied|violates check|Знания из кода/);
const l2 = async () => staffCtx({ ...(await staffWithRole('agent_l2')), name: 'Вторая линия' });

async function scanner(tools: string[] = ['code_catalog_upsert']) {
  const token = await seedAgentToken({ tools: tools as never });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const upsert = async (report: unknown) => {
    const out = await client.callTool('code_catalog_upsert', report as Record<string, unknown>);
    if (out.isError) throw new Error(out.content[0]!.text);
    return out.structuredContent as Record<string, unknown>;
  };
  return { token, client, upsert };
}

// --- C1: сопоставление с шаблонами в пределах времени ---

test('C1: сигнатура по 10000 шаблонам (5000 утверждённых) и 31 строке считается меньше чем за секунду', { timeout: 180_000 }, async () => {
  const token = await seedAgentToken();
  const approver = await seedStaff('agent_l2');
  const tag = `${Date.now()}`;
  const [scan] = await q(`insert into hda_code_scans (token_id, scan_key, repository, commit_ref) values ($1, $2, 'smartup-bench', 'abc1234') returning scan_id`, [token.tokenId, `bench-${tag}`]);
  await q(
    `insert into hda_code_error_entries (scan_id, key, repository, conditions, user_cause, what_to_check, kind, confidence, status, change_kind, scan_digest, approved_by, approved_on)
     select $1, 'bench.e' || $2 || '_' || g, 'smartup-bench', 'Условия', 'Причина', '["Проверить"]', 'data', 0.5,
            case when g % 2 = 0 then 'approved' else 'draft' end, 'new', repeat('a', 64),
            case when g % 2 = 0 then $3::uuid end, case when g % 2 = 0 then now() end
       from generate_series(1, 10000) g`,
    [scan.scan_id, tag, approver.userId],
  );
  // Половина шаблонов с общими словами строк обращения: проверка буквальной части пропускает их все.
  await q(
    `insert into hda_code_error_templates (entry_id, locale, template)
     select e.entry_id, 'ru', case when (substring(e.key from '_([0-9]+)$'))::int % 4 < 2
                                   then 'Недостаточно остатка товара {product} на складе вариант ' || substring(e.key from '_([0-9]+)$')
                                   else 'Ошибка проведения документа {doc} номер ' || substring(e.key from '_([0-9]+)$') || ' на складе' end
       from hda_code_error_entries e where e.key like $1`,
    [`bench.e${tag}\\_%`],
  );
  const lines = Array.from({ length: 30 }, (_, i) => `Недостаточно остатка товара Хлеб ${i} на складе Основной`);
  lines.push('Недостаточно остатка товара Молоко на складе вариант 9996');
  const [expected] = await q(`select signature from hda_code_error_entries where key = $1`, [`bench.e${tag}_9996`]);
  const started = Date.now();
  const [row] = await q(`select app.hda_code_signature(null, $1::text[]) as s`, [lines]);
  const elapsed = Date.now() - started;
  expect(row.s).toBe(expected.signature);
  expect(elapsed).toBeLessThan(1000);
  // Через функцию модуля (системой) тот же итог.
  expect(await codeTemplateSignature({ code: null, lines })).toBe(expected.signature);
});

// --- C2: управляющие знаки ---

test('C2: управляющий знак не становится подстановкой; база отклоняет его в шаблоне и в текстах', async () => {
  const token = await seedAgentToken();
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  const [built] = await q(`select app.hda_code_pattern('Недостаточно товара ' || repeat(chr(1), 300)) as p`);
  expect(built.p).not.toContain('(.{1,200}?)');
  await expect(pools.root.query(`insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'uz', 'Недостаточно товара ' || repeat(chr(1), 300))`, [catalog.approvedId])).rejects.toThrow(
    /hda_code_error_templates_c3/,
  );
  for (const bad of [`'Условия' || chr(13) || 'ещё'`, `'Условия' || chr(8232) || 'ещё'`, `'Условия' || chr(8203)`, `'Условия' || chr(133)`])
    await expect(pools.root.query(`update hda_code_error_entries set conditions = ${bad} where entry_id = $1`, [catalog.draftId]), bad).rejects.toThrow(/hda_code_error_entries_c9/);
  await expect(pools.root.query(`update hda_code_error_entries set what_to_check = jsonb_build_array('Остаток' || chr(1)) where entry_id = $1`, [catalog.draftId])).rejects.toThrow(/hda_code_error_entries_c9/);
  await expect(pools.root.query(`update hda_code_module_notes set summary = 'Заказы' || chr(11) || 'склад' where note_id = $1`, [catalog.moduleNoteId])).rejects.toThrow(/hda_code_module_notes_c6/);
  // Самый тяжёлый допустимый шаблон (160 подстановок в 500 знаках) компилируется: триггер проверки выражения
  // t_hda_code_error_templates_check остаётся второй защитой.
  await pools.root.query(`insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'kk', 'Недостаточно товара ' || repeat('{a}', 160))`, [catalog.draftId]);
  const [valid] = await q(`select count(*)::int as n from hda_code_error_templates where entry_id = $1`, [catalog.approvedId]);
  expect(valid.n).toBe(1);
});

test('I1: база считает строки только по \\n, строка не длиннее 300 знаков', async () => {
  const token = await seedAgentToken();
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  await expect(pools.root.query(`update hda_code_error_entries set conditions = repeat('а', 301) where entry_id = $1`, [catalog.draftId])).rejects.toThrow(/hda_code_error_entries_c9/);
  await pools.root.query(`update hda_code_error_entries set conditions = repeat('а', 300) || E'\\n' || repeat('б', 300) where entry_id = $1`, [catalog.draftId]);
});

// --- M3: запись с кодом и строка без кода ---

test('M3: запись с кодом ошибки сопоставляется со строкой без кода, но не со строкой с другим кодом', async () => {
  const token = await seedAgentToken();
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  const suffix = catalog.approvedKey.split('_').slice(-2).join('_');
  const line = `Недостаточно остатка товара Молоко на складе Основной ${suffix}`;
  expect(await codeTemplateSignature({ code: null, lines: [line] })).toBe(catalog.approvedSignature);
  expect(await codeTemplateSignature({ code: 'ORA-20001', lines: [line] })).toBe(catalog.approvedSignature);
  expect(await codeTemplateSignature({ code: 'ORA-01403', lines: [line] })).toBeNull();
});

// --- M2: блок обращения берёт код как сигнатура (строки стека пропускаются) ---

test('M2: блок "Что известно по коду" находит запись с кодом, когда первой в описании идёт строка стека ORA-06512', async () => {
  const token = await seedAgentToken();
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  const suffix = catalog.approvedKey.split('_').slice(-2).join('_');
  const t = f.tickets.aOrg;
  await q(`update hdt_tickets set description = $2, error_signature = null where ticket_id = $1`, [
    t.ticketId,
    `Не проводится заказ.\nORA-06512: at "ORDER_PKG", line 412\nORA-20001: Недостаточно остатка товара Молоко на складе Основной ${suffix}`,
  ]);
  const block = await ticketCodeKnowledge(await l2(), { number: t.number });
  expect(block.view).toBe('full');
  expect(block.view === 'full' ? block.entries.map((e) => e.key) : []).toContain(catalog.approvedKey);
});

// --- I2: заметка анализа только тем, кто видит знания из кода ---

test('I2: заметку анализа по коду не видят agent_l1 и product; видят agent_l2, care, admin; в поиск она не попадает', async () => {
  const bot = await seedAgentBot();
  const t = f.tickets.aOrg;
  const [note] = await q(
    `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, source, agent_note_kind)
     values ($1, $2, $3, 'agent', 'Гипотеза причины: ORDER_PKG.SAVE_ORDER', true, 'staff', 'code_analysis') returning message_id`,
    [f.orgA.orgId, t.ticketId, bot],
  );
  const product = await staffWithRole('product');
  const select = `select 1 from hdt_ticket_messages where message_id = $1`;
  for (const actor of [f.l1.actor, product.actor]) expect((await asActor(pools.app, actor, (c) => c.query(select, [note.message_id]))).rows, actor.staffRole).toEqual([]);
  for (const actor of [(await l2()).actor, f.care.actor, f.adminStaff.actor]) expect((await asActor(pools.app, actor, (c) => c.query(select, [note.message_id]))).rowCount, actor.type).toBe(1);
  expect(JSON.stringify(await getAgentTicket(staffCtx(f.l1), t.number))).not.toContain('ORDER_PKG');
  expect(JSON.stringify(await getAgentTicket(staffCtx(f.care), t.number))).toContain('ORDER_PKG');
  const docs = await buildTicketTextDocs(SYSTEM, [`${t.ticketId}_${note.message_id}`]);
  expect(docs.get(`${t.ticketId}_${note.message_id}`)).toEqual([]);
});

// --- I3: токены запуска разных назначений не отзывают друг друга ---

test('I3: токен запуска анализа по коду и токен запуска обращения на одном обращении не отзывают друг друга', async () => {
  const main = await seedAgentToken({ tools: ['get_ticket', 'add_internal_note', 'search_code_catalog', 'submit_code_analysis'] as never });
  const t = f.tickets.aOrg;
  const active = async (id: string) => (await q(`select revoked_at from hda_agent_tokens where token_id = $1`, [id]))[0].revoked_at === null;
  for (const order of [
    ['ticket', 'code_analysis'],
    ['code_analysis', 'ticket'],
  ] as const) {
    const [a, b] = await withActor(SYSTEM, async (tx) => [
      await issueTicketRunTokenTx(tx, SYSTEM, { parentTokenId: main.tokenId, ticketId: t.ticketId, purpose: order[0] }),
      await issueTicketRunTokenTx(tx, SYSTEM, { parentTokenId: main.tokenId, ticketId: t.ticketId, purpose: order[1] }),
    ]);
    expect(await active(a!.tokenId), order.join('>')).toBe(true);
    expect(await active(b!.tokenId), order.join('>')).toBe(true);
    // Тот же вид отзывает прежний.
    const c = await withActor(SYSTEM, (tx) => issueTicketRunTokenTx(tx, SYSTEM, { parentTokenId: main.tokenId, ticketId: t.ticketId, purpose: order[0] }));
    expect(await active(a!.tokenId), `${order[0]} повтор`).toBe(false);
    expect(await active(b!.tokenId), `${order[1]} остаётся`).toBe(true);
    expect(await active(c!.tokenId)).toBe(true);
  }
  expect(await q(`select distinct purpose from hda_agent_tokens where parent_token_id = $1 order by purpose`, [main.tokenId])).toEqual([{ purpose: 'code_analysis' }, { purpose: 'ticket' }]);
});

// --- I4, M1: истёкший ожидающий запрос не держит новый; аудит истечения и ответа ---

test('I4: ожидающий запрос с вышедшим сроком истекает в той же транзакции, новый запрос создаётся; аудит code.analysis_timed_out', async () => {
  const t = f.tickets.aOrg;
  const ctx = await l2();
  const first = await requestCodeAnalysis(ctx, { number: t.number });
  await q(`update hda_code_analysis_requests set due_on = now() - interval '1 minute' where request_id = $1`, [first.requestId]);
  const second = await requestCodeAnalysis(ctx, { number: t.number });
  expect(second.requestId).not.toBe(first.requestId);
  expect(second.status).toBe('pending');
  expect(await q(`select status from hda_code_analysis_requests where request_id = $1`, [first.requestId])).toEqual([{ status: 'timeout' }]);
  expect(await q(`select actor_id from hdc_audit_log where action = 'code.analysis_timed_out' and object_id = $1`, [first.requestId])).toEqual([{ actor_id: ctx.user.id }]);
  // Правило тоже не упирается в истёкший запрос (срок вышел больше 6 часов назад: пауза правила M7 прошла).
  await q(`update hda_code_analysis_requests set due_on = now() - interval '7 hours' where request_id = $1`, [second.requestId]);
  const outcome = await withActor(SYSTEM, (tx) => requestCodeAnalysisBySystemTx(tx, { ticketId: t.ticketId, orgId: f.orgA.orgId, ruleId: '00000000-0000-0000-0000-000000000001' }));
  expect(outcome).toBe('requested');
  expect(await q(`select status from hda_code_analysis_requests where request_id = $1`, [second.requestId])).toEqual([{ status: 'timeout' }]);
});

test('M1: истечение срока системой и ответ агента пишут журнал аудита той же транзакцией', async () => {
  const main = await seedAgentToken({ tools: ['submit_code_analysis'] as never });
  const agent = createMcpClient({ token: main.value, ip: '10.0.3.12', send: (r) => handleMcpRequest(r) });
  const t = f.tickets.aOrg;
  const request = await requestCodeAnalysis(await l2(), { number: t.number });
  expect(await markAnalysisTimeouts(SYSTEM, new Date(Date.now() + 11 * 60_000))).toEqual({ timedOut: 1 });
  expect(await q(`select actor_type from hdc_audit_log where action = 'code.analysis_timed_out' and object_id = $1`, [request.requestId])).toEqual([{ actor_type: 'system' }]);
  const out = await agent.callTool('submit_code_analysis', {
    ticket_number: t.number,
    hypothesis: 'Поздняя гипотеза',
    confidence: 0.5,
    locations: [],
    what_to_check: [],
    questions: [],
    similar_tickets: [],
    recommendation: '',
  });
  expect(out.isError).toBeFalsy();
  const [done] = await q(`select actor_type, diff from hdc_audit_log where action = 'code.analysis_done' and object_id = $1`, [request.requestId]);
  expect(done).toMatchObject({ actor_type: 'agent', diff: { from: 'timeout' } });
});

// --- I5: агент не читает базовую таблицу запросов ---

test('I5: агент не читает и не меняет таблицу запросов анализа напрямую; ответ проходит функцией базы', async () => {
  const main = await seedAgentToken({ tools: ['submit_code_analysis'] as never });
  const run = await seedAgentToken({ userId: main.userId, parentTokenId: main.tokenId, ticketId: f.tickets.aOrg.ticketId });
  await requestCodeAnalysis(await l2(), { number: f.tickets.aOrg.number });
  for (const actor of [main.actor, run.actor]) {
    expect((await asActor(pools.app, actor, (c) => c.query(`select 1 from hda_code_analysis_requests`))).rows).toEqual([]);
    expect((await asActor(pools.app, actor, (c) => c.query(`update hda_code_analysis_requests set status = 'done', finished_on = now()`))).rowCount).toBe(0);
  }
  // Функция ответа не закрывает запрос чужого обращения токеном запуска.
  const [other] = await asActor(pools.app, run.actor, (c) => c.query(`select * from app.hda_code_analysis_answer($1, null)`, [f.tickets.bOrg.ticketId])).then((r) => r.rows);
  expect(other).toBeUndefined();
});

// --- I6: агент не переписывает утверждённое ---

test('I6: агент не меняет содержимое и шаблоны утверждённой записи, не сбросив её в черновик', async () => {
  const token = await seedAgentToken();
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  for (const change of [`conditions = 'Подменено агентом'`, `what_to_check = '["Другое"]'`, `code = 'ORA-20999'`, `raised_in = '[]'`, `repository = 'smartup-other'`, `module_code = 'stock'`, `kind = 'data'`])
    await fails(token.actor, `update hda_code_error_entries set ${change} where entry_id = $1`, [catalog.approvedId]);
  await fails(token.actor, `update hda_code_error_templates set template = 'Подменённый шаблон ошибки {x} склада' where entry_id = $1`, [catalog.approvedId]);
  await fails(token.actor, `insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'en', 'Not enough stock of {product} in warehouse')`, [catalog.approvedId]);
  await fails(token.actor, `delete from hda_code_error_templates where entry_id = $1`, [catalog.approvedId]);
  expect((await q(`select count(*)::int as n from hda_code_error_templates where entry_id = $1`, [catalog.approvedId]))[0].n).toBe(1);
  // Перенос в новое сканирование разрешён, как и сброс в черновик вместе с правкой.
  await asActor(pools.app, token.actor, (c) => c.query(`update hda_code_error_entries set change_kind = 'same' where entry_id = $1`, [catalog.approvedId]));
  await asActor(pools.app, token.actor, (c) =>
    c.query(`update hda_code_error_entries set conditions = 'Новое', status = 'draft', approved_by = null, approved_on = null, change_kind = 'changed', scan_digest = repeat('e', 64) where entry_id = $1`, [catalog.approvedId]),
  );
  await asActor(pools.app, token.actor, (c) => c.query(`update hda_code_error_templates set template = 'Новый шаблон ошибки {x} на складе' where entry_id = $1`, [catalog.approvedId]));
});

// --- I7: утверждение и правка по версии, которую видел сотрудник ---

test('I7: утверждение и правка устаревшей версии записи дают conflict', async () => {
  const { upsert } = await scanner();
  const report = uniqueReport();
  await upsert(report);
  const ctx = await l2();
  const key = report.errors[0]!.key;
  const seen = await codeEntryCard(ctx, { key });
  expect(seen.version).toMatch(/^[0-9a-f]{16}-\d+$/);
  // Пока страница открыта, новое сканирование меняет запись.
  const next = structuredClone(report);
  next.scanId = `${report.scanId}-2`;
  next.errors[0]!.conditions = 'Условия изменились после сканирования';
  await upsert(next);
  await expect(approveCodeEntry(ctx, { key, version: seen.version })).rejects.toMatchObject({ code: 'conflict' });
  const edit = { key, conditions: 'Уточнено', userCause: 'Причина', whatToCheck: ['Остаток'], kind: 'data', templates: { ru: 'Недостаточно остатка товара {product} на складе {warehouse}' } };
  await expect(editCodeEntry(ctx, { ...edit, version: seen.version })).rejects.toMatchObject({ code: 'conflict' });
  expect((await q(`select status from hda_code_error_entries where key = $1`, [key]))[0].status).toBe('draft');
  const fresh = await codeEntryCard(ctx, { key });
  await approveCodeEntry(ctx, { key, version: fresh.version });
  expect((await q(`select status from hda_code_error_entries where key = $1`, [key]))[0].status).toBe('approved');
  await editCodeEntry(ctx, { ...edit, version: (await codeEntryCard(ctx, { key })).version });
});

// --- M1: аудит сброса утверждения сканированием считает все записи ---

test('M1: журнал аудита сканирования хранит число сброшенных записей и признак усечения списка ключей', async () => {
  const { upsert } = await scanner();
  const report = uniqueReport();
  const base = report.errors[0]!;
  report.errors = Array.from({ length: 120 }, (_, i) => ({ ...structuredClone(base), key: `${base.key}_${i}` }));
  report.changes = { added: report.errors.map((e) => e.key), changed: [], removed: [] };
  await upsert(report);
  const next = structuredClone(report);
  next.scanId = `${report.scanId}-2`;
  for (const error of next.errors) error.conditions = 'Изменённые условия возникновения';
  (next as { changes: unknown }).changes = { added: [], changed: next.errors.map((e) => e.key), removed: [] };
  const out = await upsert(next);
  expect(out.changed).toBe(120);
  const [audit] = await q(`select diff from hdc_audit_log where action = 'code.scan_accepted' and diff ->> 'scan' = $1`, [next.scanId]);
  expect(audit.diff).toMatchObject({ resetCount: 120, resetTruncated: true });
  expect(audit.diff.reset.length).toBeLessThanOrEqual(100);
});

// --- M4: один ключ в двух репозиториях ---

test('M4: ключ записи другого репозитория отклоняет отчёт правилом key_conflict; запись первого репозитория не меняется', async () => {
  const { upsert } = await scanner();
  const first = uniqueReport();
  await upsert(first);
  const second = uniqueReport();
  second.errors[1]!.key = first.errors[0]!.key;
  const out = await upsert(second);
  expect(out).toMatchObject({ status: 'rejected', reasons: [{ rule: 'key_conflict', path: 'errors.1.key' }] });
  expect(await q(`select repository from hda_code_error_entries where key = $1`, [first.errors[0]!.key])).toEqual([{ repository: first.repository }]);
});

// --- M7: правило не запрашивает анализ чаще раза в 6 часов ---

test('M7: правило не создаёт новый запрос в течение 6 часов после выполненного или истёкшего; кнопка работает', async () => {
  const t = f.tickets.aOrg;
  const ctx = await l2();
  const first = await requestCodeAnalysis(ctx, { number: t.number });
  await markAnalysisTimeouts(SYSTEM, new Date(Date.now() + 11 * 60_000));
  const rule = () => withActor(SYSTEM, (tx) => requestCodeAnalysisBySystemTx(tx, { ticketId: t.ticketId, orgId: f.orgA.orgId, ruleId: '00000000-0000-0000-0000-000000000001' }));
  expect(await rule()).toBe('cooldown');
  expect((await q(`select count(*)::int as n from hda_code_analysis_requests where ticket_id = $1`, [t.ticketId]))[0].n).toBe(1);
  await q(`update hda_code_analysis_requests set due_on = now() - interval '7 hours', finished_on = now() - interval '7 hours' where request_id = $1`, [first.requestId]);
  expect(await rule()).toBe('requested');
  // Кнопка сотрудника пределом правила не ограничена.
  await markAnalysisTimeouts(SYSTEM, new Date(Date.now() + 11 * 60_000));
  expect((await requestCodeAnalysis(ctx, { number: t.number })).status).toBe('pending');
});
