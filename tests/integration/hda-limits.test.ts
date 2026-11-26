import { afterEach, beforeEach, expect, test } from 'vitest';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { runAiBudget } from '@/modules/hda/api/budget';
import { callAi } from '@/modules/hda/api/run';
import { aiSettingsView, liftAiCutoff, saveAiModels, saveAiSettings } from '@/modules/hda/api/settings';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Журнал, модели, пределы и настройки AI (план M5b, задача 1; FR-ADM-09, FR-AI-17, FR-AI-21, 9.2, 10.5).

const SYSTEM: SystemActor = { type: 'system', job: 'ai.first_line' };
const schema = z.object({ ok: z.boolean() });
const TEXT = 'Документ ТЕКСТ-ОБРАЩЕНИЯ-7781 не проводится';
let f: Fixture;
let stub: StubAiClient;

beforeEach(async () => {
  f = await seedTwoOrgs();
  stub = new StubAiClient(() => ({ ok: true }));
  setAiClientForTests(stub);
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
  await pools.root.query(`delete from hda_runs`);
  await pools.root.query(`delete from hda_org_cutoffs`);
});
afterEach(() => setAiClientForTests());

const call = (over: Partial<Parameters<typeof callAi>[1]> = {}) =>
  callAi(SYSTEM, {
    purpose: 'first_line',
    orgId: f.orgA.orgId,
    refId: null,
    ticketId: f.tickets.aOrg.ticketId,
    userId: f.aUser.userId,
    system: 'ПРАВИЛА',
    data: `<ticket>${TEXT}</ticket>`,
    schema,
    maxTokens: 1024,
    ...over,
  });

async function setting(code: string, value: unknown) {
  await pools.root.query(`insert into hdc_settings (code, value) values ($1, $2::jsonb) on conflict (code) do update set value = excluded.value`, [code, JSON.stringify(value)]);
}

test('строка журнала первой линии: обращение, автор, модель цели, хеш входа; текста обращения нет ни в одной колонке', async () => {
  const outcome = await call({ detectRepeat: true });
  expect(outcome.status).toBe('ok');
  // Модель первой линии по умолчанию: Sonnet 5.5 (решение 1).
  expect(stub.calls[0]!.model).toBe('claude-sonnet-5-5');
  const [run] = (await pools.root.query(`select * from hda_runs`)).rows;
  expect(run).toMatchObject({ purpose: 'first_line', ticket_id: f.tickets.aOrg.ticketId, user_id: f.aUser.userId, org_id: f.orgA.orgId, outcome: 'ok' });
  expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/);
  // Заглушка считается по цене выбранной модели.
  expect(Number(run.cost_usd)).toBeGreaterThan(0);
  for (const value of Object.values(run)) expect(String(value)).not.toContain('ТЕКСТ-ОБРАЩЕНИЯ-7781');
  // Колонки текста в журнале не появились: перечень колонок закрыт.
  const columns = (await pools.root.query(`select column_name, data_type from information_schema.columns where table_name = 'hda_runs'`)).rows;
  for (const c of columns.filter((c) => c.data_type === 'text'))
    expect(['purpose', 'model', 'outcome', 'error_code', 'created_by', 'modified_by', 'decision', 'handoff_reason', 'input_hash', 'flag_reason', 'review_result']).toContain(c.column_name);
  // В колонку хеша текст не положить.
  await expect(pools.root.query(`update hda_runs set input_hash = $1`, [TEXT])).rejects.toThrow(/hda_runs_c9/);
});

test('клиент не читает журнал и отключения ни одной строки', async () => {
  await call();
  await pools.root.query(`insert into hda_org_cutoffs (org_id, month, reason) values ($1, date_trunc('month', now())::date, 'budget_share')`, [f.orgA.orgId]);
  for (const table of ['hda_runs', 'hda_org_cutoffs']) {
    const rows = await asActor(pools.app, f.aAdmin.actor, async (c) => (await c.query(`select * from ${table}`)).rows);
    expect(rows, table).toHaveLength(0);
  }
});

test('модель по настройке ai.models; ответ запасной модели считается по её цене', async () => {
  await setting('ai.models', { first_line: 'claude-opus-5-5' });
  await call();
  expect(stub.calls[0]!.model).toBe('claude-opus-5-5');
});

test('повтор того же входа в организации за 24 часа (решение 12): модель не вызывается, строка repeated с прошлым выбором', async () => {
  const first = await call({ detectRepeat: true });
  if (first.status !== 'ok') throw new Error('ожидался ответ');
  await pools.root.query(`update hda_runs set decision = 'answer', solution_id = $1 where run_id = $2`, ['01900000-0000-7000-8000-0000000000aa', first.runId]);
  const again = await call({ detectRepeat: true, data: `<ticket>${TEXT.toUpperCase().replace(" ", "   ")}</ticket>` });
  expect(again).toMatchObject({ status: 'repeated', prior: { decision: 'answer', solutionId: '01900000-0000-7000-8000-0000000000aa' } });
  expect(stub.calls).toHaveLength(1);
  // Другая организация с тем же текстом вызывает модель.
  expect((await call({ detectRepeat: true, orgId: f.orgB.orgId, userId: f.bUser.userId })).status).toBe('ok');
  expect(stub.calls).toHaveLength(2);
  const outcomes = (await pools.root.query(`select outcome, model, input_tokens from hda_runs order by created_on`)).rows;
  expect(outcomes[1]).toEqual({ outcome: 'repeated', model: null, input_tokens: 0 });
});

test('суточные пределы первой линии на пользователя и на организацию (решение 11): после предела модель не вызывается', async () => {
  await setting('ai.user_daily_limit', 2);
  await setting('ai.org_daily_limit', 3);
  expect((await call()).status).toBe('ok');
  expect((await call()).status).toBe('ok');
  expect(await call()).toEqual({ status: 'limited', limit: 'user' });
  // Другой пользователь той же организации: ещё один вызов до предела организации.
  expect((await call({ userId: f.aAdmin.userId })).status).toBe('ok');
  expect(await call({ userId: f.aAdmin.userId })).toEqual({ status: 'limited', limit: 'org' });
  // Другая организация не затронута: один клиент не выключает помощника всем.
  expect((await call({ orgId: f.orgB.orgId, userId: f.bUser.userId })).status).toBe('ok');
  expect(stub.calls).toHaveLength(4);
  // Черновики и переводы считает свой суточный предел: первая линия его не расходует.
  expect((await call({ purpose: 'solution_draft', userId: null, ticketId: null })).status).toBe('ok');
});

test('месячный предел и задача ai.budget (решение 11): от 80% отключаются расходующие организации, от 100% все; уведомление администраторам один раз', async () => {
  await setting('ai.monthly_budget_usd', 10);
  // Организация А израсходовала 7 долларов, Б 1: всего 8, это 80%.
  await pools.root.query(`insert into hda_runs (org_id, purpose, model, cost_usd, outcome) values ($1, 'first_line', 'claude-sonnet-5-5', 7, 'ok'), ($2, 'first_line', 'claude-sonnet-5-5', 1, 'ok')`, [f.orgA.orgId, f.orgB.orgId]);
  const budget = await runAiBudget({ type: 'system', job: 'ai.budget' });
  expect(budget).toMatchObject({ orgsCut: 1, allCut: false });
  expect((await runAiBudget({ type: 'system', job: 'ai.budget' })).orgsCut).toBe(0);
  const notices = (await pools.root.query(`select user_id, payload from hdn_notifications where kind = 'ai_budget'`)).rows;
  expect(notices).toEqual([{ user_id: f.adminStaff.userId, payload: { percent: 80, orgs: 1 } }]);
  expect(await call()).toEqual({ status: 'limited', limit: 'cutoff' });
  expect((await call({ orgId: f.orgB.orgId, userId: f.bUser.userId })).status).toBe('ok');
  // 100%: помощник отключён для всех, ни одного вызова.
  await pools.root.query(`insert into hda_runs (org_id, purpose, model, cost_usd, outcome) values ($1, 'first_line', 'claude-sonnet-5-5', 3, 'ok')`, [f.orgB.orgId]);
  expect((await runAiBudget({ type: 'system', job: 'ai.budget' })).allCut).toBe(true);
  const calls = stub.calls.length;
  expect(await call({ orgId: f.orgB.orgId, userId: f.bUser.userId })).toEqual({ status: 'limited', limit: 'budget' });
  expect(await call({ purpose: 'translation', orgId: null, userId: null, ticketId: null })).toEqual({ status: 'limited', limit: 'budget' });
  expect(stub.calls).toHaveLength(calls);
  expect((await pools.root.query(`select payload from hdn_notifications where kind = 'ai_budget' order by created_on`)).rows.map((r) => r.payload.percent)).toEqual([80, 100]);
});

test('настройки: только администратор со свежим входом, каждое изменение в журнале аудита; модель вне списка не принимается', async () => {
  const admin = staffCtx(f.adminStaff);
  const form = { enabled: 'on', minScore: '0.02', monthlyBudgetUsd: '50', userDailyLimit: '10', orgDailyLimit: '100', cutoffPercent: '30', triageFieldsOff: ['title'] };
  await expect(saveAiSettings(staffCtx(f.care), form)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveAiSettings({ ...admin, freshAuthAt: new Date(Date.now() - 3600_000) }, form)).rejects.toMatchObject({ code: 'stale_session' });
  await expect(saveAiSettings(admin, { ...form, userDailyLimit: '-1' })).rejects.toMatchObject({ code: 'invalid_input' });
  await saveAiSettings(admin, form);
  const view = await aiSettingsView(admin);
  expect(view).toMatchObject({ enabled: true, triageEnabled: false, minScore: 0.02, monthlyBudgetUsd: 50, userDailyLimit: 10, orgDailyLimit: 100, cutoffShare: 0.3, triageFieldsOff: ['title'] });
  const audited = (await pools.root.query(`select object_id from hdc_audit_log where action = 'settings.changed' order by created_on`)).rows.map((r) => r.object_id);
  expect(audited.sort()).toEqual(['ai.cutoff_share', 'ai.enabled', 'ai.min_score', 'ai.monthly_budget_usd', 'ai.org_daily_limit', 'ai.triage_enabled', 'ai.triage_fields_off', 'ai.user_daily_limit']);

  const models = { solution_draft: 'claude-haiku-5-5', translation: 'claude-haiku-5-5', idea_translation: 'claude-haiku-5-5', first_line: 'claude-opus-5-5', triage: 'claude-haiku-5-5', message_translation: 'claude-haiku-5-5', thanks: 'claude-haiku-5-5' };
  await expect(saveAiModels({ ...admin, freshAuthAt: new Date(Date.now() - 3600_000) }, models)).rejects.toMatchObject({ code: 'stale_session' });
  await expect(saveAiModels(admin, { ...models, first_line: 'gpt-5' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await saveAiModels(admin, models)).toEqual({ changed: true });
  expect(await saveAiModels(admin, models)).toEqual({ changed: false });
  expect((await aiSettingsView(admin)).effectiveModels.first_line).toBe('claude-opus-5-5');
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where object_id = 'ai.models'`)).rows[0].n).toBe(1);
});

test('снять отключение: администратор со свежим входом, с записью в журнал; снятая организация снова получает вызовы', async () => {
  const [{ cutoff_id }] = (await pools.root.query(`insert into hda_org_cutoffs (org_id, month, reason) values ($1, date_trunc('month', now() at time zone 'Asia/Tashkent')::date, 'budget_share') returning cutoff_id`, [f.orgA.orgId])).rows;
  expect(await call()).toEqual({ status: 'limited', limit: 'cutoff' });
  const admin = staffCtx(f.adminStaff);
  expect((await aiSettingsView(admin)).cutoffs).toEqual([expect.objectContaining({ cutoffId: cutoff_id, orgId: f.orgA.orgId, orgName: f.orgA.name })]);
  await expect(liftAiCutoff(staffCtx(f.care), { cutoffId: cutoff_id })).rejects.toMatchObject({ code: 'forbidden' });
  await liftAiCutoff(admin, { cutoffId: cutoff_id });
  expect((await call()).status).toBe('ok');
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where object_id = 'ai.cutoff'`)).rows[0].n).toBe(1);
  // Сотрудник не администратор снять отключение не может и в базе.
  await expect(asActor(pools.app, f.care.actor, (c) => c.query(`update hda_org_cutoffs set lifted_on = now(), lifted_by = $1`, [f.care.userId]))).resolves.toMatchObject({ rowCount: 0 });
});
