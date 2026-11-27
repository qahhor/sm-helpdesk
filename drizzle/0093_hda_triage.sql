-- Предложения разбора и блок AI у сотрудника (ТЗ 7.14, FR-TRI-01..06, FR-AI-13, UX-A-12, 10.5 triage_suggestions;
-- план M5b, задача 7, решения 6, 18).
--
-- 1. hda_runs.found: решения, найденные первой линией для этого вызова (номер решения и оценка ранжирования), для
--    блока AI сотрудника ("Найденные решения"). Только идентификаторы и числа: текста запроса и ответа в журнале
--    по-прежнему нет (поправка 101). Заголовки показ берёт из hdk_published.
-- 2. hda_triage_suggestions: предложение разбора по полю обращения (модуль, тип, заголовок, резюме, пометка "проверьте
--    приоритет"). Пишет только фоновый процесс после проверки кодом (заголовок без адресов, почты, телефонов и длинных
--    чисел), решают сотрудники, которые ведут обращения, читают сотрудники. Клиент не видит ни одной строки (FR-TRI-06).
--    Одно предложение поля на обращение: повторный ответ помощника нового предложения не даёт.
-- 3. hda_triage_field_offs: поле, предложения которого ночная задача ai.triage_review отключила, потому что за месяц
--    принято меньше 70% при не менее чем 30 решениях (FR-TRI-04). Снимает отключение администратор портала.

ALTER TABLE hda_runs ADD COLUMN found jsonb;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c13 CHECK (found IS NULL OR (jsonb_typeof(found) = 'array' AND jsonb_array_length(found) <= 3));
COMMENT ON COLUMN hda_runs.found IS 'Решения, найденные первой линией для вызова: до трёх объектов {articleId, number, score}. Только идентификаторы и оценки, без текста';
COMMENT ON CONSTRAINT hda_runs_c13 ON hda_runs IS 'Найденные решения: массив не длиннее трёх (в модель уходит до трёх решений)';

CREATE TABLE hda_triage_suggestions (
  suggestion_id uuid        NOT NULL DEFAULT uuidv7(),
  org_id        uuid        NOT NULL,
  ticket_id     uuid        NOT NULL,
  run_id        uuid        NOT NULL,
  field         text        NOT NULL,
  value         text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  decided_by    uuid,
  decided_on    timestamptz,
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_triage_suggestions_pk PRIMARY KEY (suggestion_id),
  CONSTRAINT hda_triage_suggestions_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hda_triage_suggestions_f2 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hda_triage_suggestions_f3 FOREIGN KEY (run_id) REFERENCES hda_runs (run_id),
  CONSTRAINT hda_triage_suggestions_f4 FOREIGN KEY (decided_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_triage_suggestions_c1 CHECK (field IN ('module', 'type', 'title', 'summary', 'priority_hint')),
  CONSTRAINT hda_triage_suggestions_c2 CHECK (status IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT hda_triage_suggestions_c3 CHECK (char_length(value) BETWEEN 1 AND 400),
  CONSTRAINT hda_triage_suggestions_c4 CHECK ((status = 'pending') = (decided_on IS NULL)),
  CONSTRAINT hda_triage_suggestions_c5 CHECK (decided_by IS NULL OR decided_on IS NOT NULL),
  -- Заголовок до 80 знаков (FR-TRI-01), резюме до 300.
  CONSTRAINT hda_triage_suggestions_c6 CHECK (field <> 'title' OR char_length(value) <= 80),
  CONSTRAINT hda_triage_suggestions_c7 CHECK (field <> 'priority_hint' OR value = 'check')
);

CREATE UNIQUE INDEX hda_triage_suggestions_u1 ON hda_triage_suggestions (ticket_id, field);
CREATE INDEX hda_triage_suggestions_i1 ON hda_triage_suggestions (org_id);
CREATE INDEX hda_triage_suggestions_i2 ON hda_triage_suggestions (run_id);
CREATE INDEX hda_triage_suggestions_i3 ON hda_triage_suggestions (decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX hda_triage_suggestions_i4 ON hda_triage_suggestions (field, decided_on) WHERE decided_on IS NOT NULL;
COMMENT ON INDEX hda_triage_suggestions_u1 IS 'Одно предложение поля на обращение; поиск предложений обращения для блока AI';
COMMENT ON INDEX hda_triage_suggestions_i1 IS 'Внешний ключ: организация';
COMMENT ON INDEX hda_triage_suggestions_i2 IS 'Внешний ключ: вызов модели, из которого пришло предложение';
COMMENT ON INDEX hda_triage_suggestions_i3 IS 'Внешний ключ: кто решил';
COMMENT ON INDEX hda_triage_suggestions_i4 IS 'Доля принятых по полю за месяц для ночной задачи ai.triage_review (FR-TRI-04)';

COMMENT ON TABLE hda_triage_suggestions IS 'Предложения разбора обращения от AI (логическое имя triage_suggestions, FR-TRI-01..06). Пишет фоновый процесс, решает сотрудник, клиент не видит';
COMMENT ON COLUMN hda_triage_suggestions.suggestion_id IS 'Идентификатор предложения';
COMMENT ON COLUMN hda_triage_suggestions.org_id IS 'Организация обращения';
COMMENT ON COLUMN hda_triage_suggestions.ticket_id IS 'Обращение';
COMMENT ON COLUMN hda_triage_suggestions.run_id IS 'Вызов модели (первая линия или разбор), из которого пришло предложение';
COMMENT ON COLUMN hda_triage_suggestions.field IS 'Поле: module, type, title (заголовок до 80 знаков), summary (резюме только для сотрудника), priority_hint (пометка "проверьте приоритет")';
COMMENT ON COLUMN hda_triage_suggestions.value IS 'Предложенное значение: идентификатор модуля, код типа, заголовок после проверки кодом, резюме, check у пометки приоритета';
COMMENT ON COLUMN hda_triage_suggestions.status IS 'pending (ждёт решения), accepted (принято, поле обращения изменено), rejected (отклонено)';
COMMENT ON COLUMN hda_triage_suggestions.decided_by IS 'Кто принял или отклонил. Пусто у ждущего';
COMMENT ON COLUMN hda_triage_suggestions.decided_on IS 'Когда принято или отклонено. Пусто у ждущего';
COMMENT ON COLUMN hda_triage_suggestions.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_triage_suggestions.created_on IS 'Когда предложение записано. Заполняет база';
COMMENT ON COLUMN hda_triage_suggestions.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_triage_suggestions.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_triage_suggestions_c4 ON hda_triage_suggestions IS 'У решённого предложения есть момент решения, у ждущего нет';
COMMENT ON CONSTRAINT hda_triage_suggestions_c7 ON hda_triage_suggestions IS 'Приоритет AI не предлагает (FR-TRI-03): у пометки только значение check';

CREATE TRIGGER t_hda_triage_suggestions_stamp
  BEFORE INSERT OR UPDATE ON hda_triage_suggestions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_triage_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_triage_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_triage_suggestions_internal_select ON hda_triage_suggestions FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hda_triage_suggestions_system_insert ON hda_triage_suggestions FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_triage_suggestions_staff_update ON hda_triage_suggestions FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin'))
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin'));
COMMENT ON POLICY hda_triage_suggestions_internal_select ON hda_triage_suggestions IS 'Предложения читают сотрудники (блок AI) и система (ночной подсчёт доли принятых). Клиент не читает (FR-TRI-06)';
COMMENT ON POLICY hda_triage_suggestions_system_insert ON hda_triage_suggestions IS 'Предложение записывает только фоновый процесс после проверки кодом';
COMMENT ON POLICY hda_triage_suggestions_staff_update ON hda_triage_suggestions IS 'Принять или отклонить могут сотрудники, которые ведут обращения; product только читает';
GRANT SELECT, INSERT, UPDATE ON hda_triage_suggestions TO hub_app;

CREATE TABLE hda_triage_field_offs (
  off_id      uuid         NOT NULL DEFAULT uuidv7(),
  field       text         NOT NULL,
  month       date         NOT NULL,
  share       numeric(5,4) NOT NULL,
  decisions   integer      NOT NULL,
  lifted_on   timestamptz,
  lifted_by   uuid,
  created_by  text,
  created_on  timestamptz  NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT hda_triage_field_offs_pk PRIMARY KEY (off_id),
  CONSTRAINT hda_triage_field_offs_f1 FOREIGN KEY (lifted_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_triage_field_offs_c1 CHECK (field IN ('module', 'type', 'title', 'summary', 'priority_hint')),
  CONSTRAINT hda_triage_field_offs_c2 CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT hda_triage_field_offs_c3 CHECK (share BETWEEN 0 AND 1 AND decisions >= 0),
  CONSTRAINT hda_triage_field_offs_c4 CHECK ((lifted_on IS NULL) = (lifted_by IS NULL))
);

-- Одно действующее отключение поля и одна строка на поле и месяц: ночная задача не ставит его снова.
CREATE UNIQUE INDEX hda_triage_field_offs_u1 ON hda_triage_field_offs (field) WHERE lifted_on IS NULL;
CREATE UNIQUE INDEX hda_triage_field_offs_u2 ON hda_triage_field_offs (field, month);
CREATE INDEX hda_triage_field_offs_i1 ON hda_triage_field_offs (lifted_by) WHERE lifted_by IS NOT NULL;
COMMENT ON INDEX hda_triage_field_offs_u1 IS 'Одно действующее отключение поля';
COMMENT ON INDEX hda_triage_field_offs_u2 IS 'Одна строка на поле и месяц подсчёта: снятое отключение ночь не возвращает';
COMMENT ON INDEX hda_triage_field_offs_i1 IS 'Внешний ключ: кто снял отключение';

COMMENT ON TABLE hda_triage_field_offs IS 'Поля разбора, отключённые ночной задачей ai.triage_review: доля принятых за месяц ниже 70% (FR-TRI-04). Пишет система, снимает администратор портала, клиент не видит';
COMMENT ON COLUMN hda_triage_field_offs.off_id IS 'Идентификатор отключения';
COMMENT ON COLUMN hda_triage_field_offs.field IS 'Поле разбора: module, type, title, summary, priority_hint';
COMMENT ON COLUMN hda_triage_field_offs.month IS 'Календарный месяц подсчёта: первое число по Ташкенту';
COMMENT ON COLUMN hda_triage_field_offs.share IS 'Доля принятых предложений поля за месяц';
COMMENT ON COLUMN hda_triage_field_offs.decisions IS 'Сколько предложений поля решено за месяц';
COMMENT ON COLUMN hda_triage_field_offs.lifted_on IS 'Когда администратор включил поле обратно. Пусто: поле отключено';
COMMENT ON COLUMN hda_triage_field_offs.lifted_by IS 'Кто включил поле обратно';
COMMENT ON COLUMN hda_triage_field_offs.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_triage_field_offs.created_on IS 'Когда поле отключено. Заполняет база';
COMMENT ON COLUMN hda_triage_field_offs.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_triage_field_offs.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hda_triage_field_offs_stamp
  BEFORE INSERT OR UPDATE ON hda_triage_field_offs
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_triage_field_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_triage_field_offs FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_triage_field_offs_internal_select ON hda_triage_field_offs FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hda_triage_field_offs_system_insert ON hda_triage_field_offs FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_triage_field_offs_admin_update ON hda_triage_field_offs FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hda_triage_field_offs_internal_select ON hda_triage_field_offs IS 'Отключения читают сотрудники (настройки AI) и система (запись предложений). Клиент не читает';
COMMENT ON POLICY hda_triage_field_offs_system_insert ON hda_triage_field_offs IS 'Отключение ставит только ночная задача ai.triage_review';
COMMENT ON POLICY hda_triage_field_offs_admin_update ON hda_triage_field_offs IS 'Включить поле обратно может только администратор портала';
GRANT SELECT, INSERT, UPDATE ON hda_triage_field_offs TO hub_app;
