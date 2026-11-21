-- Обращения клиентов: обращения, сообщения, история, подписки, вложения (ТЗ: 7.2, 10.2, 10.3, 10.5;
-- план M2, задача 1; решения 0026, 0027). Имена: docs/naming.md.
--
-- Кто что может (роль hub_app через withActor, роль hub_auth прав не имеет):
--   сотрудник и система: всё, кроме удаления обращений, сообщений и событий;
--   клиент: обращения своей организации с видимостью org, свои личные, а администратор клиента и личные
--   коллег. Дочерние строки наследуют видимость через EXISTS по hdt_tickets. Внутренние заметки, события
--   и вложения клиенту не видны никогда, вложения других людей только после проверки антивирусом.
-- Клиент меняет обращение только колонками, которые перечислены в триггере t_hdt_tickets_client_guard.

CREATE SEQUENCE hdt_tickets_number_sq START 1001;
COMMENT ON SEQUENCE hdt_tickets_number_sq IS 'Номера обращений SUP-<номер>. Начало 1001 (решение 0026), пропуски возможны';

-- ---------------------------------------------------------------------------
-- hdt_tickets: обращения
-- ---------------------------------------------------------------------------
CREATE TABLE hdt_tickets (
  ticket_id              uuid        NOT NULL DEFAULT uuidv7(),
  org_id                 uuid        NOT NULL,
  number                 bigint      NOT NULL DEFAULT nextval('hdt_tickets_number_sq'),
  author_id              uuid        NOT NULL,
  type                   text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'new',
  impact                 text        NOT NULL,
  priority               text        NOT NULL,
  priority_confirmed     boolean     NOT NULL DEFAULT false,
  visibility             text        NOT NULL DEFAULT 'org',
  title                  text        NOT NULL,
  description            text        NOT NULL,
  locale                 text        NOT NULL,
  module_id              uuid,
  context                jsonb,
  error_signature        text,
  source                 text        NOT NULL,
  assignee_id            uuid,
  queue                  text        NOT NULL DEFAULT 'l1',
  first_response_due_on  timestamptz,
  resolution_due_on      timestamptz,
  first_responded_on     timestamptz,
  resolved_on            timestamptz,
  sla_paused_on          timestamptz,
  sla_paused_seconds     integer     NOT NULL DEFAULT 0,
  resolution_type        text,
  solution_id            uuid,
  merged_into_id         uuid,
  known_problem_id       uuid,
  related_ticket_id      uuid,
  snoozed_until          timestamptz,
  ai_state               text        NOT NULL DEFAULT 'none',
  ai_reply_count         smallint    NOT NULL DEFAULT 0,
  ai_handoff_reason      text,
  last_client_message_on timestamptz,
  csat_score             smallint,
  csat_reason            text,
  csat_comment           text,
  closed_on              timestamptz,
  created_by             text,
  created_on             timestamptz NOT NULL DEFAULT now(),
  modified_by            text,
  modified_on            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_tickets_pk PRIMARY KEY (ticket_id),
  CONSTRAINT hdt_tickets_u1 UNIQUE (number),
  -- Пара для внешних ключей дочерних таблиц: строка дочерней таблицы принадлежит организации своего обращения.
  CONSTRAINT hdt_tickets_u2 UNIQUE (ticket_id, org_id),
  CONSTRAINT hdt_tickets_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdt_tickets_f2 FOREIGN KEY (author_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_tickets_f3 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdt_tickets_f4 FOREIGN KEY (assignee_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_tickets_f5 FOREIGN KEY (merged_into_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdt_tickets_f6 FOREIGN KEY (related_ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdt_tickets_c1 CHECK (type IN ('bug', 'question', 'service_request')),
  CONSTRAINT hdt_tickets_c2 CHECK (status IN ('new', 'in_progress', 'waiting_customer', 'in_development', 'resolved', 'closed')),
  CONSTRAINT hdt_tickets_c3 CHECK (impact IN ('blocker', 'major', 'minor', 'question')),
  CONSTRAINT hdt_tickets_c4 CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  CONSTRAINT hdt_tickets_c5 CHECK (visibility IN ('org', 'private')),
  CONSTRAINT hdt_tickets_c6 CHECK (queue IN ('l1', 'l2', 'care')),
  CONSTRAINT hdt_tickets_c7 CHECK (ai_state IN ('none', 'active', 'handed_off', 'resolved_by_ai')),
  CONSTRAINT hdt_tickets_c8 CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5),
  CONSTRAINT hdt_tickets_c9 CHECK (csat_reason IS NULL OR csat_reason IN ('slow', 'not_solved', 'unclear', 'other')),
  CONSTRAINT hdt_tickets_c10 CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT hdt_tickets_c11 CHECK (length(description) BETWEEN 1 AND 20000),
  CONSTRAINT hdt_tickets_c12 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdt_tickets_c13 CHECK (csat_comment IS NULL OR length(csat_comment) <= 2000)
);

-- Последовательность принадлежит колонке: удаляется вместе с таблицей.
ALTER SEQUENCE hdt_tickets_number_sq OWNED BY hdt_tickets.number;

CREATE INDEX hdt_tickets_i1 ON hdt_tickets (org_id, status);
CREATE INDEX hdt_tickets_i2 ON hdt_tickets (org_id, modified_on DESC, ticket_id DESC);
CREATE INDEX hdt_tickets_i3 ON hdt_tickets USING gin (title gin_trgm_ops);
CREATE INDEX hdt_tickets_i4 ON hdt_tickets USING gin (description gin_trgm_ops);
CREATE INDEX hdt_tickets_i5 ON hdt_tickets (author_id);
CREATE INDEX hdt_tickets_i6 ON hdt_tickets (module_id);
CREATE INDEX hdt_tickets_i7 ON hdt_tickets (assignee_id, status);
CREATE INDEX hdt_tickets_i8 ON hdt_tickets (resolution_due_on);
CREATE INDEX hdt_tickets_i9 ON hdt_tickets (error_signature);
CREATE INDEX hdt_tickets_i10 ON hdt_tickets (merged_into_id);
CREATE INDEX hdt_tickets_i11 ON hdt_tickets (related_ticket_id);

COMMENT ON TABLE hdt_tickets IS 'Обращения клиентов в поддержку (FR-TK-01..17). Номер SUP-<number>';
COMMENT ON COLUMN hdt_tickets.ticket_id IS 'Идентификатор обращения';
COMMENT ON COLUMN hdt_tickets.org_id IS 'Организация клиента. Берётся из актора, не из запроса';
COMMENT ON COLUMN hdt_tickets.number IS 'Номер для людей: SUP-<number>';
COMMENT ON COLUMN hdt_tickets.author_id IS 'Кто создал обращение';
COMMENT ON COLUMN hdt_tickets.type IS 'Тип: bug, question, service_request (FR-TK-01)';
COMMENT ON COLUMN hdt_tickets.status IS 'Статус: new, in_progress, waiting_customer, in_development, resolved, closed. Переходы проверяет сервис (раздел 7.2)';
COMMENT ON COLUMN hdt_tickets.impact IS 'Влияние на работу: blocker, major, minor, question (FR-TK-03)';
COMMENT ON COLUMN hdt_tickets.priority IS 'Приоритет p1..p4. Предварительный выводится из влияния';
COMMENT ON COLUMN hdt_tickets.priority_confirmed IS 'Сотрудник подтвердил приоритет';
COMMENT ON COLUMN hdt_tickets.visibility IS 'Кто видит: org (вся организация) или private (автор и администратор клиента)';
COMMENT ON COLUMN hdt_tickets.title IS 'Тема: из первых слов описания или своя';
COMMENT ON COLUMN hdt_tickets.description IS 'Описание проблемы, Markdown без HTML';
COMMENT ON COLUMN hdt_tickets.locale IS 'Язык, на котором написано обращение: ru, uz, en';
COMMENT ON COLUMN hdt_tickets.module_id IS 'Модуль Smartup из справочника';
COMMENT ON COLUMN hdt_tickets.context IS 'Контекст из Smartup: экран, версия, платформа, код и текст ошибки (веха M6)';
COMMENT ON COLUMN hdt_tickets.error_signature IS 'Сигнатура ошибки (веха M5)';
COMMENT ON COLUMN hdt_tickets.source IS 'Откуда пришло: portal, widget_web, widget_mobile, email, staff. Перечень только в коде';
COMMENT ON COLUMN hdt_tickets.assignee_id IS 'Исполнитель-сотрудник (веха M3)';
COMMENT ON COLUMN hdt_tickets.queue IS 'Линия: l1, l2, care';
COMMENT ON COLUMN hdt_tickets.first_response_due_on IS 'Срок первого ответа (веха M3)';
COMMENT ON COLUMN hdt_tickets.resolution_due_on IS 'Срок решения (веха M3)';
COMMENT ON COLUMN hdt_tickets.first_responded_on IS 'Когда дан первый ответ (веха M3)';
COMMENT ON COLUMN hdt_tickets.resolved_on IS 'Когда обращение решено последний раз';
COMMENT ON COLUMN hdt_tickets.sla_paused_on IS 'С какого момента срок решения на паузе (веха M3)';
COMMENT ON COLUMN hdt_tickets.sla_paused_seconds IS 'Сколько секунд срок решения стоял на паузе (веха M3)';
COMMENT ON COLUMN hdt_tickets.resolution_type IS 'Как решено (веха M3)';
COMMENT ON COLUMN hdt_tickets.solution_id IS 'Решение из базы решений (веха M5)';
COMMENT ON COLUMN hdt_tickets.merged_into_id IS 'В какое обращение объединено (веха M3)';
COMMENT ON COLUMN hdt_tickets.known_problem_id IS 'Известная проблема (веха M5c)';
COMMENT ON COLUMN hdt_tickets.related_ticket_id IS 'Прежнее обращение, по теме которого создано это (FR-TK-12, решение 0026)';
COMMENT ON COLUMN hdt_tickets.snoozed_until IS 'Отложено сотрудником до (веха M3)';
COMMENT ON COLUMN hdt_tickets.ai_state IS 'Состояние AI-помощника: none, active, handed_off, resolved_by_ai (веха M5b)';
COMMENT ON COLUMN hdt_tickets.ai_reply_count IS 'Сколько ответов дал AI-помощник (веха M5b)';
COMMENT ON COLUMN hdt_tickets.ai_handoff_reason IS 'Почему AI-помощник передал обращение (веха M5b)';
COMMENT ON COLUMN hdt_tickets.last_client_message_on IS 'Когда клиент написал последний раз';
COMMENT ON COLUMN hdt_tickets.csat_score IS 'Оценка клиента 1..5 после закрытия (FR-TK-11)';
COMMENT ON COLUMN hdt_tickets.csat_reason IS 'Причина низкой оценки: slow, not_solved, unclear, other (решение 0026)';
COMMENT ON COLUMN hdt_tickets.csat_comment IS 'Комментарий к оценке';
COMMENT ON COLUMN hdt_tickets.closed_on IS 'Когда обращение закрыто последний раз. От него считается срок повторного открытия';
COMMENT ON COLUMN hdt_tickets.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_tickets.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_tickets.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_tickets.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_tickets_stamp
  BEFORE INSERT OR UPDATE ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Клиент создаёт обращение только новым, на первой линии и без полей сотрудника, а меняет только
-- колонки своих именованных операций (раздел 10.3). Видимость меняют автор и администратор клиента.
CREATE FUNCTION app.hdt_tickets_client_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  allowed CONSTANT text[] := ARRAY['status', 'visibility', 'closed_on', 'resolved_on', 'last_client_message_on',
                                   'csat_score', 'csat_reason', 'csat_comment', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() <> 'client' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'new' OR NEW.queue <> 'l1' OR NEW.assignee_id IS NOT NULL OR NEW.priority_confirmed
       OR NEW.ai_state <> 'none' OR NEW.ai_reply_count <> 0 OR NEW.csat_score IS NOT NULL OR NEW.closed_on IS NOT NULL
       OR NEW.resolved_on IS NOT NULL OR NEW.merged_into_id IS NOT NULL OR NEW.solution_id IS NOT NULL
       OR NEW.first_response_due_on IS NOT NULL OR NEW.resolution_due_on IS NOT NULL THEN
      RAISE EXCEPTION 'Обращение: клиент создаёт только новое обращение без полей сотрудника, остальное нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Обращение: клиенту менять эти поля нельзя' USING ERRCODE = '42501';
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility AND NOT (OLD.author_id = app.user_uuid() OR app.org_role() = 'client_admin') THEN
    RAISE EXCEPTION 'Обращение: видимость меняют только автор и администратор клиента, остальным нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_client_guard() IS 'Триггер: клиент создаёт новое обращение без полей сотрудника и меняет только колонки своих операций';

CREATE TRIGGER t_hdt_tickets_client_guard
  BEFORE INSERT OR UPDATE ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdt_tickets_client_guard();

ALTER TABLE hdt_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_tickets FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_tickets_internal_all ON hdt_tickets FOR ALL TO hub_app
  USING (app.is_internal()) WITH CHECK (app.is_internal());
CREATE POLICY hdt_tickets_client_select ON hdt_tickets FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client'
    AND org_id = app.org_id()
    AND (visibility = 'org' OR author_id = app.user_uuid() OR app.org_role() = 'client_admin')
  );
CREATE POLICY hdt_tickets_client_insert ON hdt_tickets FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'client' AND org_id = app.org_id() AND author_id = app.user_uuid());
CREATE POLICY hdt_tickets_client_update ON hdt_tickets FOR UPDATE TO hub_app
  USING (
    app.actor_type() = 'client'
    AND org_id = app.org_id()
    AND (visibility = 'org' OR author_id = app.user_uuid() OR app.org_role() = 'client_admin')
  )
  WITH CHECK (app.actor_type() = 'client' AND org_id = app.org_id());

GRANT SELECT, INSERT, UPDATE ON hdt_tickets TO hub_app;
GRANT USAGE ON SEQUENCE hdt_tickets_number_sq TO hub_app;

-- ---------------------------------------------------------------------------
-- hdt_ticket_messages: переписка и внутренние заметки
-- ---------------------------------------------------------------------------
CREATE TABLE hdt_ticket_messages (
  message_id       uuid        NOT NULL DEFAULT uuidv7(),
  org_id           uuid        NOT NULL,
  ticket_id        uuid        NOT NULL,
  author_id        uuid,
  author_type      text        NOT NULL,
  body             text        NOT NULL,
  is_internal      boolean     NOT NULL DEFAULT false,
  source           text        NOT NULL DEFAULT 'portal',
  email_message_id text,
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_messages_pk PRIMARY KEY (message_id),
  CONSTRAINT hdt_ticket_messages_f1 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id),
  CONSTRAINT hdt_ticket_messages_f2 FOREIGN KEY (author_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_ticket_messages_c1 CHECK (author_type IN ('client', 'staff', 'system', 'ai', 'agent')),
  CONSTRAINT hdt_ticket_messages_c2 CHECK (length(body) BETWEEN 1 AND 20000),
  -- Клиент и сотрудник пишут от своего имени, системное сообщение без автора.
  CONSTRAINT hdt_ticket_messages_c3 CHECK (author_type NOT IN ('client', 'staff') OR author_id IS NOT NULL)
);

CREATE INDEX hdt_ticket_messages_i1 ON hdt_ticket_messages (ticket_id, created_on);
CREATE INDEX hdt_ticket_messages_i2 ON hdt_ticket_messages (author_id);

COMMENT ON TABLE hdt_ticket_messages IS 'Сообщения обращения: ответы клиента и сотрудников, системные, AI-помощника, внутренние заметки';
COMMENT ON COLUMN hdt_ticket_messages.message_id IS 'Идентификатор сообщения';
COMMENT ON COLUMN hdt_ticket_messages.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdt_ticket_messages.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_messages.author_id IS 'Автор. Пусто у системных сообщений';
COMMENT ON COLUMN hdt_ticket_messages.author_type IS 'Кто написал: client, staff, system, ai (помощник), agent (AI-сотрудник)';
COMMENT ON COLUMN hdt_ticket_messages.body IS 'Текст, Markdown без HTML';
COMMENT ON COLUMN hdt_ticket_messages.is_internal IS 'Внутренняя заметка: клиенту не видна никогда';
COMMENT ON COLUMN hdt_ticket_messages.source IS 'Откуда пришло: те же значения, что hdt_tickets.source';
COMMENT ON COLUMN hdt_ticket_messages.email_message_id IS 'Идентификатор письма, если сообщение пришло почтой (веха M4)';
COMMENT ON COLUMN hdt_ticket_messages.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_messages.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_ticket_messages.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_messages.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_messages_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_messages_internal_all ON hdt_ticket_messages FOR ALL TO hub_app
  USING (app.is_internal()) WITH CHECK (app.is_internal());
-- К hdt_tickets в подзапросе применяется её политика: невидимое обращение не даёт ни одного сообщения.
CREATE POLICY hdt_ticket_messages_client_select ON hdt_ticket_messages FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client' AND NOT is_internal
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_messages.ticket_id)
  );
CREATE POLICY hdt_ticket_messages_client_insert ON hdt_ticket_messages FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client' AND NOT is_internal AND author_type = 'client'
    AND author_id = app.user_uuid() AND org_id = app.org_id()
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_messages.ticket_id)
  );

GRANT SELECT, INSERT ON hdt_ticket_messages TO hub_app;

-- ---------------------------------------------------------------------------
-- hdt_ticket_events: история обращения
-- ---------------------------------------------------------------------------
CREATE TABLE hdt_ticket_events (
  event_id    uuid        NOT NULL DEFAULT uuidv7(),
  org_id      uuid        NOT NULL,
  ticket_id   uuid        NOT NULL,
  kind        text        NOT NULL,
  actor_type  text        NOT NULL,
  actor_id    uuid,
  payload     jsonb       NOT NULL DEFAULT '{}',
  is_internal boolean     NOT NULL DEFAULT false,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_events_pk PRIMARY KEY (event_id),
  CONSTRAINT hdt_ticket_events_f1 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id),
  CONSTRAINT hdt_ticket_events_f2 FOREIGN KEY (actor_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_ticket_events_c1 CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge')),
  CONSTRAINT hdt_ticket_events_c2 CHECK (actor_type IN ('client', 'staff', 'system', 'ai', 'agent'))
);

CREATE INDEX hdt_ticket_events_i1 ON hdt_ticket_events (ticket_id, created_on);
CREATE INDEX hdt_ticket_events_i2 ON hdt_ticket_events (actor_id);

COMMENT ON TABLE hdt_ticket_events IS 'История обращения: создание, статусы, видимость, оценка, а с вехи M3 приоритет, исполнитель, линия, сроки';
COMMENT ON COLUMN hdt_ticket_events.event_id IS 'Идентификатор события';
COMMENT ON COLUMN hdt_ticket_events.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdt_ticket_events.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue, due, rule, merge';
COMMENT ON COLUMN hdt_ticket_events.actor_type IS 'Кто сделал: client, staff, system, ai, agent';
COMMENT ON COLUMN hdt_ticket_events.actor_id IS 'Пользователь, если это человек';
COMMENT ON COLUMN hdt_ticket_events.payload IS 'Подробности: from, to. Без текста сообщений';
COMMENT ON COLUMN hdt_ticket_events.is_internal IS 'Внутреннее событие: клиенту не видно';
COMMENT ON COLUMN hdt_ticket_events.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_events.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_ticket_events.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_events.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_events_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_events
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_events FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_events_internal_all ON hdt_ticket_events FOR ALL TO hub_app
  USING (app.is_internal()) WITH CHECK (app.is_internal());
CREATE POLICY hdt_ticket_events_client_select ON hdt_ticket_events FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client' AND NOT is_internal
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_events.ticket_id)
  );
CREATE POLICY hdt_ticket_events_client_insert ON hdt_ticket_events FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client' AND NOT is_internal AND kind IN ('created', 'status', 'visibility', 'rated')
    AND actor_type = 'client' AND actor_id = app.user_uuid() AND org_id = app.org_id()
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_events.ticket_id)
  );

GRANT SELECT, INSERT ON hdt_ticket_events TO hub_app;

-- ---------------------------------------------------------------------------
-- hdt_ticket_watchers: подписки на обращение
-- ---------------------------------------------------------------------------
CREATE TABLE hdt_ticket_watchers (
  watcher_id  uuid        NOT NULL DEFAULT uuidv7(),
  org_id      uuid        NOT NULL,
  ticket_id   uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  source      text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_watchers_pk PRIMARY KEY (watcher_id),
  CONSTRAINT hdt_ticket_watchers_u1 UNIQUE (ticket_id, user_id),
  CONSTRAINT hdt_ticket_watchers_f1 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id),
  CONSTRAINT hdt_ticket_watchers_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_ticket_watchers_c1 CHECK (source IN ('author', 'manual', 'staff'))
);

CREATE INDEX hdt_ticket_watchers_i1 ON hdt_ticket_watchers (user_id);

COMMENT ON TABLE hdt_ticket_watchers IS 'Подписки на обращение (FR-TK-09). Письма по подпискам с вехи M4';
COMMENT ON COLUMN hdt_ticket_watchers.watcher_id IS 'Идентификатор подписки';
COMMENT ON COLUMN hdt_ticket_watchers.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdt_ticket_watchers.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_watchers.user_id IS 'Подписчик';
COMMENT ON COLUMN hdt_ticket_watchers.source IS 'Почему подписан: author (автор), manual (сам), staff (подписал сотрудник)';
COMMENT ON COLUMN hdt_ticket_watchers.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_watchers.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_ticket_watchers.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_watchers.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_watchers_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_watchers
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_ticket_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_watchers FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_watchers_internal_all ON hdt_ticket_watchers FOR ALL TO hub_app
  USING (app.is_internal()) WITH CHECK (app.is_internal());
-- Клиент видит только свои подписки и только в видимых ему обращениях (уже, чем строка 10.5, решение 0026).
CREATE POLICY hdt_ticket_watchers_client_select ON hdt_ticket_watchers FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client' AND user_id = app.user_uuid()
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_watchers.ticket_id)
  );
CREATE POLICY hdt_ticket_watchers_client_insert ON hdt_ticket_watchers FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client' AND user_id = app.user_uuid() AND org_id = app.org_id()
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_watchers.ticket_id)
  );
CREATE POLICY hdt_ticket_watchers_client_delete ON hdt_ticket_watchers FOR DELETE TO hub_app
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());

GRANT SELECT, INSERT, DELETE ON hdt_ticket_watchers TO hub_app;

-- ---------------------------------------------------------------------------
-- hdt_attachments: вложения
-- ---------------------------------------------------------------------------
CREATE TABLE hdt_attachments (
  attachment_id  uuid        NOT NULL DEFAULT uuidv7(),
  org_id         uuid        NOT NULL,
  ticket_id      uuid,
  message_id     uuid,
  uploader_id    uuid        NOT NULL,
  storage_key    text        NOT NULL,
  file_name      text        NOT NULL,
  mime           text        NOT NULL,
  size           bigint      NOT NULL,
  sha256         text,
  scan_status    text        NOT NULL DEFAULT 'pending',
  scan_signature text,
  detected_type  text,
  is_internal    boolean     NOT NULL DEFAULT false,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_attachments_pk PRIMARY KEY (attachment_id),
  CONSTRAINT hdt_attachments_u1 UNIQUE (storage_key),
  CONSTRAINT hdt_attachments_f1 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id),
  CONSTRAINT hdt_attachments_f2 FOREIGN KEY (message_id) REFERENCES hdt_ticket_messages (message_id),
  CONSTRAINT hdt_attachments_f3 FOREIGN KEY (uploader_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_attachments_f4 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdt_attachments_c1 CHECK (scan_status IN ('pending', 'clean', 'infected', 'rejected')),
  CONSTRAINT hdt_attachments_c2 CHECK (size > 0 AND size <= 52428800),
  CONSTRAINT hdt_attachments_c3 CHECK (length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT hdt_attachments_c4 CHECK (message_id IS NULL OR ticket_id IS NOT NULL),
  CONSTRAINT hdt_attachments_c5 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX hdt_attachments_i1 ON hdt_attachments (ticket_id);
CREATE INDEX hdt_attachments_i2 ON hdt_attachments (message_id);
CREATE INDEX hdt_attachments_i3 ON hdt_attachments (uploader_id) WHERE ticket_id IS NULL;
CREATE INDEX hdt_attachments_i4 ON hdt_attachments (scan_status, created_on) WHERE scan_status = 'pending';
CREATE INDEX hdt_attachments_i5 ON hdt_attachments (org_id);

COMMENT ON TABLE hdt_attachments IS 'Вложения обращений. Файл лежит в хранилище, скачать можно только после проверки антивирусом (FR-TK-13, решение 0027)';
COMMENT ON COLUMN hdt_attachments.attachment_id IS 'Идентификатор вложения';
COMMENT ON COLUMN hdt_attachments.org_id IS 'Организация загрузившего (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdt_attachments.ticket_id IS 'Обращение. Пусто, пока загрузка не прикреплена отправкой формы';
COMMENT ON COLUMN hdt_attachments.message_id IS 'Сообщение. Пусто у вложений описания обращения';
COMMENT ON COLUMN hdt_attachments.uploader_id IS 'Кто загрузил';
COMMENT ON COLUMN hdt_attachments.storage_key IS 'Ключ в хранилище: quarantine/<id> до проверки, files/<org>/<id> после. Задаёт портал';
COMMENT ON COLUMN hdt_attachments.file_name IS 'Имя файла от пользователя. Как путь не используется';
COMMENT ON COLUMN hdt_attachments.mime IS 'Заявленный тип файла';
COMMENT ON COLUMN hdt_attachments.size IS 'Размер в байтах';
COMMENT ON COLUMN hdt_attachments.sha256 IS 'Хеш содержимого после проверки';
COMMENT ON COLUMN hdt_attachments.scan_status IS 'Проверка: pending, clean, infected, rejected (тип не совпал или запрещён)';
COMMENT ON COLUMN hdt_attachments.scan_signature IS 'Что нашёл антивирус или почему файл отклонён';
COMMENT ON COLUMN hdt_attachments.detected_type IS 'Настоящий тип по первым байтам файла';
COMMENT ON COLUMN hdt_attachments.is_internal IS 'Вложение внутренней заметки: клиенту не видно';
COMMENT ON COLUMN hdt_attachments.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_attachments.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_attachments.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_attachments.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_attachments_stamp
  BEFORE INSERT OR UPDATE ON hdt_attachments
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Клиент только прикрепляет свою загрузку к обращению или сообщению. Проверку антивирусом, ключ
-- хранилища и остальные поля меняет система.
CREATE FUNCTION app.hdt_attachments_client_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  allowed CONSTANT text[] := ARRAY['ticket_id', 'message_id', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() = 'client'
     AND ((to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)
          OR (OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id)
          OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id)) THEN
    RAISE EXCEPTION 'Вложение: клиент только прикрепляет свою загрузку, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_attachments_client_guard() IS 'Триггер: клиент только прикрепляет свою загрузку к обращению или сообщению';

CREATE TRIGGER t_hdt_attachments_client_guard
  BEFORE UPDATE ON hdt_attachments
  FOR EACH ROW EXECUTE FUNCTION app.hdt_attachments_client_guard();

ALTER TABLE hdt_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_attachments FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_attachments_internal_all ON hdt_attachments FOR ALL TO hub_app
  USING (app.is_internal()) WITH CHECK (app.is_internal());
-- Клиент видит: свои загрузки в любом состоянии и чужие только после проверки, в видимых ему обращениях.
CREATE POLICY hdt_attachments_client_select ON hdt_attachments FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client' AND org_id = app.org_id() AND NOT is_internal
    AND (
      (uploader_id = app.user_uuid() AND (ticket_id IS NULL OR EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_attachments.ticket_id)))
      OR (ticket_id IS NOT NULL AND scan_status = 'clean' AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_attachments.ticket_id))
    )
  );
CREATE POLICY hdt_attachments_client_insert ON hdt_attachments FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid()
    AND ticket_id IS NULL AND message_id IS NULL AND scan_status = 'pending' AND NOT is_internal
  );
CREATE POLICY hdt_attachments_client_update ON hdt_attachments FOR UPDATE TO hub_app
  USING (app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid())
  WITH CHECK (
    app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid()
    AND (ticket_id IS NULL OR EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_attachments.ticket_id))
  );

GRANT SELECT, INSERT, UPDATE ON hdt_attachments TO hub_app;
