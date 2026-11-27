import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import {
  approveCodeEntry,
  approveModuleNote,
  codeEntryCard,
  codeKnowledgeMetrics,
  editCodeEntry,
  listCodeEntries,
  listCodeScans,
  listModuleNotes,
  rejectCodeEntry,
  rejectModuleNote,
} from '@/modules/hda/api/code-knowledge';
import { uniqueReport } from '../helpers/code-scan';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Очередь "Знания из кода", карточка записи, заметки о модулях и показатель пользы (веха M8c, задача 4; ТЗ 7.22
// FR-CODE-03, 13, 15, FR-ADM-15, 8.12; план M8c, решения 9, 10, 14, 23, 24, 26).

beforeEach(() => setLogSinkForTests(() => undefined));
afterEach(() => setLogSinkForTests(null));

async function scanned() {
  const f = await seedTwoOrgs();
  const token = await seedAgentToken({ tools: ['code_catalog_upsert'] as never });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const report = uniqueReport();
  const out = await client.callTool('code_catalog_upsert', report);
  if (out.isError) throw new Error(out.content[0]!.text);
  const l2 = staffCtx({ ...(await staffWithRole('agent_l2')), name: 'Вторая линия' });
  return { f, report, client, l2, care: staffCtx(f.care), admin: staffCtx(f.adminStaff), l1: staffCtx(f.l1), product: staffCtx({ ...(await staffWithRole('product')), name: 'Продукт' }) };
}

/** Версия записи со страницы (независимая проверка M8c, находка I7): утверждение и правка её передают. */
const version = async (ctx: Parameters<typeof codeEntryCard>[0], key: string) => (await codeEntryCard(ctx, { key })).version;

const audit = async (action: string, objectId?: string) =>
  (await pools.root.query(`select actor_id, diff from hdc_audit_log where action = $1 ${objectId ? 'and object_id = $2' : ''} order by created_on`, objectId ? [action, objectId] : [action])).rows;

test('очередь видят agent_l2, care, admin; новые выделены; первая линия и product получают forbidden', async () => {
  const { report, l2, care, admin, l1, product } = await scanned();
  for (const ctx of [l2, care, admin]) {
    const list = await listCodeEntries(ctx, { status: 'draft' });
    const mine = list.items.filter((item) => item.repository === report.repository);
    expect(mine.map((item) => item.key).sort()).toEqual(report.errors.map((e) => e.key).sort());
    expect(mine.every((item) => item.changeKind === 'new' && item.highlighted)).toBe(true);
  }
  for (const ctx of [l1, product]) {
    await expect(listCodeEntries(ctx, {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(codeEntryCard(ctx, { key: report.errors[0]!.key })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(approveCodeEntry(ctx, { key: report.errors[0]!.key, version: '0000000000000000-1' })).rejects.toMatchObject({ code: 'forbidden' });
  }
});

test('карточка: шаблоны, условия, что проверить, место в коде ссылкой; кода нет', async () => {
  const { report, l2 } = await scanned();
  const card = await codeEntryCard(l2, { key: report.errors[0]!.key });
  expect(card).toMatchObject({
    key: report.errors[0]!.key,
    code: 'ORA-20001',
    status: 'draft',
    conditions: report.errors[0]!.conditions,
    whatToCheck: report.errors[0]!.whatToCheck,
    raisedIn: [{ object: 'ORDER_PKG.SAVE_ORDER', path: 'db/packages/order_pkg.pkb', line: 412 }],
    repository: report.repository,
  });
  expect(card.templates.map((t) => t.locale).sort()).toEqual(['en', 'ru', 'uz']);
  await expect(codeEntryCard(l2, { key: 'nothing.here' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(codeEntryCard(l2, { key: 'BAD KEY' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('утверждение от имени сотрудника и отклонение с журналом аудита той же транзакцией; повтор ничего не меняет', async () => {
  const { report, l2, care } = await scanned();
  const [first, second] = [report.errors[0]!.key, report.errors[1]!.key];
  await approveCodeEntry(l2, { key: first, version: await version(l2, first) });
  const card = await codeEntryCard(care, { key: first });
  expect(card).toMatchObject({ status: 'approved', approvedBy: { id: l2.user.id } });
  await approveCodeEntry(l2, { key: first, version: card.version });
  expect((await audit('code.entry_approved')).filter((row) => row.diff.entry === first)).toEqual([{ actor_id: l2.user.id, diff: { entry: first } }]);
  await rejectCodeEntry(care, { key: second, reason: 'Неверная причина' });
  expect(await codeEntryCard(l2, { key: second })).toMatchObject({ status: 'rejected', rejectReason: 'Неверная причина', approvedBy: null });
  expect((await audit('code.entry_rejected')).filter((row) => row.diff.entry === second).length).toBe(1);
  // Отклонённую можно утвердить, утверждённую отклонить.
  await rejectCodeEntry(l2, { key: first });
  await approveCodeEntry(l2, { key: second, version: await version(l2, second) });
  expect((await codeEntryCard(l2, { key: second })).status).toBe('approved');
});

test('правка: шаблон с выражением отклоняется теми же правилами, выражение перестраивает база, аудит', async () => {
  const { report, l2 } = await scanned();
  const key = report.errors[0]!.key;
  const base = { key, version: await version(l2, key), conditions: 'Уточнено сотрудником', userCause: 'Причина', whatToCheck: ['Остаток'], kind: 'user_error' as const };
  await expect(editCodeEntry(l2, { ...base, templates: { ru: 'Недостаточно .* остатка {p}' } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(editCodeEntry(l2, { ...base, conditions: Array.from({ length: 11 }, () => 'строка').join('\n'), templates: { ru: 'Нет остатка товара {p}' } })).rejects.toMatchObject({ code: 'invalid_input' });
  await editCodeEntry(l2, { ...base, templates: { ru: 'Нет остатка товара {p} на складе', en: 'No stock of {p} left in the warehouse' } });
  const card = await codeEntryCard(l2, { key });
  expect(card).toMatchObject({ conditions: 'Уточнено сотрудником', whatToCheck: ['Остаток'] });
  expect(card.templates.map((t) => [t.locale, t.template])).toEqual([
    ['en', 'No stock of {p} left in the warehouse'],
    ['ru', 'Нет остатка товара {p} на складе'],
  ]);
  const [pattern] = (await pools.root.query(`select t.pattern from hda_code_error_templates t join hda_code_error_entries e using (entry_id) where e.key = $1 and t.locale = 'ru'`, [key])).rows;
  expect(pattern.pattern).toContain('Нет\\s+остатка\\s+товара\\s+(.{1,200}?)');
  expect((await audit('code.entry_edited')).filter((row) => row.diff.entry === key).length).toBe(1);
});

test('заметки о модулях: отличие от справочника, утверждение администратором со свежим входом создаёт модуль или меняет экраны', async () => {
  const { report, admin, care } = await scanned();
  const [orders, stock] = report.modules;
  // Модуль склада уже есть в справочнике с другими экранами.
  await pools.root.query(`insert into hdr_product_modules (code, name, screens) values ($1, '{"ru": "Склад старый"}', '[]')`, [stock!.code]);
  const notes = (await listModuleNotes(admin)).filter((n) => n.repository === report.repository);
  expect(Object.fromEntries(notes.map((n) => [n.moduleCode, n.directory]))).toEqual({ [orders!.code]: 'missing', [stock!.code]: 'screens_differ' });
  await expect(approveModuleNote(care, { code: orders!.code })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(approveModuleNote({ ...admin, freshAuthAt: new Date(Date.now() - 3_600_000) }, { code: orders!.code })).rejects.toMatchObject({ code: 'stale_session' });
  await approveModuleNote(admin, { code: orders!.code });
  await approveModuleNote(admin, { code: stock!.code });
  const modules = (await pools.root.query(`select code, name, screens from hdr_product_modules where code = any($1) order by code`, [[orders!.code, stock!.code]])).rows;
  expect(modules).toEqual([
    { code: orders!.code, name: orders!.name, screens: orders!.screens },
    { code: stock!.code, name: { ru: 'Склад старый' }, screens: stock!.screens },
  ]);
  expect((await audit('code.module_approved')).filter((row) => [orders!.code, stock!.code].includes(row.diff.module)).length).toBe(2);
  const after = (await listModuleNotes(admin)).filter((n) => n.repository === report.repository);
  expect(after.every((n) => n.status === 'approved' && n.directory === 'same')).toBe(true);
  await expect(rejectModuleNote(admin, { code: 'nothing' })).rejects.toMatchObject({ code: 'not_found' });
});

test('история сканирований с числами; показатель пользы по сигнатурам обращений и решениям из записей', async () => {
  const { f, report, l2 } = await scanned();
  const scans = (await listCodeScans(l2)).filter((s) => s.repository === report.repository);
  expect(scans).toEqual([expect.objectContaining({ status: 'accepted', added: 3, changed: 0, removed: 0, commit: 'abc1234', scanKey: report.scanId })]);
  const [entry] = (await pools.root.query(`select signature from hda_code_error_entries where key = $1`, [report.errors[0]!.key])).rows;
  const before = await codeKnowledgeMetrics(l2, { days: 30 });
  await pools.root.query(`update hdt_tickets set error_signature = $2 where ticket_id = $1`, [f.tickets.aOrg.ticketId, entry.signature]);
  await pools.root.query(`update hdt_tickets set error_signature = repeat('9', 32) where ticket_id = $1`, [f.tickets.bOrg.ticketId]);
  const after = await codeKnowledgeMetrics(l2, { days: 30 });
  expect(after.fromTemplate - before.fromTemplate).toBe(1);
  expect(after.withSignature - before.withSignature).toBe(2);
  expect(after.solutionsFromEntries).toBeGreaterThanOrEqual(0);
});
