-- Передача в разработку (ТЗ 7.9, FR-DEV-01..06; план M8, задачи 7 и 8, решения 12 и 13). Задача разработки это
-- ссылка на задачу в таск-менеджере Smartup: номер, адрес, название, статус. В ручном режиме (tracker = manual)
-- номер и ссылку вводит сотрудник и статус меняет он же; в режиме API (tracker = smartup) задачу создаёт портал,
-- статус приходит вебхуком или опросом. К одной задаче привязывается несколько обращений (FR-DEV-06), у обращения
-- не больше одной задачи. Клиент не видит ничего: ему виден только статус обращения "В разработке".

CREATE TABLE hdw_dev_tasks (
  dev_task_id        uuid        NOT NULL DEFAULT uuidv7(),
  tracker            text        NOT NULL,
  external_id        text        NOT NULL,
  url                text        NOT NULL,
  title              text        NOT NULL DEFAULT '',
  status             text        NOT NULL DEFAULT 'todo',
  version            text,
  synced_on          timestamptz,
  closed_notified_on timestamptz,
  created_by         text,
  created_on         timestamptz NOT NULL DEFAULT now(),
  modified_by        text,
  modified_on        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_dev_tasks_pk PRIMARY KEY (dev_task_id),
  CONSTRAINT hdw_dev_tasks_c1 CHECK (tracker IN ('manual', 'smartup')),
  CONSTRAINT hdw_dev_tasks_c2 CHECK (char_length(external_id) BETWEEN 1 AND 80 AND external_id ~ '^[^[:space:][:cntrl:]]+$'),
  -- Адрес показывается сотруднику ссылкой: только http(s). Схему и узел проверяет приложение при сохранении: вне
  -- localhost принимается один https. Другие схемы (javascript:, data:) база не принимает никогда.
  CONSTRAINT hdw_dev_tasks_c3 CHECK (url ~ '^https?://[^[:space:]]+$' AND char_length(url) <= 500),
  CONSTRAINT hdw_dev_tasks_c4 CHECK (char_length(title) <= 300 AND title = btrim(title)),
  CONSTRAINT hdw_dev_tasks_c5 CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  CONSTRAINT hdw_dev_tasks_c6 CHECK (version IS NULL OR (char_length(version) BETWEEN 1 AND 60 AND version = btrim(version)))
);

-- Одна строка на задачу таск-менеджера: номер без учёта регистра. Вторая передача с тем же номером привязывает
-- обращение к этой же строке (FR-DEV-06).
CREATE UNIQUE INDEX hdw_dev_tasks_u1 ON hdw_dev_tasks (tracker, lower(external_id));
-- Опрос таск-менеджера раз в 15 минут (FR-DEV-04): открытые задачи режима API, давно не сверенные первыми.
CREATE INDEX hdw_dev_tasks_i1 ON hdw_dev_tasks (synced_on NULLS FIRST) WHERE tracker = 'smartup' AND status IN ('todo', 'in_progress');

COMMENT ON TABLE hdw_dev_tasks IS 'Задачи разработки в таск-менеджере Smartup, привязанные к обращениям (FR-DEV-01..06). Клиент не видит';
COMMENT ON COLUMN hdw_dev_tasks.dev_task_id IS 'Идентификатор задачи в портале';
COMMENT ON COLUMN hdw_dev_tasks.tracker IS 'Откуда задача: manual (номер и ссылку ввёл сотрудник) или smartup (создана или найдена через API таск-менеджера)';
COMMENT ON COLUMN hdw_dev_tasks.external_id IS 'Номер задачи в таск-менеджере: как ввёл сотрудник или как вернул API';
COMMENT ON COLUMN hdw_dev_tasks.url IS 'Адрес задачи в таск-менеджере. Показывается сотруднику обычной внешней ссылкой, портал по нему не ходит';
COMMENT ON COLUMN hdw_dev_tasks.title IS 'Название задачи. Пусто: задача найдена по номеру через API, названия API не отдаёт';
COMMENT ON COLUMN hdw_dev_tasks.status IS 'Статус задачи: todo, in_progress, done, cancelled. В ручном режиме меняет сотрудник, в режиме API вебхук и опрос';
COMMENT ON COLUMN hdw_dev_tasks.version IS 'Версия Smartup с исправлением, когда она известна';
COMMENT ON COLUMN hdw_dev_tasks.synced_on IS 'Когда статус последний раз сверен с таск-менеджером. У ручных задач пусто';
COMMENT ON COLUMN hdw_dev_tasks.closed_notified_on IS 'Когда исполнителям привязанных обращений ушло напоминание о закрытии задачи (FR-DEV-05). Пусто: не уходило; очищается, если задачу открыли снова';
COMMENT ON COLUMN hdw_dev_tasks.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_dev_tasks.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_dev_tasks.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_dev_tasks.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_dev_tasks_stamp
  BEFORE INSERT OR UPDATE ON hdw_dev_tasks
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdw_dev_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_dev_tasks FORCE ROW LEVEL SECURITY;

-- Читают все сотрудники и система. Создают и меняют роли, которым разрешён статус "В разработке" (agent_l2, care,
-- admin: ТЗ 5.2), и система (вебхук и опрос таск-менеджера). Удаления нет: задача остаётся и без обращений.
CREATE POLICY hdw_dev_tasks_internal_select ON hdw_dev_tasks FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdw_dev_tasks_developer_insert ON hdw_dev_tasks FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin')));
CREATE POLICY hdw_dev_tasks_developer_update ON hdw_dev_tasks FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin')))
  WITH CHECK (app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin')));
COMMENT ON POLICY hdw_dev_tasks_internal_select ON hdw_dev_tasks IS 'Задачи разработки читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdw_dev_tasks_developer_insert ON hdw_dev_tasks IS 'Задачу заводят вторая линия, Customer Care, администратор и система';
COMMENT ON POLICY hdw_dev_tasks_developer_update ON hdw_dev_tasks IS 'Статус задачи меняют вторая линия, Customer Care, администратор и система (вебхук, опрос)';

GRANT SELECT, INSERT, UPDATE ON hdw_dev_tasks TO hub_app;

-- ---------------------------------------------------------------------------
-- hdw_dev_task_links: привязка обращения к задаче
-- ---------------------------------------------------------------------------
CREATE TABLE hdw_dev_task_links (
  org_id      uuid        NOT NULL,
  link_id     uuid        NOT NULL DEFAULT uuidv7(),
  dev_task_id uuid        NOT NULL,
  ticket_id   uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_dev_task_links_pk PRIMARY KEY (link_id),
  CONSTRAINT hdw_dev_task_links_f1 FOREIGN KEY (dev_task_id) REFERENCES hdw_dev_tasks (dev_task_id),
  -- Привязка обращения к организации (миграция 0037) меняет org_id обращения: связь идёт следом.
  CONSTRAINT hdw_dev_task_links_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  -- Индекс u1 покрывает внешний ключ задачи, u2 внешний ключ обращения.
  CONSTRAINT hdw_dev_task_links_u1 UNIQUE (dev_task_id, ticket_id),
  -- У обращения не больше одной задачи разработки.
  CONSTRAINT hdw_dev_task_links_u2 UNIQUE (ticket_id)
);

COMMENT ON TABLE hdw_dev_task_links IS 'Привязки обращений к задачам разработки (FR-DEV-06). Привязка идеи (веха M7) и известной проблемы (веха M5c) добавится колонками idea_id и known_problem_id вместе с их таблицами';
COMMENT ON COLUMN hdw_dev_task_links.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdw_dev_task_links.link_id IS 'Идентификатор привязки';
COMMENT ON COLUMN hdw_dev_task_links.dev_task_id IS 'Задача разработки';
COMMENT ON COLUMN hdw_dev_task_links.ticket_id IS 'Обращение, переданное в разработку';
COMMENT ON COLUMN hdw_dev_task_links.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_dev_task_links.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_dev_task_links.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_dev_task_links.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_dev_task_links_stamp
  BEFORE INSERT OR UPDATE ON hdw_dev_task_links
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdw_dev_task_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_dev_task_links FORCE ROW LEVEL SECURITY;

-- Привязку ставят и снимают те же роли, что ставят статус "В разработке". Система привязки только читает:
-- по ним она находит обращения закрытой задачи. Строка не меняется: права UPDATE нет.
CREATE POLICY hdw_dev_task_links_internal_select ON hdw_dev_task_links FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdw_dev_task_links_developer_insert ON hdw_dev_task_links FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin'));
CREATE POLICY hdw_dev_task_links_developer_delete ON hdw_dev_task_links FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin'));
COMMENT ON POLICY hdw_dev_task_links_internal_select ON hdw_dev_task_links IS 'Привязки читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdw_dev_task_links_developer_insert ON hdw_dev_task_links IS 'Обращение к задаче привязывают вторая линия, Customer Care и администратор';
COMMENT ON POLICY hdw_dev_task_links_developer_delete ON hdw_dev_task_links IS 'Привязку снимают вторая линия, Customer Care и администратор';

GRANT SELECT, INSERT, DELETE ON hdw_dev_task_links TO hub_app;

-- Событие истории "задача разработки": привязка, снятие привязки, закрытие задачи. Всегда внутреннее (ограничение
-- hdt_ticket_events_c3 его видимым клиенту не принимает).
ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound', 'tag', 'dev_task'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule (срабатывание правила или запуск макроса), merge, type, module, snooze, bound (привязка письма к организации), tag (тег поставлен или снят), dev_task (задача разработки привязана, отвязана или закрыта)';

-- Уведомление в портале: задача разработки закрыта, исполнителю пора проверить и сообщить клиенту (FR-DEV-05).
ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, закрытие задачи разработки и другие';
