-- Знания: решения в таблицах статей (ТЗ 7.5 FR-SOL-01..19, 10.4, 10.5, правки 1-3 и 9 раздела 10.6, 18.10; план M5,
-- задача 2, решения 8, 10, 11, 12, 16). Имена: docs/naming.md, соответствие логических имён в плане M5.
--
-- Главное правило (ТЗ 10.5): клиент получает текст решения только из hdk_published, это копия опубликованной
-- версии. Черновики, история версий, переводы в работе, источник решения (обращение), файлы, сигнатуры и исходы
-- подсказки лежат в таблицах, где у клиента нет ни одной политики. RLS защищает строки, а не колонки, поэтому всё,
-- что клиент видеть не должен, вынесено в отдельные таблицы. Из hdk_published и индекса hdk_search_documents клиент
-- читает только строки с audience = 'clients'. Решения не данные арендатора: клиенты всех организаций видят одни и
-- те же опубликованные решения. Актора посетителя (public) на этапе 1 нет: решения открыты только вошедшим (FR-SOL-15).
--
-- Права сотрудников (решение 10): черновики создают и правят agent_l1, agent_l2, care, admin; публикуют и архивируют
-- agent_l2, care, admin; product только читает. Фоновые задачи (система) пишут то же, что публикующие, и, кроме того,
-- индекс, сигнатуры по организациям и исходы подсказки. Права проверяются и в коде, и здесь.
--
-- Индекс hdk_search_documents создаётся здесь вместе с правилами доступа; триггер tsv, индексы GIN и HNSW и задание
-- kb.index добавляет задача 9. Журнал вызовов модели hda_runs создаёт задача 5 (модуль hda).

CREATE FUNCTION app.kb_can_write() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin')) $$;
COMMENT ON FUNCTION app.kb_can_write() IS 'Истина для системы и сотрудника, который пишет черновики решений: все роли, кроме product (план M5, решение 10)';

CREATE FUNCTION app.kb_can_publish() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin')) $$;
COMMENT ON FUNCTION app.kb_can_publish() IS 'Истина для системы и сотрудника, который публикует и архивирует решения: agent_l2, care, admin (FR-SOL-05)';

CREATE SEQUENCE hdk_articles_number_sq START 1001;
COMMENT ON SEQUENCE hdk_articles_number_sq IS 'Номера статей для адреса /help/a/<номер>-<slug> (правка 11 раздела 10.6). Начало 1001, пропуски возможны';

-- ---------------------------------------------------------------------------
-- hdk_articles: статьи (на этапе 1 только решения)
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_articles (
  article_id       uuid        NOT NULL DEFAULT uuidv7(),
  module_id        uuid,
  owner_id         uuid,
  number           bigint      NOT NULL DEFAULT nextval('hdk_articles_number_sq'),
  type             text        NOT NULL DEFAULT 'solution',
  audience         text        NOT NULL DEFAULT 'clients',
  original_locale  text        NOT NULL,
  shown_count      integer     NOT NULL DEFAULT 0,
  helped_count     integer     NOT NULL DEFAULT 0,
  not_helped_count integer     NOT NULL DEFAULT 0,
  archived_on      timestamptz,
  status           text        NOT NULL DEFAULT 'active',
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_articles_pk PRIMARY KEY (article_id),
  CONSTRAINT hdk_articles_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdk_articles_f2 FOREIGN KEY (owner_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdk_articles_u1 UNIQUE (number),
  -- Цели составных внешних ключей копии для читателей: номер и аудитория копии всегда равны статье.
  CONSTRAINT hdk_articles_u2 UNIQUE (article_id, number),
  CONSTRAINT hdk_articles_u3 UNIQUE (article_id, audience),
  CONSTRAINT hdk_articles_c1 CHECK (type IN ('solution')),
  -- public появится на этапе 2 вместе с открытыми страницами (правка 1 раздела 10.6): до тех пор база его не принимает.
  CONSTRAINT hdk_articles_c2 CHECK (audience IN ('internal', 'clients')),
  CONSTRAINT hdk_articles_c3 CHECK (original_locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdk_articles_c4 CHECK (shown_count >= 0 AND helped_count >= 0 AND not_helped_count >= 0),
  CONSTRAINT hdk_articles_c5 CHECK (status IN ('active', 'archived')),
  CONSTRAINT hdk_articles_c6 CHECK ((status = 'archived') = (archived_on IS NOT NULL))
);

CREATE INDEX hdk_articles_i1 ON hdk_articles (module_id);
CREATE INDEX hdk_articles_i2 ON hdk_articles (owner_id);

COMMENT ON TABLE hdk_articles IS 'Статьи базы знаний; на этапе 1 только решения (FR-SOL-01, правка 3 раздела 10.6). Клиент не читает';
COMMENT ON COLUMN hdk_articles.article_id IS 'Идентификатор статьи';
COMMENT ON COLUMN hdk_articles.module_id IS 'Модуль Smartup, к которому относится решение. Пусто: модуль ещё не выбран (публикация требует модуль)';
COMMENT ON COLUMN hdk_articles.owner_id IS 'Ответственный сотрудник: получает статью в "Мои задачи" на пересмотр (UX-W-10)';
COMMENT ON COLUMN hdk_articles.number IS 'Номер для адреса /help/a/<номер>-<slug>. Задаёт база, не меняется';
COMMENT ON COLUMN hdk_articles.type IS 'Вид статьи. На этапе 1 только solution';
COMMENT ON COLUMN hdk_articles.audience IS 'Кому видна опубликованная статья: clients (вошедшим клиентам) или internal (только сотрудникам, решение "только через сотрудника", FR-SOL-17). Меняет копию для читателей и индекс каскадом';
COMMENT ON COLUMN hdk_articles.original_locale IS 'Язык оригинала: ru, uz, en. Переводы сверяются с ним';
COMMENT ON COLUMN hdk_articles.shown_count IS 'Сколько раз решение показано подсказкой (FR-SOL-19). Пишет система';
COMMENT ON COLUMN hdk_articles.helped_count IS 'Сколько раз клиент отметил "Помогло". Пишет система';
COMMENT ON COLUMN hdk_articles.not_helped_count IS 'Сколько раз клиент отметил "Не помогло". Пишет система';
COMMENT ON COLUMN hdk_articles.archived_on IS 'Когда статья снята в архив. Пусто у действующей';
COMMENT ON COLUMN hdk_articles.status IS 'active или archived. Архив снимает копию для читателей и строки индекса (решение 11), возврат это новая публикация';
COMMENT ON COLUMN hdk_articles.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_articles.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_articles.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_articles.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
ALTER SEQUENCE hdk_articles_number_sq OWNED BY hdk_articles.number;

CREATE TRIGGER t_hdk_articles_stamp
  BEFORE INSERT OR UPDATE ON hdk_articles
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Сотрудник не меняет номер и счётчики подсказки. Открыть опубликованное решение шире (internal -> clients) может
-- только публикующий: иначе первая линия показала бы клиентам решение "только через сотрудника" без публикации.
-- Сузить (clients -> internal) может любой, кто пишет черновики: это защитное действие, копия и индекс следуют каскадом.
CREATE FUNCTION app.hdk_articles_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'Статья: номер не меняется' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'staff' AND (NEW.shown_count IS DISTINCT FROM OLD.shown_count OR NEW.helped_count IS DISTINCT FROM OLD.helped_count
     OR NEW.not_helped_count IS DISTINCT FROM OLD.not_helped_count) THEN
    RAISE EXCEPTION 'Статья: счётчики подсказки пишет только система' USING ERRCODE = '42501';
  END IF;
  IF OLD.audience = 'internal' AND NEW.audience <> 'internal' AND app.actor_type() = 'staff' AND NOT app.kb_can_publish()
     AND EXISTS (SELECT 1 FROM hdk_published p WHERE p.article_id = OLD.article_id) THEN
    RAISE EXCEPTION 'Статья: открыть опубликованное решение клиентам может только роль публикации' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdk_articles_guard() IS 'Триггер: номер не меняется, счётчики пишет система, открыть опубликованное решение шире может только публикующий';

ALTER TABLE hdk_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_articles FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_articles_internal_select ON hdk_articles FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_articles_writer_insert ON hdk_articles FOR INSERT TO hub_app WITH CHECK (app.kb_can_write() AND status = 'active');
CREATE POLICY hdk_articles_writer_update ON hdk_articles FOR UPDATE TO hub_app
  USING (app.kb_can_write() AND status = 'active') WITH CHECK (app.kb_can_write() AND status = 'active');
CREATE POLICY hdk_articles_publisher_update ON hdk_articles FOR UPDATE TO hub_app USING (app.kb_can_publish()) WITH CHECK (app.kb_can_publish());
COMMENT ON POLICY hdk_articles_internal_select ON hdk_articles IS 'Статьи читают сотрудники и система. Клиент не читает: его текст только в hdk_published';
COMMENT ON POLICY hdk_articles_writer_insert ON hdk_articles IS 'Статью заводят роли, которые пишут черновики (agent_l1, agent_l2, care, admin), и система';
COMMENT ON POLICY hdk_articles_writer_update ON hdk_articles IS 'Действующую статью правят роли черновиков: модуль, аудиторию, ответственного. В архив не снимают';
COMMENT ON POLICY hdk_articles_publisher_update ON hdk_articles IS 'Архив и возврат из него: agent_l2, care, admin и система (FR-SOL-05, решение 11)';

GRANT SELECT, INSERT, UPDATE ON hdk_articles TO hub_app;
GRANT USAGE ON SEQUENCE hdk_articles_number_sq TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_article_versions: версии текста по языкам
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_article_versions (
  version_id        uuid        NOT NULL DEFAULT uuidv7(),
  article_id        uuid        NOT NULL,
  source_version_id uuid,
  locale            text        NOT NULL,
  number            integer     NOT NULL,
  title             text        NOT NULL DEFAULT '',
  doc               jsonb       NOT NULL,
  is_machine        boolean     NOT NULL DEFAULT false,
  state             text        NOT NULL DEFAULT 'draft',
  created_by        text,
  created_on        timestamptz NOT NULL DEFAULT now(),
  modified_by       text,
  modified_on       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_article_versions_pk PRIMARY KEY (version_id),
  CONSTRAINT hdk_article_versions_f1 FOREIGN KEY (article_id) REFERENCES hdk_articles (article_id),
  CONSTRAINT hdk_article_versions_f2 FOREIGN KEY (source_version_id) REFERENCES hdk_article_versions (version_id),
  -- Индекс u1 покрывает внешний ключ статьи.
  CONSTRAINT hdk_article_versions_u1 UNIQUE (article_id, locale, number),
  -- Цель составных внешних ключей переводов и копии для читателей: версия той же статьи и того же языка.
  CONSTRAINT hdk_article_versions_u4 UNIQUE (version_id, article_id, locale),
  CONSTRAINT hdk_article_versions_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdk_article_versions_c2 CHECK (number >= 1),
  CONSTRAINT hdk_article_versions_c3 CHECK (char_length(title) <= 200),
  -- Полную проверку документа делает схема Zod при сохранении (src/modules/hdk/doc-schema.ts); база держит форму
  -- и предел размера (400 блоков, решение 13).
  CONSTRAINT hdk_article_versions_c4 CHECK (jsonb_typeof(doc) = 'object' AND doc -> 'version' = '1' AND jsonb_typeof(doc -> 'blocks') = 'array'
                                            AND octet_length(doc::text) <= 1048576),
  CONSTRAINT hdk_article_versions_c5 CHECK (state IN ('draft', 'published', 'superseded'))
);

-- Одна действующая опубликованная версия и один черновик на статью и язык (ТЗ 18.10).
CREATE UNIQUE INDEX hdk_article_versions_u2 ON hdk_article_versions (article_id, locale) WHERE state = 'published';
CREATE UNIQUE INDEX hdk_article_versions_u3 ON hdk_article_versions (article_id, locale) WHERE state = 'draft';
CREATE INDEX hdk_article_versions_i1 ON hdk_article_versions (source_version_id);

COMMENT ON TABLE hdk_article_versions IS 'Версии текста статьи по языкам: черновик, опубликованная, прежние (FR-SOL-01, UX-W-04). Клиент не читает';
COMMENT ON COLUMN hdk_article_versions.version_id IS 'Идентификатор версии';
COMMENT ON COLUMN hdk_article_versions.article_id IS 'Статья';
COMMENT ON COLUMN hdk_article_versions.source_version_id IS 'Для перевода: версия оригинала, с которой переведён текст (по ней подсвечиваются изменившиеся блоки, UX-W-06). У оригинала пусто';
COMMENT ON COLUMN hdk_article_versions.locale IS 'Язык версии: ru, uz, en';
COMMENT ON COLUMN hdk_article_versions.number IS 'Номер версии в пределах статьи и языка, с 1';
COMMENT ON COLUMN hdk_article_versions.title IS 'Заголовок решения. Пусто у нового черновика';
COMMENT ON COLUMN hdk_article_versions.doc IS 'Документ: { version: 1, blocks } с закрытым списком блоков (ТЗ 18.10). HTML не хранится';
COMMENT ON COLUMN hdk_article_versions.is_machine IS 'Текст подготовила модель (машинный перевод или черновик из обращения) и сотрудник его ещё не подтвердил';
COMMENT ON COLUMN hdk_article_versions.state IS 'draft (черновик), published (действующая, копия в hdk_published), superseded (прежняя)';
COMMENT ON COLUMN hdk_article_versions.created_by IS 'Кто создал версию. Заполняет база';
COMMENT ON COLUMN hdk_article_versions.created_on IS 'Когда создана версия. Заполняет база';
COMMENT ON COLUMN hdk_article_versions.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_article_versions.modified_on IS 'Когда строка изменена последний раз: по нему автосохранение узнаёт о правке из другой вкладки. Заполняет база';

CREATE TRIGGER t_hdk_article_versions_stamp
  BEFORE INSERT OR UPDATE ON hdk_article_versions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Версия принадлежит своей статье, языку и номеру навсегда. Текст меняется только у черновика: опубликованная и прежние
-- версии это история. Переходы: draft -> published -> superseded; назад и через ступень нельзя (возврат к прежней
-- версии создаёт новый черновик, UX-W-04).
CREATE FUNCTION app.hdk_article_versions_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.article_id IS DISTINCT FROM OLD.article_id OR NEW.locale IS DISTINCT FROM OLD.locale OR NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'Версия: статья, язык и номер не меняются' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'draft' AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.doc IS DISTINCT FROM OLD.doc OR NEW.is_machine IS DISTINCT FROM OLD.is_machine
     OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id) THEN
    RAISE EXCEPTION 'Версия: текст опубликованной и прежней версии не меняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state = 'draft' AND NEW.state = 'published') OR (OLD.state = 'published' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'Версия: недопустимый переход состояния' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdk_article_versions_guard() IS 'Триггер: принадлежность версии постоянна, текст меняется только у черновика, переходы draft -> published -> superseded';

CREATE TRIGGER t_hdk_article_versions_guard
  BEFORE UPDATE ON hdk_article_versions
  FOR EACH ROW EXECUTE FUNCTION app.hdk_article_versions_guard();

ALTER TABLE hdk_article_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_article_versions FORCE ROW LEVEL SECURITY;

-- Роли черновиков пишут только черновики; опубликованной версия становится только у публикующего (решение 10).
CREATE POLICY hdk_article_versions_internal_select ON hdk_article_versions FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_article_versions_writer_insert ON hdk_article_versions FOR INSERT TO hub_app WITH CHECK (app.kb_can_write() AND state = 'draft');
CREATE POLICY hdk_article_versions_writer_update ON hdk_article_versions FOR UPDATE TO hub_app
  USING (app.kb_can_write() AND state = 'draft') WITH CHECK (app.kb_can_write() AND state = 'draft');
CREATE POLICY hdk_article_versions_publisher_insert ON hdk_article_versions FOR INSERT TO hub_app WITH CHECK (app.kb_can_publish());
CREATE POLICY hdk_article_versions_publisher_update ON hdk_article_versions FOR UPDATE TO hub_app USING (app.kb_can_publish()) WITH CHECK (app.kb_can_publish());
COMMENT ON POLICY hdk_article_versions_internal_select ON hdk_article_versions IS 'Версии читают сотрудники и система. Клиент не читает ни черновиков, ни истории';
COMMENT ON POLICY hdk_article_versions_writer_insert ON hdk_article_versions IS 'Черновик создают agent_l1, agent_l2, care, admin и система (машинный перевод, черновик из обращения)';
COMMENT ON POLICY hdk_article_versions_writer_update ON hdk_article_versions IS 'Черновик правят роли черновиков и система; опубликованной версию они не делают';
COMMENT ON POLICY hdk_article_versions_publisher_insert ON hdk_article_versions IS 'Публикующие (agent_l2, care, admin) и система создают версию в любом состоянии';
COMMENT ON POLICY hdk_article_versions_publisher_update ON hdk_article_versions IS 'Публикация и смена прежней версии: agent_l2, care, admin и система (FR-SOL-05)';

GRANT SELECT, INSERT, UPDATE ON hdk_article_versions TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_article_translations: язык статьи, его состояние и адрес
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_article_translations (
  translation_id       uuid        NOT NULL DEFAULT uuidv7(),
  article_id           uuid        NOT NULL,
  published_version_id uuid,
  draft_version_id     uuid,
  locale               text        NOT NULL,
  slug                 text        NOT NULL DEFAULT '',
  status               text        NOT NULL DEFAULT 'reviewed',
  created_by           text,
  created_on           timestamptz NOT NULL DEFAULT now(),
  modified_by          text,
  modified_on          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_article_translations_pk PRIMARY KEY (translation_id),
  CONSTRAINT hdk_article_translations_f1 FOREIGN KEY (article_id) REFERENCES hdk_articles (article_id),
  -- Версии той же статьи и того же языка.
  CONSTRAINT hdk_article_translations_f2 FOREIGN KEY (published_version_id, article_id, locale) REFERENCES hdk_article_versions (version_id, article_id, locale),
  CONSTRAINT hdk_article_translations_f3 FOREIGN KEY (draft_version_id, article_id, locale) REFERENCES hdk_article_versions (version_id, article_id, locale),
  -- Индекс u1 покрывает внешний ключ статьи.
  CONSTRAINT hdk_article_translations_u1 UNIQUE (article_id, locale),
  CONSTRAINT hdk_article_translations_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdk_article_translations_c2 CHECK (char_length(slug) <= 120 AND slug ~ '^[a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT hdk_article_translations_c3 CHECK (status IN ('machine', 'reviewed', 'outdated'))
);

CREATE INDEX hdk_article_translations_i1 ON hdk_article_translations (published_version_id);
CREATE INDEX hdk_article_translations_i2 ON hdk_article_translations (draft_version_id);

COMMENT ON TABLE hdk_article_translations IS 'Языки статьи: строка на каждый язык, включая оригинал; состояние перевода, действующая версия, черновик и адрес (FR-SOL-06, 18). Клиент не читает';
COMMENT ON COLUMN hdk_article_translations.translation_id IS 'Идентификатор строки языка';
COMMENT ON COLUMN hdk_article_translations.article_id IS 'Статья';
COMMENT ON COLUMN hdk_article_translations.published_version_id IS 'Действующая опубликованная версия на этом языке. Меняет только публикующий';
COMMENT ON COLUMN hdk_article_translations.draft_version_id IS 'Черновик на этом языке, если он есть';
COMMENT ON COLUMN hdk_article_translations.locale IS 'Язык: ru, uz, en';
COMMENT ON COLUMN hdk_article_translations.slug IS 'Часть адреса после номера: /help/a/<номер>-<slug>. Строчные латинские буквы, цифры и дефисы';
COMMENT ON COLUMN hdk_article_translations.status IS 'machine (машинный, не подтверждён), reviewed (подтверждён; у оригинала всегда), outdated (оригинал изменился после перевода, решение 9)';
COMMENT ON COLUMN hdk_article_translations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_article_translations.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_article_translations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_article_translations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdk_article_translations_stamp
  BEFORE INSERT OR UPDATE ON hdk_article_translations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Действующую версию и состояние перевода из сотрудников меняет только публикующий: первая линия не подставит черновик
-- опубликованным и не снимет пометку машинного перевода (решения 9 и 10).
CREATE FUNCTION app.hdk_article_translations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() <> 'staff' OR app.kb_can_publish() THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.published_version_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND (NEW.published_version_id IS DISTINCT FROM OLD.published_version_id OR NEW.status IS DISTINCT FROM OLD.status
                               OR NEW.article_id IS DISTINCT FROM OLD.article_id OR NEW.locale IS DISTINCT FROM OLD.locale)) THEN
    RAISE EXCEPTION 'Перевод: опубликованную версию и состояние меняет только роль публикации' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdk_article_translations_guard() IS 'Триггер: действующую версию и состояние перевода меняют только публикующие и система';

CREATE TRIGGER t_hdk_article_translations_guard
  BEFORE INSERT OR UPDATE ON hdk_article_translations
  FOR EACH ROW EXECUTE FUNCTION app.hdk_article_translations_guard();

ALTER TABLE hdk_article_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_article_translations FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_article_translations_internal_select ON hdk_article_translations FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_article_translations_writer_insert ON hdk_article_translations FOR INSERT TO hub_app WITH CHECK (app.kb_can_write());
CREATE POLICY hdk_article_translations_writer_update ON hdk_article_translations FOR UPDATE TO hub_app USING (app.kb_can_write()) WITH CHECK (app.kb_can_write());
COMMENT ON POLICY hdk_article_translations_internal_select ON hdk_article_translations IS 'Языки статьи читают сотрудники и система. Клиент не читает';
COMMENT ON POLICY hdk_article_translations_writer_insert ON hdk_article_translations IS 'Язык добавляют роли черновиков и система; опубликованную версию ставит только публикующий (триггер)';
COMMENT ON POLICY hdk_article_translations_writer_update ON hdk_article_translations IS 'Черновик и адрес меняют роли черновиков и система; версию и состояние только публикующий (триггер)';

GRANT SELECT, INSERT, UPDATE ON hdk_article_translations TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_article_sources: из какого обращения выросло решение
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_article_sources (
  org_id      uuid        NOT NULL,
  source_id   uuid        NOT NULL DEFAULT uuidv7(),
  article_id  uuid        NOT NULL,
  ticket_id   uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_article_sources_pk PRIMARY KEY (source_id),
  CONSTRAINT hdk_article_sources_f1 FOREIGN KEY (article_id) REFERENCES hdk_articles (article_id),
  -- Привязка обращения к организации (миграция 0037) меняет org_id обращения: источник идёт следом.
  CONSTRAINT hdk_article_sources_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  -- Индекс u1 покрывает внешний ключ статьи.
  CONSTRAINT hdk_article_sources_u1 UNIQUE (article_id, ticket_id)
);

CREATE INDEX hdk_article_sources_i1 ON hdk_article_sources (ticket_id, org_id);

COMMENT ON TABLE hdk_article_sources IS 'Обращения, из которых выросло решение (FR-SOL-02). Ссылка видна только сотрудникам: отдельная таблица, потому что RLS не защищает колонки';
COMMENT ON COLUMN hdk_article_sources.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdk_article_sources.source_id IS 'Идентификатор привязки';
COMMENT ON COLUMN hdk_article_sources.article_id IS 'Статья';
COMMENT ON COLUMN hdk_article_sources.ticket_id IS 'Исходное обращение';
COMMENT ON COLUMN hdk_article_sources.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_article_sources.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_article_sources.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_article_sources.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdk_article_sources_stamp
  BEFORE INSERT OR UPDATE ON hdk_article_sources
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_article_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_article_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_article_sources_internal_select ON hdk_article_sources FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_article_sources_writer_insert ON hdk_article_sources FOR INSERT TO hub_app WITH CHECK (app.kb_can_write());
COMMENT ON POLICY hdk_article_sources_internal_select ON hdk_article_sources IS 'Источник решения видят только сотрудники и система (FR-SOL-02)';
COMMENT ON POLICY hdk_article_sources_writer_insert ON hdk_article_sources IS 'Источник ставят роли черновиков и система при создании решения из обращения (задача 7)';

GRANT SELECT, INSERT ON hdk_article_sources TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_published: копия опубликованной версии для читателей
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_published (
  published_id    uuid        NOT NULL DEFAULT uuidv7(),
  article_id      uuid        NOT NULL,
  version_id      uuid        NOT NULL,
  article_number  bigint      NOT NULL,
  locale          text        NOT NULL,
  type            text        NOT NULL DEFAULT 'solution',
  audience        text        NOT NULL,
  title           text        NOT NULL,
  doc             jsonb       NOT NULL,
  body_text       text        NOT NULL,
  slug            text        NOT NULL,
  module_ids      uuid[]      NOT NULL DEFAULT '{}',
  file_ids        uuid[]      NOT NULL DEFAULT '{}',
  original_locale text        NOT NULL,
  is_machine      boolean     NOT NULL DEFAULT false,
  is_outdated     boolean     NOT NULL DEFAULT false,
  published_on    timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_published_pk PRIMARY KEY (published_id),
  -- Номер и аудитория копии всегда равны статье: сужение аудитории статьи (clients -> internal) сразу закрывает копию
  -- от клиентов, а через неё и строки индекса (каскад hdk_search_documents_f2).
  CONSTRAINT hdk_published_f1 FOREIGN KEY (article_id, article_number) REFERENCES hdk_articles (article_id, number),
  CONSTRAINT hdk_published_f2 FOREIGN KEY (article_id, audience) REFERENCES hdk_articles (article_id, audience) ON UPDATE CASCADE,
  CONSTRAINT hdk_published_f3 FOREIGN KEY (version_id, article_id, locale) REFERENCES hdk_article_versions (version_id, article_id, locale),
  -- Индекс u1 покрывает внешние ключи статьи.
  CONSTRAINT hdk_published_u1 UNIQUE (article_id, locale),
  CONSTRAINT hdk_published_u2 UNIQUE (article_number, locale),
  -- Цель внешнего ключа индекса: строка индекса повторяет аудиторию копии.
  CONSTRAINT hdk_published_u3 UNIQUE (published_id, audience),
  CONSTRAINT hdk_published_c1 CHECK (locale IN ('ru', 'uz', 'en') AND original_locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdk_published_c2 CHECK (type IN ('solution')),
  CONSTRAINT hdk_published_c3 CHECK (audience IN ('internal', 'clients')),
  CONSTRAINT hdk_published_c4 CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT hdk_published_c5 CHECK (jsonb_typeof(doc) = 'object' AND doc -> 'version' = '1' AND jsonb_typeof(doc -> 'blocks') = 'array'
                                     AND octet_length(doc::text) <= 1048576),
  CONSTRAINT hdk_published_c6 CHECK (char_length(slug) <= 120 AND slug ~ '^[a-z0-9]*(-[a-z0-9]+)*$')
);

CREATE INDEX hdk_published_i1 ON hdk_published (version_id, article_id, locale);

COMMENT ON TABLE hdk_published IS 'Копия опубликованной версии для читателей (ТЗ 10.5, 18.10). Единственная таблица, из которой клиент получает текст решения: только строки audience = clients';
COMMENT ON COLUMN hdk_published.published_id IS 'Идентификатор строки копии';
COMMENT ON COLUMN hdk_published.article_id IS 'Статья';
COMMENT ON COLUMN hdk_published.version_id IS 'Опубликованная версия, с которой снята копия';
COMMENT ON COLUMN hdk_published.article_number IS 'Номер статьи для адреса /help/a/<номер>-<slug>: клиент не читает hdk_articles, поэтому номер повторён здесь';
COMMENT ON COLUMN hdk_published.locale IS 'Язык копии: ru, uz, en';
COMMENT ON COLUMN hdk_published.type IS 'Вид статьи. На этапе 1 только solution';
COMMENT ON COLUMN hdk_published.audience IS 'Кому видна: clients (вошедшим клиентам) или internal (только сотрудникам). Следует за статьёй каскадом';
COMMENT ON COLUMN hdk_published.title IS 'Заголовок решения';
COMMENT ON COLUMN hdk_published.doc IS 'Документ опубликованной версии. Перед отрисовкой его снова проверяет схема';
COMMENT ON COLUMN hdk_published.body_text IS 'Текст документа без разметки: для индекса и выдержки в подсказке (в ТЗ поле text)';
COMMENT ON COLUMN hdk_published.slug IS 'Часть адреса после номера';
COMMENT ON COLUMN hdk_published.module_ids IS 'Модули решения';
COMMENT ON COLUMN hdk_published.file_ids IS 'Файлы hdk_article_files, на которые ссылается документ. Клиент скачивает файл, только если он есть в видимой ему строке (решение 16)';
COMMENT ON COLUMN hdk_published.original_locale IS 'Язык оригинала: для ссылки на оригинал у машинного и устаревшего перевода (решение 9)';
COMMENT ON COLUMN hdk_published.is_machine IS 'Машинный перевод, который сотрудник не подтвердил: показывается с пометкой (FR-SOL-06)';
COMMENT ON COLUMN hdk_published.is_outdated IS 'Оригинал изменился после перевода: показывается с пометкой "перевод может отставать" (FR-SOL-18)';
COMMENT ON COLUMN hdk_published.published_on IS 'Когда опубликована версия';
COMMENT ON COLUMN hdk_published.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_published.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_published.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_published.modified_on IS 'Когда строка изменена последний раз (в ТЗ updated_at). Заполняет база';

CREATE TRIGGER t_hdk_published_stamp
  BEFORE INSERT OR UPDATE ON hdk_published
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_published ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_published FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_published_client_select ON hdk_published FOR SELECT TO hub_app USING (app.actor_type() = 'client' AND audience = 'clients');
CREATE POLICY hdk_published_internal_select ON hdk_published FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_published_publisher_insert ON hdk_published FOR INSERT TO hub_app WITH CHECK (app.kb_can_publish());
CREATE POLICY hdk_published_publisher_update ON hdk_published FOR UPDATE TO hub_app USING (app.kb_can_publish()) WITH CHECK (app.kb_can_publish());
CREATE POLICY hdk_published_publisher_delete ON hdk_published FOR DELETE TO hub_app USING (app.kb_can_publish());
COMMENT ON POLICY hdk_published_client_select ON hdk_published IS 'Клиент любой организации читает только решения для клиентов. Решение "только через сотрудника" (internal) невидимо (FR-SOL-17)';
COMMENT ON POLICY hdk_published_internal_select ON hdk_published IS 'Сотрудники и система читают все опубликованные решения';
COMMENT ON POLICY hdk_published_publisher_insert ON hdk_published IS 'Копию пишет публикация: agent_l2, care, admin и система (FR-SOL-05)';
COMMENT ON POLICY hdk_published_publisher_update ON hdk_published IS 'Копию обновляет публикация: agent_l2, care, admin и система';
COMMENT ON POLICY hdk_published_publisher_delete ON hdk_published IS 'Копию снимает архив: agent_l2, care, admin и система (решение 11)';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdk_published TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_article_files: изображения решений
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_article_files (
  file_id     uuid        NOT NULL DEFAULT uuidv7(),
  article_id  uuid        NOT NULL,
  storage_key text        NOT NULL,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size        integer     NOT NULL,
  sha256      text,
  scan_status text        NOT NULL DEFAULT 'pending',
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_article_files_pk PRIMARY KEY (file_id),
  CONSTRAINT hdk_article_files_f1 FOREIGN KEY (article_id) REFERENCES hdk_articles (article_id),
  CONSTRAINT hdk_article_files_u1 UNIQUE (storage_key),
  -- Только PNG, JPEG, WebP до 10 МБ (решение 13).
  CONSTRAINT hdk_article_files_c1 CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT hdk_article_files_c2 CHECK (size BETWEEN 1 AND 10485760),
  CONSTRAINT hdk_article_files_c3 CHECK (scan_status IN ('pending', 'clean', 'infected', 'rejected')),
  CONSTRAINT hdk_article_files_c4 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hdk_article_files_c5 CHECK (char_length(file_name) BETWEEN 1 AND 255 AND char_length(storage_key) <= 300)
);

CREATE INDEX hdk_article_files_i1 ON hdk_article_files (article_id);
CREATE INDEX hdk_article_files_i2 ON hdk_article_files (created_on) WHERE scan_status = 'pending';

COMMENT ON TABLE hdk_article_files IS 'Изображения решений в хранилище (решение 16). Клиент строк не читает: файл ему отдаёт GET /help/a/<ref>/files/<id>, если файл упомянут в видимой ему строке hdk_published';
COMMENT ON COLUMN hdk_article_files.file_id IS 'Идентификатор файла: на него ссылается блок image документа (attrs.fileId)';
COMMENT ON COLUMN hdk_article_files.article_id IS 'Статья, к которой загружен файл';
COMMENT ON COLUMN hdk_article_files.storage_key IS 'Ключ в хранилище. Задаёт портал';
COMMENT ON COLUMN hdk_article_files.file_name IS 'Имя файла при загрузке';
COMMENT ON COLUMN hdk_article_files.mime IS 'Тип: image/png, image/jpeg, image/webp (проверяется по содержимому)';
COMMENT ON COLUMN hdk_article_files.size IS 'Размер в байтах, до 10 МБ';
COMMENT ON COLUMN hdk_article_files.sha256 IS 'Хеш содержимого. Пусто, пока файл не дочитан';
COMMENT ON COLUMN hdk_article_files.scan_status IS 'Проверка антивирусом: pending, clean, infected, rejected. Показывается только clean';
COMMENT ON COLUMN hdk_article_files.created_by IS 'Кто загрузил файл. Заполняет база';
COMMENT ON COLUMN hdk_article_files.created_on IS 'Когда загружен файл. Заполняет база';
COMMENT ON COLUMN hdk_article_files.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_article_files.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdk_article_files_stamp
  BEFORE INSERT OR UPDATE ON hdk_article_files
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_article_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_article_files FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_article_files_internal_select ON hdk_article_files FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_article_files_writer_insert ON hdk_article_files FOR INSERT TO hub_app WITH CHECK (app.kb_can_write() AND scan_status = 'pending');
CREATE POLICY hdk_article_files_system_update ON hdk_article_files FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_article_files_system_delete ON hdk_article_files FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdk_article_files_internal_select ON hdk_article_files IS 'Файлы решений читают сотрудники и система. Клиенту файл отдаёт обработчик после проверки hdk_published';
COMMENT ON POLICY hdk_article_files_writer_insert ON hdk_article_files IS 'Файл загружают роли черновиков, до проверки антивирусом';
COMMENT ON POLICY hdk_article_files_system_update ON hdk_article_files IS 'Итог проверки антивирусом и ключ хранилища ставит система';
COMMENT ON POLICY hdk_article_files_system_delete ON hdk_article_files IS 'Файлы без ссылок и заражённые удаляет система';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdk_article_files TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_error_signatures: сигнатуры ошибок
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_error_signatures (
  signature_id   uuid        NOT NULL DEFAULT uuidv7(),
  article_id     uuid,
  module_id      uuid,
  signature      text        NOT NULL,
  sample_code    text,
  sample_message text,
  org_count      integer     NOT NULL DEFAULT 0,
  occurrences    integer     NOT NULL DEFAULT 0,
  last_seen_on   timestamptz,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_error_signatures_pk PRIMARY KEY (signature_id),
  CONSTRAINT hdk_error_signatures_f1 FOREIGN KEY (article_id) REFERENCES hdk_articles (article_id),
  CONSTRAINT hdk_error_signatures_f2 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdk_error_signatures_u1 UNIQUE (signature),
  -- Первые 32 знака sha256 в шестнадцатеричной записи (ТЗ 11.5).
  CONSTRAINT hdk_error_signatures_c1 CHECK (signature ~ '^[0-9a-f]{32}$'),
  CONSTRAINT hdk_error_signatures_c2 CHECK (org_count >= 0 AND occurrences >= 0),
  CONSTRAINT hdk_error_signatures_c3 CHECK (char_length(sample_code) <= 80 AND char_length(sample_message) <= 300)
);

CREATE INDEX hdk_error_signatures_i1 ON hdk_error_signatures (article_id);
CREATE INDEX hdk_error_signatures_i2 ON hdk_error_signatures (module_id);

COMMENT ON TABLE hdk_error_signatures IS 'Сигнатуры ошибок Smartup и привязанные к ним решения (FR-SOL-07, ТЗ 11.5). Клиент не читает';
COMMENT ON COLUMN hdk_error_signatures.signature_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdk_error_signatures.article_id IS 'Решение для этой ошибки. Пусто: решения пока нет (частые ошибки без решения, FR-MET-05)';
COMMENT ON COLUMN hdk_error_signatures.module_id IS 'Модуль, в котором встречается ошибка';
COMMENT ON COLUMN hdk_error_signatures.signature IS 'Сигнатура: sha256 от кода, нормализованного текста и модуля, первые 32 знака (ТЗ 11.5)';
COMMENT ON COLUMN hdk_error_signatures.sample_code IS 'Пример кода ошибки';
COMMENT ON COLUMN hdk_error_signatures.sample_message IS 'Нормализованный текст ошибки без данных клиента';
COMMENT ON COLUMN hdk_error_signatures.org_count IS 'У скольких организаций встречалась (по hdk_signature_orgs, решение 8). Клиенту показывается только число и только от 3';
COMMENT ON COLUMN hdk_error_signatures.occurrences IS 'Сколько раз встречалась';
COMMENT ON COLUMN hdk_error_signatures.last_seen_on IS 'Когда встречалась последний раз';
COMMENT ON COLUMN hdk_error_signatures.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_error_signatures.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_error_signatures.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_error_signatures.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdk_error_signatures_stamp
  BEFORE INSERT OR UPDATE ON hdk_error_signatures
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_error_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_error_signatures FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_error_signatures_internal_select ON hdk_error_signatures FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_error_signatures_writer_insert ON hdk_error_signatures FOR INSERT TO hub_app WITH CHECK (app.kb_can_write());
CREATE POLICY hdk_error_signatures_writer_update ON hdk_error_signatures FOR UPDATE TO hub_app USING (app.kb_can_write()) WITH CHECK (app.kb_can_write());
COMMENT ON POLICY hdk_error_signatures_internal_select ON hdk_error_signatures IS 'Сигнатуры читают сотрудники и система. Клиент не читает';
COMMENT ON POLICY hdk_error_signatures_writer_insert ON hdk_error_signatures IS 'Сигнатуру заводит система при создании обращения и роли черновиков при привязке к решению (задача 8)';
COMMENT ON POLICY hdk_error_signatures_writer_update ON hdk_error_signatures IS 'Привязку к решению меняют роли черновиков, счётчики система';

GRANT SELECT, INSERT, UPDATE ON hdk_error_signatures TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_signature_orgs: у каких организаций встречалась сигнатура
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_signature_orgs (
  org_id           uuid        NOT NULL,
  signature_org_id uuid        NOT NULL DEFAULT uuidv7(),
  signature_id     uuid        NOT NULL,
  first_seen_on    timestamptz NOT NULL DEFAULT now(),
  last_seen_on     timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_signature_orgs_pk PRIMARY KEY (signature_org_id),
  CONSTRAINT hdk_signature_orgs_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdk_signature_orgs_f2 FOREIGN KEY (signature_id) REFERENCES hdk_error_signatures (signature_id),
  -- Индекс u1 покрывает внешний ключ сигнатуры.
  CONSTRAINT hdk_signature_orgs_u1 UNIQUE (signature_id, org_id)
);

CREATE INDEX hdk_signature_orgs_i1 ON hdk_signature_orgs (org_id);

COMMENT ON TABLE hdk_signature_orgs IS 'Организации, у которых встречалась сигнатура: для числа "встречалось у N клиентов" (FR-SOL-12, решение 8). Пишет система, клиент не читает';
COMMENT ON COLUMN hdk_signature_orgs.org_id IS 'Организация';
COMMENT ON COLUMN hdk_signature_orgs.signature_org_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdk_signature_orgs.signature_id IS 'Сигнатура';
COMMENT ON COLUMN hdk_signature_orgs.first_seen_on IS 'Когда сигнатура впервые встретилась у организации';
COMMENT ON COLUMN hdk_signature_orgs.last_seen_on IS 'Когда встретилась последний раз';
COMMENT ON COLUMN hdk_signature_orgs.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_signature_orgs.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_signature_orgs.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_signature_orgs.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdk_signature_orgs_stamp
  BEFORE INSERT OR UPDATE ON hdk_signature_orgs
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_signature_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_signature_orgs FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_signature_orgs_internal_select ON hdk_signature_orgs FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_signature_orgs_system_insert ON hdk_signature_orgs FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_signature_orgs_system_update ON hdk_signature_orgs FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdk_signature_orgs_internal_select ON hdk_signature_orgs IS 'Читают сотрудники и система. Клиент не видит даже свою строку: из неё видно, у кого ещё ошибка';
COMMENT ON POLICY hdk_signature_orgs_system_insert ON hdk_signature_orgs IS 'Пишет система при создании обращения и при показе подсказки с этой сигнатурой (решение 8)';
COMMENT ON POLICY hdk_signature_orgs_system_update ON hdk_signature_orgs IS 'Время последней встречи обновляет система';

GRANT SELECT, INSERT, UPDATE ON hdk_signature_orgs TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_search_documents: общий поисковый индекс
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_search_documents (
  search_document_id uuid         NOT NULL DEFAULT uuidv7(),
  published_id       uuid,
  module_id          uuid,
  ref_id             uuid         NOT NULL,
  kind               text         NOT NULL,
  article_type       text,
  locale             text         NOT NULL,
  title              text         NOT NULL,
  body_text          text         NOT NULL,
  tsv                tsvector,
  embedding          vector(1024),
  audience           text         NOT NULL DEFAULT 'internal',
  created_by         text,
  created_on         timestamptz  NOT NULL DEFAULT now(),
  modified_by        text,
  modified_on        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT hdk_search_documents_pk PRIMARY KEY (search_document_id),
  -- Строка статьи живёт вместе с копией для читателей: архив удаляет копию и строку индекса (решение 11), сужение
  -- аудитории статьи доходит до индекса каскадом через копию.
  CONSTRAINT hdk_search_documents_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdk_search_documents_f2 FOREIGN KEY (published_id, audience) REFERENCES hdk_published (published_id, audience) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT hdk_search_documents_u1 UNIQUE (kind, ref_id, locale),
  -- Идеи появятся в вехе M7; public на этапе 2 (правка 1 раздела 10.6).
  CONSTRAINT hdk_search_documents_c1 CHECK (kind IN ('article', 'idea')),
  CONSTRAINT hdk_search_documents_c2 CHECK ((kind = 'article') = (published_id IS NOT NULL AND article_type IS NOT NULL)),
  CONSTRAINT hdk_search_documents_c3 CHECK (article_type IS NULL OR article_type IN ('solution')),
  CONSTRAINT hdk_search_documents_c4 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdk_search_documents_c5 CHECK (audience IN ('internal', 'clients'))
);

CREATE INDEX hdk_search_documents_i1 ON hdk_search_documents (published_id, audience);
CREATE INDEX hdk_search_documents_i2 ON hdk_search_documents (module_id);

COMMENT ON TABLE hdk_search_documents IS 'Общий поисковый индекс подсказки и поиска похожих идей (ТЗ 10.4): строка на пару "объект + язык", только опубликованное. Тексты обращений сюда не попадают';
COMMENT ON COLUMN hdk_search_documents.search_document_id IS 'Идентификатор строки индекса';
COMMENT ON COLUMN hdk_search_documents.published_id IS 'Для статьи: строка копии для читателей, с которой снят документ. У идеи пусто';
COMMENT ON COLUMN hdk_search_documents.module_id IS 'Модуль: прибавка к оценке при совпадении модуля (решение 17)';
COMMENT ON COLUMN hdk_search_documents.ref_id IS 'Идентификатор объекта: статьи или идеи';
COMMENT ON COLUMN hdk_search_documents.kind IS 'Вид объекта: article или idea (идеи с вехи M7; на этапе 2 добавится release)';
COMMENT ON COLUMN hdk_search_documents.article_type IS 'Вид статьи: на этапе 1 только solution. У идеи пусто';
COMMENT ON COLUMN hdk_search_documents.locale IS 'Язык документа: ru, uz, en';
COMMENT ON COLUMN hdk_search_documents.title IS 'Заголовок';
COMMENT ON COLUMN hdk_search_documents.body_text IS 'Текст без разметки';
COMMENT ON COLUMN hdk_search_documents.tsv IS 'Полнотекстовый вектор: russian, english или simple для узбекского. Заполняет триггер (задача 9)';
COMMENT ON COLUMN hdk_search_documents.embedding IS 'Смысловой вектор BGE-M3, 1024 измерения. Считает задание kb.index после публикации (задача 9)';
COMMENT ON COLUMN hdk_search_documents.audience IS 'Кому виден документ: clients или internal. Для статьи повторяет копию для читателей каскадом';
COMMENT ON COLUMN hdk_search_documents.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_search_documents.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdk_search_documents.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_search_documents.modified_on IS 'Когда строка изменена последний раз (в ТЗ updated_at). Заполняет база';

CREATE TRIGGER t_hdk_search_documents_stamp
  BEFORE INSERT OR UPDATE ON hdk_search_documents
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_search_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_search_documents_client_select ON hdk_search_documents FOR SELECT TO hub_app USING (app.actor_type() = 'client' AND audience = 'clients');
CREATE POLICY hdk_search_documents_internal_select ON hdk_search_documents FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_search_documents_system_insert ON hdk_search_documents FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_search_documents_system_update ON hdk_search_documents FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_search_documents_publisher_delete ON hdk_search_documents FOR DELETE TO hub_app USING (app.kb_can_publish());
COMMENT ON POLICY hdk_search_documents_client_select ON hdk_search_documents IS 'Подсказка от имени клиента находит только документы для клиентов (ТЗ 10.4)';
COMMENT ON POLICY hdk_search_documents_internal_select ON hdk_search_documents IS 'Сотрудники и система ищут по всем документам, включая internal (FR-AG-05)';
COMMENT ON POLICY hdk_search_documents_system_insert ON hdk_search_documents IS 'Строку индекса пишет задание kb.index после публикации';
COMMENT ON POLICY hdk_search_documents_system_update ON hdk_search_documents IS 'Текст и вектор обновляет задание kb.index';
COMMENT ON POLICY hdk_search_documents_publisher_delete ON hdk_search_documents IS 'Строку снимает архив в транзакции публикующего (решение 11) или система';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdk_search_documents TO hub_app;

-- ---------------------------------------------------------------------------
-- hdk_deflection_events: показы подсказки и их исходы
-- ---------------------------------------------------------------------------
CREATE TABLE hdk_deflection_events (
  org_id              uuid        NOT NULL,
  deflection_event_id uuid        NOT NULL DEFAULT uuidv7(),
  user_id             uuid        NOT NULL,
  ticket_id           uuid,
  session_id          uuid        NOT NULL,
  query_hash          text        NOT NULL,
  signature           text,
  shown_article_ids   uuid[]      NOT NULL DEFAULT '{}',
  outcome             text        NOT NULL DEFAULT 'left',
  zone                text        NOT NULL DEFAULT 'portal',
  created_by          text,
  created_on          timestamptz NOT NULL DEFAULT now(),
  modified_by         text,
  modified_on         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdk_deflection_events_pk PRIMARY KEY (deflection_event_id),
  CONSTRAINT hdk_deflection_events_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdk_deflection_events_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdk_deflection_events_f3 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  -- Одна строка на сессию формы (решение 12).
  CONSTRAINT hdk_deflection_events_u1 UNIQUE (session_id),
  -- HMAC запроса с ключом из ENCRYPTION_KEY: текст запроса не хранится (решение 12).
  CONSTRAINT hdk_deflection_events_c1 CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hdk_deflection_events_c2 CHECK (signature IS NULL OR signature ~ '^[0-9a-f]{32}$'),
  CONSTRAINT hdk_deflection_events_c3 CHECK (outcome IN ('helped', 'not_helped', 'ticket_created', 'left')),
  CONSTRAINT hdk_deflection_events_c4 CHECK (zone IN ('portal', 'widget')),
  CONSTRAINT hdk_deflection_events_c5 CHECK (cardinality(shown_article_ids) <= 3)
);

CREATE INDEX hdk_deflection_events_i1 ON hdk_deflection_events (org_id, created_on);
CREATE INDEX hdk_deflection_events_i2 ON hdk_deflection_events (user_id);
CREATE INDEX hdk_deflection_events_i3 ON hdk_deflection_events (ticket_id, org_id);
-- Показатели за период и ночная очистка строк старше 13 месяцев.
CREATE INDEX hdk_deflection_events_i4 ON hdk_deflection_events (created_on);

COMMENT ON TABLE hdk_deflection_events IS 'Показы подсказки и их исходы, строка на сессию формы (FR-SOL-13, решение 12). Пишет система, клиент не читает, хранится 13 месяцев';
COMMENT ON COLUMN hdk_deflection_events.org_id IS 'Организация клиента, которому показана подсказка';
COMMENT ON COLUMN hdk_deflection_events.deflection_event_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdk_deflection_events.user_id IS 'Пользователь, которому показана подсказка';
COMMENT ON COLUMN hdk_deflection_events.ticket_id IS 'Обращение, созданное после подсказки (исход ticket_created). Иначе пусто';
COMMENT ON COLUMN hdk_deflection_events.session_id IS 'Сессия формы, выдаёт сервер: одна строка на сессию, а не на нажатие клавиши';
COMMENT ON COLUMN hdk_deflection_events.query_hash IS 'HMAC-SHA256 запроса с ключом, выведенным из ENCRYPTION_KEY. Текст запроса не хранится';
COMMENT ON COLUMN hdk_deflection_events.signature IS 'Сигнатура ошибки запроса, если она была';
COMMENT ON COLUMN hdk_deflection_events.shown_article_ids IS 'Показанные решения, не больше трёх (FR-SOL-08)';
COMMENT ON COLUMN hdk_deflection_events.outcome IS 'Исход: left (ушёл без действия, начальное), helped, not_helped, ticket_created';
COMMENT ON COLUMN hdk_deflection_events.zone IS 'Где показана: portal или widget (виджет с вехи M6)';
COMMENT ON COLUMN hdk_deflection_events.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdk_deflection_events.created_on IS 'Когда показана подсказка. Заполняет база';
COMMENT ON COLUMN hdk_deflection_events.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdk_deflection_events.modified_on IS 'Когда изменён исход. Заполняет база';

CREATE TRIGGER t_hdk_deflection_events_stamp
  BEFORE INSERT OR UPDATE ON hdk_deflection_events
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdk_deflection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdk_deflection_events FORCE ROW LEVEL SECURITY;

CREATE POLICY hdk_deflection_events_internal_select ON hdk_deflection_events FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdk_deflection_events_system_insert ON hdk_deflection_events FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_deflection_events_system_update ON hdk_deflection_events FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdk_deflection_events_system_delete ON hdk_deflection_events FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdk_deflection_events_internal_select ON hdk_deflection_events IS 'Исходы читают сотрудники (показатели FR-MET-02) и система. Клиент не читает';
COMMENT ON POLICY hdk_deflection_events_system_insert ON hdk_deflection_events IS 'Строку создаёт система при первом показе подсказки';
COMMENT ON POLICY hdk_deflection_events_system_update ON hdk_deflection_events IS 'Исход обновляет система';
COMMENT ON POLICY hdk_deflection_events_system_delete ON hdk_deflection_events IS 'Строки старше 13 месяцев удаляет ночная очистка';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdk_deflection_events TO hub_app;

-- Триггер на hdk_articles ссылается на hdk_published, поэтому создаётся после неё.
CREATE TRIGGER t_hdk_articles_guard
  BEFORE UPDATE ON hdk_articles
  FOR EACH ROW EXECUTE FUNCTION app.hdk_articles_guard();
