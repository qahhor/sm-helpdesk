// Набор проверок изоляции (ТЗ, раздел 15.2): перечень таблиц и представлений предметной области.
//
// Каждая новая таблица или представление схемы public получает здесь строку. Тест registry.test.ts
// падает, если в базе есть объект без строки или строка без объекта, и проверяет каждое значение
// запросом напрямую в базу.
//
// client: что видит клиент под ролью hub_app.
//   none        клиент не видит ни одной строки (или не имеет права на таблицу);
//   own-org     клиент видит только строки своей организации, и хотя бы одну видит;
//   org-people  клиент видит только людей своей организации и сотрудников портала;
//   all         справочник: строки одинаковы для всех организаций;
//   own-user    клиент видит только строки, где user_id его собственный, и хотя бы одну видит.
//   clients-audience  общее содержимое для клиентов всех организаций: клиент видит только строки с audience = 'clients'
//               (и хотя бы одну), строки internal не видит (знания, план M5, задача 2).
//   published-or-own  идеи (план M7, решение 2): клиент видит строки опубликованных идей клиентов всех организаций и
//               свои строки (своя идея, свой комментарий, своя загрузка), и хотя бы одну. Идея на модерации, отклонённая
//               и комментарий на проверке другого клиента ему не видны. Что считается "своим" и "опубликованным" для
//               каждой таблицы, задаёт PUBLISHED_OR_OWN в registry.test.ts.
//   decided-only  отборы месяца (план M7): клиент видит только завершённые (decided, lapsed), и хотя бы один.
//
// app, auth: какие изменения разрешены ролям hub_app и hub_auth. Тест сверяет с правами в базе,
// а остальные проверки берут отсюда, что должно быть закрыто (проверка main, Q2).

export type ClientAccess = 'none' | 'own-org' | 'org-people' | 'all' | 'own-user' | 'clients-audience' | 'published-or-own' | 'decided-only';
export type Write = 'insert' | 'update' | 'delete';
export type DomainObject = { client: ClientAccess; app?: Write[]; auth?: Write[] };

const IU: Write[] = ['insert', 'update'];
const IUD: Write[] = ['insert', 'update', 'delete'];

export const DOMAIN_OBJECTS: Record<string, DomainObject> = {
  // AI (веха M5, задача 5). Журнал вызовов модели без текста: пишет только фоновый процесс, читают сотрудники,
  // строки не меняются и не удаляются (поправка 101).
  // Веха M5b, задача 1: решение кода (ответ, вопрос, передача) система записывает в ту же строку вызова.
  hda_runs: { client: 'none', app: ['insert', 'update'] },
  // Отключения помощника пределом расходов (план M5b, решение 11): ставит система, снимает администратор портала,
  // читают сотрудники, клиент не видит ни одной строки.
  hda_org_cutoffs: { client: 'none', app: IU },
  // Ядро. Журнал аудита только пополняется (решение 0019).
  // Удаление: только ночная очистка под системным актором и только записи старше 3 лет (срок хранения журнала,
  // решение владельца 24.11.2026, решение 0041). Свежую запись политика не отдаёт ни одному актору: retention.test.ts.
  hdc_audit_log: { client: 'none', app: ['insert', 'delete'], auth: ['insert'] },
  // События предметной области (веха M8): пишет действие над обращением, разбирает и удаляет система, клиент не видит.
  hdc_domain_events: { client: 'none', app: IUD },
  hdc_ops_alerts: { client: 'none', app: IU },
  // Отметки резервных копий (план подготовки M9, решение 6): ставит команда hub под системным актором, читает
  // администратор портала. Строки не меняются и не удаляются.
  hdc_ops_backups: { client: 'none', app: ['insert'] },
  // Отметка "фоновый процесс жив" (план подготовки M9, решение 5): одна строка на процесс, обновляется раз в минуту.
  hdc_ops_heartbeats: { client: 'none', app: IU },
  hdc_rate_limits: { client: 'none', app: IUD },
  // Очередь записи в индекс поиска Typesense (план W6, решение 10): строку пишет триггер исходной таблицы от любого
  // актора (hub_auth для организаций, участников и имён), читает, отмечает и удаляет только система. Клиент не видит.
  hdc_search_outbox: { client: 'none', app: IUD, auth: ['insert'] },
  hdc_settings: { client: 'none', app: IUD },
  // Знания (веха M5, задача 2). Клиент получает текст решения только из копии опубликованного hdk_published и
  // находит его только через индекс hdk_search_documents, в обоих только audience = clients, одинаково для всех
  // организаций. Черновики, версии, языки, источник (обращение), файлы, сигнатуры и исходы ему закрыты.
  // Статьи, версии и языки пишут роли черновиков (agent_l1, agent_l2, care, admin), публикуют и архивируют agent_l2,
  // care, admin (решение 10); удаления нет: история остаётся.
  hdk_articles: { client: 'none', app: IU },
  hdk_article_versions: { client: 'none', app: IU },
  hdk_article_translations: { client: 'none', app: IU },
  // Источник решения ставится один раз и не меняется.
  hdk_article_sources: { client: 'none', app: ['insert'] },
  // Копию пишут и снимают публикация и архив (публикующие роли и система).
  hdk_published: { client: 'clients-audience', app: IUD },
  // Файлы загружают роли черновиков, итог антивируса и удаление за системой.
  hdk_article_files: { client: 'none', app: IUD },
  hdk_error_signatures: { client: 'none', app: IU },
  // Организации сигнатуры и исходы подсказки пишет только система; исходы удаляет ночная очистка (13 месяцев).
  hdk_signature_orgs: { client: 'none', app: IU },
  hdk_search_documents: { client: 'clients-audience', app: IUD },
  hdk_deflection_events: { client: 'none', app: IUD },
  // Запросы подсказки без результата (план W6, решение 17): текст после маски, 90 дней. Пишет и удаляет система,
  // читают администратор и роли публикации решений. Клиент не видит.
  hdk_suggest_misses: { client: 'none', app: IUD },
  // Идеи (веха M7, задача 1). Опубликованную идею видят клиенты всех организаций (FR-IDEA-06): границы организации
  // у неё нет, это и записано видом published-or-own. Идею на модерации видит только автор, отклонённую автор и
  // голосовавшие или подписчики, если она была опубликована (решение 2; проверяет ideas-direct.test.ts). Удаления
  // идей, текстов, комментариев и отборов нет: история остаётся. Счётчики пишут только триггеры базы.
  hdi_ideas: { client: 'published-or-own', app: IU },
  hdi_idea_translations: { client: 'published-or-own', app: IU },
  // Голос и подписка только свои (ТЗ 15.2: "видит только свой голос"); снимаются отзывом и переносом при объединении.
  hdi_votes: { client: 'own-user', app: ['insert', 'delete'] },
  hdi_subscriptions: { client: 'own-user', app: ['insert', 'delete'] },
  // Комментарий на проверке видит только его автор; скрытый остаётся строкой.
  hdi_comments: { client: 'published-or-own', app: IU },
  // Отбор месяца: снимок пишет система, выбор product и admin, клиент видит только завершённые.
  hdi_cycles: { client: 'decided-only', app: IU },
  // Изображения идеи: свои любые, чужие только чистые у опубликованной; убирает автор до публикации, модератор и система.
  hdi_attachments: { client: 'published-or-own', app: IUD },
  // Уведомления
  // Очередь исходящих (веха M4): ставит действие, отправляет система, клиент не видит.
  hdn_outbox: { client: 'none', app: IUD },
  // Уведомления в портале и настройки писем (веха M4): только свои строки.
  // Изменение у hub_app только колонки read_on (GRANT UPDATE (read_on)): права на таблицу целиком нет.
  hdn_notifications: { client: 'own-user', app: ['insert', 'delete'] },
  hdn_notification_prefs: { client: 'own-user', app: IU },
  // Токен отдельного бота дежурных (веха M4): читает только система.
  hdn_channel_secrets: { client: 'none', app: IU },
  // Приём писем (веха M4): пишет система, клиент не видит.
  hdn_email_inbound: { client: 'none', app: IUD },
  hdn_email_threads: { client: 'none', app: ['insert'] },
  hdn_blocked_senders: { client: 'none', app: ['insert', 'delete'] },
  hdn_telegram_updates: { client: 'none', app: ['insert', 'delete'] },
  // Справочники
  hdr_business_calendars: { client: 'all', app: IU },
  hdr_l1_playbooks: { client: 'none', app: IUD },
  hdr_product_modules: { client: 'all', app: IUD },
  hdr_reply_templates: { client: 'none', app: IU },
  hdr_sla_policies: { client: 'all', app: IU },
  // Теги обращений (веха M8): создаёт сотрудник с правом записи, меняет и удаляет администратор, клиент не видит.
  hdr_tags: { client: 'none', app: IUD },
  // Идентичность: меняет только hub_auth, удаляет только отвязка контакта.
  hdu_contact_identities: { client: 'own-user', auth: IUD },
  // Использованные токены контекста виджета (веха M6): пишет обмен токена от имени системы, удаляет ночная очистка
  // только строки с вышедшим сроком. Изменить строку нельзя никому: иначе повтор токена открылся бы.
  hdu_context_token_uses: { client: 'none', auth: ['insert', 'delete'] },
  // Ссылки и коды удаляет только ночная очистка системой (решение 0023, дополнение M2).
  hdu_email_tokens: { client: 'none', auth: IUD },
  // Слияние гостя (веха M4): записывает hub_auth, отметку применения ставит hub_app (только колонка applied_on).
  hdu_guest_merges: { client: 'none', auth: ['insert'] },
  hdu_invitations: { client: 'own-org', auth: IU },
  hdu_link_codes: { client: 'none', auth: IUD },
  hdu_login_codes: { client: 'none', auth: IUD },
  hdu_memberships: { client: 'own-org', auth: IU },
  hdu_organizations: { client: 'own-org', auth: IU },
  // Домены почты организаций (веха M4): пишут Customer Care и администратор через hub_auth.
  hdu_org_email_domains: { client: 'none', auth: ['insert', 'delete'] },
  hdu_server_checks: { client: 'none', auth: IU },
  hdu_servers: { client: 'none', auth: IU },
  hdu_staff: { client: 'none', auth: IU },
  hdu_user_profiles: { client: 'org-people' },
  // Обращения (веха M2): клиент читает свою организацию, личные обращения коллег видит только администратор
  // клиента (это проверяет tickets-direct.test.ts). Удалить обращение, сообщение и событие не может никто.
  hdt_mentions: { client: 'none', app: IU },
  hdt_reply_drafts: { client: 'none', app: IUD },
  hdt_saved_filters: { client: 'none', app: IUD },
  hdt_tickets: { client: 'own-org', app: IU },
  hdt_ticket_line_transfers: { client: 'none', app: IU },
  hdt_ticket_presence: { client: 'none', app: IUD },
  hdt_ticket_reads: { client: 'none', app: IU },
  hdt_ticket_messages: { client: 'own-org', app: ['insert'] },
  hdt_ticket_events: { client: 'own-org', app: ['insert'] },
  hdt_ticket_watchers: { client: 'own-user', app: ['insert', 'delete'] },
  // Теги на обращении (веха M8): ставит и снимает сотрудник с правом записи и система, клиент не видит.
  hdt_ticket_tags: { client: 'none', app: ['insert', 'delete'] },
  hdt_attachments: { client: 'own-org', app: IUD },
  // Автоматизация (веха M8): правила ведёт администратор, выключает система (защита от зацикливания); срабатывания
  // пишет и удаляет только система. Клиент не видит ни правил, ни срабатываний.
  hdw_rules: { client: 'none', app: IUD },
  hdw_rule_runs: { client: 'none', app: ['insert', 'delete'] },
  // Макросы (веха M8): создаёт и меняет администратор, читают сотрудники, клиент и система не видят.
  hdw_macros: { client: 'none', app: IUD },
  // Исходящие вебхуки (веха M8): адреса ведёт администратор; секрет подписи читает только система; доставки ставит,
  // отправляет и удаляет только система. Клиент не видит ничего, из сотрудников читает только администратор.
  hdw_webhook_endpoints: { client: 'none', app: IUD },
  hdw_webhook_secrets: { client: 'none', app: IU },
  hdw_webhook_deliveries: { client: 'none', app: IUD },
  // Передача в разработку (веха M8): задачи и привязки читают сотрудники и система, пишут вторая линия, Customer
  // Care, администратор и система (статус из таск-менеджера). Удаляется только привязка. Клиент не видит ничего:
  // ему виден лишь статус обращения "В разработке". Привязку идеи (веха M7, миграция 0082) ставят только product и
  // admin, снять её нельзя; product ещё заводит строку задачи (tests/integration/isolation/dev-task-idea-links.test.ts).
  hdw_dev_tasks: { client: 'none', app: IU },
  hdw_dev_task_links: { client: 'none', app: ['insert', 'delete'] },
};
