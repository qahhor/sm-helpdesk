// Модуль hda, слой pref: константы вызовов модели (docs/naming.md, раздел 5; план M5, задача 5, решения 2, 3, 13).

/**
 * Цели вызова модели: M5 (решение 2), перевод идей M7 (решение 11) и цели M5b: ответ и разбор первой линии одним
 * вызовом (first_line), только разбор (triage), перевод сообщения клиента (message_translation), благодарность (thanks).
 */
export const AI_PURPOSES = ['solution_draft', 'translation', 'idea_translation', 'first_line', 'triage', 'message_translation', 'thanks'] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/**
 * Итог вызова: ok (ответ прошёл схему), invalid_response (ответ пришёл, но не прошёл разбор или схему), failed (нет
 * ответа: сеть, срок, ошибка API), limited (предел исчерпан, модель не вызывалась), repeated (тот же вход в той же
 * организации за 24 часа, модель не вызывалась: план M5b, решение 12).
 */
export const AI_OUTCOMES = ['ok', 'invalid_response', 'failed', 'limited', 'repeated'] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

/** Модель быстрая (черновики, переводы, разбор) или качественная (ответ первой линии). */
export const AI_TIERS = ['fast', 'quality'] as const;
export type AiTier = (typeof AI_TIERS)[number];

/** Решение кода по вызову первой линии (колонка hda_runs.decision): ответ решением, уточняющий вопрос, передача. */
export const AI_DECISIONS = ['answer', 'clarify', 'handoff'] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];

/**
 * Причины передачи сотруднику (FR-AI-14, план M5b, решение 13): перечень ТЗ и два уточнения обязательной передачи
 * FR-AI-06: no_text (обращение без текста) и language (язык не из языков портала).
 */
export const AI_HANDOFF_REASONS = [
  'customer_request',
  'not_helped',
  'no_solution',
  'restricted_topic',
  'p1',
  'low_confidence',
  'reply_limit',
  'ai_failure',
  'ai_disabled',
  'ai_limit',
  'no_text',
  'language',
] as const;
export type AiHandoffReason = (typeof AI_HANDOFF_REASONS)[number];

/** Закрытый список моделей для настройки ai.models (план M5b, решение 1). */
export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];

/** Уровень модели по цели вызова: качественная только у ответа первой линии (решение 1). */
export const PURPOSE_TIER: Readonly<Record<AiPurpose, AiTier>> = {
  solution_draft: 'fast',
  translation: 'fast',
  idea_translation: 'fast',
  first_line: 'quality',
  triage: 'fast',
  message_translation: 'fast',
  thanks: 'fast',
};

/** Модель уровня, если ни настройка, ни окружение её не задали (решение 1, раздел 9.2 ТЗ). */
export const TIER_DEFAULT_MODEL: Readonly<Record<AiTier, AiModel>> = { fast: 'claude-haiku-5-5', quality: 'claude-sonnet-5-5' };

/**
 * Модель цели: настройка ai.models (только из закрытого списка), затем переменная окружения уровня, затем модель уровня
 * по умолчанию. Настройка сильнее окружения (решение 1).
 */
export function modelForPurpose(purpose: AiPurpose, setting: Partial<Record<string, unknown>>, envModels: Partial<Record<AiTier, string>>): string {
  const chosen = setting[purpose];
  if (typeof chosen === 'string' && (AI_MODELS as readonly string[]).includes(chosen)) return chosen;
  const tier = PURPOSE_TIER[purpose];
  return envModels[tier] ?? TIER_DEFAULT_MODEL[tier];
}

/** Модели с запасным путём сервера при отказе (решение 3): у Haiku его нет. */
export const SERVER_FALLBACK_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5'];
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Суточный предел вызовов на черновики и переводы вместе (решение 13, поправка 101), настройка администратора. */
export const AI_DAILY_LIMIT_SETTING = 'ai.daily_limit';
export const AI_DAILY_LIMIT_DEFAULT = 300;
export const AI_DAILY_LIMIT_MAX = 10_000;
/** Сутки предела считаются по времени поддержки (Ташкент). */
export const AI_DAY_TIME_ZONE = 'Asia/Tashkent';

/** Срок ответа модели. Задача фонового процесса повторит вызов, страница покажет состояние. */
export const AI_TIMEOUT_MS = 60_000;
/** Срок ответа модели первой линии и разбора: 60 секунд FR-AI-01 держатся с запасом (план M5b, решение 5). */
export const AI_FIRST_LINE_TIMEOUT_MS = 25_000;
/** Ответ API длиннее этого не дочитывается: ответ модели ограничен max_tokens. */
export const AI_RESPONSE_MAX_BYTES = 256 * 1024;
/**
 * Вход модели обрезается (проверка на AI-инъекции, пункт 5): переписка закрытого обращения и текст решения не
 * длиннее этого числа знаков. Длинная переписка теряет конец, а не начало: проблема описана в начале.
 */
export const AI_INPUT_MAX_CHARS = 8000;

/**
 * Цена за миллион токенов входа и выхода в долларах по модели (план M5b, решение 2; FR-MET-06). Стоимость считается по
 * модели из ответа API: при запасном пути сервера цену даёт модель, которая ответила. У Haiku цена до 100 тысяч токенов
 * входа: вход первой линии меньше. Сверяются с прайсом при первом вызове с ключом.
 */
export const AI_PRICE_PER_MTOK: Readonly<Record<AiModel, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

// --- Помощник первой линии и пределы (план M5b, решения 1, 8, 11, 18) ---

/** Коды настроек AI в hdc_settings. Меняет admin со свежим входом, запись в журнал аудита. */
export const AI_SETTINGS = {
  enabled: 'ai.enabled',
  triageEnabled: 'ai.triage_enabled',
  minScore: 'ai.min_score',
  restrictedTopics: 'ai.restricted_topics',
  monthlyBudgetUsd: 'ai.monthly_budget_usd',
  userDailyLimit: 'ai.user_daily_limit',
  orgDailyLimit: 'ai.org_daily_limit',
  cutoffShare: 'ai.cutoff_share',
  models: 'ai.models',
  triageFieldsOff: 'ai.triage_fields_off',
} as const;

/** Поля предложений разбора (10.5 triage_suggestions, FR-TRI-01, 03). */
export const TRIAGE_FIELDS = ['module', 'type', 'title', 'summary', 'priority_hint'] as const;
export type TriageField = (typeof TRIAGE_FIELDS)[number];

/**
 * Значения по умолчанию (решения 8 и 11). Помощник выключен, пока администратор его не включит (решение 4: "помощник
 * включён администратором"). Порог 0: решение допускает уверенность подсказки (isConfident); настоящий порог задача 11.
 */
export const AI_DEFAULTS = {
  enabled: false,
  triageEnabled: true,
  minScore: 0,
  monthlyBudgetUsd: 100,
  userDailyLimit: 20,
  orgDailyLimit: 150,
  cutoffShare: 0.25,
} as const;
/** Доля месячного предела, после которой отключаются организации, которые его расходуют (решение 11). */
export const AI_BUDGET_WARN_SHARE = 0.8;
/** Цели с пределами на пользователя и организацию (решение 11). Остальные считает суточный предел 300 (M5). */
export const AI_FIRST_LINE_PURPOSES: readonly AiPurpose[] = ['first_line', 'triage'];
/** Повтор того же текста в организации ищется за столько часов (решение 12). */
export const AI_REPEAT_HOURS = 24;
/** Причины отключения организации от помощника (hda_org_cutoffs.reason): budget_share у организации, budget_total у всех. */
export const AI_CUTOFF_REASONS = ['budget_share', 'budget_total'] as const;
export type AiCutoffReason = (typeof AI_CUTOFF_REASONS)[number];

