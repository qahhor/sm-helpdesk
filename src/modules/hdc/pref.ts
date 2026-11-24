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
  'staff.signed_in',
  'staff.sign_in_failed',
  'staff.role_changed',
  'staff.state_changed',
  // Реестр серверов Smartup
  'server.added',
  'server.disabled',
  'server.enabled',
  'server.updated',
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
  'rule.applied',
  'rule.disabled_loop',
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
] as const;
export type DomainEventKind = (typeof DOMAIN_EVENT_KINDS)[number];
