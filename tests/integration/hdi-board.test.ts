import { expect, test } from 'vitest';
import { followIdea, ideaOfMonth, ideaPage, listIdeas } from '@/modules/hdi/api/board';
import { unvoteIdea, voteIdea } from '@/modules/hdi/api/votes';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';
import { addIdea, seedIdeas } from './isolation/ideas-fixture';

// Доска идей клиента, страница идеи, голос и подписка (ТЗ FR-IDEA-04, 06, 14, 8.3; план M7, задача 5, решения 2, 6,
// 7, 11, 22). Строки идей заводит суперпользователь, читает сервис от имени клиента: границу держит политика.

const vote = (ideaId: string, orgId: string, userId: string) => pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, ideaId, userId]);
const numbers = (items: { number: number }[]) => items.map((item) => item.number);

test('решение 22: вкладки по статусам, популярные по голосам, новые по дате публикации, фильтр модуля, постраничный вывод по ключу', async () => {
  const f = await seedTwoOrgs();
  const a = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Первая' });
  const b = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted', { title: 'Вторая' });
  const c = await addIdea(f.orgB.orgId, f.bUser, 'selected', { title: 'Третья' });
  const d = await addIdea(f.orgB.orgId, f.bUser, 'in_development', { title: 'Четвёртая' });
  const e = await addIdea(f.orgB.orgId, f.bUser, 'released', { title: 'Пятая' });
  await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: 'Секрет на модерации' });
  await vote(b.ideaId, f.orgA.orgId, f.aUser.userId);
  await vote(b.ideaId, f.orgB.orgId, f.bUser.userId);
  await vote(a.ideaId, f.orgA.orgId, f.aAdmin.userId);
  await pools.root.query(`update hdi_ideas set published_on = now() - interval '1 day' where idea_id = $1`, [b.ideaId]);
  const ctx = await clientCtx(f.aUser);

  const popular = await listIdeas(ctx, { tab: 'popular', locale: 'ru' });
  expect(numbers(popular.items)).toEqual([b.number, a.number]);
  expect(popular.items[0]).toMatchObject({ voteCount: 2, voted: true, title: 'Вторая' });
  expect(popular.items[1]).toMatchObject({ voteCount: 1, voted: false });
  expect(numbers((await listIdeas(ctx, { tab: 'new', locale: 'ru' })).items)).toEqual([a.number, b.number]);
  expect(numbers((await listIdeas(ctx, { tab: 'in_work', locale: 'ru' })).items).sort()).toEqual([c.number, d.number].sort());
  expect(numbers((await listIdeas(ctx, { tab: 'released', locale: 'ru' })).items)).toEqual([e.number]);

  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Склад"}') returning module_id`, [`board-${Date.now()}`])).rows[0]
    .module_id as string;
  await pools.root.query(`update hdi_ideas set module_id = $1 where idea_id = $2`, [moduleId, a.ideaId]);
  expect(numbers((await listIdeas(ctx, { tab: 'popular', locale: 'ru', moduleId })).items)).toEqual([a.number]);

  // Постранично: 25 идей без голосов, по 20 на страницу, без повторов и пропусков.
  for (let i = 0; i < 25; i++) await addIdea(f.orgB.orgId, f.bUser, 'open', { title: `Пачка ${i}` });
  const first = await listIdeas(ctx, { tab: 'popular', locale: 'ru' });
  expect(first.items).toHaveLength(20);
  expect(first.next).toBe(first.items[19]?.number);
  const second = await listIdeas(ctx, { tab: 'popular', locale: 'ru', after: first.next ?? 0 });
  expect(second.next).toBeNull();
  const all = [...numbers(first.items), ...numbers(second.items)];
  expect(all).toHaveLength(27);
  expect(new Set(all).size).toBe(27);
});

test('решение 22: поиск по заголовку экранирует знаки шаблона и не находит чужую идею на модерации', async () => {
  const f = await seedTwoOrgs();
  const percent = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Скидка 100% на доставку' });
  await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Скидка 1000 сум' });
  await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: 'Скидка 100% секретная' });
  const ctx = await clientCtx(f.aUser);
  expect(numbers((await listIdeas(ctx, { tab: 'popular', locale: 'ru', q: '100%' })).items)).toEqual([percent.number]);
  expect((await listIdeas(ctx, { tab: 'popular', locale: 'ru', q: '_' })).items).toEqual([]);
  expect((await listIdeas(ctx, { tab: 'popular', locale: 'ru', q: 'секретная' })).items).toEqual([]);
  await expect(listIdeas(ctx, { tab: 'nope', locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('FR-IDEA-04: голос и отзыв меняют счётчик и отметку на доске; 61-й голос за минуту отклоняется', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const ctx = await clientCtx(f.aUser);
  expect(await voteIdea(ctx, { number: idea.number })).toEqual({ voted: true, voteCount: 1 });
  expect((await listIdeas(ctx, { tab: 'popular', locale: 'ru' })).items[0]).toMatchObject({ voted: true, voteCount: 1 });
  expect(await unvoteIdea(ctx, { number: idea.number })).toEqual({ voted: false, voteCount: 0 });
  expect((await ideaPage(ctx, { number: idea.number, locale: 'ru' }))?.voted).toBe(false);
  for (let i = 0; i < 58; i++) await voteIdea(ctx, { number: idea.number });
  await expect(voteIdea(ctx, { number: idea.number })).rejects.toMatchObject({ code: 'rate_limited' });
});

test('решение 2: чужая идея на модерации даёт "не найдено"; отклонённая после публикации видна проголосовавшему и не видна остальным', async () => {
  const f = await seedTwoOrgs();
  const set = await seedIdeas(f);
  const aUser = await clientCtx(f.aUser);
  const aAdmin = await clientCtx(f.aAdmin);
  expect(await ideaPage(aUser, { number: set.bPending.number, locale: 'ru' })).toBeNull();
  expect(await ideaPage(aUser, { number: set.bDeclinedUnpublished.number, locale: 'ru' })).toBeNull();
  const declined = await ideaPage(aUser, { number: set.bDeclinedVoted.number, locale: 'ru' });
  expect(declined).toMatchObject({ status: 'declined', canVote: false });
  // Причина отклонения видна только автору (решение 5).
  expect(declined?.declineReason).toBeNull();
  expect(await ideaPage(aAdmin, { number: set.bDeclinedVoted.number, locale: 'ru' })).toBeNull();
  expect((await ideaPage(await clientCtx(f.bUser), { number: set.bDeclinedVoted.number, locale: 'ru' }))?.declineReason).toBe('Уже есть в плане');
  // Отклонённые и объединённые не попадают в списки (решение 2).
  const listed = numbers((await listIdeas(aUser, { tab: 'popular', locale: 'ru' })).items);
  expect(listed).toEqual([set.bOpen.number]);
});

test('решение 6: страница объединённой идеи ведёт на цель', async () => {
  const f = await seedTwoOrgs();
  const set = await seedIdeas(f);
  const page = await ideaPage(await clientCtx(f.aUser), { number: set.bMergedPublished.number, locale: 'ru' });
  expect(page).toMatchObject({ status: 'merged', mergedInto: set.bOpen.number, canVote: false });
});

test('решения 7 и 11: организация автора только при show_org; машинный перевод с пометкой и оригиналом, отклонённый перевод не показывается', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Печать накладных' });
  await pools.root.query(
    `insert into hdi_idea_translations (idea_id, locale, title, body, is_machine, status, source_hash) values ($1, 'en', 'Batch invoice printing', 'Print all invoices', true, 'machine', repeat('a', 64)), ($1, 'uz', 'Rad etilgan', 'Rad etilgan', true, 'rejected', repeat('a', 64))`,
    [idea.ideaId],
  );
  const en = await ideaPage(await clientCtx(f.aUser), { number: idea.number, locale: 'en' });
  expect(en?.text).toEqual({ locale: 'en', title: 'Batch invoice printing', body: 'Print all invoices', isMachine: true });
  expect(en?.original).toMatchObject({ locale: 'ru', title: 'Печать накладных' });
  expect(en?.orgName).toBeNull();
  const uz = await ideaPage(await clientCtx(f.aUser), { number: idea.number, locale: 'uz' });
  expect(uz?.text).toMatchObject({ locale: 'ru', title: 'Печать накладных', isMachine: false });
  expect(uz?.translationUnavailable).toBe(true);
  await pools.root.query(`update hdi_ideas set show_org = true, author_org_name = $2 where idea_id = $1`, [idea.ideaId, f.orgB.name]);
  expect((await ideaPage(await clientCtx(f.aUser), { number: idea.number, locale: 'ru' }))?.orgName).toBe(f.orgB.name);
  const board = await listIdeas(await clientCtx(f.aUser), { tab: 'popular', locale: 'en' });
  expect(board.items[0]).toMatchObject({ title: 'Batch invoice printing', isMachine: true });
  expect(JSON.stringify(board)).not.toContain(f.orgB.name);
});

test('подписка "Следить": на опубликованную можно, на чужую на модерации нельзя; свой статус виден на странице', async () => {
  const f = await seedTwoOrgs();
  const set = await seedIdeas(f);
  const ctx = await clientCtx(f.aUser);
  await followIdea(ctx, { number: set.bOpen.number, follow: true });
  await followIdea(ctx, { number: set.bOpen.number, follow: true });
  expect((await ideaPage(ctx, { number: set.bOpen.number, locale: 'ru' }))?.subscribed).toBe(true);
  await followIdea(ctx, { number: set.bOpen.number, follow: false });
  expect((await ideaPage(ctx, { number: set.bOpen.number, locale: 'ru' }))?.subscribed).toBe(false);
  await expect(followIdea(ctx, { number: set.bPending.number, follow: true })).rejects.toMatchObject({ code: 'not_found' });
  await expect(followIdea(ctx, { number: set.bDeclinedVoted.number, follow: true })).rejects.toMatchObject({ code: 'voting_closed' });
});

test('своя идея на модерации: можно изменить и переключить показ организации; чужой клиент её не видит на доске', async () => {
  const f = await seedTwoOrgs();
  const set = await seedIdeas(f);
  const own = await ideaPage(await clientCtx(f.aUser), { number: set.aPending.number, locale: 'ru' });
  expect(own).toMatchObject({ isAuthor: true, canEdit: true, showOrg: false, status: 'pending_review' });
  const other = await ideaPage(await clientCtx(f.bUser), { number: set.bOpen.number, locale: 'ru' });
  expect(other).toMatchObject({ isAuthor: true, canEdit: false });
  expect(numbers((await listIdeas(await clientCtx(f.bUser), { tab: 'new', locale: 'ru' })).items)).not.toContain(set.aPending.number);
});

test('"Идея месяца": последний отбор с выбором; без выбора блока нет', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  expect(await ideaOfMonth(ctx, { locale: 'ru' })).toBeNull();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'in_development', { title: 'Экспорт заказов в Excel' });
  await pools.root.query(`update hdi_ideas set selected_cycle = '2026-11-01' where idea_id = $1`, [idea.ideaId]);
  const shortlist = JSON.stringify([{ ideaId: idea.ideaId, number: idea.number, voteCount: 3, orgCount: 2, place: 1 }]);
  await pools.root.query(
    `insert into hdi_cycles (cycle, shortlist, vote_mode, leader_idea_id, selected_idea_id, status, decided_on) values ('2026-10-01', '[]', 'per_user', null, null, 'lapsed', null), ('2026-11-01', $1, 'per_user', $2, $2, 'decided', now())`,
    [shortlist, idea.ideaId],
  );
  expect(await ideaOfMonth(ctx, { locale: 'ru' })).toMatchObject({ cycle: '2026-11-01', card: { number: idea.number, title: 'Экспорт заказов в Excel', status: 'in_development' } });
});
