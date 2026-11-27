import 'server-only';
import * as z from 'zod';
import { readSetting } from '@/modules/hdc/api';
import { AI_DEFAULTS, AI_MODELS, AI_PURPOSES, AI_SETTINGS, TRIAGE_FIELDS, type AiModel, type AiPurpose, type TriageField } from '../pref';
import { RESTRICTED_TOPICS, RESTRICTED_TOPICS_DEFAULT, type TopicLists } from '../topics';

// Модуль hda, слой api: настройки AI из hdc_settings с проверкой (план M5b, задача 1, решения 1, 8, 11, 18). Нет
// строки или значение неверно: значение по умолчанию. Настройки пишет только администратор (settings.ts), читает система.

export type AiConfig = {
  enabled: boolean;
  triageEnabled: boolean;
  minScore: number;
  monthlyBudgetUsd: number;
  userDailyLimit: number;
  orgDailyLimit: number;
  cutoffShare: number;
  models: Partial<Record<AiPurpose, AiModel>>;
  triageFieldsOff: TriageField[];
  /** Обязательные темы со списками слов по языкам (решение 17). */
  restrictedTopics: TopicLists;
};

/** Слово или сочетание списка темы: до 60 знаков, не больше 100 на язык. */
const TOPIC_WORDS = z.array(z.string().trim().min(2).max(60)).max(100);

export const aiConfigSchemas = {
  enabled: z.boolean(),
  triageEnabled: z.boolean(),
  minScore: z.number().min(0).max(10),
  monthlyBudgetUsd: z.number().min(0).max(100_000),
  userDailyLimit: z.number().int().min(0).max(10_000),
  orgDailyLimit: z.number().int().min(0).max(100_000),
  cutoffShare: z.number().gt(0).max(1),
  models: z.partialRecord(z.enum(AI_PURPOSES), z.enum(AI_MODELS)),
  triageFieldsOff: z.array(z.enum(TRIAGE_FIELDS)).max(TRIAGE_FIELDS.length),
  restrictedTopics: z.strictObject(
    Object.fromEntries(
      RESTRICTED_TOPICS.map((topic) => [topic, z.strictObject({ ru: TOPIC_WORDS, uz: TOPIC_WORDS, en: TOPIC_WORDS })]),
    ) as Record<(typeof RESTRICTED_TOPICS)[number], z.ZodObject<{ ru: typeof TOPIC_WORDS; uz: typeof TOPIC_WORDS; en: typeof TOPIC_WORDS }>>,
  ),
} as const;

const DEFAULTS: AiConfig = { ...AI_DEFAULTS, models: {}, triageFieldsOff: [], restrictedTopics: RESTRICTED_TOPICS_DEFAULT };

async function read<K extends keyof AiConfig>(key: K): Promise<AiConfig[K]> {
  const parsed = aiConfigSchemas[key].safeParse(await readSetting(AI_SETTINGS[key]));
  return (parsed.success ? parsed.data : DEFAULTS[key]) as AiConfig[K];
}

/** Все настройки AI одним вызовом. */
export async function aiConfig(): Promise<AiConfig> {
  const entries = await Promise.all((Object.keys(DEFAULTS) as (keyof AiConfig)[]).map(async (key) => [key, await read(key)] as const));
  return Object.fromEntries(entries) as AiConfig;
}
