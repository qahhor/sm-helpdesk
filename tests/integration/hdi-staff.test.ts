import { expect, test } from 'vitest';
import { ideaPage } from '@/modules/hdi/api/board';
import { staffIdeaCard, staffIdeaList, voteBreakdown } from '@/modules/hdi/api/staff';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';

// Рабочее место по идеям (ТЗ FR-IDEA-15, 8.11; план M7, задача 6, решение 24): список для всех сотрудников,
// модерация и разбивка голосов только у product и admin, имена голосовавших не выдаются никому.

const vote = (ideaId: string, orgId: string, userId: string) => pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, ideaId, userId]);

test('вкладка "Модерация": идеи на проверке от старых к новым, организация автора видна всегда; "Все" с фильтрами и поиском', async () => {
  const f = await seedTwoOrgs();
  const older = await addIdea(f.orgA.orgId, f.aUser, 'pending_review', { title: 'Старая на проверке' });
  const newer = await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: 'Новая на проверке' });
  const open = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Опубликованная про склад' });
  await pools.root.query(`begin; set local session_replication_role = replica; update hdi_ideas set created_on = now() - interval '3 days' where idea_id = '${older.ideaId}'; commit`);
  for (const member of [f.l1, f.care]) {
    const moderation = await staffIdeaList(staffCtx(member), { tab: 'moderation' });
    expect(moderation.items.map((i) => i.number)).toEqual([older.number, newer.number]);
    expect(moderation.items[0]).toMatchObject({ title: 'Старая на проверке', orgName: f.orgA.name, status: 'pending_review' });
  }
  const all = await staffIdeaList(staffCtx(f.l1), { tab: 'all', status: 'open' });
  expect(all.items.map((i) => i.number)).toEqual([open.number]);
  expect((await staffIdeaList(staffCtx(f.l1), { tab: 'all', q: 'склад' })).items.map((i) => i.number)).toEqual([open.number]);
  expect((await staffIdeaList(staffCtx(f.l1), { tab: 'all', orgId: f.orgA.orgId })).items.map((i) => i.number)).toEqual([older.number]);
  await expect(staffIdeaList(staffCtx(f.l1), { tab: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('решение 24: разбивка по организациям и категориям только у product и admin, без имён голосовавших; клиенту не отдаётся', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update hdu_organizations set category = 'A' where org_id = $1`, [f.orgA.orgId]);
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Печать накладных' });
  await vote(idea.ideaId, f.orgA.orgId, f.aUser.userId);
  await vote(idea.ideaId, f.orgA.orgId, f.aAdmin.userId);
  await vote(idea.ideaId, f.orgB.orgId, f.bUser.userId);
  const product = staffCtx(await staffWithRole('product'));
  const breakdown = await voteBreakdown(product, { number: idea.number });
  expect(breakdown.orgs).toEqual([
    { orgId: f.orgA.orgId, name: f.orgA.name, category: 'A', votes: 2 },
    { orgId: f.orgB.orgId, name: f.orgB.name, category: null, votes: 1 },
  ]);
  expect(breakdown.categories).toEqual({ A: 2, B: 0, C: 0, D: 0, none: 1 });
  const text = JSON.stringify(breakdown);
  for (const member of [f.aUser, f.aAdmin, f.bUser]) {
    expect(text).not.toContain(member.userId);
    expect(text).not.toContain(member.name);
  }
  for (const member of [f.l1, f.care]) await expect(voteBreakdown(staffCtx(member), { number: idea.number })).rejects.toMatchObject({ code: 'forbidden' });

  const l1Card = await staffIdeaCard(staffCtx(f.l1), { number: idea.number });
  expect(l1Card).toMatchObject({ canModerate: false, breakdown: null, orgName: f.orgB.name, voteCount: 3, orgCount: 2 });
  const productCard = await staffIdeaCard(product, { number: idea.number });
  expect(productCard?.canModerate).toBe(true);
  expect(productCard?.breakdown?.orgs).toHaveLength(2);
  expect(JSON.stringify(productCard)).not.toContain(f.aUser.userId);

  const client = JSON.stringify(await ideaPage(await clientCtx(f.aUser), { number: idea.number, locale: 'ru' }));
  expect(client).not.toContain(f.orgB.name);
  expect(client).not.toMatch(/category|"orgs"/);
});

test('карточка: оригинал и переводы, находки, организация автора при выключенном показе', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgA.orgId, f.aUser, 'pending_review', { title: 'Звоните +998 90 123 45 67' });
  await pools.root.query(`insert into hdi_idea_translations (idea_id, locale, title, body, is_machine, status, source_hash) values ($1, 'en', 'Old', 'Old', true, 'outdated', repeat('a', 64))`, [idea.ideaId]);
  const card = await staffIdeaCard(staffCtx(f.care), { number: idea.number });
  expect(card).toMatchObject({ orgName: f.orgA.name, showOrg: false, status: 'pending_review', findings: ['phone'] });
  expect(card?.texts.map((t) => [t.locale, t.status])).toEqual([
    ['ru', 'original'],
    ['en', 'outdated'],
  ]);
  expect(await staffIdeaCard(staffCtx(f.care), { number: 999_999 })).toBeNull();
});
