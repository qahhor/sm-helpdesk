// Модуль hda, слой pref: константы вызовов модели (docs/naming.md, раздел 5; план M5, задача 5, решения 2, 3, 13).

/**
 * Цели вызова модели: M5 (решение 2), перевод идей M7 (решение 11) и цели M5b: ответ и разбор первой линии одним
 * вызовом (first_line), только разбор (triage), перевод сообщения клиента (message_translation), благодарность (thanks).
 * M5c: перевод публичного текста известной проблемы и рассылки (problem_translation) и объявления
 * (announcement_translation), написанного сотрудником.
 */
export const AI_PURPOSES = ['solution_draft', 'translation', 'idea_translation', 'first_line', 'triage', 'message_translation', 'thanks', 'problem_translation', 'announcement_translation', 'candidate'] as const;
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

/**
 * Решение кода по вызову (колонка hda_runs.decision): ответ решением, уточняющий вопрос, передача; у кандидата
 * skipped (модель не уверена, кандидата нет; веха M5c, решение 27).
 */
export const AI_DECISIONS = ['answer', 'clarify', 'handoff', 'skipped'] as const;
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
  // M5c (решения 22, 23): ответ известной проблемой и сообщение о сбое, затем передача.
  'known_problem',
  'outage',
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
  problem_translation: 'fast',
  announcement_translation: 'fast',
  // Кандидат в решение (веха M5c, решение 26): черновик всё равно проверяет человек.
  candidate: 'fast',
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
/** Поля, которые принятие меняет в обращении. Резюме и пометка приоритета только показываются сотруднику. */
export const TRIAGE_APPLIED_FIELDS = ['module', 'type', 'title'] as const satisfies readonly TriageField[];
export type TriageAppliedField = (typeof TRIAGE_APPLIED_FIELDS)[number];
export const TRIAGE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
/** Ночная проверка (FR-TRI-04): доля принятых за месяц ниже этой при не менее чем TRIAGE_REVIEW_MIN решениях. */
export const TRIAGE_REVIEW_SHARE = 0.7;
export const TRIAGE_REVIEW_MIN = 30;

/**
 * Значения по умолчанию (решения 8 и 11). Помощник выключен, пока администратор его не включит (решение 4: "помощник
 * включён администратором"). Порог min_score: наименьший score, при котором на синтетическом наборе задачи 11
 * (pnpm eval:ai, tests/eval/ai) нет ложных ответов. На наборе это 0: уверенность подсказки (isConfident) уже отсекает
 * ложные решения. Подстройка на настоящем наборе 15.6 с векторами BGE-M3 заблокирована (нет набора и ключа).
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
/**
 * Цели с пределами на пользователя и организацию и отключением организации (решение 11). Уточнение благодарности и
 * перевод сообщения тоже здесь: их вызывает текст одного клиента, и он не должен расходовать общий суточный предел
 * (независимая проверка M5b, I5). Остальные цели (черновики, переводы решений и идей) считает суточный предел 300 (M5).
 */
export const AI_USER_LIMIT_PURPOSES: readonly AiPurpose[] = ['first_line', 'triage', 'thanks', 'message_translation'];
/** Сколько раз в сутки модель уточняет благодарность в одном обращении (I5): дальше остаётся решение кода. */
export const AI_THANKS_PER_TICKET_DAY = 1;
/** Повтор того же текста в организации ищется за столько часов (решение 12). */
export const AI_REPEAT_HOURS = 24;
/** Причины отключения организации от помощника (hda_org_cutoffs.reason): budget_share у организации, budget_total у всех. */
export const AI_CUTOFF_REASONS = ['budget_share', 'budget_total'] as const;
export type AiCutoffReason = (typeof AI_CUTOFF_REASONS)[number];

// --- Тексты помощника по идентификаторам (план M5b, решение 10) ---

/** Вступления к ответу решением: тексты в messages/*.json (client.tez.intro.*). Модель выбирает только идентификатор. */
export const INTRO_TEMPLATE_IDS = ['likely_solution', 'exact_error', 'similar_case', 'known_steps'] as const;
export type IntroTemplateId = (typeof INTRO_TEMPLATE_IDS)[number];

/** Вопросы перед передачей (FR-AI-05): тексты в messages/*.json (client.tez.questions.*). */
export const HANDOFF_QUESTION_IDS = ['version', 'steps', 'since_when', 'screenshot', 'period_filters', 'other_user'] as const;
export type HandoffQuestionId = (typeof HANDOFF_QUESTION_IDS)[number];

/** Какие вопросы допустимы для типа обращения: лишние код отбрасывает, что бы ни выбрала модель. */
export const QUESTIONS_BY_TYPE: Readonly<Record<'bug' | 'question' | 'service_request', readonly HandoffQuestionId[]>> = {
  bug: ['version', 'steps', 'since_when', 'screenshot', 'other_user'],
  question: ['period_filters', 'screenshot', 'steps'],
  service_request: ['version', 'other_user'],
};
/** Не больше трёх вопросов перед передачей (FR-AI-05). */
export const HANDOFF_QUESTIONS_MAX = 3;

// --- Разбор ответов помощника (план M5b, задача 8; FR-AI-16, экран "Разбор ответов AI") ---

/** Причины отметки ответа неверным: код в hda_runs.flag_reason, подпись в messages/*.json. */
export const AI_FLAG_REASONS = ['wrong_solution', 'outdated_solution', 'should_handoff', 'wrong_language', 'other'] as const;
export type AiFlagReason = (typeof AI_FLAG_REASONS)[number];
/** Итог разбора (экран 8.12 "Разбор ответов AI"): исправлено решение, поднят порог, без изменений. */
export const AI_REVIEW_RESULTS = ['solution_fixed', 'threshold_raised', 'no_change'] as const;
export type AiReviewResult = (typeof AI_REVIEW_RESULTS)[number];
/** Выборка для просмотра первых двух недель пилота (15.6): последние ответы решением за столько дней. */
export const AI_REVIEW_SAMPLE_DAYS = 14;
export const AI_REVIEW_SAMPLE_SIZE = 20;

// --- Кандидаты в решения (веха M5c, задачи 9 и 10, решения 26-29) ---

export const CANDIDATE_STATUSES = ['new', 'accepted', 'merged', 'rejected'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export const CANDIDATE_REJECT_REASONS = ['duplicate', 'too_specific', 'not_a_solution', 'wrong_data', 'other'] as const;
export type CandidateRejectReason = (typeof CANDIDATE_REJECT_REASONS)[number];

/** Настройки кандидатов в hdc_settings: выключатель, дневной предел вызовов, пороги склейки (решения 26, 28). */
export const CANDIDATE_SETTINGS = {
  enabled: 'candidates.enabled',
  dailyLimit: 'candidates.daily_limit',
  publishedSimilarity: 'candidates.published_similarity',
  mergeSimilarity: 'candidates.merge_similarity',
} as const;
export const CANDIDATE_DEFAULTS = { enabled: true, dailyLimit: 50, publishedSimilarity: 0.88, mergeSimilarity: 0.85 } as const;
/** Обращения, закрытые за столько суток, обход берёт в кандидаты (решение 26). */
export const CANDIDATE_LOOKBACK_DAYS = 7;
/** Отклонённый кандидат возвращается в очередь, когда новых источников стало столько (FR-CAND-05). */
export const CANDIDATE_RETURN_SOURCES = 5;
/** Попыток получить вектор, после которых кандидат создаётся без склейки (решение 28). */
export const CANDIDATE_VECTOR_ATTEMPTS = 3;
/** Итоги закрытия, из которых растут кандидаты (решение 26). */
export const CANDIDATE_RESOLUTIONS = ['solved', 'workaround'] as const;

// --- AI-сотрудник и сервер MCP (веха M8b, задача 1; FR-AGT-02, 03, 04, 09; план M8b, решения 10, 14, 17, 18, 23) ---

/**
 * Инструменты чтения (FR-AGT-03, решение 17). Каталог закрытый: проверку перечня токена повторяет ограничение базы
 * hda_agent_tokens_c3. Инструментов ответа клиенту, смены статуса, приоритета, исполнителя и других из FR-AGT-05 нет.
 */
export const AGENT_READ_TOOLS = [
  'search_tickets',
  'get_ticket',
  'similar_tickets',
  'sla_risk_tickets',
  'unsolved_signatures',
  'signature_spikes',
  'search_solutions',
  'get_solution',
  'list_candidates',
  'list_known_problems',
  'list_ideas',
  'assistant_metrics',
] as const;
/** Инструменты записи (FR-AGT-04, решение 18): только то, что видят сотрудники. code_catalog_upsert появится в M8c. */
export const AGENT_WRITE_TOOLS = ['add_internal_note', 'draft_solution', 'draft_known_problem', 'create_report'] as const;
export const AGENT_TOOLS = [...AGENT_READ_TOOLS, ...AGENT_WRITE_TOOLS] as const;
export type AgentReadTool = (typeof AGENT_READ_TOOLS)[number];
export type AgentWriteTool = (typeof AGENT_WRITE_TOOLS)[number];
export type AgentTool = (typeof AGENT_TOOLS)[number];
/** Перечень токена запуска по обращению (FR-AGT-12, решение 15): чтение обращения и одна заметка. */
export const AGENT_RUN_TOOLS = ['get_ticket', 'add_internal_note'] as const satisfies readonly AgentTool[];

/** Итог вызова в журнале вызовов (решение 14). */
export const AGENT_CALL_STATUSES = ['ok', 'refused', 'invalid', 'rate_limited', 'error'] as const;
export type AgentCallStatus = (typeof AGENT_CALL_STATUSES)[number];

/** Виды сводок (решение 23): утренняя, гигиена решений, идеи, сканирование кода (M8c). */
export const REPORT_KINDS = ['morning', 'kb_hygiene', 'ideas', 'code_scan'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
/** Числа сводки для сообщения в чат команды (решение 24): только эти ключи, текст агента в чат не попадает. */
export const REPORT_CHAT_KEYS = ['new_tickets', 'ai_resolved', 'handed_off', 'sla_risk'] as const;
export type ReportChatKey = (typeof REPORT_CHAT_KEYS)[number];
/** Не больше стольких номеров обращений в сообщении чата команды. */
export const REPORT_CHAT_TICKETS_MAX = 20;
/** Пределы текстов записей агента (решение 18). */
export const AGENT_NOTE_MAX = 4000;
export const AGENT_RUN_NOTE_MAX = 2000;
export const AGENT_TITLE_MAX = 200;
export const AGENT_BODY_MAX = 20_000;
export const REPORT_STATUSES = ['unverified', 'reviewed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Значение токена: приставка и 32 случайных байта base64url (решение 10). */
export const AGENT_TOKEN_PREFIX = 'hub_at_';
export const AGENT_TOKEN_BYTES = 32;
/** Срок токена обязателен и не больше 365 суток (решение 10, проверка базы в t_hda_agent_tokens_guard). */
export const AGENT_TOKEN_MAX_DAYS = 365;
/** Суточный предел вызовов: по умолчанию 2000, не больше 10000 (экран 8.12). */
export const AGENT_DAILY_LIMIT_DEFAULT = 2000;
export const AGENT_DAILY_LIMIT_MAX = 10_000;
export const AGENT_TOKEN_NAME_MAX = 80;
/** Не больше стольких сетей в списке адресов токена (проверка базы hda_agent_tokens_c4). */
export const AGENT_ALLOWED_IPS_MAX = 50;
/** Журнал вызовов токена на экране: страницами по столько строк (решение 28). */
export const AGENT_CALLS_PAGE = 50;
/** Настройки AI-сотрудника в hdc_settings: служебный чат команды для сообщений по сводкам (решение 24). */
export const AGENT_SETTINGS = { teamChatId: 'agent.team_chat_id', spikeOrgCount: 'agent.spike_org_count', spikeWindowMinutes: 'agent.spike_window_minutes' } as const;
/** Всплеск сигнатуры (решение 25): порог разных организаций и окно в минутах, по умолчанию 3 за 60 минут. */
export const SPIKE_DEFAULTS = { orgCount: 3, windowMinutes: 60 } as const;
export const SPIKE_LIMITS = { orgCount: { min: 2, max: 100 }, windowMinutes: { min: 5, max: 1440 } } as const;
/** Повтор всплеска той же сигнатуры не раньше чем через столько часов. */
export const SPIKE_REPEAT_HOURS = 24;
/** Идентификатор чата Telegram: число, у групп и каналов со знаком минус. */
export const TELEGRAM_CHAT_ID = /^-?\d{5,15}$/;

// --- Знания из кода (веха M8c; ТЗ 7.22 FR-CODE-01..15; план M8c, решения 1, 9, 12, 18, 21, 25) ---

/** Статусы записи каталога ошибок и заметки о модуле: черновик, утверждена, отклонена, исчезла из сканирования. */
export const CODE_ENTRY_STATUSES = ['draft', 'approved', 'rejected', 'removed'] as const;
export type CodeEntryStatus = (typeof CODE_ENTRY_STATUSES)[number];
/** Что с записью в последнем сканировании: появилась, изменилась, не изменилась (выделение в очереди). */
export const CODE_CHANGE_KINDS = ['new', 'changed', 'same'] as const;
export type CodeChangeKind = (typeof CODE_CHANGE_KINDS)[number];
/** Предварительная оценка рода (FR-CODE-02): ошибка пользователя, настройка, данные, вероятный дефект. */
export const CODE_KINDS = ['user_error', 'setting', 'data', 'probable_defect'] as const;
export type CodeKind = (typeof CODE_KINDS)[number];
/** Кто видит знания из кода (FR-CODE-11). Первая линия видит только "что проверить" утверждённых записей. */
export const CODE_READER_ROLES = ['agent_l2', 'care', 'admin'] as const;
export const CODE_CHECK_ROLES = ['agent_l1', 'agent_l2', 'care', 'admin'] as const;
/** Статусы сканирования. */
export const CODE_SCAN_STATUSES = ['accepted', 'rejected'] as const;
export type CodeScanStatus = (typeof CODE_SCAN_STATUSES)[number];
/** Статусы запроса анализа по коду (10.5) и откуда запрос. */
export const CODE_ANALYSIS_STATUSES = ['pending', 'done', 'timeout'] as const;
export type CodeAnalysisStatus = (typeof CODE_ANALYSIS_STATUSES)[number];
export const CODE_ANALYSIS_SOURCES = ['staff', 'rule'] as const;
export type CodeAnalysisSource = (typeof CODE_ANALYSIS_SOURCES)[number];
/** Сколько минут ждём ответа агента (FR-CODE-10). */
export const CODE_ANALYSIS_TIMEOUT_MINUTES = 10;
/** Портал не принимает текста длиннее стольких строк (FR-CODE-12). */
export const CODE_MAX_LINES = 10;
/** Место в коде ссылкой (FR-CODE-12). */
export type CodeLocation = { object: string; path: string; line: number | null };
