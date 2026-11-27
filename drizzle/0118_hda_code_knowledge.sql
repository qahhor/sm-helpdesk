-- Веха M8c, задача 1: знания из кода (ТЗ 7.22 FR-CODE-01..15, 10.5; план M8c, решения 1, 6-9, 12, 25, 27).
--
-- Портал хранит только выводы Hermes Agent о коде Smartup, не сам код: ни одно поле не длиннее 10 строк, место в коде
-- только ссылкой (объект, файл, строка). Выражение для сопоставления строит база из текста шаблона с именованными
-- подстановками (генерируемая колонка pattern), сигнатура записи тоже генерируется из ключа: агент их не передаёт.
--
-- 1. hda_code_scans: история сканирований (дата, репозиторий, версия кода, числа). Отклонённый отчёт оставляет строку
--    без содержимого: коды правил и пути полей.
-- 2. hda_code_error_entries: каталог ошибок. Пишет AI-сотрудник основным токеном черновиками, утверждают, правят и
--    отклоняют agent_l2, care, admin. Первая линия видит только представление hda_code_checks.
-- 3. hda_code_error_templates: шаблоны сообщения по языкам, как у родителя.
-- 4. hda_code_module_notes: карта модулей и экранов; утверждает (применяет к справочнику) только администратор.
-- 5. hda_code_analysis_requests: запросы "Разобрать по коду" (FR-CODE-08, 10).
-- 6. Функции: app.hda_code_reader() (кто читает знания), app.hda_code_pattern(text) (выражение из шаблона),
--    app.hda_code_key_signature(text) (сигнатура из ключа), app.hda_code_signature(text, text[]) (сигнатура по
--    утверждённым шаблонам для всех акторов: отдаёт только 32 знака хеша).
-- Клиент не видит ни одной строки (нет политик). Система, а с ней AI-помощник, подсказка и Тез, не читает записей,
-- шаблонов и заметок о модулях: только функцию сигнатуры.

CREATE FUNCTION app.hda_code_reader() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin') $$;
COMMENT ON FUNCTION app.hda_code_reader() IS 'Истина для сотрудников, которые видят знания из кода: agent_l2, care, admin (FR-CODE-11)';

-- Выражение строит портал (FR-CODE-05): подстановки {name} становятся группами, остальной текст экранируется,
-- пробелы допускают любой пробельный промежуток, выражение привязано к строке целиком, в конце точка или знак "!".
CREATE FUNCTION app.hda_code_pattern(p_template text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT '^\s*'
      || replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(btrim(p_template), '\{[A-Za-z_][A-Za-z0-9_]{0,39}\}', E'\x01', 'g'),
               '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'),
             '\s+', '\\s+', 'g'),
           E'\x01', '(.{1,200}?)')
      || '\s*[.!]?\s*$'
$$;
COMMENT ON FUNCTION app.hda_code_pattern(text) IS 'Выражение для сопоставления из шаблона сообщения: подстановки в группы, остальное буквально (FR-CODE-05, план M8c, решение 6)';

-- Сигнатура записи из ключа (FR-CODE-04, решение 7): тот же вид, что у сигнатур 11.5, 32 знака sha256.
CREATE FUNCTION app.hda_code_key_signature(p_key text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT substr(encode(sha256(convert_to('code-key|' || p_key, 'UTF8')), 'hex'), 1, 32) $$;
COMMENT ON FUNCTION app.hda_code_key_signature(text) IS 'Сигнатура записи каталога ошибок: первые 32 знака sha256 от "code-key|<ключ>" (план M8c, решение 7)';

-- ---------------------------------------------------------------------------
-- Сканирования
-- ---------------------------------------------------------------------------
CREATE TABLE hda_code_scans (
  scan_id        uuid        NOT NULL DEFAULT uuidv7(),
  token_id       uuid        NOT NULL,
  scan_key       text        NOT NULL,
  repository     text        NOT NULL,
  commit_ref     text        NOT NULL,
  status         text        NOT NULL DEFAULT 'accepted',
  added_count    integer     NOT NULL DEFAULT 0,
  changed_count  integer     NOT NULL DEFAULT 0,
  removed_count  integer     NOT NULL DEFAULT 0,
  error_count    integer     NOT NULL DEFAULT 0,
  module_count   integer     NOT NULL DEFAULT 0,
  reject_reasons jsonb       NOT NULL DEFAULT '[]'::jsonb,
  received_on    timestamptz NOT NULL DEFAULT now(),
  chat_sent_on   timestamptz,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_code_scans_pk PRIMARY KEY (scan_id),
  CONSTRAINT hda_code_scans_f1 FOREIGN KEY (token_id) REFERENCES hda_agent_tokens (token_id),
  CONSTRAINT hda_code_scans_c1 CHECK (status IN ('accepted', 'rejected')),
  CONSTRAINT hda_code_scans_c2 CHECK (scan_key ~ '^[A-Za-z0-9._-]{1,40}$' AND repository ~ '^[a-z0-9._-]{1,80}$' AND commit_ref ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT hda_code_scans_c3 CHECK (added_count >= 0 AND changed_count >= 0 AND removed_count >= 0 AND error_count >= 0 AND module_count >= 0),
  CONSTRAINT hda_code_scans_c4 CHECK (jsonb_typeof(reject_reasons) = 'array' AND octet_length(reject_reasons::text) <= 8000 AND (status = 'rejected' OR reject_reasons = '[]'::jsonb))
);
CREATE UNIQUE INDEX hda_code_scans_u1 ON hda_code_scans (repository, scan_key) WHERE status = 'accepted';
CREATE INDEX hda_code_scans_i1 ON hda_code_scans (token_id);
CREATE INDEX hda_code_scans_i2 ON hda_code_scans (received_on DESC);
COMMENT ON INDEX hda_code_scans_u1 IS 'Принятый отчёт репозитория с тем же scanId повторно ничего не меняет (решение 11)';
COMMENT ON INDEX hda_code_scans_i1 IS 'Внешний ключ: токен AI-сотрудника, передавший отчёт';
COMMENT ON INDEX hda_code_scans_i2 IS 'История сканирований: новые сверху';

COMMENT ON TABLE hda_code_scans IS 'История сканирований кода Smartup (FR-CODE-01, 14): дата, репозиторий, версия кода, числа новых, изменённых и исчезнувших ошибок. Кода нет. Клиент не видит';
COMMENT ON COLUMN hda_code_scans.scan_id IS 'Идентификатор строки истории';
COMMENT ON COLUMN hda_code_scans.token_id IS 'Токен AI-сотрудника, который передал отчёт инструментом code_catalog_upsert';
COMMENT ON COLUMN hda_code_scans.scan_key IS 'Идентификатор сканирования из отчёта (поле scanId, например 2026-W47)';
COMMENT ON COLUMN hda_code_scans.repository IS 'Репозиторий Smartup, который сканировался';
COMMENT ON COLUMN hda_code_scans.commit_ref IS 'Версия кода: коммит, на котором сделано сканирование';
COMMENT ON COLUMN hda_code_scans.status IS 'accepted (отчёт принят) или rejected (отклонён правилами FR-CODE-05, 12)';
COMMENT ON COLUMN hda_code_scans.added_count IS 'Сколько записей каталога появилось этим сканированием';
COMMENT ON COLUMN hda_code_scans.changed_count IS 'Сколько записей изменилось с прошлого сканирования';
COMMENT ON COLUMN hda_code_scans.removed_count IS 'Сколько записей исчезло (нет в отчёте того же репозитория)';
COMMENT ON COLUMN hda_code_scans.error_count IS 'Сколько ошибок в отчёте';
COMMENT ON COLUMN hda_code_scans.module_count IS 'Сколько модулей в отчёте';
COMMENT ON COLUMN hda_code_scans.reject_reasons IS 'Причины отклонения: код правила и путь поля, без значений';
COMMENT ON COLUMN hda_code_scans.received_on IS 'Когда портал получил отчёт';
COMMENT ON COLUMN hda_code_scans.chat_sent_on IS 'Когда портал отправил сводку о сканировании в служебный чат команды (FR-CODE-14)';
COMMENT ON COLUMN hda_code_scans.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_code_scans.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hda_code_scans.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_code_scans.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_code_scans_c2 ON hda_code_scans IS 'Идентификатор сканирования, репозиторий и коммит в виде из схемы отчёта';
COMMENT ON CONSTRAINT hda_code_scans_c4 ON hda_code_scans IS 'Причины отклонения: массив не больше 8000 байт, только у отклонённого отчёта';

CREATE TRIGGER t_hda_code_scans_stamp
  BEFORE INSERT OR UPDATE ON hda_code_scans
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Система меняет в строке только отметку отправки в чат.
CREATE FUNCTION app.hda_code_scans_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() <> 'none' AND (to_jsonb(NEW) - ARRAY['chat_sent_on', 'modified_by', 'modified_on']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['chat_sent_on', 'modified_by', 'modified_on']) THEN
    RAISE EXCEPTION 'Знания из кода: в строке сканирования меняется только отметка отправки в чат' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_code_scans_guard() IS 'Триггер: строка истории сканирования не меняется, кроме отметки отправки в чат';
CREATE TRIGGER t_hda_code_scans_guard
  BEFORE UPDATE ON hda_code_scans
  FOR EACH ROW EXECUTE FUNCTION app.hda_code_scans_guard();

ALTER TABLE hda_code_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_code_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_code_scans_reader_select ON hda_code_scans FOR SELECT TO hub_app USING (app.hda_code_reader());
CREATE POLICY hda_code_scans_agent_select ON hda_code_scans FOR SELECT TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_scans_agent_insert ON hda_code_scans FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL AND token_id = app.agent_token_id());
CREATE POLICY hda_code_scans_system_select ON hda_code_scans FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hda_code_scans_system_update ON hda_code_scans FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hda_code_scans_reader_select ON hda_code_scans IS 'Историю сканирований читают agent_l2, care, admin';
COMMENT ON POLICY hda_code_scans_agent_select ON hda_code_scans IS 'AI-сотрудник основным токеном читает историю: повтор отчёта и сравнение с прошлым';
COMMENT ON POLICY hda_code_scans_agent_insert ON hda_code_scans IS 'Строку сканирования пишет AI-сотрудник основным токеном и только своим токеном';
COMMENT ON POLICY hda_code_scans_system_select ON hda_code_scans IS 'Система читает числа сканирования для сводки в чат команды: в строке нет выводов о коде';
COMMENT ON POLICY hda_code_scans_system_update ON hda_code_scans IS 'Система ставит отметку отправки в чат; остальное закрывает t_hda_code_scans_guard';
GRANT SELECT, INSERT, UPDATE ON hda_code_scans TO hub_app;

-- ---------------------------------------------------------------------------
-- Каталог ошибок
-- ---------------------------------------------------------------------------
CREATE TABLE hda_code_error_entries (
  entry_id      uuid         NOT NULL DEFAULT uuidv7(),
  scan_id       uuid         NOT NULL,
  module_id     uuid,
  approved_by   uuid,
  key           text         NOT NULL,
  signature     text         NOT NULL GENERATED ALWAYS AS (app.hda_code_key_signature(key)) STORED,
  code          text,
  repository    text         NOT NULL,
  module_code   text,
  raised_in     jsonb        NOT NULL DEFAULT '[]'::jsonb,
  conditions    text         NOT NULL,
  user_cause    text         NOT NULL,
  what_to_check jsonb        NOT NULL DEFAULT '[]'::jsonb,
  kind          text         NOT NULL,
  confidence    numeric(3,2) NOT NULL,
  status        text         NOT NULL DEFAULT 'draft',
  change_kind   text         NOT NULL DEFAULT 'new',
  scan_digest   text         NOT NULL,
  approved_on   timestamptz,
  reject_reason text,
  created_by    text,
  created_on    timestamptz  NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT hda_code_error_entries_pk PRIMARY KEY (entry_id),
  CONSTRAINT hda_code_error_entries_u1 UNIQUE (key),
  CONSTRAINT hda_code_error_entries_f1 FOREIGN KEY (scan_id) REFERENCES hda_code_scans (scan_id),
  CONSTRAINT hda_code_error_entries_f2 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hda_code_error_entries_f3 FOREIGN KEY (approved_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_code_error_entries_c1 CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$' AND char_length(key) <= 120),
  CONSTRAINT hda_code_error_entries_c2 CHECK (code IS NULL OR code ~ '^[A-Z]{2,5}-[0-9]{1,6}$'),
  CONSTRAINT hda_code_error_entries_c3 CHECK (kind IN ('user_error', 'setting', 'data', 'probable_defect') AND confidence BETWEEN 0 AND 1),
  CONSTRAINT hda_code_error_entries_c4 CHECK (status IN ('draft', 'approved', 'rejected', 'removed') AND change_kind IN ('new', 'changed', 'same')),
  CONSTRAINT hda_code_error_entries_c5 CHECK ((status = 'approved') = (approved_by IS NOT NULL) AND (approved_by IS NULL) = (approved_on IS NULL)),
  CONSTRAINT hda_code_error_entries_c6 CHECK (
    jsonb_typeof(raised_in) = 'array' AND jsonb_array_length(raised_in) <= 10
    AND jsonb_typeof(what_to_check) = 'array' AND jsonb_array_length(what_to_check) <= 10
    AND octet_length(raised_in::text) <= 8000 AND octet_length(what_to_check::text) <= 8000),
  -- Не больше 10 строк в поле (FR-CODE-12): выводы, а не фрагменты кода.
  CONSTRAINT hda_code_error_entries_c7 CHECK (
    char_length(conditions) BETWEEN 1 AND 2000 AND char_length(user_cause) BETWEEN 1 AND 2000
    AND array_length(string_to_array(conditions, E'\n'), 1) <= 10 AND array_length(string_to_array(user_cause, E'\n'), 1) <= 10
    AND (reject_reason IS NULL OR char_length(reject_reason) <= 500)),
  CONSTRAINT hda_code_error_entries_c8 CHECK (scan_digest ~ '^[0-9a-f]{64}$' AND repository ~ '^[a-z0-9._-]{1,80}$' AND (module_code IS NULL OR char_length(module_code) <= 80))
);
CREATE INDEX hda_code_error_entries_i1 ON hda_code_error_entries (scan_id);
CREATE INDEX hda_code_error_entries_i2 ON hda_code_error_entries (module_id) WHERE module_id IS NOT NULL;
CREATE INDEX hda_code_error_entries_i3 ON hda_code_error_entries (approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX hda_code_error_entries_i4 ON hda_code_error_entries (signature);
CREATE INDEX hda_code_error_entries_i5 ON hda_code_error_entries (status, change_kind);
COMMENT ON INDEX hda_code_error_entries_i1 IS 'Внешний ключ: последнее сканирование, в котором была запись';
COMMENT ON INDEX hda_code_error_entries_i2 IS 'Внешний ключ: модуль справочника';
COMMENT ON INDEX hda_code_error_entries_i3 IS 'Внешний ключ: кто утвердил';
COMMENT ON INDEX hda_code_error_entries_i4 IS 'Запись по сигнатуре обращения (блок "Что известно по коду", показатель FR-CODE-15)';
COMMENT ON INDEX hda_code_error_entries_i5 IS 'Очередь утверждения: статус и выделение новых и изменённых';

COMMENT ON TABLE hda_code_error_entries IS 'Каталог ошибок Smartup из сканирования кода (FR-CODE-02, 03): выводы, без исходного кода. Читают agent_l2, care, admin, первая линия через hda_code_checks, клиент и система нет';
COMMENT ON COLUMN hda_code_error_entries.entry_id IS 'Идентификатор записи';
COMMENT ON COLUMN hda_code_error_entries.scan_id IS 'Последнее сканирование, в отчёте которого была запись';
COMMENT ON COLUMN hda_code_error_entries.module_id IS 'Модуль справочника по коду модуля отчёта; пусто, если такого модуля в справочнике нет';
COMMENT ON COLUMN hda_code_error_entries.approved_by IS 'Сотрудник, утвердивший запись. Только у утверждённой';
COMMENT ON COLUMN hda_code_error_entries.key IS 'Ключ записи, уникален во всём каталоге (например orders.insufficient_stock)';
COMMENT ON COLUMN hda_code_error_entries.signature IS 'Сигнатура ошибки из ключа: генерирует база (FR-CODE-04, решение 7)';
COMMENT ON COLUMN hda_code_error_entries.code IS 'Код ошибки (например ORA-20001); пусто, если кода нет';
COMMENT ON COLUMN hda_code_error_entries.repository IS 'Репозиторий, сканирование которого дало запись';
COMMENT ON COLUMN hda_code_error_entries.module_code IS 'Код модуля из отчёта';
COMMENT ON COLUMN hda_code_error_entries.raised_in IS 'Место возникновения ссылками: объект, файл, строка (FR-CODE-12). Кода нет';
COMMENT ON COLUMN hda_code_error_entries.conditions IS 'Условия возникновения';
COMMENT ON COLUMN hda_code_error_entries.user_cause IS 'Вероятная причина на стороне пользователя';
COMMENT ON COLUMN hda_code_error_entries.what_to_check IS 'Что проверить: до 10 пунктов. Первая линия видит только это поле утверждённых записей';
COMMENT ON COLUMN hda_code_error_entries.kind IS 'Предварительная оценка рода: user_error, setting, data, probable_defect';
COMMENT ON COLUMN hda_code_error_entries.confidence IS 'Уверенность агента от 0 до 1';
COMMENT ON COLUMN hda_code_error_entries.status IS 'draft (черновик), approved (утверждена), rejected (отклонена), removed (исчезла из сканирования)';
COMMENT ON COLUMN hda_code_error_entries.change_kind IS 'Что с записью в последнем сканировании: new, changed, same (выделение в очереди)';
COMMENT ON COLUMN hda_code_error_entries.scan_digest IS 'Отпечаток содержимого записи от агента: сравнение со следующим сканированием (решение 10)';
COMMENT ON COLUMN hda_code_error_entries.approved_on IS 'Когда запись утверждена';
COMMENT ON COLUMN hda_code_error_entries.reject_reason IS 'Причина отклонения от сотрудника';
COMMENT ON COLUMN hda_code_error_entries.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_code_error_entries.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hda_code_error_entries.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_code_error_entries.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_code_error_entries_c1 ON hda_code_error_entries IS 'Ключ: слова через точку, до 120 знаков (решение 25)';
COMMENT ON CONSTRAINT hda_code_error_entries_c2 ON hda_code_error_entries IS 'Код ошибки вида ORA-20001 или пусто';
COMMENT ON CONSTRAINT hda_code_error_entries_c3 ON hda_code_error_entries IS 'Род из перечня и уверенность от 0 до 1 (решение 12)';
COMMENT ON CONSTRAINT hda_code_error_entries_c4 ON hda_code_error_entries IS 'Статус и вид изменения из перечня';
COMMENT ON CONSTRAINT hda_code_error_entries_c5 ON hda_code_error_entries IS 'Утвердивший и момент утверждения только у утверждённой записи';
COMMENT ON CONSTRAINT hda_code_error_entries_c6 ON hda_code_error_entries IS 'Место возникновения и "что проверить": массивы до 10 элементов';
COMMENT ON CONSTRAINT hda_code_error_entries_c7 ON hda_code_error_entries IS 'Тексты не длиннее 2000 знаков и 10 строк (FR-CODE-12)';
COMMENT ON CONSTRAINT hda_code_error_entries_c8 ON hda_code_error_entries IS 'Отпечаток sha256, репозиторий и код модуля в виде схемы отчёта';

CREATE TRIGGER t_hda_code_error_entries_stamp
  BEFORE INSERT OR UPDATE ON hda_code_error_entries
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Агент не утверждает (FR-CODE-03): пишет черновики, ставит исчезновение и переносит неизменную запись в новое
-- сканирование с прежним статусом. Сотрудник меняет только поля правки и статус, утверждает от своего имени.
CREATE FUNCTION app.hda_code_error_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  -- signature генерируется после триггеров BEFORE: в NEW она ещё пуста и в сравнение не входит.
  v_editable CONSTANT text[] := ARRAY['conditions', 'user_cause', 'what_to_check', 'kind', 'status', 'approved_by', 'approved_on', 'reject_reason', 'signature', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF app.actor_type() = 'agent' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'Знания из кода: AI-сотрудник пишет только черновики' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.key IS DISTINCT FROM OLD.key
       OR NOT (NEW.status IN ('draft', 'removed') AND NEW.approved_by IS NULL
               OR NEW.status = OLD.status AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by AND NEW.approved_on IS NOT DISTINCT FROM OLD.approved_on
                  AND NEW.scan_digest = OLD.scan_digest AND NEW.reject_reason IS NOT DISTINCT FROM OLD.reject_reason) THEN
      RAISE EXCEPTION 'Знания из кода: AI-сотрудник не утверждает и не отклоняет записи' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF app.actor_type() = 'staff' THEN
    IF TG_OP = 'INSERT' OR OLD.status = 'removed' OR NEW.status = 'removed'
       OR (to_jsonb(NEW) - v_editable) IS DISTINCT FROM (to_jsonb(OLD) - v_editable)
       OR (NEW.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by AND NEW.approved_by::text IS DISTINCT FROM app.user_id()) THEN
      RAISE EXCEPTION 'Знания из кода: сотрудник меняет только поля правки и статус, утверждает от своего имени' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_code_error_entries_guard() IS 'Триггер: AI-сотрудник не утверждает записи; сотрудник меняет только поля правки и статус и утверждает от своего имени';
CREATE TRIGGER t_hda_code_error_entries_guard
  BEFORE INSERT OR UPDATE ON hda_code_error_entries
  FOR EACH ROW EXECUTE FUNCTION app.hda_code_error_entries_guard();

ALTER TABLE hda_code_error_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_code_error_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_code_error_entries_reader_select ON hda_code_error_entries FOR SELECT TO hub_app USING (app.hda_code_reader());
CREATE POLICY hda_code_error_entries_reader_update ON hda_code_error_entries FOR UPDATE TO hub_app USING (app.hda_code_reader()) WITH CHECK (app.hda_code_reader());
CREATE POLICY hda_code_error_entries_agent_select ON hda_code_error_entries FOR SELECT TO hub_app USING (app.actor_type() = 'agent' AND app.agent_token_active());
CREATE POLICY hda_code_error_entries_agent_insert ON hda_code_error_entries FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_error_entries_agent_update ON hda_code_error_entries FOR UPDATE TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL)
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_error_entries_owner_select ON hda_code_error_entries FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hda_code_error_entries_reader_select ON hda_code_error_entries IS 'Каталог читают agent_l2, care, admin (FR-CODE-11)';
COMMENT ON POLICY hda_code_error_entries_reader_update ON hda_code_error_entries IS 'Утверждают, правят и отклоняют agent_l2, care, admin; поля закрывает t_hda_code_error_entries_guard';
COMMENT ON POLICY hda_code_error_entries_agent_select ON hda_code_error_entries IS 'AI-сотрудник читает сохранённые выводы (FR-CODE-08), основным токеном и токеном запуска анализа';
COMMENT ON POLICY hda_code_error_entries_agent_insert ON hda_code_error_entries IS 'Черновики записей пишет AI-сотрудник основным токеном (FR-AGT-04)';
COMMENT ON POLICY hda_code_error_entries_agent_update ON hda_code_error_entries IS 'AI-сотрудник обновляет записи сканированием основным токеном; утвердить не может (триггер)';
COMMENT ON POLICY hda_code_error_entries_owner_select ON hda_code_error_entries IS 'Владелец читает строки для функции app.hda_code_signature() и представления hda_code_checks, которые сами отбирают строки';
GRANT SELECT, INSERT, UPDATE ON hda_code_error_entries TO hub_app;

CREATE TABLE hda_code_error_templates (
  template_id uuid        NOT NULL DEFAULT uuidv7(),
  entry_id    uuid        NOT NULL,
  locale      text        NOT NULL,
  template    text        NOT NULL,
  pattern     text        NOT NULL GENERATED ALWAYS AS (app.hda_code_pattern(template)) STORED,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_code_error_templates_pk PRIMARY KEY (template_id),
  CONSTRAINT hda_code_error_templates_u1 UNIQUE (entry_id, locale),
  CONSTRAINT hda_code_error_templates_f1 FOREIGN KEY (entry_id) REFERENCES hda_code_error_entries (entry_id) ON DELETE CASCADE,
  -- Шаблон одной строкой без обратной косой черты: выражений и кода в шаблоне нет (FR-CODE-05, 12).
  CONSTRAINT hda_code_error_templates_c1 CHECK (char_length(template) BETWEEN 1 AND 500 AND position(E'\n' IN template) = 0 AND position(E'\r' IN template) = 0 AND position('\' IN template) = 0),
  CONSTRAINT hda_code_error_templates_c2 CHECK (locale ~ '^[a-z]{2}$')
);
CREATE INDEX hda_code_error_templates_i1 ON hda_code_error_templates (entry_id);
COMMENT ON INDEX hda_code_error_templates_i1 IS 'Внешний ключ: запись каталога';

COMMENT ON TABLE hda_code_error_templates IS 'Шаблоны сообщения записи каталога ошибок по языкам продукта (FR-CODE-02, 05): текст с именованными подстановками; выражение строит база. Доступ как у записи';
COMMENT ON COLUMN hda_code_error_templates.template_id IS 'Идентификатор шаблона';
COMMENT ON COLUMN hda_code_error_templates.entry_id IS 'Запись каталога ошибок';
COMMENT ON COLUMN hda_code_error_templates.locale IS 'Язык продукта шаблона (ru, uz, en и другие)';
COMMENT ON COLUMN hda_code_error_templates.template IS 'Текст сообщения с подстановками {name}, одной строкой';
COMMENT ON COLUMN hda_code_error_templates.pattern IS 'Выражение для сопоставления: генерирует база функцией app.hda_code_pattern() (FR-CODE-05)';
COMMENT ON COLUMN hda_code_error_templates.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_code_error_templates.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hda_code_error_templates.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_code_error_templates.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_code_error_templates_c1 ON hda_code_error_templates IS 'Шаблон одной строкой до 500 знаков без обратной косой черты';
COMMENT ON CONSTRAINT hda_code_error_templates_c2 ON hda_code_error_templates IS 'Язык двумя строчными буквами';

CREATE TRIGGER t_hda_code_error_templates_stamp
  BEFORE INSERT OR UPDATE ON hda_code_error_templates
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_code_error_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_code_error_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_code_error_templates_reader_select ON hda_code_error_templates FOR SELECT TO hub_app USING (app.hda_code_reader());
CREATE POLICY hda_code_error_templates_reader_insert ON hda_code_error_templates FOR INSERT TO hub_app WITH CHECK (app.hda_code_reader());
CREATE POLICY hda_code_error_templates_reader_update ON hda_code_error_templates FOR UPDATE TO hub_app USING (app.hda_code_reader()) WITH CHECK (app.hda_code_reader());
CREATE POLICY hda_code_error_templates_reader_delete ON hda_code_error_templates FOR DELETE TO hub_app USING (app.hda_code_reader());
CREATE POLICY hda_code_error_templates_agent_select ON hda_code_error_templates FOR SELECT TO hub_app USING (app.actor_type() = 'agent' AND app.agent_token_active());
CREATE POLICY hda_code_error_templates_agent_insert ON hda_code_error_templates FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_error_templates_agent_update ON hda_code_error_templates FOR UPDATE TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL)
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_error_templates_agent_delete ON hda_code_error_templates FOR DELETE TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_error_templates_owner_select ON hda_code_error_templates FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hda_code_error_templates_reader_select ON hda_code_error_templates IS 'Шаблоны читают agent_l2, care, admin';
COMMENT ON POLICY hda_code_error_templates_reader_insert ON hda_code_error_templates IS 'Шаблон на новом языке добавляет сотрудник при правке записи';
COMMENT ON POLICY hda_code_error_templates_reader_update ON hda_code_error_templates IS 'Шаблон правит сотрудник; выражение перестраивает база';
COMMENT ON POLICY hda_code_error_templates_reader_delete ON hda_code_error_templates IS 'Шаблон языка убирает сотрудник при правке записи';
COMMENT ON POLICY hda_code_error_templates_agent_select ON hda_code_error_templates IS 'AI-сотрудник читает шаблоны сохранённых выводов';
COMMENT ON POLICY hda_code_error_templates_agent_insert ON hda_code_error_templates IS 'Шаблоны записей пишет AI-сотрудник основным токеном';
COMMENT ON POLICY hda_code_error_templates_agent_update ON hda_code_error_templates IS 'AI-сотрудник обновляет шаблоны сканированием основным токеном';
COMMENT ON POLICY hda_code_error_templates_agent_delete ON hda_code_error_templates IS 'AI-сотрудник убирает шаблон языка, которого нет в новом сканировании';
COMMENT ON POLICY hda_code_error_templates_owner_select ON hda_code_error_templates IS 'Владелец читает строки для функции app.hda_code_signature()';
GRANT SELECT, INSERT, UPDATE, DELETE ON hda_code_error_templates TO hub_app;

-- ---------------------------------------------------------------------------
-- Карта модулей и экранов
-- ---------------------------------------------------------------------------
CREATE TABLE hda_code_module_notes (
  note_id     uuid        NOT NULL DEFAULT uuidv7(),
  scan_id     uuid        NOT NULL,
  decided_by  uuid,
  module_code text        NOT NULL,
  repository  text        NOT NULL,
  name        jsonb       NOT NULL,
  summary     text        NOT NULL DEFAULT '',
  depends_on  text[]      NOT NULL DEFAULT '{}',
  screens     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status      text        NOT NULL DEFAULT 'draft',
  change_kind text        NOT NULL DEFAULT 'new',
  scan_digest text        NOT NULL,
  decided_on  timestamptz,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_code_module_notes_pk PRIMARY KEY (note_id),
  CONSTRAINT hda_code_module_notes_u1 UNIQUE (module_code),
  CONSTRAINT hda_code_module_notes_f1 FOREIGN KEY (scan_id) REFERENCES hda_code_scans (scan_id),
  CONSTRAINT hda_code_module_notes_f2 FOREIGN KEY (decided_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_code_module_notes_c1 CHECK (status IN ('draft', 'approved', 'rejected', 'removed') AND change_kind IN ('new', 'changed', 'same')),
  CONSTRAINT hda_code_module_notes_c2 CHECK (jsonb_typeof(name) = 'object' AND name ? 'ru' AND jsonb_typeof(screens) = 'array' AND jsonb_array_length(screens) <= 200 AND octet_length(screens::text) <= 32000),
  CONSTRAINT hda_code_module_notes_c3 CHECK (char_length(module_code) BETWEEN 1 AND 80 AND char_length(summary) <= 2000 AND array_length(string_to_array(summary, E'\n'), 1) <= 10 AND cardinality(depends_on) <= 50),
  CONSTRAINT hda_code_module_notes_c4 CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL) AND (decided_by IS NULL) = (decided_on IS NULL)),
  CONSTRAINT hda_code_module_notes_c5 CHECK (scan_digest ~ '^[0-9a-f]{64}$' AND repository ~ '^[a-z0-9._-]{1,80}$')
);
CREATE INDEX hda_code_module_notes_i1 ON hda_code_module_notes (scan_id);
CREATE INDEX hda_code_module_notes_i2 ON hda_code_module_notes (decided_by) WHERE decided_by IS NOT NULL;
COMMENT ON INDEX hda_code_module_notes_i1 IS 'Внешний ключ: последнее сканирование, в котором был модуль';
COMMENT ON INDEX hda_code_module_notes_i2 IS 'Внешний ключ: кто решил по заметке';

COMMENT ON TABLE hda_code_module_notes IS 'Карта модулей и экранов из сканирования (FR-CODE-13): предложения обновить справочник модулей. Утверждает (применяет) только администратор. Клиент не видит';
COMMENT ON COLUMN hda_code_module_notes.note_id IS 'Идентификатор заметки о модуле';
COMMENT ON COLUMN hda_code_module_notes.scan_id IS 'Последнее сканирование, в отчёте которого был модуль';
COMMENT ON COLUMN hda_code_module_notes.decided_by IS 'Администратор, утвердивший или отклонивший предложение';
COMMENT ON COLUMN hda_code_module_notes.module_code IS 'Код модуля, как в Smartup';
COMMENT ON COLUMN hda_code_module_notes.repository IS 'Репозиторий, сканирование которого дало заметку';
COMMENT ON COLUMN hda_code_module_notes.name IS 'Название модуля по языкам; русское обязательно';
COMMENT ON COLUMN hda_code_module_notes.summary IS 'Краткое описание модуля';
COMMENT ON COLUMN hda_code_module_notes.depends_on IS 'Коды модулей, от которых зависит модуль';
COMMENT ON COLUMN hda_code_module_notes.screens IS 'Экраны модуля: код и название по языкам';
COMMENT ON COLUMN hda_code_module_notes.status IS 'draft, approved (применено к справочнику), rejected, removed (исчез из сканирования)';
COMMENT ON COLUMN hda_code_module_notes.change_kind IS 'Что с модулем в последнем сканировании: new, changed, same';
COMMENT ON COLUMN hda_code_module_notes.scan_digest IS 'Отпечаток содержимого от агента: сравнение со следующим сканированием';
COMMENT ON COLUMN hda_code_module_notes.decided_on IS 'Когда администратор решил по заметке';
COMMENT ON COLUMN hda_code_module_notes.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_code_module_notes.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hda_code_module_notes.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_code_module_notes.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_code_module_notes_c1 ON hda_code_module_notes IS 'Статус и вид изменения из перечня';
COMMENT ON CONSTRAINT hda_code_module_notes_c2 ON hda_code_module_notes IS 'Название с русским, экраны массивом до 200';
COMMENT ON CONSTRAINT hda_code_module_notes_c3 ON hda_code_module_notes IS 'Описание до 2000 знаков и 10 строк, зависимостей до 50';
COMMENT ON CONSTRAINT hda_code_module_notes_c4 ON hda_code_module_notes IS 'Решивший и момент решения только у утверждённой и отклонённой';
COMMENT ON CONSTRAINT hda_code_module_notes_c5 ON hda_code_module_notes IS 'Отпечаток sha256 и репозиторий в виде схемы отчёта';

CREATE TRIGGER t_hda_code_module_notes_stamp
  BEFORE INSERT OR UPDATE ON hda_code_module_notes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

CREATE FUNCTION app.hda_code_module_notes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_editable CONSTANT text[] := ARRAY['status', 'decided_by', 'decided_on', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF app.actor_type() = 'agent' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'draft' OR NEW.decided_by IS NOT NULL THEN
        RAISE EXCEPTION 'Знания из кода: AI-сотрудник пишет только черновики заметок о модулях' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.module_code IS DISTINCT FROM OLD.module_code
       OR NOT (NEW.status IN ('draft', 'removed') AND NEW.decided_by IS NULL
               OR NEW.status = OLD.status AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by AND NEW.decided_on IS NOT DISTINCT FROM OLD.decided_on AND NEW.scan_digest = OLD.scan_digest) THEN
      RAISE EXCEPTION 'Знания из кода: AI-сотрудник не решает по заметкам о модулях' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF app.actor_type() = 'staff' THEN
    IF TG_OP = 'INSERT' OR OLD.status = 'removed' OR NEW.status NOT IN ('approved', 'rejected')
       OR (to_jsonb(NEW) - v_editable) IS DISTINCT FROM (to_jsonb(OLD) - v_editable)
       OR NEW.decided_by::text IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'Знания из кода: администратор только утверждает или отклоняет заметку от своего имени' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_code_module_notes_guard() IS 'Триггер: AI-сотрудник не решает по заметкам о модулях; администратор только утверждает или отклоняет от своего имени';
CREATE TRIGGER t_hda_code_module_notes_guard
  BEFORE INSERT OR UPDATE ON hda_code_module_notes
  FOR EACH ROW EXECUTE FUNCTION app.hda_code_module_notes_guard();

ALTER TABLE hda_code_module_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_code_module_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_code_module_notes_reader_select ON hda_code_module_notes FOR SELECT TO hub_app USING (app.hda_code_reader());
CREATE POLICY hda_code_module_notes_admin_update ON hda_code_module_notes FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin') WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hda_code_module_notes_agent_select ON hda_code_module_notes FOR SELECT TO hub_app USING (app.actor_type() = 'agent' AND app.agent_token_active());
CREATE POLICY hda_code_module_notes_agent_insert ON hda_code_module_notes FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
CREATE POLICY hda_code_module_notes_agent_update ON hda_code_module_notes FOR UPDATE TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL)
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL);
COMMENT ON POLICY hda_code_module_notes_reader_select ON hda_code_module_notes IS 'Карту модулей читают agent_l2, care, admin';
COMMENT ON POLICY hda_code_module_notes_admin_update ON hda_code_module_notes IS 'Утверждает и отклоняет только администратор портала (FR-CODE-13)';
COMMENT ON POLICY hda_code_module_notes_agent_select ON hda_code_module_notes IS 'AI-сотрудник читает карту модулей';
COMMENT ON POLICY hda_code_module_notes_agent_insert ON hda_code_module_notes IS 'Заметки о модулях пишет AI-сотрудник основным токеном';
COMMENT ON POLICY hda_code_module_notes_agent_update ON hda_code_module_notes IS 'AI-сотрудник обновляет заметки сканированием основным токеном; решать не может (триггер)';
GRANT SELECT, INSERT, UPDATE ON hda_code_module_notes TO hub_app;

-- ---------------------------------------------------------------------------
-- Запросы "Разобрать по коду"
-- ---------------------------------------------------------------------------
CREATE TABLE hda_code_analysis_requests (
  org_id          uuid        NOT NULL,
  request_id      uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id       uuid        NOT NULL,
  requested_by    uuid,
  note_message_id uuid,
  source          text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  due_on          timestamptz NOT NULL,
  finished_on     timestamptz,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_code_analysis_requests_pk PRIMARY KEY (request_id),
  CONSTRAINT hda_code_analysis_requests_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hda_code_analysis_requests_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  CONSTRAINT hda_code_analysis_requests_f3 FOREIGN KEY (requested_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_code_analysis_requests_f4 FOREIGN KEY (note_message_id) REFERENCES hdt_ticket_messages (message_id),
  CONSTRAINT hda_code_analysis_requests_c1 CHECK (status IN ('pending', 'done', 'timeout')),
  CONSTRAINT hda_code_analysis_requests_c2 CHECK (source IN ('staff', 'rule') AND (source = 'staff') = (requested_by IS NOT NULL)),
  CONSTRAINT hda_code_analysis_requests_c3 CHECK ((status = 'pending') = (finished_on IS NULL) AND (note_message_id IS NULL OR status = 'done'))
);
CREATE UNIQUE INDEX hda_code_analysis_requests_u1 ON hda_code_analysis_requests (ticket_id) WHERE status = 'pending';
CREATE INDEX hda_code_analysis_requests_i1 ON hda_code_analysis_requests (org_id);
CREATE INDEX hda_code_analysis_requests_i2 ON hda_code_analysis_requests (ticket_id, created_on DESC);
CREATE INDEX hda_code_analysis_requests_i3 ON hda_code_analysis_requests (requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX hda_code_analysis_requests_i4 ON hda_code_analysis_requests (note_message_id) WHERE note_message_id IS NOT NULL;
CREATE INDEX hda_code_analysis_requests_i5 ON hda_code_analysis_requests (due_on) WHERE status = 'pending';
COMMENT ON INDEX hda_code_analysis_requests_u1 IS 'Не больше одного ожидающего запроса на обращение: повтор возвращает его же (решение 18)';
COMMENT ON INDEX hda_code_analysis_requests_i1 IS 'Внешний ключ: организация обращения';
COMMENT ON INDEX hda_code_analysis_requests_i2 IS 'Внешний ключ и последний запрос обращения для блока "Что известно по коду"';
COMMENT ON INDEX hda_code_analysis_requests_i3 IS 'Внешний ключ: кто запросил анализ';
COMMENT ON INDEX hda_code_analysis_requests_i4 IS 'Внешний ключ: заметка с ответом агента';
COMMENT ON INDEX hda_code_analysis_requests_i5 IS 'Задача code.analysis_timeouts: ожидающие запросы, срок которых вышел';

COMMENT ON TABLE hda_code_analysis_requests IS 'Запросы анализа обращения по коду (FR-CODE-08, 09, 10): кто и когда запросил, срок ответа 10 минут, заметка с ответом. Читают agent_l2, care, admin, агент свои видимые; клиент нет';
COMMENT ON COLUMN hda_code_analysis_requests.org_id IS 'Организация обращения';
COMMENT ON COLUMN hda_code_analysis_requests.request_id IS 'Идентификатор запроса: идёт агенту в теле события';
COMMENT ON COLUMN hda_code_analysis_requests.ticket_id IS 'Обращение, которое нужно разобрать';
COMMENT ON COLUMN hda_code_analysis_requests.requested_by IS 'Сотрудник, нажавший "Разобрать по коду"; пусто у запроса правила';
COMMENT ON COLUMN hda_code_analysis_requests.note_message_id IS 'Внутренняя заметка AI-сотрудника с ответом';
COMMENT ON COLUMN hda_code_analysis_requests.source IS 'Откуда запрос: staff (кнопка) или rule (правило автоматизации, FR-CODE-09)';
COMMENT ON COLUMN hda_code_analysis_requests.status IS 'pending (ждём ответа), done (заметка записана), timeout (агент не ответил за 10 минут)';
COMMENT ON COLUMN hda_code_analysis_requests.due_on IS 'До какого момента ждём ответа агента (FR-CODE-10)';
COMMENT ON COLUMN hda_code_analysis_requests.finished_on IS 'Когда запрос закончился ответом или истечением срока';
COMMENT ON COLUMN hda_code_analysis_requests.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_code_analysis_requests.created_on IS 'Когда создана строка (момент запроса). Заполняет база';
COMMENT ON COLUMN hda_code_analysis_requests.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_code_analysis_requests.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_code_analysis_requests_c1 ON hda_code_analysis_requests IS 'Статус из перечня 10.5';
COMMENT ON CONSTRAINT hda_code_analysis_requests_c2 ON hda_code_analysis_requests IS 'У запроса кнопкой есть сотрудник, у запроса правила нет';
COMMENT ON CONSTRAINT hda_code_analysis_requests_c3 ON hda_code_analysis_requests IS 'Момент окончания у законченного запроса; заметка только у выполненного';

CREATE TRIGGER t_hda_code_analysis_requests_stamp
  BEFORE INSERT OR UPDATE ON hda_code_analysis_requests
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Агент только отвечает (pending или timeout в done со ссылкой на заметку), система только ставит истечение срока.
CREATE FUNCTION app.hda_code_analysis_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_editable CONSTANT text[] := ARRAY['status', 'note_message_id', 'finished_on', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.note_message_id IS NOT NULL
       OR (app.actor_type() = 'staff' AND (NEW.source <> 'staff' OR NEW.requested_by::text IS DISTINCT FROM app.user_id()))
       OR (app.actor_type() = 'system' AND NEW.source <> 'rule') THEN
      RAISE EXCEPTION 'Знания из кода: запрос анализа создаётся ожидающим от имени того, кто его создал' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - v_editable) IS DISTINCT FROM (to_jsonb(OLD) - v_editable)
     OR (app.actor_type() = 'agent' AND NOT (OLD.status IN ('pending', 'timeout') AND NEW.status = 'done'))
     OR (app.actor_type() = 'system' AND NOT (OLD.status = 'pending' AND NEW.status = 'timeout' AND NEW.note_message_id IS NULL))
     OR app.actor_type() NOT IN ('agent', 'system') THEN
    RAISE EXCEPTION 'Знания из кода: запрос анализа закрывает только ответ агента или истечение срока' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_code_analysis_requests_guard() IS 'Триггер: запрос создаётся ожидающим от своего имени; агент только отвечает, система только ставит истечение срока';
CREATE TRIGGER t_hda_code_analysis_requests_guard
  BEFORE INSERT OR UPDATE ON hda_code_analysis_requests
  FOR EACH ROW EXECUTE FUNCTION app.hda_code_analysis_requests_guard();

ALTER TABLE hda_code_analysis_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_code_analysis_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_code_analysis_requests_reader_select ON hda_code_analysis_requests FOR SELECT TO hub_app USING (app.hda_code_reader());
CREATE POLICY hda_code_analysis_requests_reader_insert ON hda_code_analysis_requests FOR INSERT TO hub_app WITH CHECK (app.hda_code_reader());
CREATE POLICY hda_code_analysis_requests_system_select ON hda_code_analysis_requests FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hda_code_analysis_requests_system_insert ON hda_code_analysis_requests FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_code_analysis_requests_system_update ON hda_code_analysis_requests FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_code_analysis_requests_agent_select ON hda_code_analysis_requests FOR SELECT TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_can_see_org(org_id) AND (app.agent_ticket_id() IS NULL OR ticket_id = app.agent_ticket_id()));
CREATE POLICY hda_code_analysis_requests_agent_update ON hda_code_analysis_requests FOR UPDATE TO hub_app
  USING (app.actor_type() = 'agent' AND app.agent_can_see_org(org_id) AND (app.agent_ticket_id() IS NULL OR ticket_id = app.agent_ticket_id()))
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_can_see_org(org_id) AND (app.agent_ticket_id() IS NULL OR ticket_id = app.agent_ticket_id()));
COMMENT ON POLICY hda_code_analysis_requests_reader_select ON hda_code_analysis_requests IS 'Запросы читают agent_l2, care, admin';
COMMENT ON POLICY hda_code_analysis_requests_reader_insert ON hda_code_analysis_requests IS 'Запрос кнопкой создают agent_l2, care, admin от своего имени (триггер)';
COMMENT ON POLICY hda_code_analysis_requests_system_select ON hda_code_analysis_requests IS 'Система читает запросы: истечение срока и правило автоматизации';
COMMENT ON POLICY hda_code_analysis_requests_system_insert ON hda_code_analysis_requests IS 'Запрос правила автоматизации создаёт система (FR-CODE-09)';
COMMENT ON POLICY hda_code_analysis_requests_system_update ON hda_code_analysis_requests IS 'Система ставит истечение срока (FR-CODE-10); остальное закрывает триггер';
COMMENT ON POLICY hda_code_analysis_requests_agent_select ON hda_code_analysis_requests IS 'AI-сотрудник видит запросы обращений, видимых ему; токен запуска только своего';
COMMENT ON POLICY hda_code_analysis_requests_agent_update ON hda_code_analysis_requests IS 'AI-сотрудник отмечает ответ заметкой; остальное закрывает триггер';
GRANT SELECT, INSERT, UPDATE ON hda_code_analysis_requests TO hub_app;

-- ---------------------------------------------------------------------------
-- Первая линия и сигнатура по шаблонам
-- ---------------------------------------------------------------------------
-- Представление читает записи по политике владельца hda_code_error_entries_owner_select.
CREATE VIEW hda_code_checks WITH (security_barrier = true) AS
SELECT e.entry_id, e.key, e.signature, e.module_id, e.what_to_check
  FROM hda_code_error_entries e
 WHERE app.actor_type() = 'staff'
   AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin')
   AND e.status = 'approved';
COMMENT ON VIEW hda_code_checks IS 'Что проверить по утверждённым записям каталога ошибок для первой линии (FR-CODE-11): ключ, сигнатура, модуль и пункты. Без условий, причин и места в коде';
GRANT SELECT ON hda_code_checks TO hub_app;

-- Сигнатура по утверждённым шаблонам (FR-CODE-04, решение 8): любой актор получает только 32 знака хеша или пусто.
CREATE FUNCTION app.hda_code_signature(p_code text, p_lines text[]) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT e.signature
    FROM unnest(p_lines[1:31]) WITH ORDINALITY AS l(line, n)
    JOIN public.hda_code_error_templates t ON left(l.line, 500) ~* t.pattern
    JOIN public.hda_code_error_entries e ON e.entry_id = t.entry_id
   WHERE e.status = 'approved'
     AND (e.code IS NULL OR nullif(btrim(p_code), '') IS NULL OR e.code = upper(btrim(p_code)))
   ORDER BY l.n, char_length(t.template) DESC, e.key
   LIMIT 1
$$;
COMMENT ON FUNCTION app.hda_code_signature(text, text[]) IS 'Сигнатура утверждённой записи каталога, шаблон которой совпал с одной из строк (до 31), с учётом кода ошибки; иначе пусто. Других данных не отдаёт';
