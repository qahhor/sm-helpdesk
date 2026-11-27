import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { listPublicProblems, publicProblemForText, publicProblemOfTicket, reportAffected } from '@/modules/hdp/api/client';
import { addProblemSignature, createProblem, saveProblem, saveProblemTranslation, setProblemShown, setProblemStatus } from '@/modules/hdp/api/problems';
import { linkTicketToProblem } from '@/modules/hdp/api/links';
import { createTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Что видит клиент об известной проблеме (ТЗ FR-KP-05, 08, 09, 14.5, раздел 8.3; план M5c, задача 4, решения 13-16):
// баннер по сигнатуре, блок в обращении, страница проблем, "Меня это тоже затронуло". Только поля представления
// hdp_problems_public; обходной путь только опубликованным для клиентов решением.

const ERROR_TEXT = 'ORA-20001: Накладная №4512 от 12.03.2026 не проведена';
let f: Fixture;
let l2: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  setJobQueueForTests(new MemoryJobQueue());
  await pools.root.query(`delete from hdc_rate_limits`);
});
afterEach(() => setJobQueueForTests(null));

async function signatureOf(text: string): Promise<string> {
  const { ticketId } = await createTicket(await clientCtx(f.bUser), { description: text, type: 'bug', impact: 'minor', locale: 'ru' });
  return (await pools.root.query(`select error_signature from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0].error_signature as string;
}

/** Показанная проблема с публичным текстом на русском; signature: сигнатура проблемы. */
async function shownProblem(opts: { signature?: string; shown?: boolean } = {}): Promise<number> {
  const { number } = await createProblem(l2, { internalTitle: 'Внутреннее: накладные ACME' });
  if (opts.signature) await addProblemSignature(l2, { number, signature: opts.signature });
  await saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: 'После обновления накладные не проводятся. Исправляем.' });
  if (opts.shown !== false) await setProblemShown(l2, { number, shown: true });
  return number;
}

/** Решение в базе знаний с копией для читателей нужной аудитории. */
async function solution(audience: 'clients' | 'internal'): Promise<number> {
  const a = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ($1, 'ru') returning article_id, number`, [audience])).rows[0];
  const doc = { version: 1, blocks: [] };
  const v = (await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'ru', 1, 'Провести через документ', $2, 'published') returning version_id`, [a.article_id, doc])).rows[0].version_id;
  await pools.root.query(
    `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale) values ($1, $2, 'ru', $3, $4, 'Провести через документ', $5, 'Текст', 'provesti', 'ru')`,
    [a.article_id, a.number, v, audience, doc],
  );
  return Number(a.number);
}

const CARD_KEYS = ['fixedOn', 'number', 'publicBody', 'publicTitle', 'status', 'workaround'];

test('баннер: активная показанная проблема по тексту ошибки; скрытая, исправленная и закрытая не показываются', async () => {
  const sig = await signatureOf(ERROR_TEXT);
  const number = await shownProblem({ signature: sig });
  const card = await publicProblemForText(f.aUser.actor, { text: `Не проводится.\n${ERROR_TEXT}`, locale: 'ru' });
  expect(card).toEqual({ number, status: 'investigating', publicTitle: 'Не проводятся накладные', publicBody: 'После обновления накладные не проводятся. Исправляем.', workaround: null, fixedOn: null });
  // В данных баннера нет внутреннего названия, счётчиков, организаций, сигнатур.
  expect(Object.keys(card!).sort()).toEqual(CARD_KEYS);
  expect(JSON.stringify(card)).not.toContain('ACME');
  // Код и текст из контекста виджета дают ту же сигнатуру.
  expect((await publicProblemForText(f.aUser.actor, { text: '', errorCode: 'ORA-20001', errorText: 'Накладная №1 от 01.01.2026 не проведена', locale: 'ru' }))?.number).toBe(number);
  expect(await publicProblemForText(f.aUser.actor, { text: 'Просто вопрос', locale: 'ru' })).toBeNull();

  await setProblemShown(l2, { number, shown: false });
  expect(await publicProblemForText(f.aUser.actor, { text: ERROR_TEXT, locale: 'ru' })).toBeNull();
  await setProblemShown(l2, { number, shown: true });
  await setProblemStatus(l2, { number, status: 'fixed' });
  expect(await publicProblemForText(f.aUser.actor, { text: ERROR_TEXT, locale: 'ru' })).toBeNull();
});

test('обходной путь показан только опубликованным для клиентов решением', async () => {
  const number = await shownProblem();
  const internal = await solution('internal');
  await saveProblem(l2, { number, internalTitle: 'Внутреннее', moduleId: null, workaroundNumber: internal });
  const ticket = f.tickets.aOrg;
  await linkTicketToProblem(l2, { ticketNumber: ticket.number, problemNumber: number });
  expect((await publicProblemOfTicket(await clientCtx(f.aUser), { ticketNumber: ticket.number, locale: 'ru' }))?.workaround).toBeNull();
  const forClients = await solution('clients');
  await saveProblem(l2, { number, internalTitle: 'Внутреннее', moduleId: null, workaroundNumber: forClients });
  expect((await publicProblemOfTicket(await clientCtx(f.aUser), { ticketNumber: ticket.number, locale: 'ru' }))?.workaround).toEqual({ number: forClients, slug: 'provesti', title: 'Провести через документ' });
});

test('блок в обращении: только своё видимое обращение и только показанная проблема', async () => {
  const number = await shownProblem();
  await linkTicketToProblem(l2, { ticketNumber: f.tickets.aOrg.number, problemNumber: number });
  await linkTicketToProblem(l2, { ticketNumber: f.tickets.bOrg.number, problemNumber: number });
  await linkTicketToProblem(l2, { ticketNumber: f.tickets.aPrivate.number, problemNumber: number });
  expect((await publicProblemOfTicket(await clientCtx(f.aUser), { ticketNumber: f.tickets.aOrg.number, locale: 'ru' }))?.number).toBe(number);
  // Обращение другой организации и личное обращение коллеги клиенту не видны: блока нет.
  expect(await publicProblemOfTicket(await clientCtx(f.aUser), { ticketNumber: f.tickets.bOrg.number, locale: 'ru' })).toBeNull();
  expect(await publicProblemOfTicket(await clientCtx(f.aUser), { ticketNumber: f.tickets.aPrivate.number, locale: 'ru' })).toBeNull();
  await setProblemShown(l2, { number, shown: false });
  expect(await publicProblemOfTicket(await clientCtx(f.aUser), { ticketNumber: f.tickets.aOrg.number, locale: 'ru' })).toBeNull();
});

test('страница проблем: активные и исправленные за 30 суток, без счётчиков и организаций, на языке клиента', async () => {
  const active = await shownProblem();
  const fixed = await shownProblem();
  await setProblemStatus(l2, { number: fixed, status: 'fixed' });
  const old = await shownProblem();
  await setProblemStatus(l2, { number: old, status: 'fixed' });
  await pools.root.query(`update hdp_problems set fixed_on = now() - interval '31 days' where number = $1`, [old]);
  await shownProblem({ shown: false });
  await saveProblemTranslation(l2, { number: active, locale: 'en', publicTitle: 'Invoices are not posted', publicBody: 'We are fixing it.' });
  const list = await listPublicProblems(await clientCtx(f.aUser), { locale: 'en' });
  expect(list.map((p) => p.number)).toEqual([active, fixed]);
  expect(list[0]).toMatchObject({ publicTitle: 'Invoices are not posted' });
  // Перевода нет: текст на языке оригинала.
  expect(list[1]).toMatchObject({ publicTitle: 'Не проводятся накладные', status: 'fixed' });
  for (const item of list) expect(Object.keys(item).sort()).toEqual(CARD_KEYS);
});

test('"Меня это тоже затронуло": привязанное обращение одним нажатием; второе нажатие возвращает тот же номер', async () => {
  const number = await shownProblem();
  const ctx = await clientCtx(f.aUser);
  const first = await reportAffected(ctx, { problemNumber: number, locale: 'ru' });
  expect(first.created).toBe(true);
  const row = (await pools.root.query(`select * from hdt_tickets where number = $1`, [first.number])).rows[0];
  expect(row).toMatchObject({ type: 'bug', impact: 'major', title: 'Не проводятся накладные', author_id: f.aUser.userId, org_id: f.orgA.orgId });
  expect(row.known_problem_id).toBe((await pools.root.query(`select problem_id from hdp_problems where number = $1`, [number])).rows[0].problem_id);
  const count = async () => (await pools.root.query(`select count(*)::int as n from hdt_tickets where author_id = $1`, [f.aUser.userId])).rows[0].n;
  const before = await count();
  expect(await reportAffected(ctx, { problemNumber: number, locale: 'ru', description: 'Ещё раз' })).toEqual({ number: first.number, created: false });
  expect(await count()).toBe(before);
  // Коллега из той же организации получает своё обращение, номер чужого ему не отдаётся.
  const colleague = await reportAffected(await clientCtx(f.aAdmin), { problemNumber: number, locale: 'ru' });
  expect(colleague.created).toBe(true);
  expect(colleague.number).not.toBe(first.number);
  // Скрытая проблема и несуществующая: не найдено.
  await setProblemShown(l2, { number, shown: false });
  await expect(reportAffected(await clientCtx(f.bUser), { problemNumber: number, locale: 'ru' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(reportAffected(await clientCtx(f.bUser), { problemNumber: 999_999, locale: 'ru' })).rejects.toMatchObject({ code: 'not_found' });
});

test('"Меня это тоже затронуло" из виджета: описание из текста ошибки контекста, привязка по сигнатуре', async () => {
  const sig = await signatureOf(ERROR_TEXT);
  const number = await shownProblem({ signature: sig });
  const result = await reportAffected(await clientCtx(f.aUser), { problemNumber: number, locale: 'ru', context: { errorCode: 'ORA-20001', errorText: 'Накладная №77 от 01.01.2026 не проведена' }, platform: 'web' });
  const row = (await pools.root.query(`select description, source, error_signature from hdt_tickets where number = $1`, [result.number])).rows[0];
  expect(row).toMatchObject({ source: 'widget_web', error_signature: sig });
  expect(row.description).toContain('Накладная №77');
  expect((await pools.root.query(`select payload from hdt_ticket_events where kind = 'known_problem' and ticket_id = (select ticket_id from hdt_tickets where number = $1)`, [result.number])).rows).toEqual([
    { payload: { action: 'linked', problemNumber: number, via: 'signature' } },
  ]);
});
