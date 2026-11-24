import { beforeEach, expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { createDraftArticle, readPublishedSolution } from '@/modules/hdk/api/articles';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Таблицы знаний (план M5, задача 2; ТЗ 10.5, 10.6, 18.10; решения 8, 10, 11, 12, 16). Главное: клиент получает текст
// решения только из hdk_published и только с аудиторией clients. Черновики, версии, переводы, источник решения,
// файлы, сигнатуры и исходы подсказки клиенту недоступны ни одной строкой. Решения не данные арендатора: клиенты
// разных организаций видят одни и те же опубликованные решения.

let f: Fixture;
const rows = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rows);
const run = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rowCount);
/** Изменение не прошло: политика не дала строку (0) или отклонила новую строку (ошибка row-level security). */
const denied = (actor: Actor, sql: string, params: unknown[] = []) =>
  run(actor, sql, params).then(
    (count) => expect(count, sql).toBe(0),
    (error) => expect(String(error), sql).toMatch(/row-level security/),
  );

const DOC = { version: 1, blocks: [{ type: 'paragraph', attrs: { id: 'pfixture001' }, content: [{ type: 'text', text: 'Откройте раздел Склад' }] }] };

type Seeded = { clientsArticle: string; internalArticle: string; clientsNumber: number; internalNumber: number; fileId: string; signatureId: string };

/** Две опубликованные статьи (для клиентов и только через сотрудника) со всеми дочерними строками. */
async function seedKnowledge(): Promise<Seeded> {
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('warehouse', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id as string;
  const article = async (audience: 'clients' | 'internal', title: string) => {
    const a = (
      await pools.root.query(`insert into hdk_articles (module_id, audience, original_locale, owner_id) values ($1, $2, 'ru', $3) returning article_id, number`, [
        moduleId,
        audience,
        f.care.userId,
      ])
    ).rows[0] as { article_id: string; number: string };
    const v = (
      await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'ru', 1, $2, $3, 'published') returning version_id`, [
        a.article_id,
        title,
        DOC,
      ])
    ).rows[0].version_id as string;
    await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc) values ($1, 'ru', 2, $2, $3)`, [a.article_id, `${title} (черновик)`, DOC]);
    await pools.root.query(`insert into hdk_article_translations (article_id, locale, status, published_version_id, slug) values ($1, 'ru', 'reviewed', $2, 'sklad')`, [a.article_id, v]);
    await pools.root.query(
      `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, module_ids, original_locale)
       values ($1, $2, 'ru', $3, $4, $5, $6, 'Откройте раздел Склад', 'sklad', array[$7::uuid], 'ru')`,
      [a.article_id, a.number, v, audience, title, DOC, moduleId],
    );
    await pools.root.query(
      `insert into hdk_search_documents (published_id, kind, article_type, ref_id, locale, module_id, title, body_text, audience)
       select published_id, 'article', 'solution', article_id, locale, $2, title, body_text, audience from hdk_published where article_id = $1`,
      [a.article_id, moduleId],
    );
    return { id: a.article_id, number: Number(a.number) };
  };
  const clients = await article('clients', 'Остаток не списывается');
  const internal = await article('internal', 'Пересчёт себестоимости вручную');
  await pools.root.query(`insert into hdk_article_sources (org_id, article_id, ticket_id) values ($1, $2, $3)`, [f.orgA.orgId, clients.id, f.tickets.aOrg.ticketId]);
  const fileId = (
    await pools.root.query(
      `insert into hdk_article_files (article_id, storage_key, file_name, mime, size, sha256, scan_status) values ($1, 'kb/files/1', 'shot.png', 'image/png', 1024, repeat('a', 64), 'clean') returning file_id`,
      [clients.id],
    )
  ).rows[0].file_id as string;
  const signatureId = (
    await pools.root.query(
      `insert into hdk_error_signatures (article_id, module_id, signature, sample_code, sample_message) values ($1, $2, repeat('b', 32), 'ORA-20001', 'Недостаточно остатка') returning signature_id`,
      [clients.id, moduleId],
    )
  ).rows[0].signature_id as string;
  await pools.root.query(`insert into hdk_signature_orgs (org_id, signature_id) values ($1, $3), ($2, $3)`, [f.orgA.orgId, f.orgB.orgId, signatureId]);
  await pools.root.query(
    `insert into hdk_deflection_events (org_id, session_id, user_id, query_hash, shown_article_ids) values ($1, uuidv7(), $2, repeat('c', 64), array[$3::uuid])`,
    [f.orgA.orgId, f.aUser.userId, clients.id],
  );
  return { clientsArticle: clients.id, internalArticle: internal.id, clientsNumber: clients.number, internalNumber: internal.number, fileId, signatureId };
}

const CLOSED_TO_CLIENTS = [
  'hdk_articles',
  'hdk_article_versions',
  'hdk_article_translations',
  'hdk_article_sources',
  'hdk_article_files',
  'hdk_error_signatures',
  'hdk_signature_orgs',
  'hdk_deflection_events',
];

beforeEach(async () => {
  f = await seedTwoOrgs();
});

test('клиент не читает ни одной строки черновиков, версий, переводов, источников, файлов, сигнатур и исходов', async () => {
  await seedKnowledge();
  for (const table of CLOSED_TO_CLIENTS) {
    expect((await pools.root.query(`select 1 from ${table}`)).rowCount, `${table}: данные есть`).toBeGreaterThan(0);
    for (const actor of [f.aUser.actor, f.aAdmin.actor, f.bUser.actor]) expect(await rows(actor, `select * from ${table}`), `${table} для клиента`).toEqual([]);
    // Сотрудник любой роли и система читают.
    for (const actor of [f.l1.actor, (await staffWithRole('product')).actor, system]) expect((await rows(actor, `select 1 from ${table}`)).length, `${table} для ${actor.type}`).toBeGreaterThan(0);
  }
});

test('клиент читает только опубликованные решения для клиентов: решение "только через сотрудника" невидимо', async () => {
  const s = await seedKnowledge();
  for (const table of ['hdk_published', 'hdk_search_documents']) {
    const column = table === 'hdk_published' ? 'article_id' : 'ref_id';
    // Решения не данные арендатора: клиент чужой организации видит то же самое.
    for (const actor of [f.aUser.actor, f.bUser.actor, f.bAdmin.actor]) {
      const seen = await rows(actor, `select ${column} as id, audience from ${table}`);
      expect(seen, `${table} для клиента ${actor.orgId}`).toEqual([{ id: s.clientsArticle, audience: 'clients' }]);
    }
    expect((await rows(f.l1.actor, `select 1 from ${table}`)).length, `${table} для сотрудника`).toBe(2);
  }
  // Подбор номера: внутреннего решения нет и по прямому запросу.
  expect(await rows(f.aUser.actor, `select 1 from hdk_published where article_number = $1`, [s.internalNumber])).toEqual([]);
});

test('клиент ничего не пишет в таблицы знаний', async () => {
  const s = await seedKnowledge();
  const attempts = [
    `insert into hdk_articles (audience, original_locale) values ('clients', 'ru')`,
    `insert into hdk_article_versions (article_id, locale, number, doc) values ('${s.clientsArticle}', 'ru', 9, '{"version": 1, "blocks": []}')`,
    `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale)
       select article_id, article_number, 'en', version_id, 'clients', 'x', doc, 'x', 'x', 'ru' from hdk_published limit 1`,
    `insert into hdk_deflection_events (org_id, session_id, user_id, query_hash) values ('${f.orgA.orgId}', uuidv7(), '${f.aUser.userId}', repeat('d', 64))`,
    `insert into hdk_signature_orgs (org_id, signature_id) values ('${f.orgA.orgId}', '${s.signatureId}')`,
  ];
  for (const sql of attempts) await expect(run(f.aUser.actor, sql), sql).rejects.toThrow(/row-level security|permission denied|duplicate key/);
  expect(await run(f.aUser.actor, `update hdk_published set title = 'Подмена'`)).toBe(0);
  expect(await run(f.aUser.actor, `delete from hdk_published`)).toBe(0);
});

test('черновики пишут agent_l1, agent_l2, care, admin; product только читает (решение 10)', async () => {
  const s = await seedKnowledge();
  const product = (await staffWithRole('product')).actor;
  const l2 = (await staffWithRole('agent_l2')).actor;
  for (const writer of [f.l1.actor, l2, f.care.actor, f.adminStaff.actor]) {
    const id = (await rows(writer, `insert into hdk_articles (audience, original_locale) values ('clients', 'ru') returning article_id`))[0]!.article_id as string;
    expect(await run(writer, `insert into hdk_article_versions (article_id, locale, number, title, doc) values ($1, 'ru', 1, 'Черновик', $2)`, [id, DOC])).toBe(1);
    expect(await run(writer, `update hdk_article_versions set title = 'Правка' where article_id = $1 and state = 'draft'`, [id])).toBe(1);
  }
  await expect(run(product, `insert into hdk_articles (audience, original_locale) values ('clients', 'ru')`)).rejects.toThrow(/row-level security/);
  expect(await run(product, `update hdk_article_versions set title = 'Правка' where article_id = $1`, [s.clientsArticle])).toBe(0);
});

test('публикуют agent_l2, care, admin и система; agent_l1 и product не публикуют и не архивируют', async () => {
  const s = await seedKnowledge();
  const product = (await staffWithRole('product')).actor;
  const l2 = (await staffWithRole('agent_l2')).actor;
  const draftId = (await pools.root.query(`select version_id from hdk_article_versions where article_id = $1 and state = 'draft'`, [s.clientsArticle])).rows[0].version_id as string;
  // Перевод на английский: версия того же языка (копия ссылается на версию своей статьи и своего языка, hdk_published_f3).
  const enVersion = (
    await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'en', 1, 'Stock', $2, 'published') returning version_id`, [
      s.clientsArticle,
      DOC,
    ])
  ).rows[0].version_id as string;
  const publishedEn = `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale)
    values ($1, $2, 'en', $3, 'clients', 'Stock', $4, 'Stock', 'stock', 'ru')`;
  for (const weak of [f.l1.actor, product]) {
    // Черновик не становится опубликованной версией, новая версия не создаётся сразу опубликованной.
    await denied(weak, `update hdk_article_versions set state = 'published' where version_id = $1`, [draftId]);
    await expect(run(weak, `insert into hdk_article_versions (article_id, locale, number, doc, state) values ($1, 'ru', 7, $2, 'published')`, [s.clientsArticle, DOC])).rejects.toThrow(
      /row-level security/,
    );
    // Копия для читателей, индекс и архив закрыты.
    await expect(run(weak, publishedEn, [s.clientsArticle, s.clientsNumber, enVersion, DOC])).rejects.toThrow(/row-level security/);
    expect(await run(weak, `update hdk_published set title = 'x'`)).toBe(0);
    expect(await run(weak, `delete from hdk_published`)).toBe(0);
    expect(await run(weak, `delete from hdk_search_documents`)).toBe(0);
    await denied(weak, `update hdk_articles set status = 'archived' where article_id = $1`, [s.clientsArticle]);
    // Опубликованную версию первой линии не переписать.
    expect(await run(weak, `update hdk_article_versions set title = 'x' where article_id = $1 and state = 'published'`, [s.clientsArticle])).toBe(0);
  }
  await expect(run(f.l1.actor, `update hdk_article_translations set published_version_id = $1 where article_id = $2`, [draftId, s.clientsArticle])).rejects.toThrow(/публикации/);
  expect((await pools.root.query(`select count(*)::int as n from hdk_published`)).rows[0].n).toBe(2);
  expect((await pools.root.query(`select state from hdk_article_versions where version_id = $1`, [draftId])).rows[0].state).toBe('draft');
  expect((await pools.root.query(`select status from hdk_articles where article_id = $1`, [s.clientsArticle])).rows[0].status).toBe('active');
  // Вторая линия публикует: прежняя версия superseded, черновик published, копия для читателей на другом языке.
  expect(await run(l2, `update hdk_article_versions set state = 'superseded' where article_id = $1 and locale = 'ru' and state = 'published'`, [s.clientsArticle])).toBe(1);
  expect(await run(l2, `update hdk_article_versions set state = 'published' where version_id = $1`, [draftId])).toBe(1);
  expect(await run(l2, `update hdk_published set version_id = $1, title = 'Остаток не списывается, версия 2' where article_id = $2 and locale = 'ru'`, [draftId, s.clientsArticle])).toBe(1);
  expect(await run(l2, publishedEn, [s.clientsArticle, s.clientsNumber, enVersion, DOC])).toBe(1);
  expect(await run(l2, `update hdk_article_translations set published_version_id = $1 where article_id = $2`, [draftId, s.clientsArticle])).toBe(1);
  // Архив (решение 11): строки уходят из копии и индекса.
  expect(await run(f.care.actor, `delete from hdk_search_documents where ref_id = $1`, [s.clientsArticle])).toBe(1);
  expect(await run(f.care.actor, `delete from hdk_published where article_id = $1`, [s.clientsArticle])).toBe(2);
  expect(await run(f.adminStaff.actor, `update hdk_articles set status = 'archived', archived_on = now() where article_id = $1`, [s.clientsArticle])).toBe(1);
});

test('система пишет копию для читателей, индекс, сигнатуры и исходы подсказки', async () => {
  const s = await seedKnowledge();
  const versionId = (
    await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state, is_machine) values ($1, 'uz', 1, 'Qoldiq', $2, 'published', true) returning version_id`, [
      s.clientsArticle,
      DOC,
    ])
  ).rows[0].version_id as string;
  expect(
    await run(
      system,
      `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale, is_machine)
       values ($1, $2, 'uz', $3, 'clients', 'Qoldiq', $4, 'Qoldiq', 'qoldiq', 'ru', true)`,
      [s.clientsArticle, s.clientsNumber, versionId, DOC],
    ),
  ).toBe(1);
  expect(await run(system, `update hdk_search_documents set body_text = 'Новый текст' where ref_id = $1`, [s.clientsArticle])).toBe(1);
  expect(await run(system, `update hdk_error_signatures set occurrences = occurrences + 1, last_seen_on = now() where signature_id = $1`, [s.signatureId])).toBe(1);
  expect(await run(system, `update hdk_signature_orgs set last_seen_on = now() where signature_id = $1`, [s.signatureId])).toBe(2);
  expect(await run(system, `update hdk_deflection_events set outcome = 'helped'`)).toBe(1);
  // Клиент видит машинный перевод вместе с пометкой.
  expect(await rows(f.bUser.actor, `select locale, is_machine from hdk_published where locale = 'uz'`)).toEqual([{ locale: 'uz', is_machine: true }]);
  // Исходы подсказки пишет только система: сотрудник их не меняет (решение 12).
  expect(await run(f.adminStaff.actor, `update hdk_deflection_events set outcome = 'not_helped'`)).toBe(0);
});

test('база держит инварианты: одна опубликованная версия и один черновик на язык, аудитория без public, документ это объект', async () => {
  const s = await seedKnowledge();
  await expect(pools.root.query(`insert into hdk_article_versions (article_id, locale, number, doc, state) values ($1, 'ru', 3, $2, 'published')`, [s.clientsArticle, DOC])).rejects.toThrow(
    /hdk_article_versions_u2/,
  );
  await expect(pools.root.query(`insert into hdk_article_versions (article_id, locale, number, doc) values ($1, 'ru', 3, $2)`, [s.clientsArticle, DOC])).rejects.toThrow(/hdk_article_versions_u3/);
  await expect(pools.root.query(`update hdk_articles set audience = 'public' where article_id = $1`, [s.clientsArticle])).rejects.toThrow(/hdk_articles_c/);
  await expect(pools.root.query(`update hdk_published set audience = 'public'`)).rejects.toThrow(/hdk_published_c/);
  await expect(pools.root.query(`update hdk_article_versions set doc = '[1]' where article_id = $1 and state = 'draft'`, [s.clientsArticle])).rejects.toThrow(/hdk_article_versions_c/);
  await expect(pools.root.query(`update hdk_article_files set mime = 'image/svg+xml'`)).rejects.toThrow(/hdk_article_files_c/);
  await expect(pools.root.query(`update hdk_article_files set size = 10 * 1024 * 1024 + 1`)).rejects.toThrow(/hdk_article_files_c/);
});

test('черновик создаёт сотрудник с правом записи; клиент читает решение только после публикации', async () => {
  const product = staffCtx(await staffWithRole('product'));
  const l1 = staffCtx(f.l1);
  const created = await createDraftArticle(l1, { locale: 'ru', title: 'Документ не проводится', audience: 'clients', doc: DOC });
  expect(created.number).toBeGreaterThan(0);
  const stored = (await pools.root.query(`select v.state, v.title, v.created_by, t.draft_version_id = v.version_id as linked from hdk_article_versions v join hdk_article_translations t using (article_id, locale) where v.article_id = $1`, [created.articleId])).rows;
  expect(stored).toEqual([{ state: 'draft', title: 'Документ не проводится', created_by: f.l1.userId, linked: true }]);
  await expect(createDraftArticle(product, { locale: 'ru', title: 'Нельзя', audience: 'clients', doc: DOC })).rejects.toMatchObject({ code: 'forbidden' });
  // Документ проверяет схема: скрипт как блок и javascript: не сохраняются.
  await expect(createDraftArticle(l1, { locale: 'ru', title: 'x', audience: 'clients', doc: { version: 1, blocks: [{ type: 'script', attrs: { id: 'script00001' } }] } })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  // Черновик клиенту не виден.
  const client = await clientCtx(f.aUser);
  expect(await readPublishedSolution(client, { number: created.number, locale: 'ru' })).toBeNull();

  // Опубликованная копия (публикацию строит задача 4): клиент получает документ, прошедший схему.
  const s = await seedKnowledge();
  const read = await readPublishedSolution(client, { number: s.clientsNumber, locale: 'ru' });
  expect(read).toMatchObject({ title: 'Остаток не списывается', locale: 'ru', slug: 'sklad', isMachine: false, isOutdated: false, doc: DOC });
  expect(await readPublishedSolution(client, { number: s.internalNumber, locale: 'ru' })).toBeNull();
  expect(await readPublishedSolution(await clientCtx(f.bUser), { number: s.clientsNumber, locale: 'ru' })).toMatchObject({ title: 'Остаток не списывается' });
  // Сотрудник видит и внутреннее решение.
  expect(await readPublishedSolution(l1, { number: s.internalNumber, locale: 'ru' })).toMatchObject({ audience: 'internal' });
  // Ввод проверяет Zod.
  await expect(readPublishedSolution(client, { number: -1, locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(readPublishedSolution(client, { number: 1, locale: 'de' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('копия с документом, не прошедшим схему, клиенту не отдаётся', async () => {
  const s = await seedKnowledge();
  await pools.root.query(`update hdk_published set doc = '{"version": 1, "blocks": [{"type": "script", "attrs": {"id": "script00001"}}]}' where article_id = $1`, [s.clientsArticle]);
  expect(await readPublishedSolution(await clientCtx(f.aUser), { number: s.clientsNumber, locale: 'ru' })).toBeNull();
});

test('сужение аудитории статьи сразу закрывает копию и индекс от клиентов; открыть шире может только публикующий', async () => {
  const s = await seedKnowledge();
  // Первая линия делает решение "только через сотрудника" (FR-SOL-17): копия и строка индекса следуют каскадом.
  expect(await run(f.l1.actor, `update hdk_articles set audience = 'internal' where article_id = $1`, [s.clientsArticle])).toBe(1);
  expect(await rows(f.aUser.actor, `select 1 from hdk_published`)).toEqual([]);
  expect(await rows(f.aUser.actor, `select 1 from hdk_search_documents`)).toEqual([]);
  // Обратно первая линия не открывает: это публикация.
  await expect(run(f.l1.actor, `update hdk_articles set audience = 'clients' where article_id = $1`, [s.clientsArticle])).rejects.toThrow(/роль публикации/);
  expect(await run(f.care.actor, `update hdk_articles set audience = 'clients' where article_id = $1`, [s.clientsArticle])).toBe(1);
  expect((await rows(f.aUser.actor, `select article_id from hdk_published`)).map((r) => r.article_id)).toEqual([s.clientsArticle]);
  // Номер и счётчики сотрудник не меняет.
  await expect(run(f.care.actor, `update hdk_articles set number = 1 where article_id = $1`, [s.clientsArticle])).rejects.toThrow(/номер/);
  await expect(run(f.care.actor, `update hdk_articles set helped_count = 100 where article_id = $1`, [s.clientsArticle])).rejects.toThrow(/счётчики/);
  // Текст опубликованной версии не переписать даже публикующему: история неизменна.
  await expect(run(f.care.actor, `update hdk_article_versions set title = 'x' where article_id = $1 and state = 'published'`, [s.clientsArticle])).rejects.toThrow(/не меняется/);
});
