import { expect, test } from 'vitest';
import { addComment, addStaffReply, editComment, listComments, moderateComment, pendingComments } from '@/modules/hdi/api/comments';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';
import { addIdea, seedIdeas } from './isolation/ideas-fixture';

// Комментарии к идеям и ответы Smartup (ТЗ FR-IDEA-07; план M7, задача 7, решение 8): публикуются сразу, с телефоном,
// почтой, ИНН, ПИНФЛ, адресом сервера или ссылкой ждут модератора и видны только автору; скрытие с причиной и журналом.

const commentRow = (commentId: string) => pools.root.query(`select * from hdi_comments where comment_id = $1`, [commentId]).then((r) => r.rows[0]);
const ideaRow = (ideaId: string) => pools.root.query(`select comment_count from hdi_ideas where idea_id = $1`, [ideaId]).then((r) => r.rows[0]);
const audit = (action: string, objectId: string) => pools.root.query(`select diff from hdc_audit_log where action = $1 and object_id = $2`, [action, objectId]).then((r) => r.rows.map((row) => row.diff));

test('решение 8: обычный комментарий публикуется сразу, с телефоном или ссылкой ждёт модератора и виден только автору', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const a = await clientCtx(f.aUser);
  const b = await clientCtx(f.bUser);
  const plain = await addComment(a, { number: idea.number, body: 'Очень нужно, поддерживаю' });
  expect(plain.status).toBe('published');
  for (const body of ['Позвоните +998 90 123 45 67', 'Подробности на https://evil.example/login', 'Смотрите www.example.uz']) {
    expect((await addComment(a, { number: idea.number, body })).status, body).toBe('pending');
  }
  expect((await ideaRow(idea.ideaId)).comment_count).toBe(1);
  const mine = await listComments(a.actor, { number: idea.number });
  expect(mine.items.map((c) => c.status)).toEqual(['published', 'pending', 'pending', 'pending']);
  expect(mine.items[1]).toMatchObject({ mine: true, editable: true });
  const theirs = await listComments(b.actor, { number: idea.number });
  expect(theirs.items.map((c) => c.body)).toEqual(['Очень нужно, поддерживаю']);
  expect(JSON.stringify(theirs)).not.toContain(f.orgA.name);
  const [held] = await audit('idea.comment_held', (mine.items[1] as { commentId: string }).commentId);
  expect(JSON.stringify(held)).not.toMatch(/998|Позвоните/);
});

test('14.5 сверх ТЗ: 21-й комментарий за час отклоняется', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const a = await clientCtx(f.aUser);
  for (let i = 0; i < 20; i++) await addComment(a, { number: idea.number, body: `Комментарий ${i}` });
  await expect(addComment(a, { number: idea.number, body: 'Ещё один' })).rejects.toMatchObject({ code: 'rate_limited' });
});

test('комментарий к чужой идее на модерации, к отклонённой и объединённой отклоняется; автор комментирует свою на модерации', async () => {
  const f = await seedTwoOrgs();
  const set = await seedIdeas(f);
  const a = await clientCtx(f.aUser);
  await expect(addComment(a, { number: set.bPending.number, body: 'Привет' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(addComment(a, { number: set.bDeclinedVoted.number, body: 'Привет' })).rejects.toMatchObject({ code: 'comments_closed' });
  await expect(addComment(a, { number: set.bMergedPublished.number, body: 'Привет' })).rejects.toMatchObject({ code: 'comments_closed' });
  expect((await addComment(a, { number: set.aPending.number, body: 'Уточню позже' })).status).toBe('published');
  await expect(addComment(a, { number: set.bOpen.number, body: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addComment(a, { number: set.bOpen.number, body: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('скрытие модератором: аудит, уход из счётчика, причина видна автору; публикация удержанного; не модератор не может', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const a = await clientCtx(f.aUser);
  const visible = await addComment(a, { number: idea.number, body: 'Нужна выгрузка' });
  const held = await addComment(a, { number: idea.number, body: 'Мой телефон +998 90 123 45 67' });
  expect((await ideaRow(idea.ideaId)).comment_count).toBe(1);
  for (const member of [f.l1, f.care]) await expect(moderateComment(staffCtx(member), { commentId: visible.commentId, action: 'hide', reason: 'Спам' })).rejects.toMatchObject({ code: 'forbidden' });
  const product = staffCtx(await staffWithRole('product'));
  expect((await pendingComments(product)).map((c) => c.commentId)).toEqual([held.commentId]);
  await expect(moderateComment(product, { commentId: visible.commentId, action: 'hide' })).rejects.toMatchObject({ code: 'invalid_input' });
  await moderateComment(product, { commentId: visible.commentId, action: 'hide', reason: 'Не по теме' });
  expect(await commentRow(visible.commentId)).toMatchObject({ status: 'hidden', hide_reason: 'Не по теме', hidden_by: product.actor.userId });
  expect((await ideaRow(idea.ideaId)).comment_count).toBe(0);
  expect(await audit('idea.comment_hidden', visible.commentId)).toEqual([{ idea: `I-${idea.number}`, from: 'published', to: 'hidden' }]);
  await moderateComment(product, { commentId: held.commentId, action: 'publish' });
  expect((await ideaRow(idea.ideaId)).comment_count).toBe(1);
  const own = await listComments(a.actor, { number: idea.number });
  expect(own.items.find((c) => c.commentId === visible.commentId)).toMatchObject({ status: 'hidden', hideReason: 'Не по теме', editable: false });
  const other = await listComments((await clientCtx(f.bUser)).actor, { number: idea.number });
  expect(other.items.map((c) => c.commentId)).toEqual([held.commentId]);
});

test('ответ сотрудника публикуется сразу со значком Smartup; любой сотрудник может ответить', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const reply = await addStaffReply(staffCtx(f.l1), { number: idea.number, body: 'Спасибо, передали команде' });
  expect(await commentRow(reply.commentId)).toMatchObject({ is_official: true, status: 'published', org_id: null });
  const seen = await listComments((await clientCtx(f.aUser)).actor, { number: idea.number });
  expect(seen.items[0]).toMatchObject({ isOfficial: true, body: 'Спасибо, передали команде', mine: false });
});

test('правка своего комментария: в первые 15 минут можно, с телефоном уходит на проверку, позже отклоняется', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const a = await clientCtx(f.aUser);
  const comment = await addComment(a, { number: idea.number, body: 'Первый вариант' });
  expect(await editComment(a, { commentId: comment.commentId, body: 'Второй вариант' })).toEqual({ status: 'published' });
  expect(await editComment(a, { commentId: comment.commentId, body: 'Звоните +998 90 123 45 67' })).toEqual({ status: 'pending' });
  await expect(editComment(await clientCtx(f.aAdmin), { commentId: comment.commentId, body: 'Чужой' })).rejects.toMatchObject({ code: 'not_found' });
  await pools.root.query(`begin; set local session_replication_role = replica; update hdi_comments set created_on = now() - interval '16 minutes' where comment_id = '${comment.commentId}'; commit`);
  await expect(editComment(a, { commentId: comment.commentId, body: 'Третий' })).rejects.toMatchObject({ code: 'not_editable' });
});

test('постранично по ключу: старые сверху, без повторов', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const values = Array.from({ length: 55 }, (_, i) => `('${f.orgA.orgId}', '${idea.ideaId}', '${f.aUser.userId}', '${f.aUser.name.replace(/'/g, "''")}', 'Комментарий ${i}', now() + make_interval(secs => ${i}))`).join(',');
  await pools.root.query(`insert into hdi_comments (org_id, idea_id, author_id, author_name, body, created_on) values ${values}`);
  const ctx = await clientCtx(f.bUser);
  const first = await listComments(ctx.actor, { number: idea.number });
  expect(first.items).toHaveLength(50);
  expect(first.items[0]?.body).toBe('Комментарий 0');
  const second = await listComments(ctx.actor, { number: idea.number, after: first.next ?? '' });
  expect(second.items.map((c) => c.body)).toEqual(['Комментарий 50', 'Комментарий 51', 'Комментарий 52', 'Комментарий 53', 'Комментарий 54']);
  expect(second.next).toBeNull();
});
