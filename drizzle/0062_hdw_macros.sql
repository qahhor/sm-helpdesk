-- Макросы (FR-AG-15, UX-A-16, FR-ADM-10; план M8, задача 6, решение 7). Макрос это название и от одного до десяти
-- действий из набора правил автоматизации, проверенных схемой приложения. Создаёт и меняет макросы администратор
-- портала, читают сотрудники. Макрос выполняется от имени сотрудника и с его правами: обычными действиями
-- обращения, поэтому системе таблица не нужна. Клиент макросов не видит.

CREATE TABLE hdw_macros (
  macro_id    uuid        NOT NULL DEFAULT uuidv7(),
  name        text        NOT NULL,
  actions     jsonb       NOT NULL,
  is_enabled  boolean     NOT NULL DEFAULT true,
  order_no    integer     NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_macros_pk PRIMARY KEY (macro_id),
  CONSTRAINT hdw_macros_c1 CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  CONSTRAINT hdw_macros_c2 CHECK (jsonb_typeof(actions) = 'array' AND octet_length(actions::text) <= 40000)
);

-- Макросы по порядку: список администратора и меню на странице обращения.
CREATE INDEX hdw_macros_i1 ON hdw_macros (order_no);

COMMENT ON TABLE hdw_macros IS 'Макросы: несколько действий с обращением одним нажатием (FR-AG-15)';
COMMENT ON COLUMN hdw_macros.macro_id IS 'Идентификатор макроса';
COMMENT ON COLUMN hdw_macros.name IS 'Название макроса: его видят сотрудники в меню и в истории обращения';
COMMENT ON COLUMN hdw_macros.actions IS 'Действия по порядку: закрытый перечень, проверяет схема приложения';
COMMENT ON COLUMN hdw_macros.is_enabled IS 'Включён ли макрос. Выключенный не показывается в меню и не запускается';
COMMENT ON COLUMN hdw_macros.order_no IS 'Порядок в списке и в меню: меньшее раньше';
COMMENT ON COLUMN hdw_macros.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_macros.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_macros.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_macros.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_macros_stamp
  BEFORE INSERT OR UPDATE ON hdw_macros
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdw_macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_macros FORCE ROW LEVEL SECURITY;

CREATE POLICY hdw_macros_staff_select ON hdw_macros FOR SELECT TO hub_app USING (app.actor_type() = 'staff');
CREATE POLICY hdw_macros_admin_insert ON hdw_macros FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_macros_admin_update ON hdw_macros FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_macros_admin_delete ON hdw_macros FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hdw_macros_staff_select ON hdw_macros IS 'Макросы читают сотрудники: меню на странице обращения. Клиент и система не видят';
COMMENT ON POLICY hdw_macros_admin_insert ON hdw_macros IS 'Макрос создаёт администратор портала';
COMMENT ON POLICY hdw_macros_admin_update ON hdw_macros IS 'Макрос меняет администратор портала';
COMMENT ON POLICY hdw_macros_admin_delete ON hdw_macros IS 'Макрос удаляет администратор портала';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdw_macros TO hub_app;

-- Запуск макроса пишет в историю обращения запись вида rule с отметкой macro: новый вид события не нужен.
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule (срабатывание правила или запуск макроса), merge, type, module, snooze, bound (привязка письма к организации), tag (тег поставлен или снят)';
