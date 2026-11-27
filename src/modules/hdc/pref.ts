// Модуль hdc, слой pref: константы и коды (docs/naming.md, раздел 5).

/**
 * Действия журнала аудита. Закрытый перечень: запись с другим действием отклоняется.
 * Каждая веха добавляет сюда свои действия.
 */
export const AUDIT_ACTIONS = [
  // Сотрудники
  'staff.invited',
  'staff.created',
  'staff.reset',
  // Сотрудник сам сменил пароль (план подготовки M9, задача 1): все его сессии завершены.
  'staff.password_changed',
  'staff.signed_in',
  'staff.sign_in_failed',
  'staff.role_changed',
  'staff.state_changed',
  // Реестр серверов Smartup
  'server.added',
  'server.disabled',
  'server.enabled',
  'server.updated',
  // Настройки виджета сервера и новый секрет токена контекста (план M6, задача 1). Секрета в журнале нет.
  'server.widget_updated',
  'server.context_secret_created',
  // Организации и участники
  'org.provisioned',
  'org.updated',
  'member.joined',
  'member.role_changed',
  'member.state_changed',
  // Приглашения
  'invitation.created',
  'invitation.revoked',
  'invitation.accepted',
  // Учётная запись и сессии
  'user.email_confirmed',
  'user.policy_acknowledged',
  'session.revoked',
  // Каналы связи
  'telegram.linked',
  'telegram.unlinked',
  // Telegram отказал в доставке (человек заблокировал бота) и отметка снята (он снова написал боту).
  'telegram.bot_blocked',
  'telegram.bot_unblocked',
  'user.signed_in_telegram',
  // Вход клиента любым способом (волна 1, задача 8). Способ в описании: smartup, email_link, invitation, telegram.
  'user.signed_in',
  // Новая сессия виджета (план M6, решение 15): сервер и платформа. Продление по таймеру пишется только в журнал работы.
  'client.embed_session',
  // Обращения (веха M2): создание, смена статуса и видимости. Текста обращения в журнале нет.
  'ticket.created',
  'ticket.status_changed',
  'ticket.visibility_changed',
  // Антивирус нашёл заражённый файл во вложении (решение 0027).
  'attachment.infected',
  // Загрузка справочника модулей командой hub modules:import.
  'modules.imported',
  // Действия сотрудника с обращением (веха M3). Текста обращения в журнале нет.
  'ticket.assigned',
  'ticket.priority_changed',
  'ticket.type_changed',
  'ticket.module_changed',
  'ticket.snoozed',
  'ticket.line_transferred',
  'ticket.line_returned',
  'ticket.merged',
  // Оценка по ссылке из письма, без входа в портал (FR-TK-11; решение 0040).
  'ticket.rated_by_link',
  // Письма из "Неопознанных" (план M4, задача 11)
  'ticket.bound',
  'sender.blocked',
  'guest.merge_recorded',
  'guest.merged',
  'ticket.author_moved',
  // Настройки почты и уведомлений (план M4, задача 12)
  'settings.changed',
  'settings.oncall_changed',
  // Токен отдельного бота дежурных заменён: запись в одной транзакции с секретом (решение 0040).
  'settings.oncall_bot_replaced',
  'sender.unblocked',
  'org.domain_added',
  'org.domain_removed',
  // Каналы уведомлений (план M4b, задача 1)
  'notify.channels_changed',
  // Замена ключа шифрования (волна 1, задача 7)
  'secrets.resealed',
  // Чтение сотрудниками (волна 1, задача 8): открытие обращения не чаще раза в час на пару, каждая выдача файла.
  'ticket.viewed_by_staff',
  'attachment.downloaded_by_staff',
  // Памятки первой линии и шаблоны ответов (веха M3).
  'playbook.saved',
  'template.saved',
  // Сроки SLA и рабочий календарь (веха M3).
  'sla.policy_changed',
  'sla.calendar_changed',
  'sla.holidays_changed',
  // Теги обращений (веха M8): справочник и постановка на обращение.
  'tag.created',
  'tag.updated',
  'tag.deleted',
  'ticket.tag_added',
  'ticket.tag_removed',
  // Правила автоматизации (веха M8): настройка администратором, срабатывание на обращении, защита от зацикливания, пробный прогон.
  'rule.created',
  'rule.updated',
  'rule.enabled',
  'rule.disabled',
  'rule.moved',
  'rule.deleted',
  'rule.restored',
  'rule.applied',
  'rule.disabled_loop',
  // Защита от зацикливания приостановила правило на одном обращении (проверка вехи M8, находка S1).
  'rule.paused_loop',
  'rule.dry_run',
  // Исходящие вебхуки (веха M8): список адресов, смена секрета, проверочная отправка. Секрета в журнале нет.
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'webhook.secret_rotated',
  'webhook.test_sent',
  // Макросы (веха M8): настройка администратором и запуск сотрудником на обращении.
  'macro.created',
  'macro.updated',
  'macro.moved',
  'macro.deleted',
  'macro.run',
  // Передача в разработку (веха M8): привязка обращения к задаче, снятие привязки, смена статуса задачи.
  'devtask.linked',
  'devtask.unlinked',
  'devtask.status_changed',
  // Показатели (веха M8): выгрузка CSV и заметка руководителя о разборе низкой оценки.
  'metrics.exported',
  'ticket.csat_reviewed',
  // AI-помощник (веха M5b): передача сотруднику, кнопки клиента под ответом помощника.
  'ticket.ai_handoff',
  'ticket.ai_feedback',
  // Принятие предложений разбора сотрудником (веха M5b, задача 7).
  'ticket.triage_accepted',
  // Отметка ответа помощника неверным и итог разбора (веха M5b, задача 8; FR-AI-16).
  'ticket.ai_answer_flagged',
  'ticket.ai_answer_reviewed',
  // Решения (веха M5): публикация, архив, аудитория, возврат версии, отметка "Текст прочитан", заражённое изображение.
  'solution.published',
  'solution.archived',
  'solution.audience_changed',
  'solution.version_restored',
  'solution.text_read',
  'solution.file_infected',
  'solution.created_from_ticket',
  // Привязка решения к сигнатуре ошибки (веха M5, задача 8): с ней решение показывается точным совпадением.
  'solution.signature_bound',
  'solution.signature_unbound',
  // Идеи (веха M7): подача, правка автором до публикации, показ организации, модерация (публикация, отклонение,
  // объединение, правка текста модератором, правка перевода), заражённое изображение. Текста идеи в журнале нет.
  'idea.submitted',
  'idea.edited',
  'idea.org_visibility_changed',
  'idea.published',
  'idea.declined',
  'idea.merged',
  'idea.moderator_edited',
  'idea.translation_reviewed',
  'idea.file_infected',
  // Комментарии к идеям (веха M7, задача 7): удержан до модератора по находкам или ссылке, опубликован модератором,
  // скрыт с причиной. Текста комментария в журнале нет.
  'idea.comment_held',
  'idea.comment_published',
  'idea.comment_hidden',
  // Отбор месяца и статусы после выбора (веха M7, задача 9): снимок пятёрки, закрытие отбора без выбора, выбор идеи
  // месяца, смена статуса идеи (выбрана, в разработке, выпущена).
  'idea.cycle_created',
  'idea.cycle_lapsed',
  'idea.cycle_decided',
  'idea.status_changed',
  // Эксплуатация (план подготовки M9, задача 3): команда hub ops:backup-mark отметила удачную резервную копию.
  'ops.backup_marked',
  // Известные проблемы (веха M5c): создание, правка, статус, признак показа, сигнатуры, публичный текст, привязка
  // обращения и отвязка. Текста проблемы и обращения в журнале нет.
  'problem.created',
  'problem.updated',
  'problem.status_changed',
  'problem.shown_changed',
  'problem.signature_added',
  'problem.signature_removed',
  'problem.translation_saved',
  'ticket.problem_linked',
  // Рассылка обновления или закрытия проблемы подтверждена (веха M5c, задача 5): число получателей, без текста.
  'problem.broadcast_confirmed',
  // Текст оригинала изменён: принятые машинные переводы сняты с показа (независимая проверка M5c, решение 0109).
  'problem.translations_outdated',
  // Объявления (веха M5c, задача 6): создание и правка, досрочное окончание. Текста объявления в журнале нет.
  'announcement.saved',
  'announcement.ended',
  'announcement.translations_outdated',
  'ticket.problem_unlinked',
  // Кандидаты в решения (веха M5c, задачи 9 и 10): возврат отклонённого в очередь, черновик решения, объединение с
  // решением, отклонение с причиной, отметка проверенных находок недоверенного текста. Текста кандидата в журнале нет.
  'candidate.returned',
  'candidate.accepted',
  'candidate.merged',
  'candidate.rejected',
  'solution.untrusted_confirmed',
  'solution.created_from_candidate',
  // Поиск (план W6, решения 3 и 12): команда hub создала ключи Typesense (без значений) и построила индекс заново.
  'search.keys_created',
  'search.reindexed',
  // AI-сотрудники (веха M8b, задача 3): выпуск, правка перечня, адресов, предела и срока, отзыв токена и выбор токена
  // "для событий". Значения токена и его хеша в журнале нет.
  'agent.token_issued',
  'agent.token_changed',
  'agent.token_revoked',
  'agent.event_parent_set',
  // Сервер MCP (веха M8b, задача 4, решения 13 и 14): отказ в инструменте вне перечня токена и вызов инструмента
  // записи. Аргументов и текста ответов в журнале нет: только имя инструмента и номера объектов.
  'agent.tool_refused',
  'agent.tool_called',
  // Черновик известной проблемы от AI-сотрудника и всплеска (веха M8b, задача 6, решение 20).
  'problem.draft_accepted',
  'problem.proposals_linked',
  'problem.draft_rejected',
  // Сводка AI-сотрудника отмечена "Просмотрено" (веха M8b, задача 10, решение 22).
  'agent.report_reviewed',
  // Знания из кода (веха M8c, решение 26 плана M8c): приём и отклонение отчёта о сканировании, утверждение, правка и
  // отклонение записи каталога, решение по заметке о модуле, запрос анализа по коду, решение из записи. Текстов
  // записей в журнале нет: ключи, числа и номера.
  'code.scan_accepted',
  'code.scan_rejected',
  'code.entry_approved',
  'code.entry_edited',
  'code.entry_rejected',
  'code.module_approved',
  'code.module_rejected',
  'code.analysis_requested',
  // Независимая проверка M8c (решение 0134, находка M1): истечение срока и ответ агента на запрос анализа.
  'code.analysis_timed_out',
  'code.analysis_done',
  'solution.created_from_code',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Наименьшая длина текста в поиске (аудит 23.11.2026, находка P9). Запрос короче совпадает почти со всем и не может
 * идти по триграммному индексу. Номер обращения ищется при любой длине.
 */
export const SEARCH_MIN_CHARS = 3;

/** Достаточно ли текста для поиска: считаются знаки, а не единицы UTF-16. */
export const searchable = (text: string): boolean => [...text.trim()].length >= SEARCH_MIN_CHARS;

export type RateRule = { limit: number; windowSec: number };

/**
 * Пределы частоты. Первые три заданы разделом 14.5 ТЗ, остальные приняты в вехе M1
 * (docs/decisions/0014-identity-access.md).
 */
export const RATE_RULES = {
  /** Запрос ссылки для входа: 5 в час на адрес. */
  loginLinkPerAddress: { limit: 5, windowSec: 3600 },
  /** Запрос ссылки для входа: 20 в час на IP. */
  loginLinkPerIp: { limit: 20, windowSec: 3600 },
  /** Попытка входа сотрудника: 10 в 15 минут на учётную запись, затем блокировка на 15 минут. */
  staffLoginPerAccount: { limit: 10, windowSec: 900 },
  /**
   * Попытка входа сотрудника: 100 в 15 минут с одного адреса по любым учётным записям (подбор паролей по многим
   * адресам). С запасом на смену, которая входит утром из офиса с одним внешним адресом; главная защита: Turnstile
   * и 10 попыток на учётную запись.
   */
  staffLoginPerIp: { limit: 100, windowSec: 900 },
  /** Одноразовые ссылки и токены (вход по ссылке, вход из бота, приглашения, подтверждение адреса): 30 в 10 минут с адреса. */
  tokenRedeemPerIp: { limit: 30, windowSec: 600 },
  /** Коды при подключении второго фактора: библиотека на этом пути попытки не считает (проверка main, S1). */
  staffEnrollCodePerUser: { limit: 10, windowSec: 900 },
  /** Принятый код второго фактора: один раз за 120 секунд, дольше его срока с соседними шагами (проверка main, S11). */
  staffTotpCodeOnce: { limit: 1, windowSec: 120 },
  /** Запись о блокировке входа сотрудника в журнал: раз за окно блокировки (итоговая проверка доработки). */
  staffFailureAuditOnce: { limit: 1, windowSec: 900 },
  // Смена пароля сотрудником (план подготовки M9, задача 1): 5 попыток за 15 минут, проверка текущего пароля не
  // становится обходом предела попыток входа.
  staffPasswordChange: { limit: 5, windowSec: 900 },
  /** Поиск сервера Smartup по адресу на странице входа. */
  serverLookupPerIp: { limit: 20, windowSec: 3600 },
  /** Запрос подтверждения email. */
  emailConfirmPerUser: { limit: 5, windowSec: 3600 },
  /** Приглашения в одну организацию. */
  invitationsPerOrg: { limit: 20, windowSec: 3600 },
  /** Ссылки привязки Telegram на пользователя (решение 0018). */
  telegramLinkPerUser: { limit: 5, windowSec: 3600 },
  /** Ссылки входа из бота на аккаунт Telegram (раздел 14.5 ТЗ). */
  loginLinkPerTelegram: { limit: 5, windowSec: 3600 },
  /** Начало входа через Smartup: каждое начало оставляет в базе одноразовое значение состояния. Предел на адрес
   * (IPv6 по сети /64) с запасом на офис клиента за одним адресом в утренний час (проверка main, S6). */
  ssoStartPerIp: { limit: 300, windowSec: 600 },
  /** Возврат с сервера Smartup на единственный открытый адрес библиотеки входа. */
  ssoCallbackPerIp: { limit: 120, windowSec: 60 },
  /** Отчёты о нарушениях CSP с одного адреса (проверка main, S9): страница присылает несколько за раз. */
  cspReportPerIp: { limit: 60, windowSec: 600 },
  /** Вебхук таск-менеджера Smartup с одного адреса (веха M8): таск-менеджер один и шлёт событие на каждую смену статуса. */
  trackerWebhookPerIp: { limit: 600, windowSec: 60 },
  /** Выгрузка показателей в CSV (веха M8, решение 16): 20 в час на сотрудника. Каждая выгрузка читает до 50 тысяч обращений. */
  metricsExportPerUser: { limit: 20, windowSec: 3600 },
  /** Неудачные проверки токена сервера MCP с адреса (план M8b, решение 12): 30 за 10 минут, как одноразовые ссылки. */
  mcpTokenFailuresPerIp: { limit: 30, windowSec: 600 },
  /** Вызовы инструментов сервера MCP на токен: 60 в минуту против зацикливания агента (решение 12). */
  agentCallsPerMinute: { limit: 60, windowSec: 60 },
  /**
   * Методы протокола сервера MCP (initialize, tools/list, ping, уведомления) на токен: 120 в минуту, отдельно от
   * вызовов инструментов (независимая проверка M8b, находка I4).
   */
  agentProtocolPerMinute: { limit: 120, windowSec: 60 },
  /** Строка rate_limited в журнале вызовов: одна за минуту на токен, а не на каждый отказ (находка I4). */
  agentRateLimitedLog: { limit: 1, windowSec: 60 },
  /** Токен запуска по обращению: не больше 20 вызовов за срок 2 часа (решение 12). */
  agentRunTokenCalls: { limit: 20, windowSec: 7200 },
  /** Обмен токена контекста на токен виджета (план M6, решение 14): 30 в минуту на пользователя (раздел 14.5). */
  embedSessionPerUser: { limit: 30, windowSec: 60 },
  /** Тот же обмен: 120 в минуту с адреса до проверки подписи. */
  embedSessionPerIp: { limit: 120, windowSec: 60 },
  /** Неудачные обмены: после 20 за 10 минут с адреса обмен закрыт до конца окна. */
  embedSessionFailuresPerIp: { limit: 20, windowSec: 600 },
  /** Создание обращения: 10 в час на пользователя (раздел 14.5). */
  ticketCreatePerUser: { limit: 10, windowSec: 3600 },
  /** Ответы в обращениях: 60 в час на пользователя (предложение плана M2, в ТЗ предела нет). */
  ticketReplyPerUser: { limit: 60, windowSec: 3600 },
  /** Ссылки на загрузку файла: 30 в час на пользователя (план M2, задача 5). */
  uploadPresignPerUser: { limit: 30, windowSec: 3600 },
  /** Завершение загрузки: вдвое больше ссылок, браузер может повторить (вторая проверка M2). */
  uploadCompletePerUser: { limit: 60, windowSec: 3600 },
  /** Действия с обращением (подтвердить, открыть заново, оценить, видимость, подписка): общий предел на
   * пользователя, 60 в час. Каждое действие пишет событие и запись журнала (вторая проверка M2). */
  ticketActionPerUser: { limit: 60, windowSec: 3600 },
  /** Поиск клиента по тексту обращений: 30 в минуту на пользователя (решение 0041, пункт 9). Человеку хватает
   * с запасом, перебор шаблонов ради замера времени ответа становится долгим. */
  ticketSearchPerUser: { limit: 30, windowSec: 60 },
  /** Тот же поиск: 300 в час на организацию, чтобы предел не обходился числом пользователей. */
  ticketSearchPerOrg: { limit: 300, windowSec: 3600 },
  /** Попытки оценки по ссылке из письма: 10 в час на обращение. */
  csatLinkPerTicket: { limit: 10, windowSec: 3600 },
  /** Новые обращения письмом: 10 в час на адрес отправителя, как создание обращения (решение 18 вехи M4). */
  emailTicketPerSender: { limit: 10, windowSec: 3600 },
  /** Подтверждение неопознанному отправителю: не чаще раза в час на адрес (FR-EM-07, решение 18 вехи M4). */
  unidentifiedAckPerSender: { limit: 1, windowSec: 3600 },
  /** Письма "на проверку" в обращение: 20 в час на адрес отправителя (итоговая проверка M4). */
  emailReviewPerSender: { limit: 20, windowSec: 3600 },
  /** Письма "на проверку" в одно обращение: 5 в час с любых адресов (аудит 23.11.2026, находка S12). */
  emailReviewPerTicket: { limit: 5, windowSec: 3600 },
  /** Сводная заметка "письма придержаны" в обращении: не чаще раза в час (проверка волны 1). */
  emailReviewHeldNote: { limit: 1, windowSec: 3600 },
  /** Отметка "письмо уже учтено в пределах частоты": повтор разбора того же письма пределы не расходует. */
  emailLetterOnce: { limit: 1, windowSec: 86_400 },
  /** "Помогло" или "Не помогло" на странице решения (план M5, задача 4): один голос в сутки на решение и пользователя. */
  kbFeedbackOnce: { limit: 1, windowSec: 86_400 },
  /** Те же кнопки: 30 нажатий в час на пользователя по всем решениям. */
  kbFeedbackPerUser: { limit: 30, windowSec: 3600 },
  /** Подсказка решений на форме обращения (план M5, решение 13): 60 запросов в минуту на пользователя. */
  kbSuggestPerUser: { limit: 60, windowSec: 60 },
  /** Та же подсказка: 600 в час на организацию, чтобы предел не обходился числом пользователей. */
  kbSuggestPerOrg: { limit: 600, windowSec: 3600 },
  /** Создание идеи: 5 в сутки на пользователя (раздел 14.5). */
  ideaCreatePerUser: { limit: 5, windowSec: 86_400 },
  /** Голос и его отзыв: 60 в минуту на пользователя (раздел 14.5). */
  ideaVotePerUser: { limit: 60, windowSec: 60 },
  /** Комментарий к идее: 20 в час на пользователя (план M7, решение 20, сверх ТЗ). */
  ideaCommentPerUser: { limit: 20, windowSec: 3600 },
  /** Похожие идеи при наборе и поиск по доске: 30 в минуту на пользователя (решение 20, как подсказка в 14.5). */
  ideaSearchPerUser: { limit: 30, windowSec: 60 },
  /** Правка своей идеи и показа организации: 30 в час на пользователя (решение 20). */
  ideaEditPerUser: { limit: 30, windowSec: 3600 },
  /** Подписка и отписка: 60 в час на пользователя (решение 20). */
  ideaFollowPerUser: { limit: 60, windowSec: 3600 },
} as const satisfies Record<string, RateRule>;

/** Версия политики: дата вида 2026-12-01. Она же попадает в учётную запись пользователя. */
export const POLICY_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Невидимые знаки в тексте пользователя (проверка на AI-инъекции, решение 0030). Сотрудник должен видеть то же,
 * что получит модель: знаки блока "теги" Юникода модель читает как обычные буквы, а на экране их нет ("ASCII
 * smuggling"). Вырезаются форматирующие знаки, кроме соединителей нулевой ширины (из них состоят эмодзи),
 * дополнительные селекторы вариантов и управляющие знаки, кроме табуляции и переводов строк.
 */
const INVISIBLE_TEXT = /(?![\u200C\u200D])\p{Cf}|[\u{E0100}-\u{E01EF}]|(?![\t\n\r])\p{Cc}/gu;

/** Текст пользователя без невидимых знаков: для обращений, ответов и комментариев до проверки длины. */
export function cleanUserText(value: string): string {
  return (
    value
      .replace(/[\u2028\u2029]/gu, '\n')
      .replace(INVISIBLE_TEXT, '')
      // Соединитель законен по одному между знаками: цепочки из них несут скрытые биты.
      .replace(/[\u200C\u200D]{2,}/gu, (run) => run.charAt(0))
  );
}

/** Соединители и селекторы вариантов: законны в эмодзи, но внутри числа или адреса прячут его от поиска. */
const JOINERS = /[\u200C\u200D\uFE00-\uFE0F]/gu;

/** Текст без невидимых знаков и без соединителей: для текста модели, который ложится в документ (M5, 0057). */
export function stripInvisible(value: string): string {
  return cleanUserText(value).replace(JOINERS, '');
}

/**
 * Текст для поиска персональных данных (вырезание перед моделью, проверка FR-SOL-04; повторная проверка M5, 0057):
 * без невидимых знаков и соединителей, с формой NFKC там, где она прячет данные (compatNormalize). Цифры других
 * письменностей NFKC не меняет: их приводит asciiDigits, правила поиска считают цифры классом \p{Nd}.
 */
export function scanText(value: string): string {
  return asciiDigits(stripInvisible(compatNormalize(value)));
}

/** Знак, который после NFKC становится цифрой или разделителем адреса и телефона. */
const COMPAT_TARGET = /^[0-9@./:+()-]$/;

/**
 * NFKC по знакам, только где он прячет данные: полноширинные формы (U+FF00-FFEF: "９", "＠", "．", "／", буквы) и
 * знаки, которые NFKC превращает в цифру или разделитель ("①", "﹫", математические цифры). Остальное не трогается:
 * "№", многоточие и лигатуры остаются как есть, примеры текста ошибок для сотрудников не меняются.
 */
export function compatNormalize(value: string): string {
  return value.replace(/[\u0080-\u{10FFFF}]/gu, (char) => {
    const code = char.codePointAt(0)!;
    const normal = char.normalize('NFKC');
    return (code >= 0xff00 && code <= 0xffef) || COMPAT_TARGET.test(normal) ? normal : char;
  });
}

/**
 * Похоже ли совпадение правила телефона на телефон (вырезание перед моделью и проверка FR-SOL-04, общее правило):
 * хватает цифр, а с точкой или косой чертой ещё и от 9 цифр с одним и тем же разделителем между группами. Так даты
 * (25.11.2026, 25.11.2026 10:30, 01.11.2026-30.11.2026) и версии остаются текстом, а 90.123.45.67 нет.
 */
export function phoneLike(match: string, minDigits: number): boolean {
  const digits = match.match(/\p{Nd}/gu)?.length ?? 0;
  if (!/[./]/.test(match)) return digits >= minDigits;
  const separators = new Set(match.match(/(?<=\p{Nd}\)?)[\s./-](?=\(?\p{Nd})/gu) ?? []);
  return digits >= Math.max(9, minDigits) && separators.size === 1;
}

const DECIMAL_DIGIT = /\p{Nd}/u;

/**
 * Цифры любой письменности обычными (٣ и ३ становятся 3). Наборы цифр в Юникоде идут подряд по десять, от нуля до
 * девяти: значение цифры это её место в своём наборе.
 */
export function asciiDigits(value: string): string {
  return value.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0)!;
    if (code >= 0x30 && code <= 0x39) return digit;
    let offset = 0;
    while (offset < 60 && DECIMAL_DIGIT.test(String.fromCodePoint(code - offset - 1))) offset++;
    return String(offset % 10);
  });
}

/**
 * Виды событий предметной области (FR-AUTO-02; план M8, задача 2). Перечень повторяет ограничение
 * hdc_domain_events_c1. no_activity и ai_handoff пишут следующие задачи вехи и веха M5b.
 */
export const DOMAIN_EVENT_KINDS = [
  'ticket_created',
  'client_replied',
  'staff_replied',
  'status_changed',
  'priority_changed',
  'rated',
  'sla_soon',
  'sla_breached',
  'no_activity',
  'ai_handoff',
  // Передача на вторую линию (веха M8b, задача 9): событие для AI-сотрудника.
  'line_transferred',
  // Запрошен анализ по коду (веха M8c, задача 7): событие для AI-сотрудника.
  'code_analysis_requested',
] as const;
export type DomainEventKind = (typeof DOMAIN_EVENT_KINDS)[number];
