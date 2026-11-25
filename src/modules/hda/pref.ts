// Модуль hda, слой pref: константы вызовов модели (docs/naming.md, раздел 5; план M5, задача 5, решения 2, 3, 13).

/** Цели вызова модели в вехе M5 (решение 2). M5b добавит цели помощника первой линии. */
export const AI_PURPOSES = ['solution_draft', 'translation'] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/**
 * Итог вызова: ok (ответ прошёл схему), invalid_response (ответ пришёл, но не прошёл разбор или схему), failed (нет
 * ответа: сеть, срок, ошибка API), limited (суточный предел исчерпан, модель не вызывалась).
 */
export const AI_OUTCOMES = ['ok', 'invalid_response', 'failed', 'limited'] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

/** Модель быстрая (черновики, переводы) или качественная (ответы первой линии, M5b). Имена задаёт окружение. */
export const AI_TIERS = ['fast', 'quality'] as const;
export type AiTier = (typeof AI_TIERS)[number];

/** Суточный предел вызовов на черновики и переводы вместе (решение 13, поправка 101), настройка администратора. */
export const AI_DAILY_LIMIT_SETTING = 'ai.daily_limit';
export const AI_DAILY_LIMIT_DEFAULT = 300;
export const AI_DAILY_LIMIT_MAX = 10_000;
/** Сутки предела считаются по времени поддержки (Ташкент). */
export const AI_DAY_TIME_ZONE = 'Asia/Tashkent';

/** Срок ответа модели. Задача фонового процесса повторит вызов, страница покажет состояние. */
export const AI_TIMEOUT_MS = 60_000;
/** Ответ API длиннее этого не дочитывается: ответ модели ограничен max_tokens. */
export const AI_RESPONSE_MAX_BYTES = 256 * 1024;
/**
 * Вход модели обрезается (проверка на AI-инъекции, пункт 5): переписка закрытого обращения и текст решения не
 * длиннее этого числа знаков. Длинная переписка теряет конец, а не начало: проблема описана в начале.
 */
export const AI_INPUT_MAX_CHARS = 8000;

/**
 * Цена за миллион токенов в долларах для учёта расходов (FR-MET-06). Цены по рекомендованным моделям ТЗ (раздел 9):
 * быстрая как Haiku, качественная как Sonnet. При смене модели в окружении цену меняют здесь.
 */
export const AI_PRICE_PER_MTOK: Readonly<Record<AiTier, { input: number; output: number }>> = {
  fast: { input: 1, output: 5 },
  quality: { input: 3, output: 15 },
};
