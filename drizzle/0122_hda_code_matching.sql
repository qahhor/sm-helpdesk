-- Независимая проверка вехи M8c "Знания из кода", часть 1: сопоставление с шаблонами и тексты выводов (решение 0134;
-- находки C1, C2, I1, M2, M3). Миграции 0118-0121 не меняются.
--
-- 1. Выражение из шаблона строится разбиением текста по подстановкам (app.hda_code_pattern): знака-заместителя
--    больше нет, управляющий знак шаблона не становится подстановкой (C2). Выражения прежних строк без управляющих знаков те же.
-- 2. Буквальные слова шаблона (генерируемая колонка literals, строчными, длинные первыми): строка обращения
--    проверяется на все слова шаблона до регулярного выражения (C1).
-- 3. app.hda_code_matches(): одно сопоставление для сигнатуры и блока обращения (M2). Сначала утверждённые (или
--    переданные) статусы, затем слова шаблона, только потом выражение: каждый шаблон компилируется один раз, не
--    больше 500 проверок выражением и 300 мс, иначе пусто (сигнатура тогда по 11.5). Неверное выражение шаблона
--    пропускается. Запись с кодом ошибки сопоставляется и со строкой без кода (M3, решение 0134).
-- 4. Проверки текстов (C2, I1): ни одного управляющего и форматирующего знака, разделителя строк и абзацев; в
--    многострочных полях только \n, не больше 10 строк и 300 знаков в строке. Проверки добавляются NOT VALID и
--    подтверждаются, если прежние строки им уже отвечают; новые и изменённые строки проверяются всегда.
--    FORCE ROW LEVEL SECURITY не снимается.
-- 5. Триггер шаблона: выражение шаблона компилируется при записи, неверное выражение не записать (C2).

-- ---------------------------------------------------------------------------
-- Проверки текста
-- ---------------------------------------------------------------------------
-- Знаки: управляющие Cc (кроме \n в многострочном), форматирующие Cf, разделители строк и абзацев Zl, Zp.
CREATE FUNCTION app.hda_code_text_ok(p_text text, p_max_lines integer, p_line_max integer) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT p_text IS NULL OR (
    p_text !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f­؀-؅؜۝܏࣢᠎​-‏ -‮⁠-⁤⁦-⁯﻿￹-￻\U000110bd\U000110cd\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
    AND (p_max_lines > 1 OR position(E'\n' IN p_text) = 0)
    AND (SELECT count(*) <= p_max_lines AND coalesce(max(char_length(s.line)), 0) <= p_line_max FROM unnest(string_to_array(p_text, E'\n')) AS s(line))
  )
$$;
COMMENT ON FUNCTION app.hda_code_text_ok(text, integer, integer) IS 'Текст вывода знаний из кода: без управляющих, форматирующих знаков и разделителей строк (кроме \n), не больше строк и знаков в строке (решение 0134, находки C2, I1)';

CREATE FUNCTION app.hda_code_jsonb_ok(p_value jsonb, p_max_lines integer, p_line_max integer) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT p_value IS NULL OR NOT EXISTS (
    SELECT 1 FROM jsonb_path_query(p_value, 'strict $.** ? (@.type() == "string")') AS s(item)
     WHERE NOT app.hda_code_text_ok(s.item #>> '{}', p_max_lines, p_line_max))
$$;
COMMENT ON FUNCTION app.hda_code_jsonb_ok(jsonb, integer, integer) IS 'Каждая строка значения jsonb отвечает app.hda_code_text_ok() (решение 0134)';

-- ---------------------------------------------------------------------------
-- Выражение и слова шаблона
-- ---------------------------------------------------------------------------
-- Текст между подстановками экранируется, пробелы допускают любой пробельный промежуток, подстановки становятся
-- группами. Разбиение по подстановкам вместо знака-заместителя: в тексте шаблона нет знака, который стал бы группой.
CREATE OR REPLACE FUNCTION app.hda_code_pattern(p_template text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT '^\s*'
      || array_to_string(ARRAY(
           SELECT regexp_replace(regexp_replace(s.part, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), '\s+', '\\s+', 'g')
             FROM unnest(regexp_split_to_array(btrim(p_template), '\{[A-Za-z_][A-Za-z0-9_]{0,39}\}')) WITH ORDINALITY AS s(part, n)
            ORDER BY s.n), '(.{1,200}?)')
      || '\s*[.!]?\s*$'
$$;
COMMENT ON FUNCTION app.hda_code_pattern(text) IS 'Выражение для сопоставления из шаблона сообщения: текст между подстановками буквально, подстановки в группы (FR-CODE-05, план M8c, решение 6; решение 0134, находка C2)';

-- Слова шаблона вне подстановок строчными, длинные первыми: строка без любого из них шаблону не отвечает.
CREATE FUNCTION app.hda_code_literals(p_template text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT coalesce(array_agg(d.word ORDER BY char_length(d.word) DESC, d.word), '{}')
    FROM (SELECT DISTINCT s.word
            FROM regexp_split_to_table(lower(regexp_replace(btrim(p_template), '\{[A-Za-z_][A-Za-z0-9_]{0,39}\}', ' ', 'g')), '\s+') AS s(word)
           WHERE s.word <> '') AS d
$$;
COMMENT ON FUNCTION app.hda_code_literals(text) IS 'Буквальные слова шаблона строчными, длинные первыми: предварительный отбор перед выражением (решение 0134, находка C1)';

ALTER TABLE hda_code_error_templates ADD COLUMN literals text[] NOT NULL GENERATED ALWAYS AS (app.hda_code_literals(template)) STORED;
COMMENT ON COLUMN hda_code_error_templates.literals IS 'Слова шаблона вне подстановок строчными, длинные первыми: генерирует база функцией app.hda_code_literals() (решение 0134)';
-- Выражения прежних строк не пересчитываются: для шаблона без управляющих знаков новая функция даёт то же выражение,
-- а выражение строки с управляющим знаком (старый знак-заместитель) сопоставление пропускает при ошибке компиляции.

-- ---------------------------------------------------------------------------
-- Проверки строк
-- ---------------------------------------------------------------------------
ALTER TABLE hda_code_error_templates ADD CONSTRAINT hda_code_error_templates_c3 CHECK (app.hda_code_text_ok(template, 1, 500)) NOT VALID;
COMMENT ON CONSTRAINT hda_code_error_templates_c3 ON hda_code_error_templates IS 'Шаблон без управляющих и форматирующих знаков (решение 0134, находка C2)';
ALTER TABLE hda_code_error_entries ADD CONSTRAINT hda_code_error_entries_c9 CHECK (
  app.hda_code_text_ok(conditions, 10, 300) AND app.hda_code_text_ok(user_cause, 10, 300) AND app.hda_code_text_ok(reject_reason, 10, 500)
  AND app.hda_code_jsonb_ok(what_to_check, 10, 300) AND app.hda_code_jsonb_ok(raised_in, 1, 300)) NOT VALID;
COMMENT ON CONSTRAINT hda_code_error_entries_c9 ON hda_code_error_entries IS 'Тексты без управляющих и форматирующих знаков, строки только по \n, не длиннее 300 знаков (решение 0134, находки C2, I1)';
ALTER TABLE hda_code_module_notes ADD CONSTRAINT hda_code_module_notes_c6 CHECK (
  app.hda_code_text_ok(summary, 10, 300) AND app.hda_code_jsonb_ok(name, 1, 300) AND app.hda_code_jsonb_ok(screens, 1, 300)) NOT VALID;
COMMENT ON CONSTRAINT hda_code_module_notes_c6 ON hda_code_module_notes IS 'Описание и названия без управляющих и форматирующих знаков, строки только по \n, не длиннее 300 знаков (решение 0134)';

-- Прежние строки: проверка подтверждается, если они ей уже отвечают; иначе остаётся NOT VALID (новые и изменённые
-- строки проверяются всё равно). Подтверждение читает таблицу целиком, мимо политик строк.
DO $$
BEGIN
  BEGIN
    ALTER TABLE hda_code_error_templates VALIDATE CONSTRAINT hda_code_error_templates_c3;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'hda_code_error_templates_c3 остаётся NOT VALID: есть прежние строки с управляющими знаками';
  END;
  BEGIN
    ALTER TABLE hda_code_error_entries VALIDATE CONSTRAINT hda_code_error_entries_c9;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'hda_code_error_entries_c9 остаётся NOT VALID: есть прежние строки с управляющими знаками или длинными строками';
  END;
  BEGIN
    ALTER TABLE hda_code_module_notes VALIDATE CONSTRAINT hda_code_module_notes_c6;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'hda_code_module_notes_c6 остаётся NOT VALID: есть прежние строки с управляющими знаками или длинными строками';
  END;
END
$$;

-- Выражение шаблона компилируется при записи (C2): шаблон, из которого не строится выражение, не записать.
CREATE FUNCTION app.hda_code_error_templates_check() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  BEGIN
    PERFORM '' ~* app.hda_code_pattern(NEW.template);
  EXCEPTION WHEN invalid_regular_expression OR program_limit_exceeded THEN
    RAISE EXCEPTION 'Знания из кода: из шаблона не строится выражение для сопоставления' USING ERRCODE = '23514';
  END;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_code_error_templates_check() IS 'Триггер: выражение шаблона компилируется при записи; неверное выражение не записать (решение 0134, находка C2)';
CREATE TRIGGER t_hda_code_error_templates_check
  BEFORE INSERT OR UPDATE OF template ON hda_code_error_templates
  FOR EACH ROW EXECUTE FUNCTION app.hda_code_error_templates_check();

-- ---------------------------------------------------------------------------
-- Сопоставление
-- ---------------------------------------------------------------------------
-- С правами вызывающего: блок обращения читает по политикам сотрудника, сигнатура с правами владельца (ниже).
CREATE FUNCTION app.hda_code_matches(p_code text, p_lines text[], p_statuses text[])
RETURNS TABLE (entry_id uuid, signature text, key text, status text, line_no integer, template_length integer)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS
$$
DECLARE
  v_lines text[];
  v_lower text[];
  v_code text := upper(nullif(btrim(p_code), ''));
  v_started timestamptz := clock_timestamp();
  v_checked integer := 0;
  v_ids uuid[] := '{}';
  v_signatures text[] := '{}';
  v_keys text[] := '{}';
  v_statuses text[] := '{}';
  v_line_nos integer[] := '{}';
  v_lengths integer[] := '{}';
  r record;
BEGIN
  SELECT coalesce(array_agg(left(u.line, 500) ORDER BY u.n), '{}'), coalesce(array_agg(lower(left(u.line, 500)) ORDER BY u.n), '{}')
    INTO v_lines, v_lower
    FROM unnest(p_lines[1:31]) WITH ORDINALITY AS u(line, n)
   WHERE u.line IS NOT NULL AND btrim(u.line) <> '';
  IF cardinality(v_lines) = 0 THEN
    RETURN;
  END IF;
  -- Пары "шаблон и строка", где в строке есть все слова шаблона; шаблоны подряд: выражение компилируется один раз.
  FOR r IN
    SELECT t.pattern, char_length(t.template) AS len, e.entry_id AS id, e.signature AS sig, e.key AS k, e.status AS st, x.n
      FROM public.hda_code_error_templates t
      JOIN public.hda_code_error_entries e ON e.entry_id = t.entry_id
      CROSS JOIN LATERAL unnest(v_lower) WITH ORDINALITY AS x(line, n)
     WHERE e.status = ANY (p_statuses)
       AND (e.code IS NULL OR v_code IS NULL OR e.code = v_code)
       AND cardinality(t.literals) > 0
       AND position(t.literals[1] IN x.line) > 0
       AND NOT EXISTS (SELECT 1 FROM unnest(t.literals[2:]) AS w(word) WHERE position(w.word IN x.line) = 0)
     ORDER BY char_length(t.template) DESC, e.key, t.locale, x.n
  LOOP
    v_checked := v_checked + 1;
    -- Предел работы: дальше сопоставление не идёт, сигнатура определяется по 11.5.
    IF v_checked > 500 OR clock_timestamp() - v_started > interval '300 milliseconds' THEN
      RETURN;
    END IF;
    BEGIN
      IF v_lines[r.n] ~* r.pattern THEN
        v_ids := v_ids || r.id;
        v_signatures := v_signatures || r.sig;
        v_keys := v_keys || r.k;
        v_statuses := v_statuses || r.st;
        v_line_nos := v_line_nos || r.n::integer;
        v_lengths := v_lengths || r.len;
      END IF;
    EXCEPTION WHEN invalid_regular_expression OR program_limit_exceeded THEN
      NULL;
    END;
  END LOOP;
  RETURN QUERY SELECT * FROM unnest(v_ids, v_signatures, v_keys, v_statuses, v_line_nos, v_lengths);
END
$$;
COMMENT ON FUNCTION app.hda_code_matches(text, text[], text[]) IS 'Записи каталога с данными статусами, шаблон которых совпал со строкой (до 31), с учётом кода ошибки: номер строки и длина шаблона. Не дольше 300 мс и 500 проверок выражением, иначе пусто (решение 0134, находки C1, M2, M3)';

CREATE OR REPLACE FUNCTION app.hda_code_signature(p_code text, p_lines text[]) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT m.signature
    FROM app.hda_code_matches(p_code, p_lines, ARRAY['approved']) AS m
   ORDER BY m.line_no, m.template_length DESC, m.key
   LIMIT 1
$$;
COMMENT ON FUNCTION app.hda_code_signature(text, text[]) IS 'Сигнатура утверждённой записи каталога, шаблон которой совпал с одной из строк (до 31), с учётом кода ошибки; иначе пусто. Других данных не отдаёт (решение 0134: сопоставление app.hda_code_matches)';
