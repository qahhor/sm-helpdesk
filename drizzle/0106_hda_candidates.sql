-- Веха M5c, задача 9: кандидаты в решения (ТЗ 7.16, FR-CAND-01, 02, 03, 05, 07, 09, 10.5 solution_candidates и
-- solution_candidate_sources; план M5c, решения 1, 26-28). Номер миграции сдвинут на два от плана (0104).
--
-- 1. hda_solution_candidates: черновик решения, который AI подготовил из закрытого обращения без решения. Текст
--    видят только сотрудники с правом черновика решения (app.kb_can_write), клиент не видит ни одной строки. Кандидат
--    не попадает в hdk_search_documents и Typesense: подсказка и помощник его не находят, пока сотрудник не
--    опубликует решение обычным порядком (FR-CAND-06). Пишет система (задания ai.candidate, ai.candidates_embed),
--    решают сотрудники (задача 10).
-- 2. hda_candidate_sources: обращения-источники кандидата. Одно обращение даёт не больше одного кандидата.
-- 3. hdk_articles.staff_useful_count: сколько раз кандидат оказался похож на это опубликованное решение
--    ("пригодилось сотрудникам", FR-CAND-03): кандидата нет, у решения растёт счётчик.
-- 4. Цель вызова candidate в hda_runs_c1, решение кода skipped (модель не уверена, кандидата нет) в hda_runs_c7.

CREATE TABLE hda_solution_candidates (
  candidate_id             uuid         NOT NULL DEFAULT uuidv7(),
  module_id                uuid,
  article_id               uuid,
  decided_by               uuid,
  locale                   text         NOT NULL,
  title                    text         NOT NULL,
  problem                  text         NOT NULL DEFAULT '',
  steps                    jsonb        NOT NULL DEFAULT '[]'::jsonb,
  findings                 jsonb        NOT NULL DEFAULT '[]'::jsonb,
  embedding                vector(1024),
  status                   text         NOT NULL DEFAULT 'new',
  source_count             integer      NOT NULL DEFAULT 0,
  org_count                integer      NOT NULL DEFAULT 0,
  rejected_at_source_count integer,
  reject_reason            text,
  reject_comment           text,
  decided_on               timestamptz,
  created_by               text,
  created_on               timestamptz  NOT NULL DEFAULT now(),
  modified_by              text,
  modified_on              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT hda_solution_candidates_pk PRIMARY KEY (candidate_id),
  CONSTRAINT hda_solution_candidates_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hda_solution_candidates_f2 FOREIGN KEY (article_id) REFERENCES hdk_articles (article_id),
  CONSTRAINT hda_solution_candidates_f3 FOREIGN KEY (decided_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_solution_candidates_c1 CHECK (status IN ('new', 'accepted', 'merged', 'rejected')),
  CONSTRAINT hda_solution_candidates_c2 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hda_solution_candidates_c3 CHECK (char_length(title) BETWEEN 1 AND 140 AND char_length(problem) <= 1200),
  CONSTRAINT hda_solution_candidates_c4 CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 12),
  CONSTRAINT hda_solution_candidates_c5 CHECK (jsonb_typeof(findings) = 'array'),
  CONSTRAINT hda_solution_candidates_c6 CHECK (source_count >= 0 AND org_count >= 0 AND org_count <= source_count),
  CONSTRAINT hda_solution_candidates_c7 CHECK (reject_reason IS NULL OR reject_reason IN ('duplicate', 'too_specific', 'not_a_solution', 'wrong_data', 'other')),
  CONSTRAINT hda_solution_candidates_c8 CHECK (status <> 'rejected' OR (reject_reason IS NOT NULL AND rejected_at_source_count IS NOT NULL)),
  CONSTRAINT hda_solution_candidates_c9 CHECK (status NOT IN ('accepted', 'merged') OR article_id IS NOT NULL),
  CONSTRAINT hda_solution_candidates_c10 CHECK (reject_comment IS NULL OR char_length(reject_comment) <= 1000)
);

CREATE INDEX hda_solution_candidates_i1 ON hda_solution_candidates (module_id) WHERE module_id IS NOT NULL;
CREATE INDEX hda_solution_candidates_i2 ON hda_solution_candidates (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX hda_solution_candidates_i3 ON hda_solution_candidates (decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX hda_solution_candidates_i4 ON hda_solution_candidates (status, source_count DESC, org_count DESC);
CREATE INDEX hda_solution_candidates_i5 ON hda_solution_candidates USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
COMMENT ON INDEX hda_solution_candidates_i1 IS 'Внешний ключ: модуль; фильтр очереди по модулю';
COMMENT ON INDEX hda_solution_candidates_i2 IS 'Внешний ключ: решение из кандидата или решение, с которым кандидат объединён';
COMMENT ON INDEX hda_solution_candidates_i3 IS 'Внешний ключ: кто решил';
COMMENT ON INDEX hda_solution_candidates_i4 IS 'Очередь кандидатов: по статусу, больше источников и организаций сверху (FR-CAND-04)';
COMMENT ON INDEX hda_solution_candidates_i5 IS 'Склейка похожих кандидатов по косинусному сходству векторов BGE-M3 (FR-CAND-02)';

COMMENT ON TABLE hda_solution_candidates IS 'Кандидаты в решения из закрытых обращений (логическое имя solution_candidates, FR-CAND-01..09). Пишет система, решают сотрудники с правом черновика решения, клиент не видит. В поисковый индекс не попадает';
COMMENT ON COLUMN hda_solution_candidates.candidate_id IS 'Идентификатор кандидата';
COMMENT ON COLUMN hda_solution_candidates.module_id IS 'Модуль первого обращения-источника. Пусто: модуль не указан';
COMMENT ON COLUMN hda_solution_candidates.article_id IS 'Решение-черновик из кандидата (accepted) или решение, с которым кандидат объединён (merged)';
COMMENT ON COLUMN hda_solution_candidates.decided_by IS 'Кто принял, объединил или отклонил';
COMMENT ON COLUMN hda_solution_candidates.locale IS 'Язык текста кандидата: язык первого обращения-источника';
COMMENT ON COLUMN hda_solution_candidates.title IS 'Заголовок черновика AI (до 140 знаков). Ссылки вне разрешённых доменов вырезаны до записи';
COMMENT ON COLUMN hda_solution_candidates.problem IS 'Описание проблемы из черновика AI (до 1200 знаков)';
COMMENT ON COLUMN hda_solution_candidates.steps IS 'Шаги решения из черновика AI: массив строк до 12';
COMMENT ON COLUMN hda_solution_candidates.findings IS 'Находки проверки текста для подсветки: массив {kind, text} (телефон, почта, ИНН, длинные числа и другие, FR-CAND-09)';
COMMENT ON COLUMN hda_solution_candidates.embedding IS 'Вектор заголовка и проблемы (BGE-M3, 1024). Пусто: сервис векторов был недоступен, досчитает ночная задача ai.candidates_embed';
COMMENT ON COLUMN hda_solution_candidates.status IS 'new (ждёт решения), accepted (сделан черновиком решения), merged (объединён с решением), rejected (отклонён)';
COMMENT ON COLUMN hda_solution_candidates.source_count IS 'Сколько обращений-источников склеено в кандидата';
COMMENT ON COLUMN hda_solution_candidates.org_count IS 'Сколько различных организаций у источников';
COMMENT ON COLUMN hda_solution_candidates.rejected_at_source_count IS 'Число источников в момент отклонения: отклонённый возвращается в new, когда новых источников стало не меньше пяти (FR-CAND-05)';
COMMENT ON COLUMN hda_solution_candidates.reject_reason IS 'Причина отклонения из списка: duplicate, too_specific, not_a_solution, wrong_data, other';
COMMENT ON COLUMN hda_solution_candidates.reject_comment IS 'Комментарий сотрудника к отклонению (до 1000 знаков)';
COMMENT ON COLUMN hda_solution_candidates.decided_on IS 'Когда принято последнее решение по кандидату';
COMMENT ON COLUMN hda_solution_candidates.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_solution_candidates.created_on IS 'Когда кандидат появился. Заполняет база';
COMMENT ON COLUMN hda_solution_candidates.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_solution_candidates.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_solution_candidates_c6 ON hda_solution_candidates IS 'Организаций не больше, чем источников';
COMMENT ON CONSTRAINT hda_solution_candidates_c8 ON hda_solution_candidates IS 'У отклонённого есть причина и число источников в момент отклонения';
COMMENT ON CONSTRAINT hda_solution_candidates_c9 ON hda_solution_candidates IS 'У принятого и объединённого есть решение';

CREATE TRIGGER t_hda_solution_candidates_stamp
  BEFORE INSERT OR UPDATE ON hda_solution_candidates
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_solution_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_solution_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_solution_candidates_writer_select ON hda_solution_candidates FOR SELECT TO hub_app USING (app.kb_can_write());
CREATE POLICY hda_solution_candidates_system_insert ON hda_solution_candidates FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_solution_candidates_writer_update ON hda_solution_candidates FOR UPDATE TO hub_app USING (app.kb_can_write()) WITH CHECK (app.kb_can_write());
CREATE POLICY hda_solution_candidates_system_delete ON hda_solution_candidates FOR DELETE TO hub_app USING (app.actor_type() = 'system' AND decided_by IS NULL);
COMMENT ON POLICY hda_solution_candidates_writer_select ON hda_solution_candidates IS 'Кандидатов читают система и сотрудники с правом черновика решения (все роли, кроме product). Клиент не читает';
COMMENT ON POLICY hda_solution_candidates_system_insert ON hda_solution_candidates IS 'Кандидата создаёт только фоновый процесс';
COMMENT ON POLICY hda_solution_candidates_writer_update ON hda_solution_candidates IS 'Склейку пишет система, решение по кандидату сотрудник с правом черновика решения';
COMMENT ON POLICY hda_solution_candidates_system_delete ON hda_solution_candidates IS 'Опустевшего после ночной склейки кандидата удаляет система; решённого сотрудником кандидата не удаляет никто';
GRANT SELECT, INSERT, UPDATE, DELETE ON hda_solution_candidates TO hub_app;

CREATE TABLE hda_candidate_sources (
  org_id       uuid        NOT NULL,
  source_id    uuid        NOT NULL DEFAULT uuidv7(),
  candidate_id uuid        NOT NULL,
  ticket_id    uuid        NOT NULL,
  created_by   text,
  created_on   timestamptz NOT NULL DEFAULT now(),
  modified_by  text,
  modified_on  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_candidate_sources_pk PRIMARY KEY (source_id),
  CONSTRAINT hda_candidate_sources_f1 FOREIGN KEY (candidate_id) REFERENCES hda_solution_candidates (candidate_id),
  CONSTRAINT hda_candidate_sources_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  CONSTRAINT hda_candidate_sources_u1 UNIQUE (ticket_id)
);
CREATE INDEX hda_candidate_sources_i1 ON hda_candidate_sources (candidate_id);
CREATE INDEX hda_candidate_sources_i2 ON hda_candidate_sources (org_id);
COMMENT ON INDEX hda_candidate_sources_i1 IS 'Внешний ключ: кандидат; источники кандидата и пересчёт счётчиков';
COMMENT ON INDEX hda_candidate_sources_i2 IS 'Внешний ключ: организация обращения';
COMMENT ON TABLE hda_candidate_sources IS 'Обращения-источники кандидата в решение (логическое имя solution_candidate_sources). Одно обращение даёт одного кандидата. Клиент не видит';
COMMENT ON COLUMN hda_candidate_sources.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу): число различных организаций кандидата';
COMMENT ON COLUMN hda_candidate_sources.source_id IS 'Идентификатор строки';
COMMENT ON COLUMN hda_candidate_sources.candidate_id IS 'Кандидат';
COMMENT ON COLUMN hda_candidate_sources.ticket_id IS 'Закрытое обращение-источник';
COMMENT ON COLUMN hda_candidate_sources.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_candidate_sources.created_on IS 'Когда источник добавлен. Заполняет база';
COMMENT ON COLUMN hda_candidate_sources.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_candidate_sources.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_candidate_sources_u1 ON hda_candidate_sources IS 'Одно обращение даёт не больше одного кандидата: повтор задания не создаёт второго источника';

CREATE TRIGGER t_hda_candidate_sources_stamp
  BEFORE INSERT OR UPDATE ON hda_candidate_sources
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_candidate_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_candidate_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_candidate_sources_writer_select ON hda_candidate_sources FOR SELECT TO hub_app USING (app.kb_can_write());
CREATE POLICY hda_candidate_sources_system_insert ON hda_candidate_sources FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_candidate_sources_system_update ON hda_candidate_sources FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hda_candidate_sources_writer_select ON hda_candidate_sources IS 'Источники читают система и сотрудники с правом черновика решения. Клиент не читает';
COMMENT ON POLICY hda_candidate_sources_system_insert ON hda_candidate_sources IS 'Источник добавляет только фоновый процесс (создание кандидата и склейка)';
COMMENT ON POLICY hda_candidate_sources_system_update ON hda_candidate_sources IS 'Источник к другому кандидату переносит только ночная склейка фонового процесса';
GRANT SELECT, INSERT, UPDATE ON hda_candidate_sources TO hub_app;

ALTER TABLE hdk_articles ADD COLUMN staff_useful_count integer NOT NULL DEFAULT 0;
ALTER TABLE hdk_articles ADD CONSTRAINT hdk_articles_c7 CHECK (staff_useful_count >= 0);
COMMENT ON COLUMN hdk_articles.staff_useful_count IS 'Пригодилось сотрудникам: сколько закрытых обращений без решения оказались похожи на это решение (FR-CAND-03, кандидат не создан) или объединены с ним (FR-CAND-04)';
COMMENT ON CONSTRAINT hdk_articles_c7 ON hdk_articles IS 'Счётчик "пригодилось сотрудникам" не отрицательный';

ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c1;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c1 CHECK (purpose IN ('solution_draft', 'translation', 'idea_translation', 'first_line', 'triage', 'message_translation', 'thanks', 'problem_translation', 'announcement_translation', 'candidate'));
ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c7;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c7 CHECK (decision IS NULL OR decision IN ('answer', 'clarify', 'handoff', 'skipped'));
COMMENT ON CONSTRAINT hda_runs_c7 ON hda_runs IS 'Решение кода: ответ, вопрос, передача; skipped у кандидата, когда модель не уверена';
