-- Теги обращений (FR-AUTO-13; план M8, задача 1, решение 8). Справочник тегов лежит в модуле hdr, связь тега с
-- обращением в модуле hdt (docs/naming.md). Тег создаёт любой сотрудник, который ведёт обращения, прямо на обращении;
-- переименовать, перекрасить и удалить тег может администратор. Клиент не видит ни тегов, ни событий о них.

CREATE TABLE hdr_tags (
  tag_id      uuid        NOT NULL DEFAULT uuidv7(),
  name        text        NOT NULL,
  color       text        NOT NULL DEFAULT 'gray',
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdr_tags_pk PRIMARY KEY (tag_id),
  CONSTRAINT hdr_tags_c1 CHECK (char_length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
  CONSTRAINT hdr_tags_c2 CHECK (color IN ('gray', 'green', 'orange', 'purple', 'blue', 'teal', 'red', 'accent'))
);

-- Название уникально без учёта регистра: "Срочно" и "срочно" один тег.
CREATE UNIQUE INDEX hdr_tags_u1 ON hdr_tags (lower(name));

COMMENT ON TABLE hdr_tags IS 'Справочник тегов обращений (FR-AUTO-13)';
COMMENT ON COLUMN hdr_tags.tag_id IS 'Идентификатор тега';
COMMENT ON COLUMN hdr_tags.name IS 'Название тега: до 40 знаков, уникально без учёта регистра';
COMMENT ON COLUMN hdr_tags.color IS 'Код цвета из восьми токенов оформления: gray, green, orange, purple, blue, teal, red, accent';
COMMENT ON COLUMN hdr_tags.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdr_tags.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdr_tags.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdr_tags.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdr_tags_stamp
  BEFORE INSERT OR UPDATE ON hdr_tags
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdr_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdr_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY hdr_tags_internal_select ON hdr_tags FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdr_tags_writer_insert ON hdr_tags FOR INSERT TO hub_app WITH CHECK (app.staff_can_write_tickets());
CREATE POLICY hdr_tags_admin_update ON hdr_tags FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdr_tags_admin_delete ON hdr_tags FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hdr_tags_internal_select ON hdr_tags IS 'Теги читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdr_tags_writer_insert ON hdr_tags IS 'Тег создаёт сотрудник, который ведёт обращения, и система (правила автоматизации)';
COMMENT ON POLICY hdr_tags_admin_update ON hdr_tags IS 'Переименовать и перекрасить тег может только администратор портала';
COMMENT ON POLICY hdr_tags_admin_delete ON hdr_tags IS 'Удалить тег может только администратор портала';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdr_tags TO hub_app;

-- ---------------------------------------------------------------------------
-- hdt_ticket_tags: теги на обращении
-- ---------------------------------------------------------------------------
CREATE TABLE hdt_ticket_tags (
  org_id        uuid        NOT NULL,
  ticket_tag_id uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id     uuid        NOT NULL,
  tag_id        uuid        NOT NULL,
  added_by      uuid,
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_tags_pk PRIMARY KEY (ticket_tag_id),
  CONSTRAINT hdt_ticket_tags_u1 UNIQUE (ticket_id, tag_id),
  -- Привязка обращения к организации (миграция 0037) меняет org_id обращения: связь идёт следом.
  CONSTRAINT hdt_ticket_tags_f1 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  -- Удаление тега администратором снимает его со всех обращений.
  CONSTRAINT hdt_ticket_tags_f2 FOREIGN KEY (tag_id) REFERENCES hdr_tags (tag_id) ON DELETE CASCADE,
  CONSTRAINT hdt_ticket_tags_f3 FOREIGN KEY (added_by) REFERENCES auth."user" ("id")
);

-- Фильтр очереди по тегу: обращения тега. Обращение в уникальном ключе стоит первым и своего индекса не требует.
CREATE INDEX hdt_ticket_tags_i1 ON hdt_ticket_tags (tag_id, ticket_id);
CREATE INDEX hdt_ticket_tags_i2 ON hdt_ticket_tags (added_by) WHERE added_by IS NOT NULL;

COMMENT ON TABLE hdt_ticket_tags IS 'Теги на обращении (FR-AUTO-13). Клиент не видит';
COMMENT ON COLUMN hdt_ticket_tags.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdt_ticket_tags.ticket_tag_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdt_ticket_tags.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_tags.tag_id IS 'Тег из справочника hdr_tags';
COMMENT ON COLUMN hdt_ticket_tags.added_by IS 'Сотрудник, который поставил тег. Пусто: тег поставило правило автоматизации';
COMMENT ON COLUMN hdt_ticket_tags.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_tags.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_ticket_tags.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_tags.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_tags_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_tags
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_ticket_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_tags_internal_select ON hdt_ticket_tags FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_ticket_tags_writer_insert ON hdt_ticket_tags FOR INSERT TO hub_app
  WITH CHECK (app.staff_can_write_tickets() AND (app.actor_type() = 'system' OR added_by = app.user_uuid()));
CREATE POLICY hdt_ticket_tags_writer_delete ON hdt_ticket_tags FOR DELETE TO hub_app USING (app.staff_can_write_tickets());
COMMENT ON POLICY hdt_ticket_tags_internal_select ON hdt_ticket_tags IS 'Теги обращений читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdt_ticket_tags_writer_insert ON hdt_ticket_tags IS 'Тег ставит от своего имени сотрудник, который ведёт обращения, и система';
COMMENT ON POLICY hdt_ticket_tags_writer_delete ON hdt_ticket_tags IS 'Тег снимает сотрудник, который ведёт обращения, и система';

GRANT SELECT, INSERT, DELETE ON hdt_ticket_tags TO hub_app;

-- Событие истории "тег": всегда внутреннее (ограничение hdt_ticket_events_c3 его видимым клиенту не принимает).
ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound', 'tag'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule, merge, type, module, snooze, bound (привязка письма к организации), tag (тег поставлен или снят)';
