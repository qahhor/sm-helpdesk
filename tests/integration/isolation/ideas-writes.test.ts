import { expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { IDEA_STATUSES, transitionBy } from '@/modules/hdi/pref';
import { staffWithRole } from '../helpers/auth';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';
import { addIdea, seedIdeas } from './ideas-fixture';

// Запись в таблицы идей прямыми запросами под hub_app (план M7, задача 1, решения 3, 4, 5, 6, 8, 17, 19): что
// запрещено, отклоняет база, а не только код.

const run = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rowCount);
const system: Actor = { type: 'system', job: 'test' };
const insertIdea = `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, show_org, author_org_name) values ($1, $2, $3, 'ru', $4, $5, $6)`;

test('клиент подаёт только свою идею на модерацию от своего имени и из своей организации', async () => {
  const f = await seedTwoOrgs();
  const a = f.aUser;
  // Чужая организация и чужой автор: политика.
  await expect(run(a.actor, insertIdea, [f.orgB.orgId, a.userId, a.name, 'pending_review', false, null])).rejects.toThrow(/row-level security/);
  await expect(run(a.actor, insertIdea, [f.orgA.orgId, f.aAdmin.userId, f.aAdmin.name, 'pending_review', false, null])).rejects.toThrow(/row-level security/);
  // Сразу опубликованная, чужое имя, чужое название организации: триггер.
  await expect(run(a.actor, insertIdea, [f.orgA.orgId, a.userId, a.name, 'open', false, null])).rejects.toThrow(/нельзя/);
  await expect(run(a.actor, insertIdea, [f.orgA.orgId, a.userId, 'Smartup Support', 'pending_review', false, null])).rejects.toThrow(/нельзя/);
  await expect(run(a.actor, insertIdea, [f.orgA.orgId, a.userId, a.name, 'pending_review', true, 'Globex'])).rejects.toThrow(/нельзя/);
  await expect(
    run(a.actor, `insert into hdi_ideas (org_id, author_id, author_name, original_locale, vote_count) values ($1, $2, $3, 'ru', 100)`, [f.orgA.orgId, a.userId, a.name]),
  ).rejects.toThrow(/нельзя/);
  expect(await run(a.actor, insertIdea, [f.orgA.orgId, a.userId, a.name, 'pending_review', true, f.orgA.name])).toBe(1);
  expect(await run(a.actor, insertIdea, [f.orgA.orgId, a.userId, a.name, 'pending_review', false, null])).toBe(1);
  // Сотрудник идею не подаёт.
  await expect(run(f.l1.actor, insertIdea, [f.orgA.orgId, a.userId, a.name, 'pending_review', false, null])).rejects.toThrow(/row-level security|нельзя/);
});

test('клиент не меняет статус, счётчики, номер, причину и чужую идею; правит текст только своей идеи на модерации', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const set = (actor: Actor, change: string, id: string) => run(actor, `update hdi_ideas set ${change} where idea_id = $1`, [id]);
  for (const change of [`status = 'open'`, `vote_count = 99`, `org_count = 3`, `comment_count = 5`, `number = 999999`, `findings_checked = true`, `author_name = 'Другой'`])
    await expect(set(f.aUser.actor, change, s.aPending.ideaId), change).rejects.toThrow(/нельзя/);
  // Чужую идею клиент не меняет: строка ему не видна для изменения.
  expect(await set(f.aUser.actor, `show_org = false`, s.bOpen.ideaId)).toBe(0);
  // Модуль и показ организации своей идеи на модерации меняет.
  expect(await set(f.aUser.actor, `show_org = true, author_org_name = '${f.orgA.name}'`, s.aPending.ideaId)).toBe(1);
  const editOriginal = (actor: Actor, id: string) => run(actor, `update hdi_idea_translations set body = 'Новое описание' where idea_id = $1 and status = 'original'`, [id]);
  expect(await editOriginal(f.aUser.actor, s.aPending.ideaId)).toBe(1);
  await expect(run(f.aUser.actor, `update hdi_idea_translations set status = 'machine', is_machine = true where idea_id = $1`, [s.aPending.ideaId])).rejects.toThrow(/нельзя/);
  // После публикации текст автор не правит, показ организации меняет (решения 5, 7).
  await pools.root.query(`update hdi_ideas set status = 'open' where idea_id = $1`, [s.aPending.ideaId]);
  expect(await editOriginal(f.aUser.actor, s.aPending.ideaId)).toBe(0);
  await expect(set(f.aUser.actor, `module_id = null, show_org = true`, s.aPending.ideaId)).resolves.toBe(1);
  expect(await set(f.aUser.actor, `show_org = false, author_org_name = null`, s.aPending.ideaId)).toBe(1);
  // Перевод клиент не пишет; оригинал чужой идеи тоже.
  await expect(
    run(f.aUser.actor, `insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'en', 'Idea', 'Body', repeat('b', 64))`, [s.aPending.ideaId]),
  ).rejects.toThrow(/row-level security/);
});

test('agent_l1, agent_l2 и care не публикуют, не отклоняют и не меняют статус даже прямым запросом; product публикует', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  for (const role of ['agent_l1', 'agent_l2', 'care'] as const) {
    const staff = (await staffWithRole(role)).actor;
    expect(await run(staff, `update hdi_ideas set status = 'open' where idea_id = $1`, [s.bPending.ideaId]), role).toBe(0);
    expect(await run(staff, `update hdi_ideas set status = 'declined', decline_reason = 'x' where idea_id = $1`, [s.bOpen.ideaId]), role).toBe(0);
    expect(await run(staff, `update hdi_idea_translations set title = 'Правка' where idea_id = $1`, [s.bPending.ideaId]), role).toBe(0);
    expect(await run(staff, `update hdi_comments set status = 'hidden', hide_reason = 'x'`), role).toBe(0);
  }
  const product = await staffWithRole('product');
  expect(await run(product.actor, `update hdi_ideas set status = 'open' where idea_id = $1`, [s.bPending.ideaId])).toBe(1);
  const row = (await pools.root.query(`select published_on, moderated_by from hdi_ideas where idea_id = $1`, [s.bPending.ideaId])).rows[0];
  expect(row.published_on).not.toBeNull();
  expect(row.moderated_by).toBe(product.userId);
  // Счётчики, автора и показ организации модератор не меняет.
  for (const change of [`vote_count = 10`, `author_name = 'Другой'`, `show_org = true`, `published_on = now() - interval '1 year'`])
    await expect(run(product.actor, `update hdi_ideas set ${change} where idea_id = $1`, [s.bOpen.ideaId]), change).rejects.toThrow(/нельзя/);
});

test('решение 19: переходы статуса в базе совпадают с IDEA_TRANSITIONS, шорт-лист ставит только система', async () => {
  const f = await seedTwoOrgs();
  const product = (await staffWithRole('product')).actor;
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const move = `update hdi_ideas set status = $2,
      decline_reason = case when $2 = 'declined' then 'Причина' else decline_reason end,
      merged_into_id = case when $2 = 'merged' then $3::uuid else merged_into_id end,
      released_in = case when $2 = 'released' then '5.12' else released_in end,
      released_on = case when $2 = 'released' then current_date else released_on end
    where idea_id = $1`;
  for (const from of IDEA_STATUSES)
    for (const to of IDEA_STATUSES) {
      if (from === to) continue;
      for (const [who, actor] of [
        ['moderator', product],
        ['system', system],
      ] as const) {
        const idea = await addIdea(f.orgA.orgId, f.aUser, from, { mergedInto: from === 'merged' ? target.ideaId : undefined });
        const allowed = who === 'system' ? transitionBy(from, to) !== null : transitionBy(from, to) === 'moderator';
        const result = run(actor, move, [idea.ideaId, to, target.ideaId]);
        if (allowed) await expect(result, `${who}: ${from} -> ${to}`).resolves.toBe(1);
        else await expect(result, `${who}: ${from} -> ${to}`).rejects.toThrow(/нельзя/);
      }
    }
});

test('решение 6: объединять можно только с опубликованной идеей, не с модерации, не с отклонённой и не с объединённой', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const product = (await staffWithRole('product')).actor;
  const merge = (into: string) => run(product, `update hdi_ideas set status = 'merged', merged_into_id = $2 where idea_id = $1`, [s.aPending.ideaId, into]);
  for (const bad of [s.bPending.ideaId, s.bDeclinedVoted.ideaId, s.bMergedPublished.ideaId]) await expect(merge(bad)).rejects.toThrow(/нельзя/);
  await expect(merge(s.aPending.ideaId)).rejects.toThrow(/hdi_ideas_c7|нельзя/);
  expect(await merge(s.bOpen.ideaId)).toBe(1);
});

test('решения 3 и 4: сотрудник не голосует, голос вне голосования и голос с чужой организацией отклоняет база', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const vote = (actor: Actor, orgId: string, userId: string, ideaId: string) =>
    run(actor, `insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, ideaId, userId]);
  // Сотрудник: политика (agent_l1, а с итоговой проверки M7 и product: политики вставки голосов у модератора нет,
  // решение 0065) и ключ участника организации.
  await expect(vote(f.l1.actor, f.orgA.orgId, f.l1.userId, s.bOpen.ideaId)).rejects.toThrow(/row-level security/);
  const product = await staffWithRole('product');
  await expect(vote(product.actor, f.orgA.orgId, product.userId, s.bOpen.ideaId)).rejects.toThrow(/row-level security/);
  // Чужая организация и чужой пользователь.
  await expect(vote(f.aUser.actor, f.orgB.orgId, f.aUser.userId, s.bOpen.ideaId)).rejects.toThrow(/row-level security/);
  await expect(vote(f.aUser.actor, f.orgA.orgId, f.aAdmin.userId, s.bOpen.ideaId)).rejects.toThrow(/row-level security/);
  // Автор голосует за свою идею и на модерации (решение 4): голос ставится при подаче. Отклонённая, объединённая: нельзя.
  expect(await vote(f.aUser.actor, f.orgA.orgId, f.aUser.userId, s.aPending.ideaId)).toBe(1);
  for (const idea of [s.bDeclinedFollowed.ideaId, s.bMergedPublished.ideaId])
    await expect(vote(f.aUser.actor, f.orgA.orgId, f.aUser.userId, idea)).rejects.toThrow(/нельзя/);
  // Чужая идея на модерации клиенту не видна: голос тоже отклоняется.
  await expect(vote(f.aUser.actor, f.orgA.orgId, f.aUser.userId, s.bPending.ideaId)).rejects.toThrow(/нельзя/);
  expect(await vote(f.aUser.actor, f.orgA.orgId, f.aUser.userId, s.bOpen.ideaId)).toBe(1);
  // После выбора голос заморожен: ни отозвать, ни отдать.
  await pools.root.query(`update hdi_ideas set status = 'shortlisted' where idea_id = $1`, [s.bOpen.ideaId]);
  expect(await run(f.aUser.actor, `delete from hdi_votes where idea_id = $1`, [s.bOpen.ideaId])).toBe(1);
  expect(await vote(f.aUser.actor, f.orgA.orgId, f.aUser.userId, s.bOpen.ideaId)).toBe(1);
  await pools.root.query(`update hdi_ideas set status = 'selected' where idea_id = $1`, [s.bOpen.ideaId]);
  await expect(run(f.aUser.actor, `delete from hdi_votes where idea_id = $1`, [s.bOpen.ideaId])).rejects.toThrow(/нельзя/);
  await expect(vote(f.aAdmin.actor, f.orgA.orgId, f.aAdmin.userId, s.bOpen.ideaId)).rejects.toThrow(/нельзя/);
});

test('подписка: только своя, на видимую идею и не на отклонённую (иначе подписка открыла бы её)', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const follow = (actor: Actor, userId: string, ideaId: string) => run(actor, `insert into hdi_subscriptions (idea_id, user_id) values ($1, $2)`, [ideaId, userId]);
  await expect(follow(f.aUser.actor, f.aAdmin.userId, s.bOpen.ideaId)).rejects.toThrow(/row-level security/);
  for (const idea of [s.bPending.ideaId, s.bDeclinedUnpublished.ideaId, s.bDeclinedVoted.ideaId])
    await expect(follow(f.aAdmin.actor, f.aAdmin.userId, idea)).rejects.toThrow(/row-level security/);
  expect(await follow(f.aUser.actor, f.aUser.userId, s.bOpen.ideaId)).toBe(1);
  expect(await run(f.aAdmin.actor, `delete from hdi_subscriptions where idea_id = $1`, [s.bOpen.ideaId])).toBe(0);
  expect(await run(f.aUser.actor, `delete from hdi_subscriptions where idea_id = $1`, [s.bOpen.ideaId])).toBe(1);
});

test('решение 8: клиент пишет только обычный комментарий от своего имени, сотрудник ответ Smartup, скрывает только модератор', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const comment = (actor: Actor, values: { orgId: string | null; author: { userId: string; name: string }; official: boolean; status?: string; idea?: string }) =>
    run(actor, `insert into hdi_comments (org_id, idea_id, author_id, author_name, body, is_official, status) values ($1, $2, $3, $4, 'Текст', $5, $6)`, [
      values.orgId,
      values.idea ?? s.bOpen.ideaId,
      values.author.userId,
      values.author.name,
      values.official,
      values.status ?? 'published',
    ]);
  await expect(comment(f.aUser.actor, { orgId: null, author: f.aUser, official: true })).rejects.toThrow(/row-level security|нельзя/);
  await expect(comment(f.aUser.actor, { orgId: f.orgA.orgId, author: { userId: f.aUser.userId, name: 'Smartup' }, official: false })).rejects.toThrow(/нельзя/);
  await expect(comment(f.aUser.actor, { orgId: f.orgA.orgId, author: f.aUser, official: false, status: 'hidden' })).rejects.toThrow(/нельзя|hdi_comments_c4/);
  // К чужой идее на модерации и к отклонённой не комментирует.
  for (const idea of [s.bPending.ideaId, s.bDeclinedVoted.ideaId])
    await expect(comment(f.aUser.actor, { orgId: f.orgA.orgId, author: f.aUser, official: false, idea })).rejects.toThrow(/row-level security/);
  expect(await comment(f.aUser.actor, { orgId: f.orgA.orgId, author: f.aUser, official: false, status: 'pending' })).toBe(1);
  // Свой комментарий на проверке автор не публикует сам.
  await expect(run(f.aUser.actor, `update hdi_comments set status = 'published' where author_id = $1`, [f.aUser.userId])).rejects.toThrow(/нельзя/);
  // Ответ Smartup пишет любой сотрудник, скрыть его и чужой комментарий может только модератор.
  expect(await comment(f.l1.actor, { orgId: null, author: f.l1, official: true })).toBe(1);
  await expect(run(f.l1.actor, `update hdi_comments set status = 'hidden', hide_reason = 'x' where author_id = $1`, [f.aUser.userId])).rejects.toThrow(/нельзя/);
  const product = await staffWithRole('product');
  expect(await run(product.actor, `update hdi_comments set status = 'hidden', hide_reason = 'Телефон' where author_id = $1`, [f.aUser.userId])).toBe(1);
  expect((await pools.root.query(`select hidden_by from hdi_comments where author_id = $1`, [f.aUser.userId])).rows[0].hidden_by).toBe(product.userId);
  // Скрытый автор не возвращает.
  await expect(run(f.aUser.actor, `update hdi_comments set body = 'Исправил' where author_id = $1`, [f.aUser.userId])).rejects.toThrow(/нельзя/);
});

test('решение 17: клиент не меняет отбор; сотрудник выбирает только из пятёрки, не лидера только с объяснением, один раз', async () => {
  const f = await seedTwoOrgs();
  const leader = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted');
  const second = await addIdea(f.orgA.orgId, f.aUser, 'shortlisted');
  const outsider = await addIdea(f.orgA.orgId, f.aUser, 'open');
  const shortlist = JSON.stringify([
    { ideaId: leader.ideaId, number: leader.number, voteCount: 5, orgCount: 2, place: 1 },
    { ideaId: second.ideaId, number: second.number, voteCount: 3, orgCount: 1, place: 2 },
  ]);
  const cycleId = (
    await pools.root.query(`insert into hdi_cycles (cycle, vote_mode, shortlist, leader_idea_id) values ('2026-12-01', 'per_user', $1, $2) returning cycle_id`, [shortlist, leader.ideaId])
  ).rows[0].cycle_id as string;
  const choose = (actor: Actor, ideaId: string, explanation: string | null) =>
    run(actor, `update hdi_cycles set status = 'decided', selected_idea_id = $2, explanation_ru = $3 where cycle_id = $1`, [cycleId, ideaId, explanation]);
  expect(await choose(f.aUser.actor, leader.ideaId, null)).toBe(0);
  expect(await choose(f.l1.actor, leader.ideaId, null)).toBe(0);
  const product = (await staffWithRole('product')).actor;
  await expect(choose(product, outsider.ideaId, 'Важнее')).rejects.toThrow(/нельзя/);
  await expect(choose(product, second.ideaId, null)).rejects.toThrow(/hdi_cycles_c7/);
  await expect(run(product, `update hdi_cycles set shortlist = '[]' where cycle_id = $1`, [cycleId])).rejects.toThrow(/нельзя/);
  expect(await choose(product, second.ideaId, 'Меньше голосов, но закрывает просьбы всех складов')).toBe(1);
  await expect(choose(product, leader.ideaId, null)).rejects.toThrow(/нельзя/);
  // Вставляет отбор только система.
  await expect(run(product, `insert into hdi_cycles (cycle, vote_mode) values ('2027-01-01', 'per_user')`)).rejects.toThrow(/row-level security/);
  expect(await run(system, `insert into hdi_cycles (cycle, vote_mode) values ('2027-01-01', 'per_user')`)).toBe(1);
  await expect(run(system, `insert into hdi_cycles (cycle, vote_mode) values ('2027-01-01', 'per_user')`)).rejects.toThrow(/hdi_cycles_u1/);
});

test('решение 10: клиент прикрепляет свою загрузку только к своей идее на модерации и не меняет итог проверки', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const upload = (actor: Actor, orgId: string, uploader: string, status = 'pending') =>
    asActor(pools.app, actor, (c) =>
      c.query(
        `insert into hdi_attachments (org_id, uploader_id, storage_key, file_name, mime, size, scan_status) values ($1, $2, 'quarantine/ideas/' || uuidv7(), 'a.png', 'image/png', 10, $3) returning attachment_id`,
        [orgId, uploader, status],
      ),
    ).then((r) => r.rows[0].attachment_id as string);
  await expect(upload(f.aUser.actor, f.orgA.orgId, f.aUser.userId, 'clean')).rejects.toThrow(/row-level security/);
  await expect(
    asActor(pools.app, f.aUser.actor, (c) =>
      c.query(`insert into hdi_attachments (org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, 'quarantine/ideas/x', 'a.svg', 'image/svg+xml', 10)`, [
        f.orgA.orgId,
        f.aUser.userId,
      ]),
    ),
  ).rejects.toThrow(/hdi_attachments_c2/);
  const id = await upload(f.aUser.actor, f.orgA.orgId, f.aUser.userId);
  const attach = (ideaId: string) => run(f.aUser.actor, `update hdi_attachments set idea_id = $2 where attachment_id = $1`, [id, ideaId]);
  await expect(attach(s.bOpen.ideaId)).rejects.toThrow(/row-level security|hdi_attachments_f1/);
  await expect(run(f.aUser.actor, `update hdi_attachments set scan_status = 'clean' where attachment_id = $1`, [id])).rejects.toThrow(/нельзя/);
  expect(await attach(s.aPending.ideaId)).toBe(1);
  await expect(attach(s.aPending.ideaId)).rejects.toThrow(/нельзя/);
});
