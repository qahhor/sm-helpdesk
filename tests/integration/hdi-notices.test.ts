import { afterEach, beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { addComment, addStaffReply, moderateComment } from '@/modules/hdi/api/comments';
import { runModerationDigest } from '@/modules/hdi/api/notices';
import { declineIdea, mergeIdea, publishIdea } from '@/modules/hdi/api/moderate';
import { submitIdea } from '@/modules/hdi/api/submit';
import { notifyIdeaStatusTx } from '@/modules/hdi/core/notices';
import { renderMail } from '@/modules/hdn/mail/render';
import { readIdeaMailPref, saveIdeaMailPref } from '@/modules/hdn/api/notifications';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools, system } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';
import { expectWithin } from './helpers/timing';

// Уведомления по идеям (ТЗ FR-IDEA-11, FR-NT-01, 03, 04; план M7, задача 8, решения 14, 15): колокольчик на каждое
// событие, письмо не чаще одного в сутки по идее на пользователя, кроме "Выпущена"; получатели без повторов; без
// отключивших письма об идеях; строки ставятся пачкой в транзакции смены статуса.

beforeEach(() => {
  setJobQueueForTests(new MemoryJobQueue());
  setAiClientForTests(new StubAiClient());
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

const bell = (ideaId: string) =>
  pools.root.query(`select user_id, kind, payload from hdn_notifications where idea_id = $1 order by created_on, user_id`, [ideaId]).then((r) => r.rows as { user_id: string; kind: string; payload: Record<string, unknown> }[]);
const mails = (ideaId: string) =>
  pools.root
    .query(`select recipient_user_id, template, payload, settings_path, channel from hdn_outbox where payload ->> 'ideaId' = $1 order by created_on, recipient_user_id`, [ideaId])
    .then((r) => r.rows as { recipient_user_id: string; template: string; payload: Record<string, unknown>; settings_path: string; channel: string }[]);
const product = async () => staffCtx(await staffWithRole('product'));
const vote = (ideaId: string, orgId: string, userId: string) => pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, ideaId, userId]);
const follow = (ideaId: string, userId: string) => pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) values ($1, $2)`, [ideaId, userId]);

test('решение 15: публикация уведомляет только автора; отклонение после публикации: автор, проголосовавшие и подписчики без повторов', async () => {
  const f = await seedTwoOrgs();
  const result = await submitIdea(await clientCtx(f.aUser), { title: 'Печать накладных пачкой', body: 'Печатать все накладные одной кнопкой', locale: 'ru' });
  const number = (result as { number: number }).number;
  const ideaId = (await pools.root.query(`select idea_id from hdi_ideas where number = $1`, [number])).rows[0].idea_id as string;
  const moderator = await product();
  await publishIdea(moderator, { number });
  expect((await bell(ideaId)).map((n) => [n.user_id, n.kind])).toEqual([[f.aUser.userId, 'idea_published']]);
  expect((await mails(ideaId)).map((m) => [m.recipient_user_id, m.template, m.channel, m.settings_path])).toEqual([[f.aUser.userId, 'idea_status', 'email', '/settings']]);

  // Автор уже голосовал и подписан сам; bUser голосовал и подписан, aAdmin только подписан.
  await vote(ideaId, f.orgB.orgId, f.bUser.userId);
  await follow(ideaId, f.bUser.userId);
  await follow(ideaId, f.aAdmin.userId);
  await declineIdea(moderator, { number, reason: 'Уже есть в плане' });
  const declined = (await bell(ideaId)).filter((n) => n.kind === 'idea_declined');
  expect(declined.map((n) => n.user_id).sort()).toEqual([f.aUser.userId, f.bUser.userId, f.aAdmin.userId].sort());
  expect(declined[0]?.payload).toEqual({ idea: number, status: 'declined' });
  // Автор уже получил письмо о публикации сегодня: второе письмо за сутки по той же идее не уходит (решение 14).
  expect((await mails(ideaId)).filter((m) => m.payload.event === 'declined').map((m) => m.recipient_user_id).sort()).toEqual([f.bUser.userId, f.aAdmin.userId].sort());
  // Причина отклонения в письма и колокольчик не попадает: её видит автор на странице идеи.
  expect(JSON.stringify(await mails(ideaId))).not.toContain('Уже есть в плане');
});

test('решение 14: второе событие за сутки без письма, "Выпущена" всегда; отключившие письма об идеях получают только колокольчик', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted', { title: 'Экспорт в Excel' });
  await vote(idea.ideaId, f.orgA.orgId, f.aUser.userId);
  await vote(idea.ideaId, f.orgA.orgId, f.aAdmin.userId);
  await saveIdeaMailPref((await clientCtx(f.aAdmin)).actor, { email: false });
  expect(await readIdeaMailPref((await clientCtx(f.aAdmin)).actor)).toEqual({ email: false });
  const moderator = await product();
  const run = (status: 'selected' | 'in_development' | 'released') => withActor(moderator.actor, (tx) => notifyIdeaStatusTx(tx, { ideaId: idea.ideaId, number: idea.number, authorId: f.bUser.userId, status }));
  await run('selected');
  await run('in_development');
  await run('released');
  const notices = await bell(idea.ideaId);
  expect(notices.filter((n) => n.user_id === f.aAdmin.userId).map((n) => n.payload.status)).toEqual(['selected', 'in_development', 'released']);
  const sent = await mails(idea.ideaId);
  expect(sent.filter((m) => m.recipient_user_id === f.aAdmin.userId)).toEqual([]);
  expect(sent.filter((m) => m.recipient_user_id === f.aUser.userId).map((m) => m.payload.event)).toEqual(['selected', 'released']);
  expect(sent.filter((m) => m.recipient_user_id === f.bUser.userId).map((m) => m.payload.event)).toEqual(['selected', 'released']);
});

test('1000 проголосовавших: одна пачка строк в транзакции; откат смены статуса не оставляет ни колокольчика, ни писем', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted');
  await pools.root.query(
    `with u as (insert into auth."user" (name, email, "emailVerified") select 'Голос ' || g, 'voter-' || g || '-' || $2 || '@acme.example', true from generate_series(1, 1000) g returning id)
     , m as (insert into hdu_memberships (org_id, user_id, role, source) select $1, id, 'client_user', 'invite' from u returning user_id)
     insert into hdi_votes (org_id, idea_id, user_id) select $1, $3, user_id from m`,
    [f.orgA.orgId, Date.now(), idea.ideaId],
  );
  const moderator = await product();
  const started = Date.now();
  await withActor(moderator.actor, (tx) => notifyIdeaStatusTx(tx, { ideaId: idea.ideaId, number: idea.number, authorId: f.bUser.userId, status: 'selected' }));
  expectWithin(Date.now() - started, 10_000, 'уведомление о статусе идеи с 2000 голосов');
  // Одна команда на таблицу: у строк, вставленных одной командой транзакции, один номер команды (системная колонка cmin).
  expect((await pools.root.query(`select count(distinct cmin::text)::int as n from hdn_notifications where idea_id = $1`, [idea.ideaId])).rows[0].n).toBe(1);
  expect((await pools.root.query(`select count(distinct cmin::text)::int as n from hdn_outbox where payload ->> 'ideaId' = $1`, [idea.ideaId])).rows[0].n).toBe(1);
  expect((await bell(idea.ideaId)).length).toBe(1001);
  expect((await mails(idea.ideaId)).length).toBe(1001);

  const other = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted');
  await vote(other.ideaId, f.orgA.orgId, f.aUser.userId);
  await expect(
    withActor(moderator.actor, async (tx) => {
      await notifyIdeaStatusTx(tx, { ideaId: other.ideaId, number: other.number, authorId: f.bUser.userId, status: 'selected' });
      throw new Error('откат');
    }),
  ).rejects.toThrow('откат');
  expect(await bell(other.ideaId)).toEqual([]);
  expect(await mails(other.ideaId)).toEqual([]);
});

test('объединение уведомляет проголосовавших за источник; ответ Smartup только автора и подписчиков; скрытие комментария его автора', async () => {
  const f = await seedTwoOrgs();
  const moderator = await product();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const source = await addIdea(f.orgB.orgId, f.bAdmin, 'open');
  await vote(source.ideaId, f.orgA.orgId, f.aUser.userId);
  await mergeIdea(moderator, { number: source.number, into: target.number });
  const merged = await bell(source.ideaId);
  expect(merged.map((n) => n.user_id).sort()).toEqual([f.aUser.userId, f.bAdmin.userId].sort());
  expect(merged[0]).toMatchObject({ kind: 'idea_merged', payload: { idea: source.number, into: target.number, status: 'merged' } });

  await vote(target.ideaId, f.orgA.orgId, f.aAdmin.userId);
  await follow(target.ideaId, f.aUser.userId);
  await addStaffReply(staffCtx(f.l1), { number: target.number, body: 'Передали команде' });
  const replies = (await bell(target.ideaId)).filter((n) => n.kind === 'idea_official_reply');
  expect(replies.map((n) => n.user_id).sort()).toEqual([f.bUser.userId, f.aUser.userId].sort());

  const comment = await addComment(await clientCtx(f.aAdmin), { number: target.number, body: 'Не по теме' });
  await moderateComment(moderator, { commentId: comment.commentId, action: 'hide', reason: 'Не по теме' });
  const hidden = (await bell(target.ideaId)).filter((n) => n.kind === 'idea_comment_hidden');
  expect(hidden.map((n) => n.user_id)).toEqual([f.aAdmin.userId]);
  // Текст комментария и причина в уведомления не попадают.
  expect(JSON.stringify(await bell(target.ideaId))).not.toContain('Не по теме');
});

test('итоговая проверка M7, M4: в письмо идут только оригинал и проверенный перевод заголовка, машинный перевод нет', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted', { title: 'Экспорт заказов' });
  await pools.root.query(
    `insert into hdi_idea_translations (idea_id, locale, title, body, is_machine, status, source_hash)
     values ($1, 'en', 'Machine order export', 'Text', true, 'machine', repeat('a', 64)), ($1, 'uz', 'Buyurtmalar eksporti', 'Matn', false, 'reviewed', repeat('a', 64))`,
    [idea.ideaId],
  );
  const moderator = await product();
  await withActor(moderator.actor, (tx) => notifyIdeaStatusTx(tx, { ideaId: idea.ideaId, number: idea.number, authorId: f.bUser.userId, status: 'selected' }));
  const [mail] = await mails(idea.ideaId);
  expect(mail?.payload.titles).toEqual({ ru: 'Экспорт заказов', uz: 'Buyurtmalar eksporti' });
  expect(JSON.stringify(mail?.payload)).not.toContain('Machine order export');
  // Получатель с английским языком видит оригинал без пометки, а не машинный перевод.
  const en = await renderMail('idea_status', 'en', { ...(mail!.payload as Parameters<typeof renderMail>[2]), hubUrl: 'https://hub.example', supportAddress: null });
  expect(en.text).toContain('Экспорт заказов');
  expect(en.text).not.toContain('Machine order export');
});

test('письмо: заголовок без ссылок на языке получателя, без разметки', async () => {
  const data = {
    template: 'idea_status' as const,
    event: 'released' as const,
    ideaId: '00000000-0000-0000-0000-000000000001',
    number: 204,
    title: 'Экспорт <b>заказов</b> https://evil.example',
    titles: { ru: 'Экспорт <b>заказов</b> https://evil.example', en: 'Order export www.evil.example' },
    url: 'https://hub.example/en/ideas/204',
    hubUrl: 'https://hub.example',
    supportAddress: null,
  };
  const en = await renderMail('idea_status', 'en', data);
  expect(en.subject).toContain('[I-204]');
  expect(en.text).toContain('Order export');
  expect(en.html).not.toContain('evil.example');
  expect(en.text).not.toContain('evil.example');
  const ru = await renderMail('idea_status', 'ru', data);
  expect(ru.html).toContain('Экспорт');
  expect(ru.html).not.toContain('<b>заказов');
  expect(ru.html).not.toContain('evil.example');
});

test('сводка модерации раз в день роли product: идеи старше двух рабочих дней, повторный запуск в тот же день ничего не шлёт', async () => {
  const f = await seedTwoOrgs();
  const p1 = await staffWithRole('product');
  const old = await addIdea(f.orgA.orgId, f.aUser, 'pending_review');
  await addIdea(f.orgA.orgId, f.aUser, 'pending_review');
  await pools.root.query(`begin; set local session_replication_role = replica; update hdi_ideas set created_on = now() - interval '7 days' where idea_id = '${old.ideaId}'; commit`);
  const first = await runModerationDigest(system, new Date());
  expect(first.due).toBe(1);
  const rows = (await pools.root.query(`select user_id, payload from hdn_notifications where kind = 'idea_moderation_due' and user_id = $1`, [p1.userId])).rows;
  expect(rows).toEqual([{ user_id: p1.userId, payload: { count: 1 } }]);
  expect((await pools.root.query(`select count(*)::int as n from hdn_outbox where template = 'staff_idea_moderation' and recipient_user_id = $1`, [p1.userId])).rows[0].n).toBe(1);
  expect(await runModerationDigest(system, new Date())).toMatchObject({ skipped: true });
  expect((await pools.root.query(`select count(*)::int as n from hdn_notifications where kind = 'idea_moderation_due' and user_id = $1`, [p1.userId])).rows[0].n).toBe(1);
});
