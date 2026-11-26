-- Очередь записи в индекс поиска Typesense (план W6, задача 3, решения 1, 10, 11; решение владельца 0070).
-- Строку пишут триггеры исходных таблиц в той же транзакции, что и изменение: откатилось изменение, нет и строки.
-- Триггер срабатывает только на индексируемые колонки, публикацию, аудиторию и статус. В строке только вид и
-- идентификатор, без текста: актуальные строки задача search.sync читает сама под системным актором и пишет в
-- Typesense пачкой. Поэтому вставка разрешена любой роли, которая меняет исходные таблицы: hub_app, hub_auth
-- (организации, участники, сотрудники, имена людей) и hub_owner (каскад внешнего ключа идёт от владельца таблицы:
-- смена аудитории статьи доходит до hdk_published, смена организации обращения до сообщений). Роль пересчёта
-- счётчиков идей строк не пишет: её правки (счётчики, shortlisted -> open) триггер пропускает условием WHEN.
-- Читает, отмечает сбой и удаляет строки только система. Клиент и сотрудник очередь не видят.

CREATE TABLE hdc_search_outbox (
  org_id          uuid,
  outbox_id       uuid        NOT NULL DEFAULT uuidv7(),
  entity_kind     text        NOT NULL,
  entity_id       text        NOT NULL,
  op              text        NOT NULL DEFAULT 'upsert',
  attempts        smallint    NOT NULL DEFAULT 0,
  next_attempt_on timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_search_outbox_pk PRIMARY KEY (outbox_id),
  CONSTRAINT hdc_search_outbox_c1 CHECK (entity_kind IN ('ticket', 'ticket_text', 'solution', 'idea', 'org', 'person', 'config')),
  CONSTRAINT hdc_search_outbox_c2 CHECK (entity_id ~ '^[A-Za-z0-9_.-]{1,80}$'),
  CONSTRAINT hdc_search_outbox_c3 CHECK (op IN ('upsert', 'delete')),
  CONSTRAINT hdc_search_outbox_c4 CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT hdc_search_outbox_c5 CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,40}$')
);

-- Очередь разбора: ждущие строки по времени попытки. Строки после пятого сбоя в индекс не входят: их чинит сверка.
CREATE INDEX hdc_search_outbox_i1 ON hdc_search_outbox (next_attempt_on, outbox_id) WHERE attempts < 5;
-- Повторы одного объекта схлопываются; проверка "по объекту ещё ждёт запись" для события изоляции.
CREATE INDEX hdc_search_outbox_i2 ON hdc_search_outbox (entity_kind, entity_id);

COMMENT ON TABLE hdc_search_outbox IS 'Очередь записи в индекс поиска Typesense (план W6): вид и идентификатор объекта, без текста';
COMMENT ON COLUMN hdc_search_outbox.org_id IS 'Организация объекта, если он принадлежит организации (обращение, сообщение, идея). Для наблюдения, на права не влияет';
COMMENT ON COLUMN hdc_search_outbox.outbox_id IS 'Идентификатор строки. Растёт со временем';
COMMENT ON COLUMN hdc_search_outbox.entity_kind IS 'Вид объекта: ticket, ticket_text, solution, idea, org, person, config';
COMMENT ON COLUMN hdc_search_outbox.entity_id IS 'Идентификатор объекта; у сообщения <обращение>_<сообщение>, у настроек поиска код настройки';
COMMENT ON COLUMN hdc_search_outbox.op IS 'Что случилось со строкой: upsert (вставка, правка) или delete (удаление). Задача всё равно читает актуальное';
COMMENT ON COLUMN hdc_search_outbox.attempts IS 'Сколько раз запись в индекс закончилась сбоем; после пятого строку чинит ночная сверка';
COMMENT ON COLUMN hdc_search_outbox.next_attempt_on IS 'Когда брать строку: сразу, после паузы повтора или после срока захвата задачей';
COMMENT ON COLUMN hdc_search_outbox.last_error_code IS 'Код последнего сбоя записи, без текста и данных';
COMMENT ON COLUMN hdc_search_outbox.created_on IS 'Когда строка записана. Заполняет база';

ALTER TABLE hdc_search_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_search_outbox FORCE ROW LEVEL SECURITY;

-- Вставка: только новая строка без попыток и ошибок (триггер), от любого актора роли, которая меняет исходные таблицы.
-- Прочитать свою строку обратно вставка не позволяет: политики чтения у этих ролей нет, кроме системы.
CREATE POLICY hdc_search_outbox_any_insert ON hdc_search_outbox FOR INSERT TO hub_app, hub_auth, hub_owner
  WITH CHECK (attempts = 0 AND last_error_code IS NULL AND next_attempt_on <= now() + interval '1 minute');
CREATE POLICY hdc_search_outbox_system_select ON hdc_search_outbox FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hdc_search_outbox_system_update ON hdc_search_outbox FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdc_search_outbox_system_delete ON hdc_search_outbox FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdc_search_outbox_any_insert ON hdc_search_outbox IS 'Строку пишет триггер исходной таблицы в транзакции изменения, от любого актора';
COMMENT ON POLICY hdc_search_outbox_system_select ON hdc_search_outbox IS 'Очередь читает только фоновая задача search.sync и наблюдение';
COMMENT ON POLICY hdc_search_outbox_system_update ON hdc_search_outbox IS 'Захват и отметку сбоя ставит только фоновая задача';
COMMENT ON POLICY hdc_search_outbox_system_delete ON hdc_search_outbox IS 'Записанные в индекс строки удаляет только фоновая задача';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdc_search_outbox TO hub_app;
GRANT INSERT ON hdc_search_outbox TO hub_auth;

-- ---------------------------------------------------------------------------
-- Триггеры исходных таблиц
-- ---------------------------------------------------------------------------
-- Аргументы: вид объекта, колонки идентификатора через запятую (значения соединяются знаком _), колонка организации
-- или пустая строка. Функция не SECURITY DEFINER: вставка идёт от роли и актора изменения под политикой выше.
CREATE FUNCTION app.hdc_search_enqueue() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  rec jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  id text;
  org uuid;
BEGIN
  SELECT string_agg(rec ->> col, '_' ORDER BY n) INTO id FROM unnest(string_to_array(TG_ARGV[1], ',')) WITH ORDINALITY AS c(col, n);
  IF TG_ARGV[2] <> '' THEN org := (rec ->> TG_ARGV[2])::uuid; END IF;
  INSERT INTO hdc_search_outbox (org_id, entity_kind, entity_id, op)
  VALUES (org, TG_ARGV[0], id, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdc_search_enqueue() IS 'Ставит объект в очередь записи индекса поиска (план W6, решение 10): аргументы вид, колонки идентификатора, колонка организации';

-- Обращения: тема, описание, язык, организация, номер.
CREATE TRIGGER t_hdt_tickets_search AFTER INSERT OR DELETE ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('ticket', 'ticket_id', 'org_id');
CREATE TRIGGER t_hdt_tickets_search_update AFTER UPDATE OF title, description, locale, org_id, number ON hdt_tickets
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.description IS DISTINCT FROM NEW.description OR OLD.locale IS DISTINCT FROM NEW.locale
        OR OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.number IS DISTINCT FROM NEW.number)
  EXECUTE FUNCTION app.hdc_search_enqueue('ticket', 'ticket_id', 'org_id');

-- Переписка и внутренние заметки (решение 0070, пункт 3): коллекция только для ключа сотрудника.
CREATE TRIGGER t_hdt_ticket_messages_search AFTER INSERT OR DELETE ON hdt_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('ticket_text', 'ticket_id,message_id', 'org_id');
CREATE TRIGGER t_hdt_ticket_messages_search_update AFTER UPDATE OF body, is_internal, org_id ON hdt_ticket_messages
  FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR OLD.is_internal IS DISTINCT FROM NEW.is_internal OR OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION app.hdc_search_enqueue('ticket_text', 'ticket_id,message_id', 'org_id');

-- Решения: только копия для читателей (hdk_published). Публикация, новая версия, аудитория, архив (удаление копий).
CREATE TRIGGER t_hdk_published_search AFTER INSERT OR UPDATE OR DELETE ON hdk_published
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('solution', 'article_id', '');

-- Идеи: появление на доске и уход с неё (модерация, отклонение, объединение), модуль. Переходы между статусами доски
-- (open, shortlisted, selected, released) видимости не меняют и строки не пишут: их делает и роль пересчёта счётчиков.
CREATE TRIGGER t_hdi_ideas_search AFTER INSERT OR DELETE ON hdi_ideas
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('idea', 'idea_id', 'org_id');
CREATE TRIGGER t_hdi_ideas_search_update AFTER UPDATE OF status, module_id, merged_into_id ON hdi_ideas
  FOR EACH ROW
  WHEN ((OLD.status IN ('pending_review', 'declined', 'merged')) IS DISTINCT FROM (NEW.status IN ('pending_review', 'declined', 'merged'))
        OR OLD.module_id IS DISTINCT FROM NEW.module_id OR OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id)
  EXECUTE FUNCTION app.hdc_search_enqueue('idea', 'idea_id', 'org_id');
CREATE TRIGGER t_hdi_idea_translations_search AFTER INSERT OR DELETE ON hdi_idea_translations
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('idea', 'idea_id', '');
CREATE TRIGGER t_hdi_idea_translations_search_update AFTER UPDATE OF title, body, status, locale ON hdi_idea_translations
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.body IS DISTINCT FROM NEW.body OR OLD.status IS DISTINCT FROM NEW.status OR OLD.locale IS DISTINCT FROM NEW.locale)
  EXECUTE FUNCTION app.hdc_search_enqueue('idea', 'idea_id', '');

-- Организации: название, ИНН, код на сервере Smartup, состояние, вид. Категория и признак AI в индекс не входят.
CREATE TRIGGER t_hdu_organizations_search AFTER INSERT OR DELETE ON hdu_organizations
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('org', 'org_id', '');
CREATE TRIGGER t_hdu_organizations_search_update AFTER UPDATE OF name, inn, external_company_id, state, kind ON hdu_organizations
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.inn IS DISTINCT FROM NEW.inn OR OLD.external_company_id IS DISTINCT FROM NEW.external_company_id
        OR OLD.state IS DISTINCT FROM NEW.state OR OLD.kind IS DISTINCT FROM NEW.kind)
  EXECUTE FUNCTION app.hdc_search_enqueue('org', 'org_id', '');

-- Люди: имя (схема auth), участие в организациях, учётная запись сотрудника. Адреса почты в индекс не входят.
CREATE TRIGGER t_auth_user_search AFTER INSERT OR DELETE ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('person', 'id', '');
CREATE TRIGGER t_auth_user_search_update AFTER UPDATE OF name ON auth."user"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION app.hdc_search_enqueue('person', 'id', '');
CREATE TRIGGER t_hdu_memberships_search AFTER INSERT OR DELETE ON hdu_memberships
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('person', 'user_id', '');
CREATE TRIGGER t_hdu_memberships_search_update AFTER UPDATE OF state, org_id ON hdu_memberships
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION app.hdc_search_enqueue('person', 'user_id', '');
CREATE TRIGGER t_hdu_staff_search AFTER INSERT OR DELETE ON hdu_staff
  FOR EACH ROW EXECUTE FUNCTION app.hdc_search_enqueue('person', 'user_id', '');
CREATE TRIGGER t_hdu_staff_search_update AFTER UPDATE OF state ON hdu_staff
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION app.hdc_search_enqueue('person', 'user_id', '');

-- Синонимы, словарь узбекского и курирование (решение 0070, пункт 4) хранит hdc_settings под кодами search.*:
-- их запись ставит строку config, задача отправляет набор в Typesense.
CREATE TRIGGER t_hdc_settings_search AFTER INSERT OR UPDATE OF value ON hdc_settings
  FOR EACH ROW WHEN (NEW.code IN ('search.synonyms', 'search.uz_stems', 'search.curation'))
  EXECUTE FUNCTION app.hdc_search_enqueue('config', 'code', '');
