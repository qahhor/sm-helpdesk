-- Привязка идеи к задаче разработки (ТЗ FR-IDEA-12, FR-DEV-06; план M7, задача 9, решение 18). Выбранная идея
-- передаётся в разработку тем же адаптером hdw, что и обращения, и привязывается к задаче строкой той же таблицы
-- hdw_dev_task_links: у строки ровно одно из обращения (ticket_id с организацией) или идеи (idea_id). У идеи не больше
-- одной задачи; к одной задаче привязываются несколько обращений и идей.
--
-- Номер миграции: план отдавал этой привязке 0080, но 0081 (уведомления по идеям) уже применена на развёрнутых базах,
-- а скрипт миграций идёт по номерам: файл 0080 после 0081 не применился бы. Поэтому 0082, номер 0080 не занят.
--
-- Политики. Защита привязок обращений не меняется ни в одном случае: прежние политики вставки и удаления только
-- сужаются условием ticket_id IS NOT NULL (у привязки обращения ticket_id есть всегда, проверка c1), то есть для
-- строк обращений они пропускают ровно то же, что и раньше. Привязку идеи ставят только модераторы идей (product,
-- admin), как и статус идеи "В разработке" (решение 18); снимать её не может никто: у идеи одна задача навсегда.
-- Чтение не меняется: все сотрудники и система, клиент не видит ничего. Роль product получает право завести строку
-- задачи разработки (новая задача для идеи); менять статус задачи она не может, это по-прежнему вторая линия,
-- Customer Care, администратор и система.

ALTER TABLE hdw_dev_task_links ADD COLUMN idea_id uuid;
ALTER TABLE hdw_dev_task_links ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE hdw_dev_task_links ALTER COLUMN ticket_id DROP NOT NULL;
-- Идеи не удаляются (у hdi_ideas нет права DELETE): ключ без каскада.
ALTER TABLE hdw_dev_task_links ADD CONSTRAINT hdw_dev_task_links_f3 FOREIGN KEY (idea_id) REFERENCES hdi_ideas (idea_id);
-- Ровно одно: обращение с организацией или идея без организации (идея общая для клиентов всех организаций). Внешний
-- ключ f2 (ticket_id, org_id) с пустыми значениями не проверяется, поэтому у привязки обращения оба обязательны здесь.
ALTER TABLE hdw_dev_task_links ADD CONSTRAINT hdw_dev_task_links_c1 CHECK (
  (ticket_id IS NOT NULL AND org_id IS NOT NULL AND idea_id IS NULL)
  OR (ticket_id IS NULL AND org_id IS NULL AND idea_id IS NOT NULL)
);
-- У идеи не больше одной задачи разработки (решение 18). Индекс покрывает и внешний ключ f3.
CREATE UNIQUE INDEX hdw_dev_task_links_u3 ON hdw_dev_task_links (idea_id) WHERE idea_id IS NOT NULL;

COMMENT ON TABLE hdw_dev_task_links IS 'Привязки обращений и идей к задачам разработки (FR-DEV-06, FR-IDEA-12): в строке ровно одно из обращения или идеи. Привязка известной проблемы (веха M5c) добавится колонкой known_problem_id вместе с её таблицей';
COMMENT ON COLUMN hdw_dev_task_links.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу). У привязки идеи пусто: идея общая для клиентов всех организаций';
COMMENT ON COLUMN hdw_dev_task_links.ticket_id IS 'Обращение, переданное в разработку. У привязки идеи пусто';
COMMENT ON COLUMN hdw_dev_task_links.idea_id IS 'Идея, переданная в разработку (план M7, решение 18). У привязки обращения пусто';
COMMENT ON CONSTRAINT hdw_dev_task_links_c1 ON hdw_dev_task_links IS 'Ровно одно из обращения (с организацией) или идеи (без организации)';
COMMENT ON INDEX hdw_dev_task_links_u3 IS 'У идеи не больше одной задачи разработки (план M7, решение 18)';

-- Прежние политики сужаются только для строк без обращения: для привязок обращений условие то же (см. шапку).
ALTER POLICY hdw_dev_task_links_developer_insert ON hdw_dev_task_links
  WITH CHECK (ticket_id IS NOT NULL AND app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin'));
ALTER POLICY hdw_dev_task_links_developer_delete ON hdw_dev_task_links
  USING (ticket_id IS NOT NULL AND app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin'));
COMMENT ON POLICY hdw_dev_task_links_developer_insert ON hdw_dev_task_links IS 'Обращение к задаче привязывают вторая линия, Customer Care и администратор; привязку идеи эта политика не пропускает';
COMMENT ON POLICY hdw_dev_task_links_developer_delete ON hdw_dev_task_links IS 'Привязку обращения снимают вторая линия, Customer Care и администратор; привязку идеи эта политика не снимает';

CREATE POLICY hdw_dev_task_links_moderator_insert ON hdw_dev_task_links FOR INSERT TO hub_app
  WITH CHECK (idea_id IS NOT NULL AND ticket_id IS NULL AND org_id IS NULL AND app.actor_type() = 'staff' AND app.staff_role() IN ('product', 'admin'));
COMMENT ON POLICY hdw_dev_task_links_moderator_insert ON hdw_dev_task_links IS 'Идею к задаче привязывают только модераторы идей product и admin (план M7, решение 18); снять привязку идеи нельзя';

CREATE POLICY hdw_dev_tasks_moderator_insert ON hdw_dev_tasks FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'product');
COMMENT ON POLICY hdw_dev_tasks_moderator_insert ON hdw_dev_tasks IS 'Роль product заводит задачу разработки для выбранной идеи (план M7, решение 18). Статус задачи она не меняет';
