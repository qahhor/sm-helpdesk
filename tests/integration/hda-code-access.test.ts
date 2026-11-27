import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { seedAgentToken } from './helpers/agent';
import { seedCodeCatalog, seedStaff } from './helpers/code';
import { asActor, pools } from './helpers/db';
import { seedEverything } from './isolation/seed-everything';

// Таблицы знаний из кода и представление первой линии (веха M8c, задача 1; ТЗ 7.22 FR-CODE-02, 05, 11, 12, 10.5;
// план M8c, решения 1, 6-9). Запросы идут напрямую под hub_app с переменными актора: проверяется сама политика.

type Actor = Parameters<typeof asActor>[1];
const SYSTEM: Actor = { type: 'system', job: 'test' };
const TABLES = ['hda_code_scans', 'hda_code_error_entries', 'hda_code_error_templates', 'hda_code_module_notes', 'hda_code_analysis_requests'] as const;

const rows = async (actor: Actor, query: string, params: unknown[] = []) =>
  asActor(pools.app, actor, (c) => c.query(query, params)).then(
    (r) => r.rows,
    (error) => {
      expect(String(error)).toMatch(/permission denied/);
      return [];
    },
  );

const fails = (actor: Actor, query: string, params: unknown[] = []) =>
  expect(asActor(pools.app, actor, (c) => c.query(query, params))).rejects.toThrow(/row-level security|permission denied|violates check|cannot insert|Знания из кода/);

async function world() {
  const f = await seedEverything();
  const l2 = await seedStaff('agent_l2', 'Вторая линия');
  const product = await seedStaff('product', 'Продукт');
  const token = await seedAgentToken({ tools: ['get_ticket', 'add_internal_note'] });
  const catalog = await seedCodeCatalog(token.tokenId, { approvedBy: l2.userId });
  // Ожидающий запрос анализа по обращению организации A создаёт seedEverything.
  const request = (await pools.root.query(`select request_id from hda_code_analysis_requests where ticket_id = $1 and status = 'pending'`, [f.tickets.aOrg.ticketId])).rows[0].request_id as string;
  return { f, l2, product, token, catalog, request };
}

test('клиент не видит ни одной строки знаний из кода и представления первой линии', async () => {
  const { f } = await world();
  for (const actor of [f.aUser.actor, f.aAdmin.actor, f.bUser.actor])
    for (const name of [...TABLES, 'hda_code_checks']) expect(await rows(actor, `select 1 from ${name}`), name).toEqual([]);
});

test('знания читают agent_l2, care и admin; первая линия, product и система таблиц не читают', async () => {
  const { f, l2, product, catalog } = await world();
  for (const actor of [l2.actor, f.care.actor, f.adminStaff.actor]) {
    const entries = await rows(actor, `select entry_id from hda_code_error_entries where entry_id = any($1)`, [[catalog.approvedId, catalog.draftId]]);
    expect(entries.length, actor.type).toBe(2);
    for (const name of TABLES) expect((await rows(actor, `select 1 from ${name}`)).length, name).toBeGreaterThan(0);
  }
  for (const actor of [f.l1.actor, product.actor]) for (const name of TABLES) expect(await rows(actor, `select 1 from ${name}`), name).toEqual([]);
  // Система (AI-помощник, подсказка, Тез) выводов не читает: только функцию сигнатуры.
  for (const name of ['hda_code_error_entries', 'hda_code_error_templates', 'hda_code_module_notes']) expect(await rows(SYSTEM, `select 1 from ${name}`), name).toEqual([]);
});

test('первая линия видит в hda_code_checks только "что проверить" утверждённых записей', async () => {
  const { f, l2, product, catalog } = await world();
  const seen = await rows(f.l1.actor, `select * from hda_code_checks where entry_id = any($1)`, [[catalog.approvedId, catalog.draftId]]);
  expect(seen).toEqual([
    { entry_id: catalog.approvedId, key: catalog.approvedKey, signature: catalog.approvedSignature, module_id: null, what_to_check: ['Остаток по товару на складе заказа', 'Включён ли контроль остатков'] },
  ]);
  expect((await rows(l2.actor, `select 1 from hda_code_checks where entry_id = $1`, [catalog.approvedId])).length).toBe(1);
  for (const actor of [product.actor, SYSTEM, f.aUser.actor]) expect(await rows(actor, `select 1 from hda_code_checks`), actor.type).toEqual([]);
});

test('выражение и сигнатура строятся базой и не записываются', async () => {
  const { catalog } = await world();
  const [template] = (await pools.root.query(`select pattern from hda_code_error_templates where entry_id = $1`, [catalog.approvedId])).rows;
  expect(template.pattern).toMatch(/^\^\\s\*Недостаточно\\s\+остатка\\s\+товара\\s\+\(\.\{1,200\}\?\)\\s\+на\\s\+складе/);
  expect(catalog.approvedSignature).toBe(createHash('sha256').update(`code-key|${catalog.approvedKey}`).digest('hex').slice(0, 32));
  const [built] = (await pools.root.query(`select app.hda_code_pattern('Сумма (итог) больше 5.0 {x}?') as p`)).rows;
  expect(built.p).toBe('^\\s*Сумма\\s+\\(итог\\)\\s+больше\\s+5\\.0\\s+(.{1,200}?)\\?\\s*[.!]?\\s*$');
  await expect(pools.root.query(`insert into hda_code_error_templates (entry_id, locale, template, pattern) values ($1, 'uz', 'Xato {a} bor', '.*')`, [catalog.approvedId])).rejects.toThrow(/non-DEFAULT|generated/);
  await expect(pools.root.query(`update hda_code_error_entries set signature = repeat('0', 32) where entry_id = $1`, [catalog.approvedId])).rejects.toThrow(/non-DEFAULT|generated|can only be updated to DEFAULT/);
  // Обратная косая черта и перевод строки в шаблоне запрещены проверкой базы (FR-CODE-05, 12).
  await expect(pools.root.query(`insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'uz', 'Xato \\d+ {a}')`, [catalog.approvedId])).rejects.toThrow(/hda_code_error_templates_c1/);
});

test('функция сигнатуры отдаёт только сигнатуру утверждённой записи с учётом кода ошибки', async () => {
  const { f, catalog } = await world();
  const suffix = catalog.approvedKey.split('_').slice(-2).join('_');
  const line = `Недостаточно остатка товара "Молоко 1л" на складе Основной ${suffix}.`;
  const call = (actor: Actor, code: string | null, lines: string[]) =>
    asActor(pools.app, actor, (c) => c.query(`select app.hda_code_signature($1, $2) as s`, [code, lines])).then((r) => r.rows[0].s as string | null);
  for (const actor of [SYSTEM, f.aUser.actor, f.l1.actor]) expect(await call(actor, 'ORA-20001', ['Не то', line]), actor.type).toBe(catalog.approvedSignature);
  expect(await call(SYSTEM, null, [line.toLowerCase()])).toBe(catalog.approvedSignature);
  expect(await call(SYSTEM, 'ORA-01403', [line])).toBeNull();
  expect(await call(SYSTEM, null, [`Отрицательный остаток товара Молоко ${suffix}`])).toBeNull();
  // Отклонённая и исчезнувшая записи сигнатуры не дают.
  for (const status of ['rejected', 'removed']) {
    await pools.root.query(`update hda_code_error_entries set status = $2, approved_by = null, approved_on = null where entry_id = $1`, [catalog.approvedId, status]);
    expect(await call(SYSTEM, null, [line]), status).toBeNull();
  }
});

test('AI-сотрудник основным токеном пишет черновики каталога, но не утверждает; токен запуска только читает', async () => {
  const { f, l2, token, catalog } = await world();
  const scan = `insert into hda_code_scans (token_id, scan_key, repository, commit_ref) values ($1, $2, 'smartup-core', 'def5678') returning scan_id`;
  const [created] = await asActor(pools.app, token.actor, (c) => c.query(scan, [token.tokenId, `scan-${Date.now()}`])).then((r) => r.rows);
  expect(created.scan_id).toBeTruthy();
  // Чужим токеном строку сканирования не записать.
  const other = await seedAgentToken();
  await fails(token.actor, scan, [other.tokenId, `scan-other-${Date.now()}`]);
  const entry = `insert into hda_code_error_entries (scan_id, key, repository, raised_in, conditions, user_cause, what_to_check, kind, confidence, status, change_kind, scan_digest, approved_by, approved_on)
                 values ($1, $2, 'smartup-core', '[]', 'Условия', 'Причина', '["Проверить"]', 'data', 0.5, $3, 'new', repeat('c', 64), $4, $5)`;
  await asActor(pools.app, token.actor, (c) => c.query(entry, [created.scan_id, `routes.empty_points_${Date.now()}`, 'draft', null, null]));
  await fails(token.actor, entry, [created.scan_id, `routes.approved_${Date.now()}`, 'approved', l2.userId, new Date()]);
  await fails(token.actor, `update hda_code_error_entries set status = 'approved', approved_by = $2, approved_on = now() where entry_id = $1`, [catalog.draftId, l2.userId]);
  // Неизменная утверждённая запись остаётся утверждённой при обходе сканирования.
  await asActor(pools.app, token.actor, (c) => c.query(`update hda_code_error_entries set scan_id = $2, change_kind = 'same' where entry_id = $1`, [catalog.approvedId, created.scan_id]));
  // Изменившаяся запись агента снова черновик без утвердившего.
  await asActor(pools.app, token.actor, (c) =>
    c.query(`update hda_code_error_entries set scan_digest = repeat('d', 64), status = 'draft', approved_by = null, approved_on = null, change_kind = 'changed' where entry_id = $1`, [catalog.approvedId]),
  );

  const run = await seedAgentToken({ userId: token.userId, parentTokenId: token.tokenId, ticketId: f.tickets.aOrg.ticketId });
  expect((await rows(run.actor, `select 1 from hda_code_error_entries where entry_id = $1`, [catalog.draftId])).length).toBe(1);
  await fails(run.actor, scan, [run.tokenId, `scan-run-${Date.now()}`]);
  await fails(run.actor, `insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'en', 'Negative balance of {product} item')`, [catalog.draftId]);
});

test('сотрудник второй линии утверждает от своего имени и меняет только поля правки и статуса', async () => {
  const { f, l2, catalog } = await world();
  await fails(l2.actor, `update hda_code_error_entries set status = 'approved', approved_by = $2, approved_on = now() where entry_id = $1`, [catalog.draftId, f.care.userId]);
  await asActor(pools.app, l2.actor, (c) => c.query(`update hda_code_error_entries set status = 'approved', approved_by = $2, approved_on = now() where entry_id = $1`, [catalog.draftId, l2.userId]));
  await asActor(pools.app, l2.actor, (c) => c.query(`update hda_code_error_entries set conditions = 'Уточнено', what_to_check = '["Один"]' where entry_id = $1`, [catalog.draftId]));
  for (const change of [`key = 'orders.other'`, `scan_digest = repeat('f', 64)`, `raised_in = '[]'`, `status = 'removed'`])
    await fails(l2.actor, `update hda_code_error_entries set ${change} where entry_id = $1`, [catalog.draftId]);
  expect(await rows(f.l1.actor, `update hda_code_error_entries set conditions = 'Нет' where entry_id = $1 returning 1`, [catalog.draftId])).toEqual([]);
  // Заметку о модуле утверждает только администратор портала.
  const note = `update hda_code_module_notes set status = 'approved', decided_by = $2, decided_on = now() where note_id = $1 returning 1`;
  expect(await rows(f.care.actor, note, [catalog.moduleNoteId, f.care.userId])).toEqual([]);
  expect((await rows(f.adminStaff.actor, note, [catalog.moduleNoteId, f.adminStaff.userId])).length).toBe(1);
});

test('запрос анализа: пишет вторая линия от себя, агент закрывает функцией базы только запросы видимых ему обращений', async () => {
  const { f, l2, token, request } = await world();
  const insert = `insert into hda_code_analysis_requests (org_id, ticket_id, requested_by, source, due_on) values ($1, $2, $3, 'staff', now() + interval '10 minutes')`;
  await fails(f.l1.actor, insert, [f.orgB.orgId, f.tickets.bOrg.ticketId, f.l1.userId]);
  await fails(l2.actor, insert, [f.orgB.orgId, f.tickets.bOrg.ticketId, f.care.userId]);
  await asActor(pools.app, l2.actor, (c) => c.query(insert, [f.orgB.orgId, f.tickets.bOrg.ticketId, l2.userId]));
  // Второй ожидающий запрос по тому же обращению не записать.
  await expect(asActor(pools.app, l2.actor, (c) => c.query(insert, [f.orgB.orgId, f.tickets.bOrg.ticketId, l2.userId]))).rejects.toThrow(/hda_code_analysis_requests_u1/);

  // Агент таблицу запросов не читает и не меняет (независимая проверка, находка I5): ответ отмечает функция базы, и
  // только по обращению организации с AI-обработкой, видимой агенту.
  expect(await rows(token.actor, `select 1 from hda_code_analysis_requests where request_id = $1`, [request])).toEqual([]);
  expect((await asActor(pools.app, token.actor, (c) => c.query(`update hda_code_analysis_requests set status = 'done', finished_on = now() where request_id = $1`, [request]))).rowCount).toBe(0);
  const answer = (actor: Actor) => asActor(pools.app, actor, (c) => c.query(`select request_id, previous_status from app.hda_code_analysis_answer($1, null)`, [f.tickets.aOrg.ticketId])).then((r) => r.rows);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  expect(await answer(token.actor)).toEqual([]);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = true, ai_consent_on = current_date, ai_consent_ref = 'Тестовое согласие' where org_id = $1`, [f.orgA.orgId]);
  for (const actor of [l2.actor, SYSTEM]) expect(await answer(actor), actor.type).toEqual([]);
  expect(await answer(token.actor)).toEqual([{ request_id: request, previous_status: 'pending' }]);
  expect((await pools.root.query(`select status from hda_code_analysis_requests where request_id = $1`, [request])).rows).toEqual([{ status: 'done' }]);
  // Система ставит только истечение срока ожидающему запросу.
  await fails(SYSTEM, `update hda_code_analysis_requests set status = 'pending', finished_on = null where request_id = $1`, [request]);
});
