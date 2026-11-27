import { expect, test } from 'vitest';
import { anonymizeForAgent } from '@/modules/hda/agent/anonymize';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { rootWithoutTriggers, type SeededToken, seedAgentToken } from './helpers/agent';
import { asActor, pools } from './helpers/db';
import { seedEverything } from './isolation/seed-everything';

// Представления для AI-сотрудника (веха M8b, задача 2; FR-AGT-06, FR-AGT-12, 14.3 "Внутренние агенты"; план M8b,
// решения 6, 7, 15). Запросы напрямую под hub_app с переменными актора agent: проверяется само представление.

type Actor = Parameters<typeof asActor>[1];
const read = async (actor: Actor, query: string, params: unknown[] = []) => (await asActor(pools.app, actor, (c) => c.query(query, params))).rows;
const columns = async (view: string) =>
  (await pools.owner.query(`select column_name from information_schema.columns where table_name = $1 order by ordinal_position`, [view])).rows.map((r) => r.column_name as string);

const VIEWS = ['hda_agent_tickets', 'hda_agent_messages', 'hda_agent_solutions', 'hda_agent_candidates', 'hda_agent_problems', 'hda_agent_ideas'];

async function setup() {
  const f = await seedEverything();
  const main = await seedAgentToken();
  // Организация без AI-обработки и служебная "Неопознанные" со своими обращениями.
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  await pools.root.query(`insert into hdu_organizations (org_id, name, kind) values (app.service_org_id(), 'Неопознанные', 'service') on conflict do nothing`);
  const guest = (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Гость', $1, false) returning id`, [`guest-${Date.now()}@users.invalid`])).rows[0].id;
  const unidentified = (
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
       values (app.service_org_id(), $1, 'question', 'minor', 'p3', 'private', 'Письмо гостя', 'Пишет guest@mail.uz', 'ru', 'email') returning ticket_id`,
      [guest],
    )
  ).rows[0].ticket_id as string;
  await pools.root.query(`update hdu_organizations set category = 'B' where org_id = $1`, [f.orgA.orgId]);
  return { f, main, unidentified };
}

test('у каждого представления нет колонок контактов, названия, ИНН, сервера и автора-пользователя', async () => {
  await setup();
  for (const view of VIEWS) {
    const names = await columns(view);
    expect(names.length, view).toBeGreaterThan(0);
    for (const forbidden of ['author_id', 'author_name', 'author_org_name', 'name', 'inn', 'server_id', 'email', 'phone', 'context', 'assignee_id', 'owner_id', 'uploader_id', 'storage_key', 'file_name', 'by_user', 'picked_up_by'])
      expect(names, `${view}.${forbidden}`).not.toContain(forbidden);
  }
  expect(await columns('hda_agent_tickets')).toEqual(expect.arrayContaining(['ticket_id', 'number', 'org_id', 'org_category', 'title', 'description', 'status', 'priority']));
});

test('обращения: только организации с AI-обработкой, без "Неопознанных"; выключение AI убирает их следующим запросом', async () => {
  const { f, main, unidentified } = await setup();
  const ids = async () => (await read(main.actor, `select ticket_id, org_category from hda_agent_tickets order by number`)).map((r) => r.ticket_id as string);
  const seen = await ids();
  // Видимость private не мешает: агент внутренний (решение 6).
  expect(seen).toEqual([f.tickets.aOrg.ticketId, f.tickets.aPrivate.ticketId, f.tickets.aMine.ticketId]);
  expect(seen).not.toContain(f.tickets.bOrg.ticketId);
  expect(seen).not.toContain(unidentified);
  expect((await read(main.actor, `select distinct org_category from hda_agent_tickets`)).map((r) => r.org_category)).toEqual(['B']);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  expect(await ids()).toEqual([]);
});

test('сообщения: публичные, помощника, заметки агента, внутренние заметки сотрудников и поля передачи; без вложений', async () => {
  const { f, main } = await setup();
  const ticket = f.tickets.aOrg.ticketId;
  await rootWithoutTriggers(
    `insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, is_internal, ai_payload)
     values ($1, $2, 'ai', 'Попробуйте решение', false, '{"kind": "answer", "introId": "a", "articleId": "019a0000-0000-7000-8000-000000000001", "articleNumber": 17, "locale": "ru"}')`,
    [f.orgA.orgId, ticket],
  );
  await rootWithoutTriggers(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, agent_note_kind) values ($1, $2, $3, 'agent', 'Заметка агента', true, 'note')`, [
    f.orgA.orgId,
    ticket,
    main.userId,
  ]);
  const rows = await read(main.actor, `select item_kind, author_type, author_no, body, ai_kind, ai_solution_number, reason_code, checked, needed from hda_agent_messages where ticket_id = $1 order by created_on, item_kind`, [ticket]);
  const bodies = rows.map((r) => r.body);
  expect(bodies).toContain('Публичное сообщение');
  expect(bodies).toContain('Попробуйте решение');
  expect(bodies).toContain('Заметка агента');
  // Внутренняя заметка сотрудника видна агенту (решение владельца 27.11.2026, решение 0114): обезличивает её код.
  expect(bodies).toContain('Внутренняя заметка');
  expect(rows.find((r) => r.body === 'Внутренняя заметка')).toMatchObject({ author_type: 'staff', author_no: 1 });
  expect(rows.find((r) => r.author_type === 'ai')).toMatchObject({ ai_kind: 'answer', ai_solution_number: '17' });
  expect(rows.find((r) => r.author_type === 'client')).toMatchObject({ author_no: 1 });
  expect(rows.find((r) => r.item_kind === 'line_transfer')).toMatchObject({ reason_code: 'other', checked: 'Проверено', needed: 'Нужно', body: null });
  // Обращения организаций без AI-обработки не дают и сообщений.
  expect(await read(main.actor, `select 1 from hda_agent_messages where ticket_id = $1`, [f.tickets.bOrg.ticketId])).toEqual([]);
});

test('внутренняя заметка сотрудника видна агенту и обезличивается; заметок организаций без AI-обработки и "Неопознанных" нет', async () => {
  const { f, main, unidentified } = await setup();
  const note = (orgId: string, ticketId: string, body: string) =>
    pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', $4, true)`, [
      orgId,
      ticketId,
      f.adminStaff.userId,
      body,
    ]);
  await note(f.orgA.orgId, f.tickets.aOrg.ticketId, 'Клиент просит перезвонить: +998 90 123-45-67, почта buh@acme.uz');
  await note(f.orgB.orgId, f.tickets.bOrg.ticketId, 'Заметка организации без AI');
  await note(SERVICE_ORG_ID, unidentified, 'Заметка по письму гостя');
  const rows = await read(main.actor, `select ticket_id, body, is_internal, author_type from hda_agent_messages where item_kind = 'message' and is_internal and author_type = 'staff'`);
  const contact = rows.find((r) => String(r.body).includes('перезвонить'));
  expect(contact).toMatchObject({ ticket_id: f.tickets.aOrg.ticketId, is_internal: true });
  const clean = anonymizeForAgent(String(contact!.body), { people: [], orgTerms: [] }).text;
  expect(clean).not.toContain('123-45-67');
  expect(clean).not.toContain('buh@acme.uz');
  expect(clean).toContain('[телефон]');
  expect(clean).toContain('[email]');
  const bodies = rows.map((r) => r.body);
  expect(bodies).not.toContain('Заметка организации без AI');
  expect(bodies).not.toContain('Заметка по письму гостя');
  // Выключение AI-обработки закрывает и внутренние заметки.
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  expect(await read(main.actor, `select 1 from hda_agent_messages where is_internal and author_type = 'staff'`)).toEqual([]);
});

test('решения только опубликованные обеих аудиторий со статистикой; проблемы без разбивки по организациям', async () => {
  const { main } = await setup();
  const solutions = await read(main.actor, `select audience, title, helped_count, staff_useful_count from hda_agent_solutions order by audience`);
  expect(solutions.map((r) => r.audience)).toEqual(['clients', 'internal']);
  const draft = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ('internal', 'ru') returning article_id`)).rows[0].article_id;
  expect(await read(main.actor, `select 1 from hda_agent_solutions where article_id = $1`, [draft])).toEqual([]);
  const problems = await read(main.actor, `select number, internal_title, signatures, org_count from hda_agent_problems order by number`);
  expect(problems.map((r) => r.internal_title)).toEqual(['Накладные ACME не проводятся', 'Скрытая проблема', 'Закрытая проблема', 'Черновик AI-сотрудника']);
  expect(problems[0].signatures).toEqual(['b'.repeat(32)]);
});

test('идеи без авторов и без идей организаций с выключенной AI-обработкой; кандидаты с номерами источников', async () => {
  const { f, main } = await setup();
  // Опубликованная идея Б не видна: AI-обработка Б выключена.
  expect(await read(main.actor, `select 1 from hda_agent_ideas`)).toEqual([]);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = true where org_id = $1`, [f.orgB.orgId]);
  const ideas = await read(main.actor, `select status, title, body, vote_count from hda_agent_ideas`);
  // Идеи на модерации не видны, опубликованная видна с текстом языка оригинала.
  expect(ideas).toEqual([expect.objectContaining({ status: 'open', title: 'Идея', body: 'Описание' })]);
  const candidates = await read(main.actor, `select title, source_numbers from hda_agent_candidates`);
  expect(candidates).toEqual([{ title: 'Кандидат: накладная', source_numbers: [String(f.tickets.aOrg.number)] }]);
  // Источник из организации без AI-обработки закрывает кандидата целиком.
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  expect(await read(main.actor, `select 1 from hda_agent_candidates`)).toEqual([]);
});

test('токен запуска видит только своё обращение и его сообщения, остальные представления пусты', async () => {
  const { f, main } = await setup();
  const run: SeededToken = await seedAgentToken({ userId: main.userId, parentTokenId: main.tokenId, ticketId: f.tickets.aOrg.ticketId });
  expect((await read(run.actor, `select ticket_id from hda_agent_tickets`)).map((r) => r.ticket_id)).toEqual([f.tickets.aOrg.ticketId]);
  expect((await read(run.actor, `select distinct ticket_id from hda_agent_messages`)).map((r) => r.ticket_id)).toEqual([f.tickets.aOrg.ticketId]);
  for (const view of ['hda_agent_solutions', 'hda_agent_candidates', 'hda_agent_problems', 'hda_agent_ideas']) expect(await read(run.actor, `select 1 from ${view}`), view).toEqual([]);
});

test('отозванный токен и не агент не видят ни одной строки ни одного представления', async () => {
  const { f, main } = await setup();
  await pools.root.query(`update hdu_organizations set is_ai_enabled = true where org_id = $1`, [f.orgB.orgId]);
  for (const view of VIEWS) expect((await read(main.actor, `select 1 from ${view}`)).length, view).toBeGreaterThan(0);
  for (const actor of [f.adminStaff.actor, f.aUser.actor, { type: 'system', job: 'test' } as const]) for (const view of VIEWS) expect(await read(actor, `select 1 from ${view}`), view).toEqual([]);
  await pools.root.query(`update hda_agent_tokens set revoked_at = now() where token_id = $1`, [main.tokenId]);
  for (const view of VIEWS) expect(await read(main.actor, `select 1 from ${view}`), view).toEqual([]);
});
