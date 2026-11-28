// Известные места, где транзакция открывается внутри другой (проверка качества, Q12). Это долг: каждое место держит
// соединение внешней транзакции, пока внутренняя ждёт своё. Новое место сюда не добавляется: чтение выносится до
// транзакции (образцы: src/modules/hdt/core/notice-identity.ts, readSettings в src/modules/hdc/settings.ts).
// Строка: "пул внешней>пул внутренней файл#функция внутренней транзакции". Список сверяет каждый интеграционный тест
// (tests/integration/setup/each.ts); строка, которая больше не встречается, удаляется.
export const NESTED_TX_ALLOWED: ReadonlySet<string> = new Set<string>([
  // Настройка читается внутри транзакции другого модуля (пределы, языки, сроки).
  'app>app src/modules/hdc/settings.ts#readSetting',
  // Сведения об организациях для проверки публичного текста внутри транзакции проблемы.
  'app>app src/modules/hdu/core/orgs.ts#orgFactsOf',
  // Название организации для письма дежурным и руководителю: без обёртки разбора событий (прямой вызов правил).
  'app>auth src/modules/hdu/core/recipients.ts#organizationNameTx',
  // Справочник сотрудников для имён в ответах внутри транзакции чтения.
  'app>auth src/modules/hdu/core/staff-lookup.ts#staffDirectoryTx',
  // Руководители линии и сотрудники роли для уведомлений сотрудникам.
  'app>auth src/modules/hdu/core/recipients.ts#lineLeadsTx',
  'app>auth src/modules/hdu/core/recipients.ts#staffIdsWithRoleTx',
  // Запасной путь уведомления клиенту: получателя не было в снимке или транзакцию открыл путь без обёртки.
  'app>auth src/modules/hdu/core/recipients.ts#replyRolesTx',
  'app>auth src/modules/hdu/core/recipients.ts#telegramLinkedManyTx',
  // Привязка Telegram одного пользователя при чтении и сохранении его настроек уведомлений.
  'app>auth src/modules/hdu/core/recipients.ts#telegramChatTx',
]);
