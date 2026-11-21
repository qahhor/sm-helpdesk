-- Рабочее место агента, ответы и заметки (план M3, задача 8; ТЗ 10.5): черновики ответа, присутствие
-- "кто открыл и кто печатает" и упоминания коллег во внутренних заметках. Клиент не видит ни одной строки
-- (10.5: "К: нет"). Роль product читает присутствие, но не пишет черновики и упоминания.

-- Черновик ответа (FR-AG-21, UX-A-07): один на сотрудника и обращение, виден только автору.
CREATE TABLE hdt_reply_drafts (
  ticket_id   uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  body        text        NOT NULL,
  is_internal boolean     NOT NULL DEFAULT false,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_reply_drafts_pk PRIMARY KEY (ticket_id, user_id),
  CONSTRAINT hdt_reply_drafts_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdt_reply_drafts_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdt_reply_drafts_c1 CHECK (char_length(body) BETWEEN 1 AND 20000)
);

CREATE INDEX hdt_reply_drafts_i1 ON hdt_reply_drafts (user_id);

COMMENT ON TABLE hdt_reply_drafts IS 'Черновик ответа сотрудника: сохраняется на сервере, доступен с другого устройства, удаляется после отправки';
COMMENT ON COLUMN hdt_reply_drafts.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_reply_drafts.user_id IS 'Сотрудник, автор черновика';
COMMENT ON COLUMN hdt_reply_drafts.body IS 'Текст черновика';
COMMENT ON COLUMN hdt_reply_drafts.is_internal IS 'Режим поля: внутренняя заметка (true) или ответ клиенту (false)';
COMMENT ON COLUMN hdt_reply_drafts.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_reply_drafts.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_reply_drafts.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_reply_drafts.modified_on IS 'Когда черновик сохранён последний раз. Заполняет база';

CREATE TRIGGER t_hdt_reply_drafts_stamp
  BEFORE INSERT OR UPDATE ON hdt_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_reply_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_reply_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_reply_drafts_author ON hdt_reply_drafts FOR ALL TO hub_app
  USING (app.actor_type() = 'staff' AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'staff' AND user_id = app.user_uuid() AND app.staff_can_write_tickets());
COMMENT ON POLICY hdt_reply_drafts_author ON hdt_reply_drafts IS
  'Черновик видит и меняет только автор; сохраняет только роль, которая ведёт обращения';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdt_reply_drafts TO hub_app;

-- Присутствие (FR-AG-12, решение 10 плана M3): страница отмечается раз в 10 секунд, строка живёт 60 секунд.
CREATE TABLE hdt_ticket_presence (
  ticket_id   uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  mode        text        NOT NULL,
  expires_on  timestamptz NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_presence_pk PRIMARY KEY (ticket_id, user_id),
  CONSTRAINT hdt_ticket_presence_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdt_ticket_presence_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdt_ticket_presence_c1 CHECK (mode IN ('viewing', 'typing'))
);

CREATE INDEX hdt_ticket_presence_i1 ON hdt_ticket_presence (expires_on);

COMMENT ON TABLE hdt_ticket_presence IS 'Кто из сотрудников открыл обращение и кто печатает ответ. Строки старше минуты удаляет фоновая задача';
COMMENT ON COLUMN hdt_ticket_presence.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_presence.user_id IS 'Сотрудник';
COMMENT ON COLUMN hdt_ticket_presence.mode IS 'viewing: открыл обращение, typing: печатает ответ или заметку';
COMMENT ON COLUMN hdt_ticket_presence.expires_on IS 'До какого момента отметка действует';
COMMENT ON COLUMN hdt_ticket_presence.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_presence.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_ticket_presence.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_presence.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_presence_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_presence
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_ticket_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_presence FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_presence_internal_select ON hdt_ticket_presence FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_ticket_presence_own_insert ON hdt_ticket_presence FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND user_id = app.user_uuid());
CREATE POLICY hdt_ticket_presence_own_update ON hdt_ticket_presence FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'staff' AND user_id = app.user_uuid());
CREATE POLICY hdt_ticket_presence_system_delete ON hdt_ticket_presence FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdt_ticket_presence_internal_select ON hdt_ticket_presence IS 'Присутствие видят сотрудники и система';
COMMENT ON POLICY hdt_ticket_presence_own_insert ON hdt_ticket_presence IS 'Сотрудник отмечает только себя';
COMMENT ON POLICY hdt_ticket_presence_own_update ON hdt_ticket_presence IS 'Сотрудник продлевает только свою отметку';
COMMENT ON POLICY hdt_ticket_presence_system_delete ON hdt_ticket_presence IS 'Устаревшие отметки удаляет фоновая задача';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdt_ticket_presence TO hub_app;

-- Упоминания (UX-A-05): "@имя" во внутренней заметке. Уведомление упомянутому отправит M4.
CREATE TABLE hdt_mentions (
  message_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  read_on     timestamptz,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_mentions_pk PRIMARY KEY (message_id, user_id),
  CONSTRAINT hdt_mentions_f1 FOREIGN KEY (message_id) REFERENCES hdt_ticket_messages (message_id),
  CONSTRAINT hdt_mentions_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX hdt_mentions_i1 ON hdt_mentions (user_id, read_on);

COMMENT ON TABLE hdt_mentions IS 'Упоминание сотрудника во внутренней заметке';
COMMENT ON COLUMN hdt_mentions.message_id IS 'Внутренняя заметка с упоминанием';
COMMENT ON COLUMN hdt_mentions.user_id IS 'Упомянутый сотрудник';
COMMENT ON COLUMN hdt_mentions.read_on IS 'Когда упомянутый прочитал. Пусто: не прочитано';
COMMENT ON COLUMN hdt_mentions.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_mentions.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_mentions.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_mentions.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_mentions_stamp
  BEFORE INSERT OR UPDATE ON hdt_mentions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_mentions FORCE ROW LEVEL SECURITY;

-- Подзапросы к сообщениям идут под их политикой: клиенту внутренние заметки не видны.
CREATE POLICY hdt_mentions_select ON hdt_mentions FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'system'
    OR (app.actor_type() = 'staff' AND (
      user_id = app.user_uuid()
      OR EXISTS (SELECT 1 FROM hdt_ticket_messages m WHERE m.message_id = hdt_mentions.message_id AND m.author_id = app.user_uuid())))
  );
CREATE POLICY hdt_mentions_insert ON hdt_mentions FOR INSERT TO hub_app
  WITH CHECK (
    app.staff_can_write_tickets() AND app.actor_type() = 'staff'
    AND EXISTS (SELECT 1 FROM hdt_ticket_messages m
                 WHERE m.message_id = hdt_mentions.message_id AND m.author_id = app.user_uuid() AND m.is_internal)
  );
CREATE POLICY hdt_mentions_read ON hdt_mentions FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'staff' AND user_id = app.user_uuid());
COMMENT ON POLICY hdt_mentions_select ON hdt_mentions IS 'Упоминание видят упомянутый, автор заметки и система';
COMMENT ON POLICY hdt_mentions_insert ON hdt_mentions IS 'Упоминание создаёт автор внутренней заметки из роли, которая ведёт обращения';
COMMENT ON POLICY hdt_mentions_read ON hdt_mentions IS 'Отметку "прочитано" ставит упомянутый';

GRANT SELECT, INSERT, UPDATE ON hdt_mentions TO hub_app;
