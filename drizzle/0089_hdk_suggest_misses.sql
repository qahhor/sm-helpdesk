-- Запросы подсказки решений без результата (план W6, задача 9, решение 17; ответ владельца 0070, пункт 5).
-- Команда базы знаний видит, что клиенты ищут и не находят. Строка на сессию формы: последний запрос сессии, после
-- которого подсказка ничего не показала; если потом в той же сессии решение нашлось, строка удаляется. Текст запроса
-- хранится после маски данных (телефоны, адреса, ИНН, ПИНФЛ, серверы заменены), без пользователя и организации, и
-- удаляется ночной очисткой через 90 дней. Пишет и удаляет только система, читают администратор и роли публикации
-- решений (agent_l2, care, admin). Клиент строк не видит.

CREATE TABLE hdk_suggest_misses (
  miss_id     uuid        NOT NULL DEFAULT uuidv7(),
  module_id   uuid,
  session_id  uuid        NOT NULL,
  locale      text        NOT NULL,
  query_text  text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_suggest_misses_pk PRIMARY KEY (miss_id),
  CONSTRAINT hdk_suggest_misses_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id) ON DELETE SET NULL,
  CONSTRAINT hdk_suggest_misses_u1 UNIQUE (session_id),
  CONSTRAINT hdk_suggest_misses_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdk_suggest_misses_c2 CHECK (char_length(query_text) BETWEEN 1 AND 500)
);

-- Сводка за неделю и ночная очистка по времени записи.
CREATE INDEX hdk_suggest_misses_i1 ON hdk_suggest_misses (modified_on);
CREATE INDEX hdk_suggest_misses_i2 ON hdk_suggest_misses (module_id);

COMMENT ON TABLE hdk_suggest_misses IS 'Запросы подсказки решений без результата (план W6, решение 17): текст после маски данных, 90 дней';
COMMENT ON COLUMN hdk_suggest_misses.miss_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdk_suggest_misses.module_id IS 'Модуль, выбранный на форме обращения. Пусто: не выбран';
COMMENT ON COLUMN hdk_suggest_misses.session_id IS 'Сессия формы обращения: одна строка на сессию, последний запрос без результата';
COMMENT ON COLUMN hdk_suggest_misses.locale IS 'Язык интерфейса клиента: ru, uz, en';
COMMENT ON COLUMN hdk_suggest_misses.query_text IS 'Текст запроса после маски данных: без телефонов, адресов, ИНН, ПИНФЛ и адресов серверов';
COMMENT ON COLUMN hdk_suggest_misses.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_suggest_misses.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_suggest_misses.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_suggest_misses.modified_on IS 'Когда записан последний запрос сессии. Заполняет база';

CREATE TRIGGER t_hdk_suggest_misses_stamp
  BEFORE INSERT OR UPDATE ON hdk_suggest_misses
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_suggest_misses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_suggest_misses FORCE ROW LEVEL SECURITY;
CREATE POLICY hdk_suggest_misses_system_all ON hdk_suggest_misses FOR ALL TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_suggest_misses_publisher_select ON hdk_suggest_misses FOR SELECT TO hub_app USING (app.kb_can_publish());
COMMENT ON POLICY hdk_suggest_misses_system_all ON hdk_suggest_misses IS 'Пишет подсказка под системным актором, удаляет ночная очистка';
COMMENT ON POLICY hdk_suggest_misses_publisher_select ON hdk_suggest_misses IS 'Читают администратор и роли публикации решений (команда базы знаний)';
GRANT SELECT, INSERT, UPDATE, DELETE ON hdk_suggest_misses TO hub_app;
