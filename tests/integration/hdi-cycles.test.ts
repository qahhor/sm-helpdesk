import { afterEach, beforeEach, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { clientCycleArchive, decideCycle, draftCycleExplanation, runIdeaCycle, staffCycleBoard } from '@/modules/hdi/api/cycles';
import { SCHEDULES } from '@/worker/main';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { addIdea, type IdeaRef } from './isolation/ideas-fixture';

// Отбор месяца (ТЗ FR-IDEA-09, 10, 16; план M7, задача 9, решения 3, 16, 17). Время подменяется параметром: задание
// получает "сейчас" от расписания, тест передаёт его сам (строка M7 раздела 16.2: тест с подменой времени).

let f: Fixture;
let stub: StubAiClient;

beforeEach(async () => {
  setJobQueueForTests(new MemoryJobQueue());
  stub = new StubAiClient();
  setAiClientForTests(stub);
  f = await seedTwoOrgs();
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

/** 1 декабря 2026, 09:00 по Ташкенту: 04:00 UTC. */
const DEC_1 = new Date('2026-12-01T04:00:00Z');
const product = async () => staffCtx(await staffWithRole('product'));
const statusOf = async (ref: IdeaRef) => (await pools.root.query(`select status, selected_cycle::text from hdi_ideas where idea_id = $1`, [ref.ideaId])).rows[0] as { status: string; selected_cycle: string | null };
const cycles = () => pools.root.query(`select cycle::text, status, shortlist, vote_mode, leader_idea_id, selected_idea_id, decided_by from hdi_cycles order by cycle`).then((r) => r.rows);

/** Голоса пользователей первой организации (или своей для каждой пары) строками под суперпользователем. */
async function votes(ref: IdeaRef, voters: { orgId: string; userId: string }[]): Promise<void> {
  for (const v of voters) await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [v.orgId, ref.ideaId, v.userId]);
}
/** Новые клиенты организации: голосующие для счёта. */
async function voters(orgId: string, n: number): Promise<{ orgId: string; userId: string }[]> {
  const r = await pools.root.query(
    `with u as (insert into auth."user" (name, email, "emailVerified") select 'Голос ' || g, 'cycle-' || g || '-' || $2 || '@acme.example', true from generate_series(1, $3::int) g returning id)
     insert into hdu_memberships (org_id, user_id, role, source) select $1, id, 'client_user', 'invite' from u returning user_id`,
    [orgId, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, n],
  );
  return r.rows.map((row) => ({ orgId, userId: row.user_id as string }));
}
/** Одинаковая дата создания: в обход триггера служебных колонок. */
async function sameCreatedOn(refs: IdeaRef[]): Promise<void> {
  await pools.root.query(
    `begin; set local session_replication_role = replica; update hdi_ideas set created_on = '2026-11-05T10:00:00Z' where idea_id in (${refs.map((r) => `'${r.ideaId}'`).join(', ')}); commit`,
  );
}

test('FR-IDEA-09: 1 декабря 2026 в 09:00 по Ташкенту отбор создаётся, в 08:59 нет', async () => {
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(idea, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  expect(await runIdeaCycle(system, new Date('2026-12-01T03:59:00Z'))).toEqual({ status: 'too_early' });
  expect(await cycles()).toEqual([]);
  const result = await runIdeaCycle(system, DEC_1);
  expect(result).toMatchObject({ status: 'created', cycle: '2026-12-01', shortlist: [idea.number] });
  expect(await cycles()).toMatchObject([{ cycle: '2026-12-01', status: 'open', vote_mode: 'per_user', leader_idea_id: idea.ideaId, selected_idea_id: null }]);
  expect((await cycles())[0].shortlist).toEqual([{ ideaId: idea.ideaId, number: idea.number, voteCount: 1, orgCount: 1, place: 1 }]);
  expect(await statusOf(idea)).toMatchObject({ status: 'shortlisted' });
  // Позже в том же месяце (процесс не работал утром) задание догоняет тот же отбор.
  expect(await runIdeaCycle(system, new Date('2026-12-15T10:00:00Z'))).toEqual({ status: 'exists', cycle: '2026-12-01' });
});

test('решение 16: повторный и параллельный запуск дают один отбор', async () => {
  await staffWithRole('product');
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(idea, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  const results = await Promise.all(Array.from({ length: 5 }, () => runIdeaCycle(system, DEC_1)));
  expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'exists')).toHaveLength(4);
  expect(await cycles()).toHaveLength(1);
  // Уведомление роли product одно, снимок не задвоен.
  expect((await pools.root.query(`select count(*)::int as n from hdn_notifications where kind = 'idea_cycle'`)).rows[0].n).toBe(1);
  expect((await statusOf(idea)).status).toBe('shortlisted');
});

test('решение 16: пятёрка по голосам, при равенстве раньше созданная, затем меньший номер; идеи без голосов не участвуют', async () => {
  const people = await voters(f.orgA.orgId, 6);
  const ideas: IdeaRef[] = [];
  for (let i = 0; i < 7; i++) ideas.push(await addIdea(f.orgB.orgId, f.bUser, 'open', { title: `Идея ${i}` }));
  const [i0, i1, i2, i3, i4, i5, i6] = ideas as [IdeaRef, IdeaRef, IdeaRef, IdeaRef, IdeaRef, IdeaRef, IdeaRef];
  await votes(i0, people.slice(0, 1));
  await votes(i1, people.slice(0, 3));
  await votes(i2, people.slice(0, 2));
  await votes(i3, people.slice(0, 2));
  await votes(i4, people.slice(0, 2));
  await votes(i5, people.slice(0, 1));
  // i6 без голосов. Равенство по голосам у i2, i3, i4: i4 создана раньше всех, у i2 и i3 одна дата, решает номер.
  await sameCreatedOn([i2, i3]);
  await pools.root.query(`begin; set local session_replication_role = replica; update hdi_ideas set created_on = '2026-11-01T10:00:00Z' where idea_id = '${i4.ideaId}'; commit`);
  // i0 и i5 по одному голосу: i0 создана раньше.
  const result = await runIdeaCycle(system, DEC_1);
  expect(result).toMatchObject({ status: 'created', shortlist: [i1.number, i4.number, i2.number, i3.number, i0.number] });
  expect((await statusOf(i5)).status).toBe('open');
  expect((await statusOf(i6)).status).toBe('open');
  const [row] = await cycles();
  expect(row.shortlist.map((s: { place: number; number: number }) => [s.place, s.number])).toEqual([
    [1, i1.number],
    [2, i4.number],
    [3, i2.number],
    [4, i3.number],
    [5, i0.number],
  ]);
});

test('решение 16: меньше пяти кандидатов дают короткую пятёрку; без кандидатов отбор пустой и сразу закрыт', async () => {
  const lone = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(lone, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  await addIdea(f.orgB.orgId, f.bUser, 'open');
  await addIdea(f.orgB.orgId, f.bUser, 'pending_review');
  expect(await runIdeaCycle(system, new Date('2026-11-01T04:00:00Z'))).toMatchObject({ status: 'created', shortlist: [lone.number] });
  // В декабре голосов нет ни у кого: lone вернулась в open при закрытии ноябрьского отбора, но её голос остался.
  await pools.root.query(`delete from hdi_votes`);
  expect(await runIdeaCycle(system, DEC_1)).toMatchObject({ status: 'created', shortlist: [], lapsed: 1 });
  expect((await cycles()).map((c) => [c.cycle, c.status, c.shortlist, c.leader_idea_id])).toEqual([
    ['2026-11-01', 'lapsed', [{ ideaId: lone.ideaId, number: lone.number, voteCount: 1, orgCount: 1, place: 1 }], lone.ideaId],
    ['2026-12-01', 'lapsed', [], null],
  ]);
  expect((await statusOf(lone)).status).toBe('open');
});

test('решение 3: режим per_org меняет порядок', async () => {
  const many = await voters(f.orgA.orgId, 3);
  const big = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Крупный клиент' });
  const wide = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Две организации' });
  await votes(big, many);
  await votes(wide, [many[0]!, { orgId: f.orgB.orgId, userId: f.bAdmin.userId }]);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ideas.vote_mode', '"per_org"') on conflict (code) do update set value = excluded.value`);
  const result = await runIdeaCycle(system, DEC_1);
  expect(result).toMatchObject({ shortlist: [wide.number, big.number] });
  expect((await cycles())[0]).toMatchObject({ vote_mode: 'per_org' });
});

test('решение 17: невыбранный прошлый отбор закрывается как lapsed, пятёрка возвращается в open и участвует снова', async () => {
  const a = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const b = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(a, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  await votes(b, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }, { orgId: f.orgA.orgId, userId: f.aAdmin.userId }]);
  await runIdeaCycle(system, new Date('2026-11-01T04:00:00Z'));
  expect((await statusOf(a)).status).toBe('shortlisted');
  const result = await runIdeaCycle(system, DEC_1);
  expect(result).toMatchObject({ status: 'created', lapsed: 1, shortlist: [b.number, a.number] });
  expect((await cycles()).map((c) => [c.cycle, c.status])).toEqual([
    ['2026-11-01', 'lapsed'],
    ['2026-12-01', 'open'],
  ]);
  const audit = await pools.root.query(`select action, diff from hdc_audit_log where action like 'idea.cycle%' order by created_on, audit_id`);
  expect(audit.rows.map((r) => r.action)).toEqual(['idea.cycle_created', 'idea.cycle_lapsed', 'idea.cycle_created']);
});

test('FR-IDEA-10, решение 17: не лидер без объяснения отклоняется; выбор ставит selected, остальные в open; второй выбор отклоняется', async () => {
  const leader = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Лидер' });
  const second = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Вторая' });
  const third = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Третья' });
  const people = await voters(f.orgA.orgId, 3);
  await votes(leader, people);
  await votes(second, people.slice(0, 2));
  await votes(third, people.slice(0, 1));
  await runIdeaCycle(system, DEC_1);
  const moderator = await product();

  await expect(decideCycle(moderator, { cycle: '2026-12-01', number: second.number })).rejects.toMatchObject({ code: 'explanation_required' });
  await expect(decideCycle(moderator, { cycle: '2026-12-01', number: second.number, explanationRu: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  // Идея вне пятёрки и чужие роли.
  const outside = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await expect(decideCycle(moderator, { cycle: '2026-12-01', number: outside.number, explanationRu: 'Нет' })).rejects.toMatchObject({ code: 'not_in_shortlist' });
  for (const role of ['agent_l1', 'agent_l2', 'care'] as const)
    await expect(decideCycle(staffCtx(await staffWithRole(role)), { cycle: '2026-12-01', number: leader.number })).rejects.toMatchObject({ code: 'forbidden' });

  await decideCycle(moderator, { cycle: '2026-12-01', number: second.number, explanationRu: 'Быстрее сделать, польза шире', explanationEn: 'Faster to build' });
  expect(await statusOf(second)).toEqual({ status: 'selected', selected_cycle: '2026-12-01' });
  expect((await statusOf(leader)).status).toBe('open');
  expect((await statusOf(third)).status).toBe('open');
  const [row] = await cycles();
  expect(row).toMatchObject({ status: 'decided', selected_idea_id: second.ideaId, decided_by: moderator.actor.userId });
  await expect(decideCycle(moderator, { cycle: '2026-12-01', number: leader.number })).rejects.toMatchObject({ code: 'cycle_closed' });
  const audit = await pools.root.query(`select action, actor_id, diff from hdc_audit_log where action in ('idea.cycle_decided', 'idea.status_changed') order by created_on, audit_id`);
  expect(audit.rows).toMatchObject([
    { action: 'idea.cycle_decided', actor_id: moderator.actor.userId, diff: { cycle: '2026-12-01', idea: `I-${second.number}`, leader: false } },
    { action: 'idea.status_changed', diff: { from: 'shortlisted', to: 'selected' } },
  ]);
  // Проголосовавшие за выбранную получили "Выбрана".
  const notices = await pools.root.query(`select user_id from hdn_notifications where idea_id = $1 and payload ->> 'status' = 'selected'`, [second.ideaId]);
  expect(notices.rows.map((r) => r.user_id).sort()).toEqual([...people.slice(0, 2).map((p) => p.userId), f.bUser.userId].sort());
});

test('решение 17: лидер выбирается без объяснения; два сотрудника одновременно сохраняют один выбор', async () => {
  const leader = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const other = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(leader, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }, { orgId: f.orgA.orgId, userId: f.aAdmin.userId }]);
  await votes(other, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  await runIdeaCycle(system, DEC_1);
  const [p1, p2] = [await product(), staffCtx(await staffWithRole('admin'))];
  const results = await Promise.allSettled([
    decideCycle(p1, { cycle: '2026-12-01', number: leader.number }),
    decideCycle(p2, { cycle: '2026-12-01', number: other.number, explanationRu: 'Другая' }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'cycle_closed' } });
  const selected = (await pools.root.query(`select count(*)::int as n from hdi_ideas where status = 'selected'`)).rows[0].n;
  expect(selected).toBe(1);
});

test('уведомления отбора: product получает "пятёрка готова", проголосовавшие за идеи пятёрки "в шорт-листе"', async () => {
  const p = await staffWithRole('product');
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(idea, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  await runIdeaCycle(system, DEC_1);
  const staffBell = await pools.root.query(`select user_id, kind, payload from hdn_notifications where kind = 'idea_cycle'`);
  expect(staffBell.rows).toEqual([{ user_id: p.userId, kind: 'idea_cycle', payload: { count: 1 } }]);
  const staffMail = await pools.root.query(`select recipient_user_id, payload from hdn_outbox where template = 'staff_idea_cycle'`);
  expect(staffMail.rows).toEqual([{ recipient_user_id: p.userId, payload: { template: 'staff_idea_cycle', count: 1, url: '/agent/ideas/cycles' } }]);
  const shortlisted = await pools.root.query(`select user_id from hdn_notifications where idea_id = $1 and payload ->> 'status' = 'shortlisted'`, [idea.ideaId]);
  expect(shortlisted.rows.map((r) => r.user_id).sort()).toEqual([f.aUser.userId, f.bUser.userId].sort());
});

test('машинный черновик объяснения: заглушка модели, только для product и admin, ничего не сохраняет', async () => {
  const moderator = await product();
  const draft = await draftCycleExplanation(moderator, { text: 'Эта идея полезна всем складам' });
  expect(draft).toEqual({ uz: 'Эта идея полезна всем складам', en: 'Эта идея полезна всем складам', machine: true });
  expect(stub.calls).toHaveLength(2);
  expect(stub.calls[0]?.data).toContain('Эта идея полезна всем складам');
  await expect(draftCycleExplanation(staffCtx(f.l1), { text: 'Текст' })).rejects.toMatchObject({ code: 'forbidden' });
  expect(await cycles()).toEqual([]);
  // Без ключа модели черновика нет: сотрудник пишет сам.
  setAiClientForTests(null);
  expect(await draftCycleExplanation(moderator, { text: 'Текст' })).toEqual({ uz: null, en: null, machine: true });
});

test('FR-IDEA-16: клиент видит только завершённые отборы с выбором и объяснением на своём языке, без того, кто выбрал', async () => {
  const leader = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Лидер ноября' });
  const pick = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Выбор ноября' });
  await votes(leader, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }, { orgId: f.orgA.orgId, userId: f.aAdmin.userId }]);
  await votes(pick, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  await runIdeaCycle(system, new Date('2026-11-01T04:00:00Z'));
  const client = await clientCtx(f.aUser);
  expect(await clientCycleArchive(client, { locale: 'ru' })).toEqual([]);
  await decideCycle(await product(), { cycle: '2026-11-01', number: pick.number, explanationRu: 'Объяснение', explanationEn: 'Explanation' });
  await runIdeaCycle(system, DEC_1);
  const archive = await clientCycleArchive(client, { locale: 'en' });
  expect(archive).toEqual([{ cycle: '2026-11-01', status: 'decided', idea: { number: pick.number, title: 'Выбор ноября' }, explanation: 'Explanation', explanationLocale: 'en', explanationMachine: false }]);
  expect(JSON.stringify(archive)).not.toMatch(/decided_?by/i);
  const uz = await clientCycleArchive(client, { locale: 'uz' });
  expect(uz[0]).toMatchObject({ explanation: 'Объяснение', explanationLocale: 'ru' });
  // Декабрьский отбор открыт (лидер вернулся в голосование и снова первый): клиенту его нет.
  expect((await staffCycleBoard(await product())).current?.cycle).toBe('2026-12-01');
});

test('итоговая проверка M7, M6: машинный черновик, сохранённый без правки, клиент видит с пометкой; правка или отметка "проверено" её снимает', async () => {
  const leader = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Лидер' });
  await votes(leader, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  await runIdeaCycle(system, new Date('2026-11-01T04:00:00Z'));
  // uz из черновика без правки (пометка стоит), en сотрудник поправил (пометки нет).
  await decideCycle(await product(), {
    cycle: '2026-11-01',
    number: leader.number,
    explanationRu: 'Объяснение',
    explanationUz: 'Tushuntirish',
    explanationEn: 'Explanation',
    explanationUzMachine: true,
    explanationEnMachine: false,
  });
  const client = await clientCtx(f.aUser);
  expect((await clientCycleArchive(client, { locale: 'uz' }))[0]).toMatchObject({ explanation: 'Tushuntirish', explanationLocale: 'uz', explanationMachine: true });
  expect((await clientCycleArchive(client, { locale: 'en' }))[0]).toMatchObject({ explanation: 'Explanation', explanationLocale: 'en', explanationMachine: false });
  // Русский пишет сотрудник: пометки нет никогда.
  expect((await clientCycleArchive(client, { locale: 'ru' }))[0]).toMatchObject({ explanationLocale: 'ru', explanationMachine: false });
  expect((await pools.root.query(`select explanation_uz_machine, explanation_en_machine from hdi_cycles where cycle = '2026-11-01'`)).rows[0]).toEqual({ explanation_uz_machine: true, explanation_en_machine: false });
  // Пометка без текста не сохраняется (база это тоже не пропускает).
  await expect(pools.root.query(`insert into hdi_cycles (cycle, vote_mode, status, explanation_en_machine) values ('2093-01-01', 'per_user', 'lapsed', true)`)).rejects.toThrow(/hdi_cycles_c8/);
});

test('расписание и ручной запуск: ideas.cycle 1-го числа в 09:00 по Ташкенту; hub ideas:cycle --month делает отбор этого месяца', async () => {
  expect(SCHEDULES).toContainEqual({ name: 'ideas.cycle', cron: '0 9 1 * *', tz: 'Asia/Tashkent' });
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await votes(idea, [{ orgId: f.orgA.orgId, userId: f.aUser.userId }]);
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { env: process.env, out: (l: string) => void lines.push(l), err: (l: string) => void errors.push(l), readSecret: async () => '' };
  expect(await runCli(['ideas:cycle', '--month', '2027-03'], io)).toBe(0);
  expect(lines).toEqual([`Отбор 2027-03-01 создан: в пятёрке 1 (I-${idea.number}), закрыто без выбора 0.`]);
  expect(await runCli(['ideas:cycle', '--month', '2027-03'], io)).toBe(0);
  expect(lines.at(-1)).toBe('Отбор 2027-03-01 уже есть, ничего не изменено.');
  expect(await runCli(['ideas:cycle', '--month', '2027-13'], io)).toBe(2);
  expect(await runCli(['ideas:cycle'], io)).toBe(2);
  expect((await cycles()).map((c) => c.cycle)).toEqual(['2027-03-01']);
});
