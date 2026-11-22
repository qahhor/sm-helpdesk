-- Сохранённые фильтры рабочего места (FR-AG-14, UX-A-09, 10.5; план M3, задача 5). Свои и общие: сотрудник видит
-- свои и общие, меняет и удаляет только свои. Клиент не видит ничего.

CREATE TABLE hdt_saved_filters (
  filter_id   uuid        NOT NULL DEFAULT uuidv7(),
  owner_id    uuid        NOT NULL,
  name        text        NOT NULL,
  query       jsonb       NOT NULL,
  is_shared   boolean     NOT NULL DEFAULT false,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_saved_filters_pk PRIMARY KEY (filter_id),
  CONSTRAINT hdt_saved_filters_f1 FOREIGN KEY (owner_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdt_saved_filters_c1 CHECK (length(name) BETWEEN 1 AND 80),
  CONSTRAINT hdt_saved_filters_c2 CHECK (jsonb_typeof(query) = 'object')
);

CREATE INDEX hdt_saved_filters_i1 ON hdt_saved_filters (owner_id);

COMMENT ON TABLE hdt_saved_filters IS 'Сохранённые списки рабочего места: очередь, сортировка и строка поиска под своим названием';
COMMENT ON COLUMN hdt_saved_filters.filter_id IS 'Идентификатор фильтра';
COMMENT ON COLUMN hdt_saved_filters.owner_id IS 'Сотрудник, который сохранил фильтр';
COMMENT ON COLUMN hdt_saved_filters.name IS 'Название списка';
COMMENT ON COLUMN hdt_saved_filters.query IS 'Условия: объект {queue, sort, q}';
COMMENT ON COLUMN hdt_saved_filters.is_shared IS 'Общий: виден всем сотрудникам';
COMMENT ON COLUMN hdt_saved_filters.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_saved_filters.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_saved_filters.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_saved_filters.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_saved_filters_stamp
  BEFORE INSERT OR UPDATE ON hdt_saved_filters
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_saved_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_saved_filters FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_saved_filters_staff_select ON hdt_saved_filters FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND (owner_id = app.user_uuid() OR is_shared));
CREATE POLICY hdt_saved_filters_staff_insert ON hdt_saved_filters FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND owner_id = app.user_uuid());
CREATE POLICY hdt_saved_filters_staff_update ON hdt_saved_filters FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND owner_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'staff' AND owner_id = app.user_uuid());
CREATE POLICY hdt_saved_filters_staff_delete ON hdt_saved_filters FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND owner_id = app.user_uuid());

GRANT SELECT, INSERT, UPDATE, DELETE ON hdt_saved_filters TO hub_app;
