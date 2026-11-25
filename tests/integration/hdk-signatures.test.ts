import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { createSolutionFromTicket } from '@/modules/hdk/api/from-ticket';
import { publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { bindSolutionSignature, repairTicketSignatures, solutionSignatures, unbindSolutionSignature } from '@/modules/hdk/api/signatures';
import { suggestForClient } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { createTicket, getTicket } from '@/modules/hdt/api';
import { addMembership, clientCtx, ensureOrg, staffCtx, staffWithRole, verifiedClientFixture } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Сигнатуры ошибок (план M5, задача 8; ТЗ 11.5, FR-SOL-07, 12; решения 7 и 8). Сигнатуру обращения считает сервер
// от имени системы: клиент её не задаёт и не читает. Организации сигнатуры пишет система; одна ошибка у разных
// клиентов с разными номерами даёт одну сигнатуру, пример текста для сотрудников без данных клиента. Сотрудник
// привязывает решение к сигнатурам в редакторе, решение из обращения получает сигнатуру обращения.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.index' };
let f: Fixture;
let serial = 0;
const newId = () => `sig${String(++serial).padStart(9, '0')}`;
const p = (text: string) => ({ type: 'paragraph' as const, attrs: { id: newId() }, content: [{ type: 'text' as const, text }] });
const step = (text: string) => ({ type: 'step' as const, attrs: { id: newId() }, content: [p(text)] });
const LABELS = { what: 'Что видит пользователь', why: 'Почему так происходит', do: 'Что сделать' };

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hdk_search_documents`);
  await pools.root.query(`delete from hdc_rate_limits where code like 'kb-%' or code like 'ticket-create%'`);
  await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

const report = async (member: { userId: string }, description: string) => createTicket(await clientCtx(member), { description, type: 'bug', impact: 'minor', locale: 'ru' });
const ticketSignature = async (ticketId: string) => (await pools.root.query(`select error_signature from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0].error_signature as string | null;
const signatureRow = async (signature: string) => (await pools.root.query(`select * from hdk_error_signatures where signature = $1`, [signature])).rows[0];

/** Клиент третьей организации. */
async function thirdClient() {
  const orgId = await ensureOrg(`Третья организация ${Date.now()}`);
  const user = await verifiedClientFixture(`third-${Date.now()}-${Math.random()}@client.example`, { memberships: 0 });
  await addMembership(user.userId, orgId);
  return { ...user, orgId };
}

async function publishedSolution(title: string, what: string) {
  // Панель готовности требует модуль (UX-W-07).
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('sig-${Date.now()}-${Math.random()}', '{"ru": "Заказы"}') returning module_id`)).rows[0].module_id as string;
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience: 'clients', moduleId, doc: { version: 1, blocks: [p(what), step('Откройте настройки периода')] } });
  const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const outcome = await publishSolution(l2, { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false });
  expect(outcome.status).toBe('published');
  await runIndexJob(SYSTEM, { articleId: created.articleId });
  return created;
}

test('сигнатуру считает сервер: одна ошибка у трёх организаций с разными номерами даёт одну сигнатуру и три организации', async () => {
  const third = await thirdClient();
  const a = await report(f.aUser, 'Добрый день. При проведении заказа выходит:\nORA-20001: Документ №4512 от 12.03.2026 не найден\nORA-06512: at "SALES.ORDER", line 120');
  const b = await report(f.bUser, 'ORA-20001: Документ №17 от 01.11.2026 не найден');
  const c = await report(third, 'Не проводится документ.\nORA-20001: Документ №900001 от 05.01.2026 не найден');
  // Второе обращение той же организации: организаций по-прежнему три, встреч четыре.
  await report(f.aAdmin, 'ORA-20001: Документ №1 от 02.02.2026 не найден');
  const signature = await ticketSignature(a.ticketId);
  expect(signature).toMatch(/^[0-9a-f]{32}$/);
  expect(await ticketSignature(b.ticketId)).toBe(signature);
  expect(await ticketSignature(c.ticketId)).toBe(signature);
  const row = await signatureRow(signature!);
  expect(row).toMatchObject({ article_id: null, sample_code: 'ORA-20001', sample_message: 'документ №<n> от <n>.<n> не найден', org_count: 3, occurrences: 4 });
  const orgs = (await pools.root.query(`select org_id from hdk_signature_orgs where signature_id = $1 order by org_id`, [row.signature_id])).rows.map((r) => r.org_id);
  expect(orgs.sort()).toEqual([f.orgA.orgId, f.orgB.orgId, third.orgId].sort());
  // Клиент сигнатуру своего обращения не получает: ни страницей обращения, ни прямым запросом к таблицам знаний.
  const view = await getTicket(await clientCtx(f.aUser), a.number);
  expect(view).not.toBeNull();
  expect(JSON.stringify(view)).not.toContain(signature);
  for (const table of ['hdk_error_signatures', 'hdk_signature_orgs'])
    expect(await asActor(pools.app, f.aUser.actor, async (client) => (await client.query(`select 1 from ${table}`)).rowCount), table).toBe(0);
});

test('разные ошибки с одним кодом Oracle дают разные сигнатуры; описание без строки ошибки сигнатуры не получает', async () => {
  const doc = await report(f.aUser, 'ORA-20001: Документ №4512 не найден');
  const period = await report(f.aUser, 'ORA-20001: Период 03.2026 закрыт для изменений');
  const plain = await report(f.aUser, 'Не печатается накладная, принтер молчит. См. SUP-1234');
  const [s1, s2] = [await ticketSignature(doc.ticketId), await ticketSignature(period.ticketId)];
  expect(s1).toMatch(/^[0-9a-f]{32}$/);
  expect(s2).toMatch(/^[0-9a-f]{32}$/);
  expect(s1).not.toBe(s2);
  expect(await ticketSignature(plain.ticketId)).toBeNull();
});

test('пример текста ошибки без почты, телефона, имени автора и названия организации', async () => {
  const author = (await pools.root.query(`select name from auth."user" where id = $1`, [f.aUser.userId])).rows[0].name as string;
  const created = await report(f.aUser, `ORA-20999: Пользователь ${author} из ${f.orgA.name} (тел. +998 90 123 45 67, почта dilshod.k@firma.uz) не может провести документ`);
  const row = await signatureRow((await ticketSignature(created.ticketId))!);
  const sample = row.sample_message as string;
  expect(sample).toContain('не может провести документ');
  for (const leaked of [author.toLowerCase(), f.orgA.name.toLowerCase(), 'dilshod', 'firma', '123'])
    expect(sample, leaked).not.toContain(leaked);
});

test('клиент не задаёт сигнатуру: вставка обращения с error_signature отклоняется базой', async () => {
  const insert = (withSignature: boolean) =>
    asActor(pools.app, f.aUser.actor, (c) =>
      c.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source${withSignature ? ', error_signature' : ''})
         values ($1, $2, 'bug', 'minor', 'p3', 'org', 'Ошибка', 'ORA-20001: x', 'ru', 'portal'${withSignature ? `, '${'a'.repeat(32)}'` : ''})`,
        [f.orgA.orgId, f.aUser.userId],
      ),
    );
  await expect(insert(false)).resolves.toMatchObject({ rowCount: 1 });
  await expect(insert(true)).rejects.toMatchObject({ code: '42501' });
  // Правкой своего обращения клиент сигнатуру тоже не меняет.
  await expect(
    asActor(pools.app, f.aUser.actor, (c) => c.query(`update hdt_tickets set error_signature = $2 where ticket_id = $1`, [f.tickets.aOrg.ticketId, 'b'.repeat(32)])),
  ).rejects.toMatchObject({ code: '42501' });
});

test('подсказка: строка ошибки в описании даёт точное совпадение привязанного решения и число организаций от трёх', async () => {
  const solution = await publishedSolution('Документ не найден при проведении', 'При проведении выходит ошибка о ненайденном документе');
  const outcome = await bindSolutionSignature(staffCtx(f.l1), { number: solution.number, errorText: 'ORA-20001: Документ №1 не найден' });
  expect(outcome).toMatchObject({ status: 'bound' });
  const ask = async (member: { userId: string }) =>
    (await suggestForClient(await clientCtx(member), { text: `Здравствуйте, выходит ORA-20001: Документ №${Math.floor(Math.random() * 1000)} не найден`, sessionId: randomUUID(), locale: 'ru' })).items;
  // Две организации: точное совпадение есть, числа нет.
  await report(f.aUser, 'ORA-20001: Документ №5 не найден');
  expect(await ask(f.bUser)).toMatchObject([{ number: solution.number, exact: true, orgCount: null }]);
  // Третья организация встретила ошибку: число 3 показывается, без названий.
  const third = await thirdClient();
  const shown = await ask(third);
  expect(shown).toMatchObject([{ number: solution.number, exact: true, orgCount: 3 }]);
  expect(JSON.stringify(shown)).not.toContain(f.orgA.name);
});

test('редактор: привязка по тексту и по строке списка, чужая привязка, отвязка, журнал; product и клиент не могут', async () => {
  const one = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Документ не найден', audience: 'clients', doc: { version: 1, blocks: [p('x')] } });
  const two = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Период закрыт', audience: 'clients', doc: { version: 1, blocks: [p('y')] } });
  // Код и текст отдельно и строка целиком дают одну сигнатуру; повтор не создаёт вторую строку и записи журнала.
  expect(await bindSolutionSignature(staffCtx(f.l1), { number: one.number, errorCode: 'ora-20001', errorText: 'Документ 12 не найден' })).toMatchObject({ status: 'bound' });
  expect(await bindSolutionSignature(staffCtx(f.l1), { number: one.number, errorText: 'ORA-20001: Документ 99 не найден' })).toMatchObject({ status: 'bound' });
  // Сигнатура из обращения (строка без решения) привязывается по идентификатору.
  const ticket = await report(f.aUser, 'Ошибка: Период закрыт для изменений');
  const fromTicket = await signatureRow((await ticketSignature(ticket.ticketId))!);
  expect(await bindSolutionSignature(staffCtx(f.l1), { number: one.number, signatureId: fromTicket.signature_id })).toMatchObject({ status: 'bound' });
  const list = await solutionSignatures(staffCtx(f.l1), { number: one.number });
  expect(list).toHaveLength(2);
  expect(list.map((s) => s.sampleCode)).toEqual(expect.arrayContaining(['ORA-20001', null]));
  expect(list.find((s) => s.sampleCode === 'ORA-20001')).toMatchObject({ sampleMessage: 'документ <n> не найден' });
  expect(list.find((s) => s.signatureId === fromTicket.signature_id)).toMatchObject({ sampleMessage: 'период закрыт для изменений', orgCount: 1, occurrences: 1 });
  // Сигнатура уже у другого решения: не перехватывается, ответ называет решение.
  expect(await bindSolutionSignature(staffCtx(f.l1), { number: two.number, errorText: 'ORA-20001: Документ 1 не найден' })).toEqual({ status: 'taken', number: one.number });
  expect(await bindSolutionSignature(staffCtx(f.l1), { number: two.number, errorText: '   ' }).catch((e) => e.code)).toBe('invalid_input');
  // Журнал аудита: привязка и отвязка.
  await unbindSolutionSignature(staffCtx(f.l1), { number: one.number, signatureId: fromTicket.signature_id });
  expect((await signatureRow(fromTicket.signature)).article_id).toBeNull();
  const audit = (await pools.root.query(`select action from hdc_audit_log where object_id = $1 order by created_on`, [one.articleId])).rows.map((r) => r.action);
  expect(audit.filter((a) => a.startsWith('solution.signature_'))).toEqual(['solution.signature_bound', 'solution.signature_bound', 'solution.signature_unbound']);
  // product только читает; клиенту функции не даны.
  const product = staffCtx(await staffWithRole('product'));
  expect((await solutionSignatures(product, { number: one.number })).length).toBe(1);
  await expect(bindSolutionSignature(product, { number: two.number, errorText: 'ORA-20002: x y' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(unbindSolutionSignature(product, { number: one.number, signatureId: list[0]!.signatureId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(solutionSignatures((await clientCtx(f.aUser)) as never, { number: one.number })).rejects.toMatchObject({ code: 'forbidden' });
});

test('решение из обращения получает сигнатуру обращения; занятая сигнатура не перехватывается', async () => {
  const created = await report(f.aUser, 'ORA-20001: Остаток товара "Молоко" недостаточен');
  await pools.root.query(`update hdt_tickets set status = 'resolved' where ticket_id = $1`, [created.ticketId]);
  const signature = (await ticketSignature(created.ticketId))!;
  const solution = await createSolutionFromTicket(staffCtx(f.l1), { number: created.number }, () => LABELS, newId);
  const article = (await pools.root.query(`select article_id from hdk_articles where number = $1`, [solution.number])).rows[0].article_id;
  expect((await signatureRow(signature)).article_id).toBe(article);
  // Второе обращение с той же ошибкой: его решение сигнатуру не забирает.
  const again = await report(f.bUser, 'ORA-20001: Остаток товара "Кефир" недостаточен');
  await pools.root.query(`update hdt_tickets set status = 'resolved' where ticket_id = $1`, [again.ticketId]);
  await createSolutionFromTicket(staffCtx(f.l1), { number: again.number }, () => LABELS, newId);
  expect((await signatureRow(signature)).article_id).toBe(article);
});

// --- Повторная проверка M5 (docs/decisions/0057, M7m) ---

/** Процесс упал между записью обращения и записью сигнатуры: у обращения сигнатуры нет, встреч нет. */
async function lostSignature(ticketId: string, age: string) {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`update hdt_tickets set error_signature = null, created_on = now() - $2::interval where ticket_id = $1`, [ticketId, age]);
    await client.query('commit');
  } finally {
    client.release();
  }
  await pools.root.query(`delete from hdk_signature_orgs`);
  await pools.root.query(`delete from hdk_error_signatures`);
}

test('M7m: сверка дописывает потерянную сигнатуру недавнего обращения; старое, свежее и обращение без строки ошибки не трогает', async () => {
  const lost = await report(f.aUser, 'Не проводится.\nORA-20001: Документ №4512 от 12.03.2026 не найден');
  const old = await report(f.bUser, 'ORA-20002: Склад закрыт для документа №1');
  const plain = await report(f.aAdmin, 'Просто вопрос без ошибки');
  await lostSignature(lost.ticketId, '2 hours');
  await lostSignature(old.ticketId, '30 days');
  const fresh = await report(f.aAdmin, 'ORA-20003: Касса №2 не открыта');
  await lostSignature(fresh.ticketId, '1 minute');
  const result = await repairTicketSignatures(SYSTEM);
  expect(result.repaired).toBe(1);
  const signature = await ticketSignature(lost.ticketId);
  expect(signature).toMatch(/^[0-9a-f]{32}$/);
  expect(await signatureRow(signature!)).toMatchObject({ org_count: 1, occurrences: 1 });
  expect(await ticketSignature(old.ticketId)).toBeNull();
  expect(await ticketSignature(fresh.ticketId)).toBeNull();
  expect(await ticketSignature(plain.ticketId)).toBeNull();
  // Повтор ничего не удваивает.
  expect((await repairTicketSignatures(SYSTEM)).repaired).toBe(0);
  expect(await signatureRow(signature!)).toMatchObject({ org_count: 1, occurrences: 1 });
});
