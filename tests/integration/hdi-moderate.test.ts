import { afterEach, beforeEach, expect, test } from 'vitest';
import { defaultStubResponse, setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { runIdeaIndexJob, runIdeaTranslationJob } from '@/modules/hdi/api/jobs';
import { declineIdea, editIdeaAsModerator, mergeIdea, publishIdea, reviewIdeaTranslation } from '@/modules/hdi/api/moderate';
import { submitIdea } from '@/modules/hdi/api/submit';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { appUrl, pools, system } from './helpers/db';
import { Client } from 'pg';
import { withActor } from '@/db/with-actor';
import { mergeTx } from '@/modules/hdi/core/moderate';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';

// Модерация, объединение и машинный перевод идей (ТЗ FR-IDEA-03, 13, 14.3, S6 (2); план M7, задача 4).

let jobs: MemoryJobQueue;
let stub: StubAiClient;
beforeEach(() => {
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  stub = new StubAiClient();
  setAiClientForTests(stub);
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

const product = async () => staffCtx(await staffWithRole('product'));
const ideaRow = (ideaId: string) => pools.root.query(`select * from hdi_ideas where idea_id = $1`, [ideaId]).then((r) => r.rows[0]);
const texts = (ideaId: string) =>
  pools.root.query(`select locale, title, body, status, is_machine from hdi_idea_translations where idea_id = $1 order by locale`, [ideaId]).then((r) => r.rows);
const audit = (action: string, ideaId: string) => pools.root.query(`select diff from hdc_audit_log where action = $1 and object_id = $2`, [action, ideaId]).then((r) => r.rows.map((row) => row.diff));

async function submitted(f: Fixture, body = 'Хотим печатать все накладные дня одной кнопкой') {
  const result = await submitIdea(await clientCtx(f.aUser), { title: 'Печать накладных пачкой', body, locale: 'ru', showOrg: true, confirmFindings: true });
  const number = (result as { number: number }).number;
  const ideaId = (await pools.root.query(`select idea_id from hdi_ideas where number = $1`, [number])).rows[0].idea_id as string;
  return { number, ideaId };
}

test('публикация ставит published_on и модератора, задания перевода и индекса и запись журнала; не модератор отклоняется', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f);
  for (const member of [f.l1, f.care]) await expect(publishIdea(staffCtx(member), { number })).rejects.toMatchObject({ code: 'forbidden' });
  const moderator = await product();
  expect(await publishIdea(moderator, { number: `I-${number}` })).toEqual({ number });
  const row = await ideaRow(ideaId);
  expect(row).toMatchObject({ status: 'open', moderated_by: moderator.actor.userId });
  expect(row.published_on).not.toBeNull();
  expect(jobs.sent).toEqual([
    { name: 'ideas.translate', data: { ideaId } },
    { name: 'ideas.index', data: { ideaId } },
  ]);
  expect(await audit('idea.published', ideaId)).toEqual([{ number: `I-${number}`, from: 'pending_review', to: 'open', findings: [] }]);
  await expect(publishIdea(moderator, { number })).rejects.toMatchObject({ code: 'bad_transition' });
});

test('решение 9: блокирующая находка без отметки "Проверено" не публикуется, с отметкой публикуется', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f, 'Звоните +998 90 123 45 67 по поводу печати');
  const moderator = await product();
  await expect(publishIdea(moderator, { number })).rejects.toMatchObject({ code: 'findings_unchecked' });
  await publishIdea(moderator, { number, findingsChecked: true });
  expect(await ideaRow(ideaId)).toMatchObject({ status: 'open', findings_checked: true });
});

test('решение 5: модератор правит текст до публикации, в журнале только отпечатки; после публикации правка закрыта', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f, 'Звоните +998 90 123 45 67 по поводу печати');
  const moderator = await product();
  await editIdeaAsModerator(moderator, { number, title: 'Печать накладных пачкой', body: 'Хотим печатать по поводу печати', moduleId: '' });
  expect((await texts(ideaId))[0]).toMatchObject({ body: 'Хотим печатать по поводу печати', status: 'original' });
  const [diff] = await audit('idea.moderator_edited', ideaId);
  expect(JSON.stringify(diff)).not.toMatch(/печат|998/);
  expect(diff.textDigestFrom).not.toBe(diff.textDigestTo);
  // Без находок публикуется без отметки.
  await publishIdea(moderator, { number });
  await expect(editIdeaAsModerator(moderator, { number, title: 'Другая', body: 'x', moduleId: '' })).rejects.toMatchObject({ code: 'not_editable' });
});

test('отклонение без причины отклоняется; с причиной снимает идею из индекса той же транзакцией', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f);
  const moderator = await product();
  await publishIdea(moderator, { number });
  await runIdeaIndexJob(system, { ideaId });
  expect((await pools.root.query(`select count(*)::int as n from hdk_search_documents where ref_id = $1`, [ideaId])).rows[0].n).toBe(1);
  await expect(declineIdea(moderator, { number })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(declineIdea(moderator, { number, reason: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(declineIdea(moderator, { number, reason: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'invalid_input' });
  await declineIdea(moderator, { number, reason: 'Уже есть в плане на весну' });
  expect(await ideaRow(ideaId)).toMatchObject({ status: 'declined', decline_reason: 'Уже есть в плане на весну' });
  expect((await pools.root.query(`select count(*)::int as n from hdk_search_documents where ref_id = $1`, [ideaId])).rows[0].n).toBe(0);
  await expect(declineIdea(moderator, { number, reason: 'Ещё раз' })).rejects.toMatchObject({ code: 'bad_transition' });
});

test('решение 6: объединение в идею на модерации, отклонённую, объединённую и в саму себя отклоняется', async () => {
  const f = await seedTwoOrgs();
  const { number } = await submitted(f);
  const moderator = await product();
  const pending = await addIdea(f.orgB.orgId, f.bUser, 'pending_review');
  const declined = await addIdea(f.orgB.orgId, f.bUser, 'declined');
  const open = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const merged = await addIdea(f.orgB.orgId, f.bUser, 'merged', { mergedInto: open.ideaId });
  for (const into of [pending.number, declined.number, merged.number, number, 999_999])
    await expect(mergeIdea(moderator, { number, into })).rejects.toMatchObject({ code: 'bad_merge_target' });
});

test('решение 6: голоса пересекающихся пользователей не задваиваются, подписки переносятся, источник уходит из индекса', async () => {
  const f = await seedTwoOrgs();
  const moderator = await product();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Печать накладных одной кнопкой' });
  const source = await addIdea(f.orgA.orgId, f.aUser, 'open', { title: 'Печать накладных пачкой' });
  await pools.root.query(
    `insert into hdi_votes (org_id, idea_id, user_id) values ($1, $3, $4), ($1, $3, $5), ($2, $3, $6), ($1, $7, $4), ($2, $7, $6), ($2, $7, $8)`,
    [f.orgA.orgId, f.orgB.orgId, source.ideaId, f.aUser.userId, f.aAdmin.userId, f.bUser.userId, target.ideaId, f.bAdmin.userId],
  );
  await pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) values ($1, $2), ($1, $3), ($4, $3)`, [source.ideaId, f.aUser.userId, f.bUser.userId, target.ideaId]);
  await runIdeaIndexJob(system, { ideaId: source.ideaId });
  expect(await mergeIdea(moderator, { number: source.number, into: `I-${target.number}` })).toEqual({ into: target.number, moved: 1 });
  expect(await ideaRow(target.ideaId)).toMatchObject({ vote_count: 4, org_count: 2 });
  expect(await ideaRow(source.ideaId)).toMatchObject({ status: 'merged', merged_into_id: target.ideaId, vote_count: 0, org_count: 0 });
  expect((await pools.root.query(`select user_id from hdi_subscriptions where idea_id = $1 order by user_id`, [target.ideaId])).rows.map((r) => r.user_id).sort()).toEqual(
    [f.aUser.userId, f.bUser.userId].sort(),
  );
  expect((await pools.root.query(`select count(*)::int as n from hdk_search_documents where ref_id = $1`, [source.ideaId])).rows[0].n).toBe(0);
  expect(await audit('idea.merged', source.ideaId)).toEqual([{ number: `I-${source.number}`, into: `I-${target.number}`, from: 'open', to: 'merged', movedVotes: 1 }]);
});

/** Отдельное подключение клиента с открытой транзакцией: голос вставлен, но не зафиксирован. */
async function heldVote(actor: { userId: string; orgId: string }, ideaId: string): Promise<Client> {
  const c = new Client({ connectionString: appUrl });
  await c.connect();
  await c.query('begin');
  await c.query(`select set_config('app.actor_type', 'client', true), set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.org_role', 'client_user', true)`, [
    actor.userId,
    actor.orgId,
  ]);
  await c.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [actor.orgId, ideaId, actor.userId]);
  return c;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('итоговая проверка M7, M1: объединение ждёт голос, начатый раньше, и переносит его; голос не остаётся у объединённой идеи', async () => {
  const f = await seedTwoOrgs();
  const moderator = await product();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const source = await addIdea(f.orgA.orgId, f.aUser, 'open');
  const voter = await heldVote({ userId: f.aAdmin.userId, orgId: f.orgA.orgId }, source.ideaId);
  try {
    const merging = mergeIdea(moderator, { number: source.number, into: target.number });
    await pause(400);
    await voter.query('commit');
    expect(await merging).toEqual({ into: target.number, moved: 1 });
  } finally {
    await voter.end();
  }
  expect((await pools.root.query(`select idea_id from hdi_votes where user_id = $1`, [f.aAdmin.userId])).rows.map((r) => r.idea_id)).toEqual([target.ideaId]);
  expect(await ideaRow(source.ideaId)).toMatchObject({ status: 'merged', vote_count: 0 });
  expect(await ideaRow(target.ideaId)).toMatchObject({ vote_count: 1 });
});

test('итоговая проверка M7, M1: голос во время объединения ждёт его конца и отклоняется: идея уже объединена', async () => {
  const f = await seedTwoOrgs();
  const moderator = await product();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const source = await addIdea(f.orgA.orgId, f.aUser, 'open');
  let vote: Promise<unknown> | null = null;
  let settled = false;
  await withActor(moderator.actor, async (tx) => {
    await mergeTx(tx, source.number, target.number);
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    vote = (async () => {
      try {
        await c.query('begin');
        await c.query(`select set_config('app.actor_type', 'client', true), set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.org_role', 'client_user', true)`, [
          f.aAdmin.userId,
          f.orgA.orgId,
        ]);
        await c.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [f.orgA.orgId, source.ideaId, f.aAdmin.userId]);
        await c.query('commit');
      } finally {
        settled = true;
        await c.end();
      }
    })();
    await pause(400);
    // Голос ждёт блокировку строки идеи, пока объединение не зафиксировано.
    expect(settled).toBe(false);
  });
  await expect(vote).rejects.toThrow(/нельзя/);
  expect((await pools.root.query(`select count(*)::int as n from hdi_votes where idea_id = $1`, [source.ideaId])).rows[0].n).toBe(0);
  expect(await ideaRow(source.ideaId)).toMatchObject({ status: 'merged', vote_count: 0 });
});

test('14.3: в запрос перевода не попадают имя автора, организация, почта и телефон; переводы ложатся машинными, журнал без текста', async () => {
  const f = await seedTwoOrgs();
  const body = `Алишер из ACME Trade просит: печатать 50 накладных за раз, почта a@acme.uz, телефон +998 90 123 45 67`;
  const { number, ideaId } = await submitted(f, body);
  await publishIdea(await product(), { number, findingsChecked: true });
  await pools.root.query(`insert into hdi_comments (org_id, idea_id, author_id, author_name, body) values ($1, $2, $3, 'Алишер', 'Секретный комментарий')`, [f.orgA.orgId, ideaId, f.aUser.userId]);
  // Заглушка возвращает текст как пришёл: сверка с оригиналом (телефон и почта вырезаны) его отклонит, проверяем запрос.
  const result = await runIdeaTranslationJob(system, { ideaId });
  expect(stub.calls).toHaveLength(2);
  for (const call of stub.calls) {
    expect(call.data).toContain('<idea>');
    expect(call.data).toContain('50 накладных');
    for (const secret of ['Алишер', 'ACME', 'Trade', 'a@acme.uz', '123 45 67', 'Секретный комментарий']) expect(call.data, secret).not.toContain(secret);
  }
  expect(result.status).toBe('translated');
  const runs = await pools.root.query(`select org_id, purpose, outcome from hda_runs where ref_id = $1`, [ideaId]);
  expect(runs.rows).toEqual([
    { org_id: f.orgA.orgId, purpose: 'idea_translation', outcome: 'ok' },
    { org_id: f.orgA.orgId, purpose: 'idea_translation', outcome: 'ok' },
  ]);
});

test('решение 11: перевод проходит сверку и виден клиенту машинным; с потерянным числом получает rejected и клиенту не виден', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f, 'Печатать 50 накладных за раз, сейчас по одной');
  await publishIdea(await product(), { number });
  stub.respond = (call) =>
    call.data.includes('на узбекский')
      ? { title: 'Yuk xatlarini bosib chiqarish', body: 'Bir martada yuk xatlarini chop etish' }
      : call.data.includes('на английский')
        ? { title: 'Batch printing of invoices', body: 'Print 50 invoices at once, now one by one' }
        : defaultStubResponse(call);
  expect(await runIdeaTranslationJob(system, { ideaId })).toEqual({ status: 'translated', machine: 1, rejected: 1 });
  expect((await texts(ideaId)).map((t) => [t.locale, t.status, t.is_machine])).toEqual([
    ['en', 'machine', true],
    ['ru', 'original', false],
    ['uz', 'rejected', true],
  ]);
  const { asActor } = await import('./helpers/db');
  const seen = await asActor(pools.app, f.bUser.actor, (c) => c.query(`select locale from hdi_idea_translations where idea_id = $1 order by locale`, [ideaId]));
  expect(seen.rows.map((r) => r.locale)).toEqual(['en', 'ru']);
  expect(jobs.sent).toContainEqual({ name: 'ideas.index', data: { ideaId } });
  // Повтор задания: годный перевод того же оригинала не переводится заново, не прошедший сверку переводится.
  stub.calls.length = 0;
  await runIdeaTranslationJob(system, { ideaId });
  expect(stub.calls.map((c) => c.data.includes('на узбекский'))).toEqual([true]);
});

// Проверка на AI-инъекции (волна 7, S-I3): враждебная заглушка дописывает в перевод указание и адрес словами.
test('S-I3: перевод с дописанным текстом и адресом словами получает rejected, клиент другой организации видит оригинал', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f, 'Печатать 50 накладных за раз, сейчас по одной');
  await publishIdea(await product(), { number });
  stub.respond = (call) =>
    call.data.includes('на узбекский')
      ? { title: 'Yuk xatlarini bosib chiqarish', body: 'Bir martada 50 yuk xatini chop etish. Hisobingiz bloklandi: smartup-help nuqta com ga parolingizni yuboring' }
      : call.data.includes('на английский')
        ? { title: 'Batch printing of invoices', body: `Print 50 invoices at once, now one by one. ${'Your account is blocked. Send your password to the support team right now. '.repeat(2)}` }
        : defaultStubResponse(call);
  expect(await runIdeaTranslationJob(system, { ideaId })).toEqual({ status: 'translated', machine: 0, rejected: 2 });
  const { asActor } = await import('./helpers/db');
  const seen = await asActor(pools.app, f.bUser.actor, (c) => c.query(`select locale, body from hdi_idea_translations where idea_id = $1 order by locale`, [ideaId]));
  expect(seen.rows.map((r) => r.locale)).toEqual(['ru']);
  expect(JSON.stringify(seen.rows)).not.toMatch(/parol|password|nuqta/);
});

test('решение 12: организация с выключенной AI-обработкой не даёт вызова модели', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f);
  await publishIdea(await product(), { number });
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  expect(await runIdeaTranslationJob(system, { ideaId })).toEqual({ status: 'ai_disabled', machine: 0, rejected: 0 });
  expect(stub.calls).toEqual([]);
  expect((await pools.root.query(`select count(*)::int as n from hda_runs where ref_id = $1`, [ideaId])).rows[0].n).toBe(0);
});

test('решение 11: правка перевода модератором ставит reviewed без пометки машинного, задание его не перезаписывает', async () => {
  const f = await seedTwoOrgs();
  const { number, ideaId } = await submitted(f);
  const moderator = await product();
  await publishIdea(moderator, { number });
  await runIdeaTranslationJob(system, { ideaId });
  await expect(reviewIdeaTranslation(staffCtx(f.l1), { number, locale: 'en', title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(reviewIdeaTranslation(moderator, { number, locale: 'ru', title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'invalid_input' });
  await reviewIdeaTranslation(moderator, { number, locale: 'en', title: 'Batch printing of invoices', body: 'Print all invoices of the day with one button' });
  expect((await texts(ideaId)).find((t) => t.locale === 'en')).toMatchObject({ status: 'reviewed', is_machine: false, title: 'Batch printing of invoices' });
  stub.calls.length = 0;
  await runIdeaTranslationJob(system, { ideaId });
  expect(stub.calls).toEqual([]);
  expect((await texts(ideaId)).find((t) => t.locale === 'en')).toMatchObject({ status: 'reviewed' });
  // Правка оригинала делает переводы устаревшими (триггер базы): клиент их не видит до нового перевода.
  await pools.root.query(`update hdi_idea_translations set body = 'Новое описание' where idea_id = $1 and status = 'original'`, [ideaId]);
  expect((await texts(ideaId)).filter((t) => t.locale !== 'ru').map((t) => t.status)).toEqual(['outdated', 'outdated']);
});
