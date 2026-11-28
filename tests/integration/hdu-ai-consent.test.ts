import { beforeEach, expect, test } from 'vitest';
import { assistantEligible, triageEligible } from '@/modules/hda/api/eligibility';
import { getOrganization, orgAiProfile, resolveClient, setOrgAiProcessing } from '@/modules/hdu/api/orgs';
import { setOrgAiProcessingTx } from '@/modules/hdu/core/orgs';
import { provisionFromSmartup } from '@/modules/hdu/core/provision';
import { withIdentity } from '@/db/with-identity';
import { clientSession, newSmartupUser, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Согласие на AI-обработку и AI новых организаций (план M9, задача 2, решение 10; решения ТЗ 24 и 88). Организация,
// созданная входом через Smartup, получает AI-обработку только при ai.new_org_default = true. Включить обработку
// могут care и admin с отметкой согласия (дата и основание до 200 знаков), отметка и журнал одной транзакцией;
// выключение пишет org.ai_disabled и прежнюю отметку не стирает. Клиент колонок согласия не получает.

const SYSTEM = { type: 'system', job: 'ai.first_line' } as const;
const NOW = new Date('2026-11-27T10:00:00Z');
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hdc_settings where code in ('ai.enabled', 'ai.triage_enabled', 'ai.new_org_default')`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true'::jsonb), ('ai.triage_enabled', 'true'::jsonb)`);
});

const org = async (orgId: string) =>
  (await pools.root.query(`select is_ai_enabled, ai_consent_on::text as consent_on, ai_consent_ref from hdu_organizations where org_id = $1`, [orgId])).rows[0];
const audits = async (action: string) =>
  (await pools.root.query(`select actor_id, org_id, object_id, diff from hdc_audit_log where action = $1 order by created_on`, [action])).rows;
const profile = { id: '2001', name: 'Дилноза', companyId: '777', companyName: 'Новая компания' };

test('без настройки и при ai.new_org_default = false организация из входа через Smartup создаётся без AI-обработки', async () => {
  const { server, user } = await newSmartupUser();
  const { orgId } = (await provisionFromSmartup(user.id, server.code, profile)) as { orgId: string };
  expect(await org(orgId)).toEqual({ is_ai_enabled: false, consent_on: null, ai_consent_ref: null });
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.new_org_default', 'false'::jsonb)`);
  const second = await newSmartupUser();
  const other = (await provisionFromSmartup(second.user.id, second.server.code, { ...profile, companyId: '778' })) as { orgId: string };
  expect((await org(other.orgId)).is_ai_enabled).toBe(false);
  expect(await assistantEligible(SYSTEM, { orgId })).toBe(false);
});

test('при ai.new_org_default = true прежнее поведение; повторный вход признак не меняет', async () => {
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.new_org_default', 'true'::jsonb)`);
  const { server, user } = await newSmartupUser();
  const { orgId } = (await provisionFromSmartup(user.id, server.code, profile)) as { orgId: string };
  expect((await org(orgId)).is_ai_enabled).toBe(true);
  await pools.root.query(`update hdc_settings set value = 'false'::jsonb where code = 'ai.new_org_default'`);
  await provisionFromSmartup(user.id, server.code, { ...profile, companyName: 'Переименована' });
  expect((await org(orgId)).is_ai_enabled).toBe(true);
});

test('care включает AI-обработку с отметкой согласия: колонки и журнал org.ai_consent_recorded', async () => {
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  await setOrgAiProcessing(staffCtx(f.care), { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: ' Письмо 14/2026 ' }, NOW);
  expect(await org(f.orgA.orgId)).toEqual({ is_ai_enabled: true, consent_on: '2026-11-20', ai_consent_ref: 'Письмо 14/2026' });
  expect(await audits('org.ai_consent_recorded')).toEqual([
    { actor_id: f.care.userId, org_id: f.orgA.orgId, object_id: f.orgA.orgId, diff: { consentOn: '2026-11-20', consentRef: 'Письмо 14/2026', wasEnabled: false } },
  ]);
  expect(await getOrganization(staffCtx(f.care), f.orgA.orgId)).toMatchObject({ isAiEnabled: true, aiConsentOn: '2026-11-20', aiConsentRef: 'Письмо 14/2026' });
  // admin тоже может; новая отметка по уже включённой организации записывается заново.
  await setOrgAiProcessing(staffCtx(f.adminStaff), { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-25', consentRef: 'Договор 7' }, NOW);
  expect((await audits('org.ai_consent_recorded')).map((r) => r.diff)).toEqual([
    { consentOn: '2026-11-20', consentRef: 'Письмо 14/2026', wasEnabled: false },
    { consentOn: '2026-11-25', consentRef: 'Договор 7', wasEnabled: true },
  ]);
});

test('включение без даты, без основания, с датой в будущем или основанием длиннее 200 знаков: invalid_input', async () => {
  const ctx = staffCtx(f.care);
  const base = { orgId: f.orgA.orgId, enabled: true };
  for (const input of [
    base,
    { ...base, consentRef: 'Письмо' },
    { ...base, consentOn: '2026-11-20' },
    { ...base, consentOn: '2026-11-20', consentRef: '   ' },
    { ...base, consentOn: '2026-11-28', consentRef: 'Письмо' },
    { ...base, consentOn: '20.11.2026', consentRef: 'Письмо' },
    { ...base, consentOn: '2026-11-20', consentRef: 'х'.repeat(201) },
    { ...base, consentOn: '2026-11-20', consentRef: 'Письмо', extra: 1 },
  ])
    await expect(setOrgAiProcessing(ctx, input, NOW)).rejects.toMatchObject({ code: 'invalid_input' });
  // Дата "сегодня" по Ташкенту проходит: 27.11.2026 04:00 по Ташкенту это ещё 26.11 по UTC.
  await setOrgAiProcessing(ctx, { ...base, consentOn: '2026-11-27', consentRef: 'Письмо' }, new Date('2026-11-26T23:00:00Z'));
  expect(await audits('org.ai_consent_recorded')).toHaveLength(1);
});

test('первая и вторая линия, product, AI-сотрудник и клиент не меняют AI-обработку; несвежий вход: stale_session', async () => {
  const input = { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: 'Письмо' };
  for (const role of ['agent_l1', 'agent_l2', 'product', 'agent_bot'] as const)
    await expect(setOrgAiProcessing(staffCtx(await staffWithRole(role)), input, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(setOrgAiProcessing(f.aAdmin as never, input, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  const stale = { ...staffCtx(f.care), freshAuthAt: new Date(NOW.getTime() - 60 * 60_000) };
  await expect(setOrgAiProcessing(stale, input, NOW)).rejects.toMatchObject({ code: 'stale_session' });
  await expect(setOrgAiProcessing(staffCtx(f.care), { ...input, orgId: '00000000-0000-7000-8000-00000000abcd' }, NOW)).rejects.toMatchObject({ code: 'not_found' });
  expect(await audits('org.ai_consent_recorded')).toEqual([]);
});

test('отметка и журнал в одной транзакции: откат не оставляет ни того, ни другого', async () => {
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  await expect(
    withIdentity(f.care.actor, async (tx) => {
      await setOrgAiProcessingTx(tx, f.care.actor, { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: 'Письмо' });
      throw new Error('откат');
    }),
  ).rejects.toThrow('откат');
  expect(await org(f.orgA.orgId)).toEqual({ is_ai_enabled: false, consent_on: null, ai_consent_ref: null });
  expect(await audits('org.ai_consent_recorded')).toEqual([]);
});

test('база не включает AI-обработку без отметки, даже в обход кода', async () => {
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  await expect(pools.root.query(`update hdu_organizations set is_ai_enabled = true where org_id = $1`, [f.orgA.orgId])).rejects.toThrow(/согласи/);
  await expect(pools.root.query(`update hdu_organizations set ai_consent_ref = $2 where org_id = $1`, [f.orgA.orgId, 'х'.repeat(201)])).rejects.toThrow(/hdu_organizations_c7/);
  // Существующие строки с включённой обработкой без отметки миграция не трогает, их другие изменения проходят.
  await pools.root.query(`update hdu_organizations set category = 'B' where org_id = $1`, [f.orgB.orgId]);
});

test('выключение пишет org.ai_disabled, прежнюю отметку не стирает; повтор ничего не пишет; все пути AI молчат', async () => {
  const ctx = staffCtx(f.care);
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: 'Письмо' }, NOW);
  expect(await triageEligible(SYSTEM, { orgId: f.orgA.orgId })).toBe(true);
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: false }, NOW);
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: false }, NOW);
  expect(await org(f.orgA.orgId)).toEqual({ is_ai_enabled: false, consent_on: '2026-11-20', ai_consent_ref: 'Письмо' });
  expect(await audits('org.ai_disabled')).toEqual([{ actor_id: f.care.userId, org_id: f.orgA.orgId, object_id: f.orgA.orgId, diff: null }]);
  // Выключение не требует отметки и не принимает её полей.
  await expect(setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: false, consentRef: 'x' }, NOW)).rejects.toMatchObject({ code: 'invalid_input' });
  // Первая линия и разбор (hda/api/eligibility.ts), профиль для черновика, переводов и кандидатов.
  expect(await assistantEligible(SYSTEM, { orgId: f.orgA.orgId })).toBe(false);
  expect(await triageEligible(SYSTEM, { orgId: f.orgA.orgId })).toBe(false);
  expect((await orgAiProfile(SYSTEM, { orgId: f.orgA.orgId, userIds: [] }))?.isAiEnabled).toBe(false);
  // Остальные пути (черновик, переводы, кандидаты, события и представления AI-сотрудника, код) проверяют свои тесты
  // с is_ai_enabled = false: hda-ai, hda-message-ai, hda-candidates, hda-agent-events, hda-agent-views, hda-code-analysis.
});

test('категория прежней формой; признак AI через неё больше не меняется', async () => {
  const { updateOrganization } = await import('@/modules/hdu/api/orgs');
  await expect(updateOrganization(staffCtx(f.care), { orgId: f.orgA.orgId, category: 'A', isAiEnabled: true })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('клиент не получает колонок согласия: доступ и организация клиента без них', async () => {
  await setOrgAiProcessing(staffCtx(f.care), { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: 'Письмо 14' }, NOW);
  const access = await resolveClient(await clientSession(f.aUser));
  expect(JSON.stringify(access)).not.toContain('Письмо 14');
  expect(JSON.stringify(access)).not.toMatch(/consent/i);
});

test('флажок "AI-обработка новых организаций сразу" пишет ai.new_org_default с журналом settings.changed', async () => {
  const { aiSettingsView, saveAiSettings } = await import('@/modules/hda/api/settings');
  const admin = staffCtx(f.adminStaff);
  const form = { enabled: 'on', minScore: '0', monthlyBudgetUsd: '100', userDailyLimit: '20', orgDailyLimit: '150', cutoffPercent: '25', triageFieldsOff: [] };
  expect((await aiSettingsView(admin)).newOrgDefault).toBe(false);
  await saveAiSettings(admin, { ...form, newOrgDefault: 'on' });
  expect((await aiSettingsView(admin)).newOrgDefault).toBe(true);
  expect((await pools.root.query(`select value from hdc_settings where code = 'ai.new_org_default'`)).rows[0].value).toBe(true);
  expect((await pools.root.query(`select diff from hdc_audit_log where action = 'settings.changed' and object_id = 'ai.new_org_default'`)).rows).toEqual([
    { diff: { code: 'ai.new_org_default', to: true } },
  ]);
  await expect(saveAiSettings(staffCtx(f.care), { ...form, newOrgDefault: 'on' })).rejects.toMatchObject({ code: 'forbidden' });
});

test('повторное включение после выключения требует новой отметки в том же UPDATE; код ставит её и с теми же значениями (проверка M9, M5)', async () => {
  const ctx = staffCtx(f.care);
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: 'Письмо' }, NOW);
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: false }, NOW);
  // Прежняя отметка осталась, но включить обработку одним признаком в обход кода нельзя.
  await expect(pools.root.query(`update hdu_organizations set is_ai_enabled = true where org_id = $1`, [f.orgA.orgId])).rejects.toThrow(/согласи/);
  await expect(pools.root.query(`update hdu_organizations set is_ai_enabled = true, ai_consent_on = ai_consent_on, ai_consent_ref = ai_consent_ref where org_id = $1`, [f.orgA.orgId])).rejects.toThrow(/согласи/);
  // Новая отметка в том же UPDATE проходит.
  await pools.root.query(`update hdu_organizations set is_ai_enabled = true, ai_consent_ref = 'Письмо 2' where org_id = $1`, [f.orgA.orgId]);
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: false }, NOW);
  // Код включает обработку и с той же датой и основанием: отметка ставится заново, журнал пишется.
  await setOrgAiProcessing(ctx, { orgId: f.orgA.orgId, enabled: true, consentOn: '2026-11-20', consentRef: 'Письмо 2' }, NOW);
  expect(await org(f.orgA.orgId)).toEqual({ is_ai_enabled: true, consent_on: '2026-11-20', ai_consent_ref: 'Письмо 2' });
  expect((await audits('org.ai_consent_recorded')).map((r) => r.diff)).toEqual([
    // Организация набора начинает с включённой обработкой.
    { consentOn: '2026-11-20', consentRef: 'Письмо', wasEnabled: true },
    { consentOn: '2026-11-20', consentRef: 'Письмо 2', wasEnabled: false },
  ]);
});
