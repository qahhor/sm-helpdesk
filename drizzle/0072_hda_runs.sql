-- Журнал вызовов модели (ТЗ 11.12, 14.3, поправка 101; план M5, задача 5, решения 2, 3, 13; логическое имя ai_runs).
-- Модуль hda открывается одной таблицей с целями solution_draft и translation; веха M5b дополнит её целями помощника.
--
-- Главное правило (поправка 101, проверка на AI-инъекции, пункт 10): журнал не хранит текста запроса и ответа. Иначе
-- он стал бы копией данных клиентов без их политик доступа. Здесь только цель, модель, токены, стоимость, время и
-- итог. По этой же таблице считается суточный предел вызовов (решение 13).
--
-- Пишет только фоновый процесс (система): модель вызывают только его задачи (решение 3). Читают сотрудники (учёт
-- расходов, FR-MET-06 в вехе M5b). Клиент не видит ни одной строки. Строки не меняются и не удаляются.

CREATE TABLE hda_runs (
  org_id        uuid,
  run_id        uuid          NOT NULL DEFAULT uuidv7(),
  ref_id        uuid,
  purpose       text          NOT NULL,
  model         text,
  input_tokens  integer       NOT NULL DEFAULT 0,
  output_tokens integer       NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms    integer       NOT NULL DEFAULT 0,
  outcome       text          NOT NULL,
  error_code    text,
  created_by    text,
  created_on    timestamptz   NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT hda_runs_pk PRIMARY KEY (run_id),
  CONSTRAINT hda_runs_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hda_runs_c1 CHECK (purpose IN ('solution_draft', 'translation')),
  CONSTRAINT hda_runs_c2 CHECK (outcome IN ('ok', 'invalid_response', 'failed', 'limited')),
  CONSTRAINT hda_runs_c3 CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cost_usd >= 0 AND latency_ms >= 0),
  CONSTRAINT hda_runs_c4 CHECK (model IS NULL OR char_length(model) <= 200),
  CONSTRAINT hda_runs_c5 CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$'),
  -- Модель не вызывалась: ни модели, ни токенов.
  CONSTRAINT hda_runs_c6 CHECK (outcome <> 'limited' OR (model IS NULL AND input_tokens = 0 AND output_tokens = 0))
);

CREATE INDEX hda_runs_i1 ON hda_runs (org_id);
-- Суточный предел считает вызовы за сутки.
CREATE INDEX hda_runs_i2 ON hda_runs (created_on);
CREATE INDEX hda_runs_i3 ON hda_runs (ref_id);

COMMENT ON TABLE hda_runs IS 'Журнал вызовов модели без текста запроса и ответа (ТЗ 11.12, поправка 101): цель, модель, токены, стоимость, время, итог. Пишет фоновый процесс, читают сотрудники';
COMMENT ON COLUMN hda_runs.org_id IS 'Организация, чьи данные ушли в модель (черновик из обращения). У перевода решения пусто: текст решения не данные организации';
COMMENT ON COLUMN hda_runs.run_id IS 'Идентификатор вызова';
COMMENT ON COLUMN hda_runs.ref_id IS 'Объект вызова: статья hdk_articles (черновик или перевод). Без внешнего ключа: журнал переживает объект';
COMMENT ON COLUMN hda_runs.purpose IS 'Цель вызова: solution_draft (черновик решения из обращения), translation (перевод решения)';
COMMENT ON COLUMN hda_runs.model IS 'Идентификатор модели из ответа API. Пусто, если модель не вызывалась (суточный предел)';
COMMENT ON COLUMN hda_runs.input_tokens IS 'Токены запроса из ответа API';
COMMENT ON COLUMN hda_runs.output_tokens IS 'Токены ответа из ответа API';
COMMENT ON COLUMN hda_runs.cost_usd IS 'Стоимость вызова в долларах по ценам уровня модели (src/modules/hda/pref.ts)';
COMMENT ON COLUMN hda_runs.latency_ms IS 'Время вызова в миллисекундах';
COMMENT ON COLUMN hda_runs.outcome IS 'Итог: ok, invalid_response (ответ не прошёл разбор или схему), failed (нет ответа), limited (суточный предел, модель не вызывалась)';
COMMENT ON COLUMN hda_runs.error_code IS 'Код сбоя без текста: timeout, http_429, schema и подобные. У удачного вызова пусто';
COMMENT ON COLUMN hda_runs.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_runs.created_on IS 'Когда сделан вызов. Заполняет база';
COMMENT ON COLUMN hda_runs.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_runs.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hda_runs_stamp
  BEFORE INSERT OR UPDATE ON hda_runs
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY hda_runs_internal_select ON hda_runs FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hda_runs_system_insert ON hda_runs FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hda_runs_internal_select ON hda_runs IS 'Журнал вызовов читают сотрудники и система (суточный предел). Клиент не читает';
COMMENT ON POLICY hda_runs_system_insert ON hda_runs IS 'Вызов записывает только фоновый процесс: модель вызывают только его задачи (решение 3)';

GRANT SELECT, INSERT ON hda_runs TO hub_app;
