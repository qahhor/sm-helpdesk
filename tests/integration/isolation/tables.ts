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
//   active-audience  объявления (план M5c, решение 24): клиент видит только начавшиеся объявления, действующие и
//               закончившиеся за 90 суток, с аудиторией "все", "модуль" или своим сервером, и только тексты сотрудника и
//               принятые переводы, и хотя бы одно.
//   shown-only  известные проблемы (план M5c, решение 2): клиент видит только проблемы с признаком показа, не закрытые
//               и не исправленные больше 30 суток назад, и только тексты сотрудника и принятые переводы, и хотя бы одну.
//
// agent: что видит и пишет актор agent (AI-сотрудник через сервер MCP, веха M8b) с действующим токеном.
//   none        по умолчанию (поле не задано): ни одной строки, записи нет;
//   via-view    представление для агента hda_agent_* (задача 2): строки только по его правилам;
//   own-token-insert  журнал вызовов: агент пишет строку только своим токеном и не читает ни одной;
//   reports     сводки: агент пишет основным токеном и не читает ни одной;
//   reference   справочник без данных клиентов (модули, календари, сроки SLA): политика "любой актор" отдаёт его и
//               агенту, все строки, изменить нельзя.
//   code-catalog  знания из кода (веха M8c): выводы о коде без данных клиентов. Что агент читает и меняет каким
//               токеном, задаёт таблица CODE_AGENT в registry.test.ts (независимая проверка, находка I5); остальное
//               закрыто, как у none. Утвердить не может (триггеры защиты), подробности в hda-code-access.test.ts.
//
// app, auth: какие изменения разрешены ролям hub_app и hub_auth. Тест сверяет с правами в базе,
// а остальные проверки берут отсюда, что должно быть закрыто (проверка main, Q2).

export type ClientAccess = 'none' | 'own-org' | 'org-people' | 'all' | 'own-user' | 'clients-audience' | 'published-or-own' | 'decided-only' | 'shown-only' | 'active-audience';
export type Write = 'insert' | 'update' | 'delete';
export type AgentAccess = 'none' | 'via-view' | 'own-token-insert' | 'reports' | 'reference' | 'code-catalog';
export type DomainObject = { client: ClientAccess; agent?: AgentAccess; app?: Write[]; auth?: Write[] };

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
  // Предложения разбора (план M5b, задача 7, решение 18): пишет система, решают сотрудники, которые ведут обращения,
  // клиент не видит ни одной строки (FR-TRI-06).
  hda_triage_suggestions: { client: 'none', app: IU },
  // Поля разбора, отключённые ночной задачей (FR-TRI-04): ставит система, включает обратно администратор портала.
  hda_triage_field_offs: { client: 'none', app: IU },
  // Машинный перевод сообщения клиента для сотрудника (план M5b, задача 9, решение 24): запрос ставит сотрудник,
  // текст пишет и строки старше 24 часов удаляет система, клиент не видит ни одной строки (FR-AG-11).
  hda_message_translations: { client: 'none', app: IUD },
  // Кандидаты в решения (веха M5c, задача 9): создаёт и склеивает система, решают сотрудники с правом черновика
  // решения; опустевшего после ночной склейки нерешённого кандидата удаляет система. Клиент не видит ни одной строки
  // (15.2 "Не найдено").
  hda_solution_candidates: { client: 'none', app: IUD },
  // Источники кандидата: добавляет и переносит при ночной склейке только система, строки не удаляются.
  hda_candidate_sources: { client: 'none', app: IU },
  // AI-сотрудник (веха M8b, задача 1). Токены читает администратор портала и система, выпускает и меняет
  // администратор (основной) и система (токен запуска, время вызова); истёкшие токены запуска удаляет ночная очистка.
  hda_agent_tokens: { client: 'none', app: IUD },
  // Журнал вызовов: пишет агент своим токеном и система, читает администратор, строки не меняются; ночная очистка
  // удаляет строки старше 365 суток.
  hda_agent_tool_calls: { client: 'none', agent: 'own-token-insert', app: ['insert', 'delete'] },
  // Сводки: пишет агент основным токеном, читают сотрудники, отметку "просмотрено" ставит сотрудник. Клиент не видит.
  hda_agent_reports: { client: 'none', agent: 'reports', app: IU },
  // Представления для агента (веха M8b, задача 2): строки только актору agent с действующим токеном, организации с
  // AI-обработкой, без "Неопознанных", без внутренних заметок сотрудников; токену запуска только его обращение.
  // Клиенту, сотруднику и системе пусто. Изменений нет: только чтение.
  hda_agent_tickets: { client: 'none', agent: 'via-view' },
  hda_agent_messages: { client: 'none', agent: 'via-view' },
  hda_agent_solutions: { client: 'none', agent: 'via-view' },
  hda_agent_candidates: { client: 'none', agent: 'via-view' },
  hda_agent_problems: { client: 'none', agent: 'via-view' },
  hda_agent_ideas: { client: 'none', agent: 'via-view' },
  // Сигнатуры ошибок для unsolved_signatures (задача 5, миграция 0112): без организаций, образец текста только если все
  // организации сигнатуры видны агенту.
  hda_agent_signatures: { client: 'none', agent: 'via-view' },
  // Всплески сигнатур (задача 8, миграция 0114): пишет система, проблему ставит роль ведения проблем, читают
  // сотрудники; агент читает их представлением с номерами только видимых ему обращений.
  hda_signature_spikes: { client: 'none', app: IU },
  hda_agent_spikes: { client: 'none', agent: 'via-view' },
  // Исходящая очередь событий для AI-сотрудника (задача 9, миграция 0115): только система, удаление ночной очисткой.
  hda_agent_events: { client: 'none', app: IUD },
  // Знания из кода (веха M8c, задача 1, миграция 0118): клиент не видит ни одной строки, система не читает записей,
  // шаблонов и заметок о модулях (только функцию сигнатуры). Читают agent_l2, care, admin; первая линия только
  // представление hda_code_checks. Удаления нет, кроме шаблона языка, который убирает сканирование или правка.
  hda_code_scans: { client: 'none', agent: 'code-catalog', app: IU },
  hda_code_error_entries: { client: 'none', agent: 'code-catalog', app: IU },
  hda_code_error_templates: { client: 'none', agent: 'code-catalog', app: IUD },
  hda_code_module_notes: { client: 'none', agent: 'code-catalog', app: IU },
  // Запросы анализа: агент таблицу не читает и не меняет; ответ отмечает функция app.hda_code_analysis_answer().
  hda_code_analysis_requests: { client: 'none', app: IU },
  // Первая линия: "что проверить" утверждённых записей. Клиенту, системе и агенту пусто, только чтение.
  hda_code_checks: { client: 'none' },
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
  // Отметки ресурсов сервера (план M9, задача 9, решение 17): одна строка на сервер, пишет и читает только система
  // (команда hub ops:host-mark и задача ops.watch). Клиент, сотрудник и агент не видят. Удаляет только ночная
  // очистка под системой отметки старше 7 суток (независимая проверка M9, M2; миграция 0128).
  hdc_ops_host_marks: { client: 'none', app: IUD },
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
  // Известные проблемы (веха M5c, задача 1). Клиент не читает таблиц проблем, текстов и сигнатур ни одной строки:
  // его вид только представление hdp_problems_public (решение 2). Пишут agent_l2, care, admin и система; первая линия
  // при привязке обращения только пересчитывает счётчики (t_hdp_problems_guard). Удаления проблем и текстов нет:
  // история остаётся; сигнатуру сотрудник убирает.
  hdp_problems: { client: 'none', app: IU },
  // Предложенные привязки черновика проблемы (веха M8b, решение 20): пишут AI-сотрудник к своему черновику и система,
  // читают сотрудники, снимает роль ведения проблем; клиент не видит ни одной строки.
  hdp_problem_proposals: { client: 'none', app: ['insert', 'delete'] },
  hdp_problem_translations: { client: 'none', app: IU },
  hdp_problem_signatures: { client: 'none', app: IUD },
  hdp_problems_public: { client: 'shown-only' },
  // Рассылки (веха M5c, задача 5): готовят и подтверждают agent_l2, care, admin, ход отправки ведёт система; удаления
  // нет. Клиент не читает ни одной строки: он видит только сообщение рассылки в своём обращении.
  hdp_broadcasts: { client: 'none', app: IU },
  // Объявления (веха M5c, задача 6): пишут care, admin и система (машинный перевод), удаления нет, досрочное окончание
  // это правка конца показа. Закрытие баннера только своё: клиент ставит его за себя, снять нельзя.
  hdp_announcements: { client: 'active-audience', app: IU },
  hdp_announcement_translations: { client: 'active-audience', app: IU },
  hdp_announcement_dismissals: { client: 'own-user', app: ['insert'] },
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
  // Справочники с политикой "любой актор": агент тоже читает их целиком (веха M8b, задача 1), данных клиентов в них нет.
  hdr_business_calendars: { client: 'all', agent: 'reference', app: IU },
  hdr_l1_playbooks: { client: 'none', app: IUD },
  hdr_product_modules: { client: 'all', agent: 'reference', app: IUD },
  hdr_reply_templates: { client: 'none', app: IU },
  hdr_sla_policies: { client: 'all', agent: 'reference', app: IU },
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
