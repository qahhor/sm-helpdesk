-- Веха M5c, задача 1: известные проблемы (ТЗ 7.15, FR-KP-01, 02, 10; раздел 10.5; план M5c, решения 1, 2, 3, 7).
--
-- Таблицы модуля hdp: проблема, её публичные тексты по языкам и сигнатуры ошибок. Клиент не читает ни одной из них:
-- у них нет ни одной политики для клиента. Клиент видит проблему только через представление hdp_problems_public без
-- внутреннего названия, владельца, счётчиков и сигнатур, и только с признаком показа, не закрытую, а исправленную не
-- дольше 30 суток (решение 2). Роль hub_app общая у клиента и сотрудника, поэтому граница проведена базой, а не кодом.
--
-- Пишут проблему agent_l2, care, admin и система (app.hdp_can_write, FR-KP-03). Любой сотрудник, который ведёт
-- обращения, привязывает к проблеме обращение (решение 3): для этого политика пускает его обновить строку проблемы,
-- а триггер разрешает ему менять только счётчики. Счётчики и моменты появления ставит сам триггер пересчётом по
-- привязанным обращениям: подделать их нельзя никому.

CREATE FUNCTION app.hdp_can_write() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin')) $$;
COMMENT ON FUNCTION app.hdp_can_write() IS 'Истина для системы и сотрудника, который ведёт известные проблемы: agent_l2, care, admin (FR-KP-03)';

CREATE SEQUENCE hdp_problems_number_sq START 1;
COMMENT ON SEQUENCE hdp_problems_number_sq IS 'Номера известных проблем для показа KP-<номер>. Пропуски возможны';

-- ---------------------------------------------------------------------------
-- hdp_problems: известные проблемы
-- ---------------------------------------------------------------------------
CREATE TABLE hdp_problems (
  problem_id             uuid        NOT NULL DEFAULT uuidv7(),
  module_id              uuid,
  workaround_solution_id uuid,
  owner_id               uuid,
  number                 bigint      NOT NULL DEFAULT nextval('hdp_problems_number_sq'),
  internal_title         text        NOT NULL,
  source_locale          text        NOT NULL DEFAULT 'ru',
  show_to_clients        boolean     NOT NULL DEFAULT false,
  first_seen_on          timestamptz,
  last_seen_on           timestamptz,
  fixed_on               timestamptz,
  closed_on              timestamptz,
  ticket_count           integer     NOT NULL DEFAULT 0,
  org_count              integer     NOT NULL DEFAULT 0,
  status                 text        NOT NULL DEFAULT 'investigating',
  created_by             text,
  created_on             timestamptz NOT NULL DEFAULT now(),
  modified_by            text,
  modified_on            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_problems_pk PRIMARY KEY (problem_id),
  CONSTRAINT hdp_problems_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdp_problems_f2 FOREIGN KEY (workaround_solution_id) REFERENCES hdk_articles (article_id),
  CONSTRAINT hdp_problems_f3 FOREIGN KEY (owner_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdp_problems_u1 UNIQUE (number),
  CONSTRAINT hdp_problems_c1 CHECK (status IN ('investigating', 'cause_found', 'fixing', 'fixed', 'closed')),
  CONSTRAINT hdp_problems_c2 CHECK (internal_title = btrim(internal_title) AND char_length(internal_title) BETWEEN 1 AND 200),
  CONSTRAINT hdp_problems_c3 CHECK (source_locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdp_problems_c4 CHECK (ticket_count >= 0 AND org_count >= 0 AND org_count <= ticket_count),
  CONSTRAINT hdp_problems_c5 CHECK ((status = 'closed') = (closed_on IS NOT NULL)),
  CONSTRAINT hdp_problems_c6 CHECK (status <> 'fixed' OR fixed_on IS NOT NULL)
);

CREATE INDEX hdp_problems_i1 ON hdp_problems (module_id);
CREATE INDEX hdp_problems_i2 ON hdp_problems (workaround_solution_id);
CREATE INDEX hdp_problems_i3 ON hdp_problems (owner_id);
-- Список проблем у сотрудника: открытые сверху по последнему появлению.
CREATE INDEX hdp_problems_i4 ON hdp_problems (status, last_seen_on DESC);

COMMENT ON TABLE hdp_problems IS 'Известные проблемы (ТЗ 7.15, FR-KP-01, 02, 10). Клиент не читает: его вид только представление hdp_problems_public';
COMMENT ON COLUMN hdp_problems.problem_id IS 'Идентификатор проблемы';
COMMENT ON COLUMN hdp_problems.module_id IS 'Модуль Smartup, в котором проявляется проблема. Пусто: не выбран';
COMMENT ON COLUMN hdp_problems.workaround_solution_id IS 'Обходной путь: решение базы знаний. Клиент видит его только опубликованным для клиентов (hdk_published)';
COMMENT ON COLUMN hdp_problems.owner_id IS 'Владелец: сотрудник, который ведёт проблему и получает напоминания задачи разработки';
COMMENT ON COLUMN hdp_problems.number IS 'Номер для показа KP-<номер>. Задаёт база, не меняется';
COMMENT ON COLUMN hdp_problems.internal_title IS 'Внутреннее название для сотрудников. Клиенту не показывается: при создании из обращения это тема обращения (решение 4)';
COMMENT ON COLUMN hdp_problems.source_locale IS 'Язык, на котором сотрудник пишет публичный текст: ru, uz, en. С него переводятся остальные языки';
COMMENT ON COLUMN hdp_problems.show_to_clients IS 'Показывать клиентам: баннер, блок в обращении, страница проблем. Включается только с публичным текстом (решение 5)';
COMMENT ON COLUMN hdp_problems.first_seen_on IS 'Когда создано первое привязанное обращение. Ставит триггер пересчёта';
COMMENT ON COLUMN hdp_problems.last_seen_on IS 'Когда создано последнее привязанное обращение. Ставит триггер пересчёта';
COMMENT ON COLUMN hdp_problems.fixed_on IS 'Когда проблема переведена в "Исправлено". Ставит база; от него считаются 30 суток показа на странице проблем';
COMMENT ON COLUMN hdp_problems.closed_on IS 'Когда проблема закрыта. Ставит база';
COMMENT ON COLUMN hdp_problems.ticket_count IS 'Сколько обращений привязано (FR-KP-10). Ставит триггер пересчёта';
COMMENT ON COLUMN hdp_problems.org_count IS 'Сколько разных организаций среди привязанных обращений (FR-KP-10). Ставит триггер пересчёта';
COMMENT ON COLUMN hdp_problems.status IS 'Статус: investigating, cause_found, fixing (активные: притягивают обращения по сигнатуре), fixed, closed (FR-KP-02). Из closed перехода нет';
COMMENT ON COLUMN hdp_problems.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_problems.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_problems.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_problems.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
ALTER SEQUENCE hdp_problems_number_sq OWNED BY hdp_problems.number;

CREATE TRIGGER t_hdp_problems_stamp
  BEFORE INSERT OR UPDATE ON hdp_problems
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Номер не меняется, из закрытой проблемы перехода нет, моменты статуса ставит база. Сотрудник без права ведения
-- (первая линия при привязке обращения) не меняет ничего, кроме пересчёта. Счётчики и моменты появления всегда
-- пересчитываются по привязанным обращениям: функция изменчивая, поэтому каждый её запрос видит строки транзакций,
-- зафиксированных до блокировки строки проблемы.
CREATE FUNCTION app.hdp_problems_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  counted CONSTANT text[] := ARRAY['ticket_count', 'org_count', 'first_seen_on', 'last_seen_on', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  total integer;
  orgs integer;
  first_on timestamptz;
  last_on timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'investigating' AND NEW.status <> 'cause_found' AND NEW.status <> 'fixing' THEN
      RAISE EXCEPTION 'Проблема: новая проблема бывает только активной' USING ERRCODE = '42501';
    END IF;
    NEW.ticket_count := 0;
    NEW.org_count := 0;
    NEW.first_seen_on := NULL;
    NEW.last_seen_on := NULL;
    NEW.fixed_on := NULL;
    NEW.closed_on := NULL;
    RETURN NEW;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.problem_id IS DISTINCT FROM OLD.problem_id THEN
    RAISE EXCEPTION 'Проблема: номер не меняется' USING ERRCODE = '42501';
  END IF;
  -- Без актора пишут только миграции и суперпользователь (подготовка данных): у hub_app без актора нет доступа к
  -- строкам вовсе. Им моменты статуса ставятся только недостающие, пересчёта нет.
  IF app.actor_type() = 'none' THEN
    IF NEW.status = 'fixed' AND NEW.fixed_on IS NULL THEN NEW.fixed_on := now(); END IF;
    IF NEW.status = 'closed' AND NEW.closed_on IS NULL THEN NEW.closed_on := now(); END IF;
    RETURN NEW;
  END IF;
  IF NOT app.hdp_can_write() AND (to_jsonb(NEW) - counted) IS DISTINCT FROM (to_jsonb(OLD) - counted) THEN
    RAISE EXCEPTION 'Проблема: менять проблему может только вторая линия, Customer Care и администратор' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'closed' AND (to_jsonb(NEW) - counted) IS DISTINCT FROM (to_jsonb(OLD) - counted) THEN
    RAISE EXCEPTION 'Проблема: закрытая проблема не меняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.fixed_on := CASE WHEN NEW.status = 'fixed' THEN now() WHEN NEW.status = 'closed' THEN OLD.fixed_on ELSE NULL END;
    NEW.closed_on := CASE WHEN NEW.status = 'closed' THEN now() ELSE NULL END;
  ELSE
    NEW.fixed_on := OLD.fixed_on;
    NEW.closed_on := OLD.closed_on;
  END IF;
  SELECT count(*), count(DISTINCT t.org_id), min(t.created_on), max(t.created_on)
    INTO total, orgs, first_on, last_on
    FROM hdt_tickets t WHERE t.known_problem_id = NEW.problem_id;
  NEW.ticket_count := total;
  NEW.org_count := orgs;
  -- Все обращения отвязаны: моменты появления остаются прежними, история не теряется.
  NEW.first_seen_on := coalesce(first_on, OLD.first_seen_on);
  NEW.last_seen_on := coalesce(last_on, OLD.last_seen_on);
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdp_problems_guard() IS
  'Триггер: номер не меняется, закрытая проблема не меняется, моменты статуса ставит база, без права ведения меняется только пересчёт; счётчики и моменты появления пересчитываются по привязанным обращениям';
CREATE TRIGGER t_hdp_problems_guard
  BEFORE INSERT OR UPDATE ON hdp_problems
  FOR EACH ROW EXECUTE FUNCTION app.hdp_problems_guard();

ALTER TABLE hdp_problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_problems FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_problems_internal_select ON hdp_problems FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdp_problems_writer_insert ON hdp_problems FOR INSERT TO hub_app WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problems_writer_update ON hdp_problems FOR UPDATE TO hub_app USING (app.hdp_can_write()) WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problems_linker_update ON hdp_problems FOR UPDATE TO hub_app
  USING (app.staff_can_write_tickets()) WITH CHECK (app.staff_can_write_tickets());
-- Для представления hdp_problems_public: оно читает таблицу от имени владельца, как hdu_user_profiles (миграция 0005).
CREATE POLICY hdp_problems_owner_select ON hdp_problems FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hdp_problems_internal_select ON hdp_problems IS 'Проблемы читают сотрудники и система. Клиент не читает: его вид только hdp_problems_public';
COMMENT ON POLICY hdp_problems_writer_insert ON hdp_problems IS 'Проблему заводят agent_l2, care, admin и система (FR-KP-03)';
COMMENT ON POLICY hdp_problems_writer_update ON hdp_problems IS 'Проблему ведут agent_l2, care, admin и система';
COMMENT ON POLICY hdp_problems_linker_update ON hdp_problems IS 'Сотрудник, который ведёт обращения, при привязке обращения пересчитывает счётчики; другие поля ему закрывает t_hdp_problems_guard';
COMMENT ON POLICY hdp_problems_owner_select ON hdp_problems IS 'Владелец читает строки для представления hdp_problems_public, которое само отбирает показанные проблемы';
GRANT SELECT, INSERT, UPDATE ON hdp_problems TO hub_app;
GRANT USAGE ON SEQUENCE hdp_problems_number_sq TO hub_app;

-- ---------------------------------------------------------------------------
-- hdp_problem_translations: публичное название и описание по языкам
-- ---------------------------------------------------------------------------
CREATE TABLE hdp_problem_translations (
  translation_id uuid        NOT NULL DEFAULT uuidv7(),
  problem_id     uuid        NOT NULL,
  accepted_by    uuid,
  locale         text        NOT NULL,
  public_title   text        NOT NULL DEFAULT '',
  public_body    text        NOT NULL DEFAULT '',
  is_machine     boolean     NOT NULL DEFAULT false,
  accepted_on    timestamptz,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_problem_translations_pk PRIMARY KEY (translation_id),
  CONSTRAINT hdp_problem_translations_f1 FOREIGN KEY (problem_id) REFERENCES hdp_problems (problem_id),
  CONSTRAINT hdp_problem_translations_f2 FOREIGN KEY (accepted_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hdp_problem_translations_u1 UNIQUE (problem_id, locale),
  CONSTRAINT hdp_problem_translations_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdp_problem_translations_c2 CHECK (char_length(public_title) <= 200 AND public_title = btrim(public_title)),
  CONSTRAINT hdp_problem_translations_c3 CHECK (char_length(public_body) <= 5000),
  CONSTRAINT hdp_problem_translations_c4 CHECK ((accepted_by IS NULL) = (accepted_on IS NULL)),
  -- Принимают только машинный перевод: текст сотрудника и так его.
  CONSTRAINT hdp_problem_translations_c5 CHECK (is_machine OR accepted_by IS NULL)
);

CREATE INDEX hdp_problem_translations_i1 ON hdp_problem_translations (accepted_by);

COMMENT ON TABLE hdp_problem_translations IS 'Публичное название и описание известной проблемы по языкам портала (FR-KP-01). Клиент читает только через hdp_problems_public';
COMMENT ON COLUMN hdp_problem_translations.translation_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdp_problem_translations.problem_id IS 'Проблема';
COMMENT ON COLUMN hdp_problem_translations.accepted_by IS 'Сотрудник, который принял машинный перевод. Пусто: перевод не принят и клиенту не виден';
COMMENT ON COLUMN hdp_problem_translations.locale IS 'Язык: ru, uz, en';
COMMENT ON COLUMN hdp_problem_translations.public_title IS 'Публичное название, которое видит клиент. Пишет сотрудник, не берётся из текста клиента (угроза T23)';
COMMENT ON COLUMN hdp_problem_translations.public_body IS 'Публичное описание "Что происходит". Проходит проверку текста перед сохранением (решение 6)';
COMMENT ON COLUMN hdp_problem_translations.is_machine IS 'Текст подготовила модель (задание problems.translate). Клиенту виден только после принятия сотрудником';
COMMENT ON COLUMN hdp_problem_translations.accepted_on IS 'Когда сотрудник принял машинный перевод';
COMMENT ON COLUMN hdp_problem_translations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_problem_translations.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_problem_translations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_problem_translations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_problem_translations_stamp
  BEFORE INSERT OR UPDATE ON hdp_problem_translations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdp_problem_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_problem_translations FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_problem_translations_internal_select ON hdp_problem_translations FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdp_problem_translations_writer_insert ON hdp_problem_translations FOR INSERT TO hub_app WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problem_translations_writer_update ON hdp_problem_translations FOR UPDATE TO hub_app USING (app.hdp_can_write()) WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problem_translations_owner_select ON hdp_problem_translations FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hdp_problem_translations_internal_select ON hdp_problem_translations IS 'Тексты читают сотрудники и система. Клиент только через hdp_problems_public';
COMMENT ON POLICY hdp_problem_translations_writer_insert ON hdp_problem_translations IS 'Тексты пишут agent_l2, care, admin и система (машинный перевод)';
COMMENT ON POLICY hdp_problem_translations_writer_update ON hdp_problem_translations IS 'Тексты правят и принимают agent_l2, care, admin и система';
COMMENT ON POLICY hdp_problem_translations_owner_select ON hdp_problem_translations IS 'Владелец читает строки для представления hdp_problems_public';
GRANT SELECT, INSERT, UPDATE ON hdp_problem_translations TO hub_app;

-- ---------------------------------------------------------------------------
-- hdp_problem_signatures: сигнатуры ошибок проблемы
-- ---------------------------------------------------------------------------
CREATE TABLE hdp_problem_signatures (
  problem_id  uuid        NOT NULL,
  added_by    uuid,
  signature   text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_problem_signatures_pk PRIMARY KEY (problem_id, signature),
  CONSTRAINT hdp_problem_signatures_f1 FOREIGN KEY (problem_id) REFERENCES hdp_problems (problem_id),
  CONSTRAINT hdp_problem_signatures_f2 FOREIGN KEY (added_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hdp_problem_signatures_c1 CHECK (signature ~ '^[0-9a-f]{32}$')
);

-- Сигнатура уникальна среди активных проблем (раздел 10.5, решение 7): исправленная и закрытая не мешают новой.
CREATE UNIQUE INDEX hdp_problem_signatures_u1 ON hdp_problem_signatures (signature) WHERE is_active;
CREATE INDEX hdp_problem_signatures_i1 ON hdp_problem_signatures (added_by);

COMMENT ON TABLE hdp_problem_signatures IS 'Сигнатуры ошибок известной проблемы: по ним новое обращение привязывается само (FR-KP-04). Клиент не читает';
COMMENT ON COLUMN hdp_problem_signatures.problem_id IS 'Проблема';
COMMENT ON COLUMN hdp_problem_signatures.added_by IS 'Сотрудник, который добавил сигнатуру. Пусто: перенесена при создании из обращения системой';
COMMENT ON COLUMN hdp_problem_signatures.signature IS 'Сигнатура ошибки (ТЗ 11.5): 32 знака sha256';
COMMENT ON COLUMN hdp_problem_signatures.is_active IS 'Проблема активна (investigating, cause_found, fixing). Ведёт база по статусу проблемы (решение 7)';
COMMENT ON COLUMN hdp_problem_signatures.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_problem_signatures.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_problem_signatures.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_problem_signatures.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_problem_signatures_stamp
  BEFORE INSERT OR UPDATE ON hdp_problem_signatures
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Признак активности берётся только из статуса проблемы: присланное значение отбрасывается.
CREATE FUNCTION app.hdp_problem_signatures_active() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  NEW.is_active := EXISTS (SELECT 1 FROM hdp_problems p WHERE p.problem_id = NEW.problem_id AND p.status IN ('investigating', 'cause_found', 'fixing'));
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdp_problem_signatures_active() IS 'Триггер: признак активности сигнатуры ставится по статусу проблемы (решение 7)';
CREATE TRIGGER t_hdp_problem_signatures_active
  BEFORE INSERT OR UPDATE ON hdp_problem_signatures
  FOR EACH ROW EXECUTE FUNCTION app.hdp_problem_signatures_active();

-- Смена статуса проблемы переносит активность на её сигнатуры той же транзакцией.
CREATE FUNCTION app.hdp_problems_signatures_active() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  UPDATE hdp_problem_signatures SET is_active = NEW.status IN ('investigating', 'cause_found', 'fixing')
   WHERE problem_id = NEW.problem_id AND is_active IS DISTINCT FROM (NEW.status IN ('investigating', 'cause_found', 'fixing'));
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdp_problems_signatures_active() IS 'Триггер: смена статуса проблемы делает её сигнатуры активными или нет (решение 7)';
CREATE TRIGGER t_hdp_problems_signatures_active
  AFTER UPDATE OF status ON hdp_problems
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION app.hdp_problems_signatures_active();

ALTER TABLE hdp_problem_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_problem_signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_problem_signatures_internal_select ON hdp_problem_signatures FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdp_problem_signatures_writer_insert ON hdp_problem_signatures FOR INSERT TO hub_app WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problem_signatures_writer_update ON hdp_problem_signatures FOR UPDATE TO hub_app USING (app.hdp_can_write()) WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problem_signatures_writer_delete ON hdp_problem_signatures FOR DELETE TO hub_app USING (app.hdp_can_write());
COMMENT ON POLICY hdp_problem_signatures_internal_select ON hdp_problem_signatures IS 'Сигнатуры читают сотрудники и система. Клиент не читает';
COMMENT ON POLICY hdp_problem_signatures_writer_insert ON hdp_problem_signatures IS 'Сигнатуру добавляют agent_l2, care, admin и система';
COMMENT ON POLICY hdp_problem_signatures_writer_update ON hdp_problem_signatures IS 'Признак активности меняет триггер смены статуса от имени того, кто сменил статус';
COMMENT ON POLICY hdp_problem_signatures_writer_delete ON hdp_problem_signatures IS 'Сигнатуру убирают agent_l2, care, admin';
GRANT SELECT, INSERT, UPDATE, DELETE ON hdp_problem_signatures TO hub_app;

-- ---------------------------------------------------------------------------
-- hdp_problems_public: что клиент видит о проблеме (решение 2)
-- ---------------------------------------------------------------------------
-- Только показанные проблемы, кроме закрытых и исправленных больше 30 суток назад; только тексты сотрудника и принятые
-- переводы с названием и описанием. Нет внутреннего названия, владельца, счётчиков, сигнатур, моментов появления.
-- Обходной путь отдаётся идентификатором решения: его текст клиент читает только из hdk_published, где политика
-- оставляет решения для клиентов. Без актора (и под hub_auth) представление пусто.
CREATE VIEW hdp_problems_public WITH (security_barrier = true) AS
SELECT p.problem_id, p.number, p.status, p.module_id, p.workaround_solution_id, p.fixed_on,
       t.locale, t.public_title, t.public_body
  FROM hdp_problems p
  JOIN hdp_problem_translations t ON t.problem_id = p.problem_id
 WHERE app.actor_type() IN ('client', 'staff', 'system')
   AND p.show_to_clients
   AND p.status <> 'closed'
   AND (p.status <> 'fixed' OR p.fixed_on > now() - interval '30 days')
   AND t.public_title <> '' AND btrim(t.public_body) <> ''
   AND (NOT t.is_machine OR t.accepted_by IS NOT NULL);

COMMENT ON VIEW hdp_problems_public IS 'Известные проблемы для клиентов (FR-KP-05, 08, 09; решение 2): номер, статус, модуль, обходной путь, язык, публичные название и описание, момент исправления. Без внутренних полей';
GRANT SELECT ON hdp_problems_public TO hub_app;

-- ---------------------------------------------------------------------------
-- Обращение ссылается на проблему (колонка есть с миграции 0011)
-- ---------------------------------------------------------------------------
-- Ограничение NOT VALID и проверка отдельно: проверка не держит блокировку записи на таблице обращений. Индекс по
-- колонке частичный и создаётся вне транзакции следующей миграцией 0099.
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_f7 FOREIGN KEY (known_problem_id) REFERENCES hdp_problems (problem_id) NOT VALID;
ALTER TABLE hdt_tickets VALIDATE CONSTRAINT hdt_tickets_f7;
COMMENT ON COLUMN hdt_tickets.known_problem_id IS 'Известная проблема (веха M5c): не больше одной на обращение (FR-KP-04). Ставит сотрудник, правило или привязка по сигнатуре; клиент не задаёт';

-- Перевод публичного текста проблемы моделью (решение 17).
ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c1;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c1 CHECK (purpose IN ('solution_draft', 'translation', 'idea_translation', 'first_line', 'triage', 'message_translation', 'thanks', 'problem_translation'));
