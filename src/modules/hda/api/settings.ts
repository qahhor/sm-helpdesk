import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext, writeAudit, writeSettingTx } from '@/modules/hdc/api';
import { orgFactsTx } from '@/modules/hdu/api/automation';
import { currentMonth, monthSpendTx } from '../core/runs';
import { HdaError } from '../error';
import { type CandidateConfig, candidateConfig, candidateConfigSchemas } from '../candidates/run';
import { AI_DAILY_LIMIT_MAX, AI_DAILY_LIMIT_SETTING, AI_MODELS, AI_PURPOSES, AI_SETTINGS, CANDIDATE_SETTINGS, type AiCutoffReason, type AiModel, type AiPurpose, TRIAGE_FIELDS } from '../pref';
import { aiOrgCutoffs } from '../schema';
import { RESTRICTED_TOPICS } from '../topics';
import { type AiConfig, aiConfig, aiConfigSchemas } from './config';
import { aiDailyLimit, aiModelsFor } from './run';

// Модуль hda, слой api: настройки AI (план M5, решение 13; план M5b, задача 1, FR-ADM-09, FR-AI-17). Меняет только
// администратор портала со входом не старше 15 минут, каждое изменение пишется в журнал аудита той же транзакцией
// (writeSettingTx). После смены модели администратор видит предупреждение прогнать проверочный набор (15.6).

export { HdaError, isHdaError } from '../error';

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
}

function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
}

export async function aiDailyLimitSetting(ctx: StaffContext): Promise<number> {
  requireAdmin(ctx);
  return aiDailyLimit();
}

export async function saveAiDailyLimit(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const parsed = z.strictObject({ limit: z.coerce.number().int().min(0).max(AI_DAILY_LIMIT_MAX) }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, AI_DAILY_LIMIT_SETTING, parsed.data.limit));
}

export type AiCutoffView = { cutoffId: string; orgId: string | null; orgName: string | null; reason: AiCutoffReason; createdOn: Date };
export type AiSettingsView = AiConfig & {
  /** Модель каждой цели с учётом окружения фонового процесса. */
  effectiveModels: Record<AiPurpose, string>;
  spentUsd: number;
  cutoffs: AiCutoffView[];
};

/** Экран /agent/settings/ai: значения, модели по целям, расход за месяц и действующие отключения. */
export async function aiSettingsView(ctx: StaffContext): Promise<AiSettingsView> {
  requireAdmin(ctx);
  const config = await aiConfig();
  const effectiveModels = await aiModelsFor(AI_PURPOSES);
  const { spentUsd, cutoffs } = await withActor(ctx.actor, async (tx) => {
    const spend = await monthSpendTx(tx);
    const rows = await tx
      .select({ cutoffId: aiOrgCutoffs.cutoffId, orgId: aiOrgCutoffs.orgId, reason: aiOrgCutoffs.reason, createdOn: aiOrgCutoffs.createdOn })
      .from(aiOrgCutoffs)
      .where(and(eq(aiOrgCutoffs.month, currentMonth), isNull(aiOrgCutoffs.liftedOn)));
    const facts = await orgFactsTx(tx, rows.flatMap((r) => (r.orgId ? [r.orgId] : [])));
    return {
      spentUsd: Math.round(spend.total * 100) / 100,
      cutoffs: rows.map((r) => ({ ...r, orgName: r.orgId ? (facts.get(r.orgId)?.name ?? null) : null })),
    };
  });
  return { ...config, effectiveModels, spentUsd, cutoffs };
}

const flag = z.union([z.literal('on'), z.literal('true'), z.literal(true)]).optional();
const generalInput = z.strictObject({
  enabled: flag,
  triageEnabled: flag,
  newOrgDefault: flag,
  minScore: z.coerce.number().pipe(aiConfigSchemas.minScore),
  monthlyBudgetUsd: z.coerce.number().pipe(aiConfigSchemas.monthlyBudgetUsd),
  userDailyLimit: z.coerce.number().pipe(aiConfigSchemas.userDailyLimit),
  orgDailyLimit: z.coerce.number().pipe(aiConfigSchemas.orgDailyLimit),
  // Доля в процентах на экране, в настройке дробью.
  cutoffPercent: z.coerce.number().int().min(1).max(100),
  triageFieldsOff: z.array(z.enum(TRIAGE_FIELDS)).max(TRIAGE_FIELDS.length).default([]),
});

/** Переключатели, порог, пределы и отключённые поля разбора: одна запись журнала на каждое изменённое значение. */
export async function saveAiSettings(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const parsed = generalInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const d = parsed.data;
  const next: Omit<AiConfig, 'models' | 'restrictedTopics'> = {
    enabled: d.enabled !== undefined,
    triageEnabled: d.triageEnabled !== undefined,
    newOrgDefault: d.newOrgDefault !== undefined,
    minScore: d.minScore,
    monthlyBudgetUsd: d.monthlyBudgetUsd,
    userDailyLimit: d.userDailyLimit,
    orgDailyLimit: d.orgDailyLimit,
    cutoffShare: d.cutoffPercent / 100,
    triageFieldsOff: [...new Set(d.triageFieldsOff)],
  };
  const current = await aiConfig();
  await withActor(ctx.actor, async (tx) => {
    // Темы правятся своей формой: здесь их нет.
    for (const key of Object.keys(next) as (keyof typeof next)[])
      if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) await writeSettingTx(tx, AI_SETTINGS[key], next[key]);
  });
}

const modelsInput = z.strictObject(Object.fromEntries(AI_PURPOSES.map((p) => [p, z.enum(AI_MODELS)])) as Record<AiPurpose, z.ZodEnum<{ [K in AiModel]: K }>>);

/** Модель каждой цели из закрытого списка (решение 1). Возвращает, изменилась ли хоть одна: тогда экран просит прогнать набор 15.6. */
export async function saveAiModels(ctx: StaffContext, input: unknown): Promise<{ changed: boolean }> {
  requireFreshAdmin(ctx);
  const parsed = modelsInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const before = await aiModelsFor(AI_PURPOSES);
  const changed = AI_PURPOSES.some((p) => parsed.data[p] !== before[p]);
  if (changed) await withActor(ctx.actor, (tx) => writeSettingTx(tx, AI_SETTINGS.models, parsed.data));
  return { changed };
}

/** Снять отключение организации (или всех) до конца месяца: администратор со свежим входом, запись в журнал. */
export async function liftAiCutoff(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const parsed = z.strictObject({ cutoffId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  await withActor(ctx.actor, async (tx) => {
    const [row] = await tx
      .update(aiOrgCutoffs)
      .set({ liftedOn: new Date(), liftedBy: ctx.actor.userId })
      .where(and(eq(aiOrgCutoffs.cutoffId, parsed.data.cutoffId), isNull(aiOrgCutoffs.liftedOn)))
      .returning({ orgId: aiOrgCutoffs.orgId, reason: aiOrgCutoffs.reason });
    if (!row) throw new HdaError('invalid_input');
    await writeAudit(tx, { action: 'settings.changed', objectType: 'setting', objectId: 'ai.cutoff', ...(row.orgId ? { orgId: row.orgId } : {}), diff: { lifted: parsed.data.cutoffId, reason: row.reason } });
  });
}

/** Строки поля "по одному в строке" в список: пустые и повторы отбрасываются. */
const lines = (value: unknown) => [...new Set(String(value ?? '').split(/\r?\n|,/).map((w) => w.trim()).filter(Boolean))];

/**
 * Обязательные темы (решение 17): у каждой из семи тем списки слов и сочетаний на русском, узбекском и английском.
 * Узбекский пишется латиницей или кириллицей: поиск находит обе письменности. Пустой список темы допускается: тогда
 * тему находит только флаг модели. Запись в журнал аудита.
 */
export async function saveRestrictedTopics(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  if (!input || typeof input !== 'object') throw new HdaError('invalid_input');
  const raw = input as Record<string, unknown>;
  const lists = Object.fromEntries(RESTRICTED_TOPICS.map((t) => [t, { ru: lines(raw[`${t}.ru`]), uz: lines(raw[`${t}.uz`]), en: lines(raw[`${t}.en`]) }]));
  const parsed = aiConfigSchemas.restrictedTopics.safeParse(lists);
  if (!parsed.success) throw new HdaError('invalid_input');
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, AI_SETTINGS.restrictedTopics, parsed.data));
}

// --- Кандидаты в решения (план M5c, задача 9, решения 26, 28) ---

const candidateInput = z.strictObject({
  enabled: flag,
  dailyLimit: z.coerce.number().pipe(candidateConfigSchemas.dailyLimit),
  // Пороги на экране в процентах, в настройке дробью.
  publishedPercent: z.coerce.number().min(50).max(100),
  mergePercent: z.coerce.number().min(50).max(100),
});

/** Настройки кандидатов для экрана администратора. */
export async function candidateSettingsView(ctx: StaffContext): Promise<CandidateConfig> {
  requireAdmin(ctx);
  return candidateConfig();
}

/** Выключатель, дневной предел и пороги склейки кандидатов: только администратор со свежим входом, журнал аудита. */
export async function saveCandidateSettings(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const parsed = candidateInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const d = parsed.data;
  const next: CandidateConfig = { enabled: d.enabled !== undefined, dailyLimit: d.dailyLimit, publishedSimilarity: d.publishedPercent / 100, mergeSimilarity: d.mergePercent / 100 };
  const current = await candidateConfig();
  await withActor(ctx.actor, async (tx) => {
    for (const key of Object.keys(next) as (keyof CandidateConfig)[]) if (current[key] !== next[key]) await writeSettingTx(tx, CANDIDATE_SETTINGS[key], next[key]);
  });
}
