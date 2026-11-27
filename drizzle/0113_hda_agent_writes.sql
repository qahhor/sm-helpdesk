-- Веха M8b, задача 6: записи AI-сотрудника (ТЗ 7.21 FR-AGT-04, 05, 07, 12, 14.3; план M8b, решения 18-22).
-- Агент пишет только то, что видят сотрудники, и ничего не читает обратно (политик чтения у актора agent нет):
--
-- 1. Внутренняя заметка и записка второй линии: строка hdt_ticket_messages с author_type = 'agent', is_internal,
--    автором учётной записью agent_bot токена и видом agent_note_kind. Политика вставки пускает только в обращение,
--    видное агенту. Триггер не даёт другим акторам писать от имени агента и считает заметки токена запуска (предел
--    note_limit). Заметка не трогает обращение, сроки, исполнителя, уведомления и правила: их меняет только код
--    сотрудника, а у таблицы сообщений триггеров на это нет.
-- 2. Черновик решения: статья hdk_articles с is_agent_draft, is_untrusted, аудиторией internal, версия-черновик,
--    перевод и обращения-источники, видные агенту. Предлагаемая правка опубликованного решения ссылкой
--    revises_article_id, чужую статью агент не меняет. Публикует сотрудник обычным порядком.
-- 3. Черновик известной проблемы: статус draft (не активный, признак показа запрещён), сигнатура неактивна (триггер
--    активности по статусу), обращения только предложены в hdp_problem_proposals, описание агента в internal_description.
--    Принимает и отклоняет сотрудник с правом ведения проблем.
-- 4. Сводка: таблица и политики с миграции 0109.

-- ---------------------------------------------------------------------------
-- 1. Заметки агента
-- ---------------------------------------------------------------------------
ALTER TABLE hdt_ticket_messages ADD COLUMN agent_note_kind text;
COMMENT ON COLUMN hdt_ticket_messages.agent_note_kind IS 'Вид записи AI-сотрудника: note (внутренняя заметка) или handoff_memo (черновик записки второй линии). Только у author_type = agent';
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c8 CHECK (
  (author_type = 'agent') = (agent_note_kind IS NOT NULL)
  AND (agent_note_kind IS NULL OR (is_internal AND agent_note_kind IN ('note', 'handoff_memo')))
) NOT VALID;
ALTER TABLE hdt_ticket_messages VALIDATE CONSTRAINT hdt_ticket_messages_c8;
COMMENT ON CONSTRAINT hdt_ticket_messages_c8 ON hdt_ticket_messages IS 'Запись AI-сотрудника всегда внутренняя и с видом note или handoff_memo; у остальных авторов вида нет';

CREATE POLICY hdt_ticket_messages_agent_insert ON hdt_ticket_messages FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'agent'
    AND author_type = 'agent' AND is_internal AND agent_note_kind IS NOT NULL
    AND author_id::text = app.user_id()
    AND NOT is_auto AND broadcast_id IS NULL AND ai_payload IS NULL AND email_message_id IS NULL
    AND app.agent_can_see_org(org_id)
    AND (app.agent_ticket_id() IS NULL OR ticket_id = app.agent_ticket_id())
  );
COMMENT ON POLICY hdt_ticket_messages_agent_insert ON hdt_ticket_messages IS 'AI-сотрудник пишет только внутреннюю заметку или записку от своей учётной записи в обращение, видное ему; токен запуска только в своё';

-- Счётчик заметок токена запуска меняет функция от имени владельца: у актора agent прав на токены нет.
CREATE POLICY hda_agent_tokens_owner_update ON hda_agent_tokens FOR UPDATE TO hub_owner
  USING (parent_token_id IS NOT NULL) WITH CHECK (parent_token_id IS NOT NULL);
COMMENT ON POLICY hda_agent_tokens_owner_update ON hda_agent_tokens IS 'Владелец увеличивает счётчик заметок токена запуска в функции app.hdt_ticket_messages_agent_guard()';

CREATE FUNCTION app.hdt_ticket_messages_agent_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.author_type <> 'agent' THEN
    RETURN NEW;
  END IF;
  -- Подготовка данных суперпользователем идёт без актора.
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF app.actor_type() <> 'agent' THEN
    RAISE EXCEPTION 'Сообщение: запись AI-сотрудника пишет только сам AI-сотрудник' USING ERRCODE = '42501';
  END IF;
  IF app.agent_ticket_id() IS NOT NULL THEN
    UPDATE public.hda_agent_tokens SET notes_written = notes_written + 1
     WHERE token_id = app.agent_token_id() AND notes_written < note_limit;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Токен запуска: предел заметок исчерпан' USING ERRCODE = '23514', CONSTRAINT = 'hda_agent_tokens_c9';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_ticket_messages_agent_guard() IS 'Триггер: запись с author_type = agent пишет только актор agent; у токена запуска заметки считаются до note_limit (FR-AGT-12)';
CREATE TRIGGER t_hdt_ticket_messages_agent_guard
  BEFORE INSERT ON hdt_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION app.hdt_ticket_messages_agent_guard();

-- ---------------------------------------------------------------------------
-- 2. Черновик решения
-- ---------------------------------------------------------------------------
ALTER TABLE hdk_articles ADD COLUMN is_agent_draft boolean NOT NULL DEFAULT false;
ALTER TABLE hdk_articles ADD COLUMN revises_article_id uuid;
COMMENT ON COLUMN hdk_articles.is_agent_draft IS 'Черновик записал AI-сотрудник (FR-AGT-04): пометка "AI-сотрудник, не проверено" до публикации';
COMMENT ON COLUMN hdk_articles.revises_article_id IS 'Черновик AI-сотрудника предлагает правку этого решения. Само решение агент не меняет';
ALTER TABLE hdk_articles ADD CONSTRAINT hdk_articles_f3 FOREIGN KEY (revises_article_id) REFERENCES hdk_articles (article_id);
ALTER TABLE hdk_articles ADD CONSTRAINT hdk_articles_c8 CHECK (NOT is_agent_draft OR is_untrusted);
COMMENT ON CONSTRAINT hdk_articles_c8 ON hdk_articles IS 'Черновик AI-сотрудника всегда с недоверенным текстом: находки публикуются только после отметки каждой';
CREATE INDEX hdk_articles_i3 ON hdk_articles (revises_article_id) WHERE revises_article_id IS NOT NULL;
COMMENT ON INDEX hdk_articles_i3 IS 'Внешний ключ: решение, правку которого предлагает черновик AI-сотрудника';

-- Статья заведена этим актором agent в этой транзакции: к ней агент добавляет версию, перевод и источники.
CREATE FUNCTION app.agent_new_article(article uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT app.actor_type() = 'agent' AND app.agent_token_active() AND EXISTS (
    SELECT 1 FROM public.hdk_articles a
     WHERE a.article_id = article AND a.is_agent_draft AND a.created_by = app.user_id() AND a.created_on = now())
$$;
COMMENT ON FUNCTION app.agent_new_article(uuid) IS 'Истина, если статью только что завёл этот AI-сотрудник в текущей транзакции (черновик решения, решение 21)';

-- Политика владельца hdk_articles_owner_select есть с миграции 0110: функция ниже читает статьи по ней.

CREATE POLICY hdk_articles_agent_insert ON hdk_articles FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL
    AND is_agent_draft AND is_untrusted AND audience = 'internal' AND status = 'active' AND archived_on IS NULL
    AND owner_id IS NULL AND shown_count = 0 AND helped_count = 0 AND not_helped_count = 0 AND staff_useful_count = 0
  );
CREATE POLICY hdk_article_versions_agent_insert ON hdk_article_versions FOR INSERT TO hub_app
  WITH CHECK (app.agent_new_article(article_id) AND state = 'draft' AND number = 1 AND NOT is_machine AND source_version_id IS NULL AND untrusted_confirmed IS NULL);
CREATE POLICY hdk_article_translations_agent_insert ON hdk_article_translations FOR INSERT TO hub_app
  WITH CHECK (app.agent_new_article(article_id) AND published_version_id IS NULL);
CREATE POLICY hdk_article_sources_agent_insert ON hdk_article_sources FOR INSERT TO hub_app
  WITH CHECK (app.agent_new_article(article_id) AND app.agent_can_see_org(org_id));
COMMENT ON POLICY hdk_articles_agent_insert ON hdk_articles IS 'AI-сотрудник основным токеном заводит только черновик решения: internal, недоверенный, без ответственного и счётчиков';
COMMENT ON POLICY hdk_article_versions_agent_insert ON hdk_article_versions IS 'AI-сотрудник пишет только первую версию-черновик своей новой статьи';
COMMENT ON POLICY hdk_article_translations_agent_insert ON hdk_article_translations IS 'AI-сотрудник пишет только перевод-черновик своей новой статьи, без опубликованной версии';
COMMENT ON POLICY hdk_article_sources_agent_insert ON hdk_article_sources IS 'AI-сотрудник указывает источниками своей новой статьи только обращения организаций, видных ему';

-- ---------------------------------------------------------------------------
-- 3. Черновик известной проблемы
-- ---------------------------------------------------------------------------
ALTER TABLE hdp_problems ADD COLUMN internal_description text;
COMMENT ON COLUMN hdp_problems.internal_description IS 'Внутреннее описание: у черновика AI-сотрудника его текст. Клиенту не показывается';
ALTER TABLE hdp_problems DROP CONSTRAINT hdp_problems_c1;
ALTER TABLE hdp_problems ADD CONSTRAINT hdp_problems_c1 CHECK (status IN ('draft', 'investigating', 'cause_found', 'fixing', 'fixed', 'closed'));
ALTER TABLE hdp_problems ADD CONSTRAINT hdp_problems_c7 CHECK (status <> 'draft' OR NOT show_to_clients);
ALTER TABLE hdp_problems ADD CONSTRAINT hdp_problems_c8 CHECK (internal_description IS NULL OR char_length(internal_description) <= 4000);
COMMENT ON CONSTRAINT hdp_problems_c1 ON hdp_problems IS 'Статусы проблемы; draft: черновик AI-сотрудника или всплеска, не активный и клиенту не виден (решение 20 плана M8b)';
COMMENT ON CONSTRAINT hdp_problems_c7 ON hdp_problems IS 'Черновик проблемы клиенту не показывается';
COMMENT ON CONSTRAINT hdp_problems_c8 ON hdp_problems IS 'Внутреннее описание не длиннее 4000 знаков';

CREATE OR REPLACE FUNCTION app.hdp_problems_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  counted CONSTANT text[] := ARRAY['ticket_count', 'org_count', 'first_seen_on', 'last_seen_on', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  total integer;
  orgs integer;
  first_on timestamptz;
  last_on timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'draft' THEN
      -- Черновик заводят AI-сотрудник и система (всплеск сигнатуры), без признака показа (решение 20 плана M8b).
      IF app.actor_type() NOT IN ('agent', 'system', 'none') THEN
        RAISE EXCEPTION 'Проблема: черновик заводят только AI-сотрудник и система' USING ERRCODE = '42501';
      END IF;
      NEW.show_to_clients := false;
    ELSIF NEW.status <> 'investigating' AND NEW.status <> 'cause_found' AND NEW.status <> 'fixing' THEN
      RAISE EXCEPTION 'Проблема: новая проблема бывает только активной или черновиком' USING ERRCODE = '42501';
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
    IF NEW.status = 'closed' AND NEW.fixed_on IS NULL THEN NEW.fixed_on := coalesce(NEW.closed_on, now()); END IF;
    IF NEW.status = 'closed' AND NEW.closed_on IS NULL THEN NEW.closed_on := now(); END IF;
    RETURN NEW;
  END IF;
  IF NOT app.hdp_can_write() AND (to_jsonb(NEW) - counted) IS DISTINCT FROM (to_jsonb(OLD) - counted) THEN
    RAISE EXCEPTION 'Проблема: менять проблему может только вторая линия, Customer Care и администратор' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'closed' AND (to_jsonb(NEW) - counted) IS DISTINCT FROM (to_jsonb(OLD) - counted) THEN
    RAISE EXCEPTION 'Проблема: закрытая проблема не меняется' USING ERRCODE = '42501';
  END IF;
  -- Из черновика только принятие (investigating) или отклонение (closed); в черновик не возвращаются.
  IF NEW.status IS DISTINCT FROM OLD.status AND (NEW.status = 'draft' OR (OLD.status = 'draft' AND NEW.status NOT IN ('investigating', 'closed'))) THEN
    RAISE EXCEPTION 'Проблема: черновик только принимается или отклоняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Отклонённый черновик не исправлен: момента исправления у него нет (показатель FR-MET-08).
    NEW.fixed_on := CASE WHEN NEW.status = 'fixed' THEN now() WHEN NEW.status = 'closed' AND OLD.status = 'draft' THEN NULL
                         WHEN NEW.status = 'closed' THEN coalesce(OLD.fixed_on, now()) ELSE NULL END;
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
  'Триггер: номер не меняется, закрытая проблема не меняется, черновик заводят AI-сотрудник и система, из черновика только принятие или отклонение, моменты статуса ставит база, без права ведения меняется только пересчёт; счётчики и моменты появления пересчитываются по привязанным обращениям';

-- Проблема заведена этим актором agent в этой транзакции: к ней агент добавляет сигнатуру и предложения.
CREATE FUNCTION app.agent_new_problem(problem uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT app.actor_type() = 'agent' AND app.agent_token_active() AND EXISTS (
    SELECT 1 FROM public.hdp_problems p
     WHERE p.problem_id = problem AND p.status = 'draft' AND p.created_by = app.user_id() AND p.created_on = now())
$$;
COMMENT ON FUNCTION app.agent_new_problem(uuid) IS 'Истина, если черновик проблемы только что завёл этот AI-сотрудник в текущей транзакции (решение 20)';

CREATE POLICY hdp_problems_agent_insert ON hdp_problems FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL
    AND status = 'draft' AND NOT show_to_clients AND owner_id IS NULL AND workaround_solution_id IS NULL
  );
CREATE POLICY hdp_problem_signatures_agent_insert ON hdp_problem_signatures FOR INSERT TO hub_app
  WITH CHECK (app.agent_new_problem(problem_id) AND added_by IS NULL);
COMMENT ON POLICY hdp_problems_agent_insert ON hdp_problems IS 'AI-сотрудник основным токеном заводит только черновик проблемы без признака показа, владельца и обходного пути';
COMMENT ON POLICY hdp_problem_signatures_agent_insert ON hdp_problem_signatures IS 'AI-сотрудник добавляет сигнатуру только своему новому черновику; она неактивна по статусу draft';

CREATE TABLE hdp_problem_proposals (
  org_id      uuid        NOT NULL,
  proposal_id uuid        NOT NULL DEFAULT uuidv7(),
  problem_id  uuid        NOT NULL,
  ticket_id   uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_problem_proposals_pk PRIMARY KEY (proposal_id),
  CONSTRAINT hdp_problem_proposals_f1 FOREIGN KEY (problem_id) REFERENCES hdp_problems (problem_id),
  CONSTRAINT hdp_problem_proposals_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  -- Индекс u1 покрывает внешний ключ проблемы.
  CONSTRAINT hdp_problem_proposals_u1 UNIQUE (problem_id, ticket_id)
);
CREATE INDEX hdp_problem_proposals_i1 ON hdp_problem_proposals (ticket_id, org_id);
COMMENT ON INDEX hdp_problem_proposals_i1 IS 'Внешний ключ: обращение';
COMMENT ON TABLE hdp_problem_proposals IS 'Обращения, которые черновик известной проблемы предлагает привязать (решение 20 плана M8b). Привязку делает сотрудник кнопкой "Привязать предложенные". Клиент не видит';
COMMENT ON COLUMN hdp_problem_proposals.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdp_problem_proposals.proposal_id IS 'Идентификатор предложения';
COMMENT ON COLUMN hdp_problem_proposals.problem_id IS 'Черновик проблемы';
COMMENT ON COLUMN hdp_problem_proposals.ticket_id IS 'Предложенное обращение';
COMMENT ON COLUMN hdp_problem_proposals.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_problem_proposals.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_problem_proposals.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_problem_proposals.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_problem_proposals_stamp
  BEFORE INSERT OR UPDATE ON hdp_problem_proposals
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdp_problem_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_problem_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_problem_proposals_internal_select ON hdp_problem_proposals FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdp_problem_proposals_writer_insert ON hdp_problem_proposals FOR INSERT TO hub_app WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_problem_proposals_agent_insert ON hdp_problem_proposals FOR INSERT TO hub_app
  WITH CHECK (app.agent_new_problem(problem_id) AND app.agent_can_see_org(org_id));
CREATE POLICY hdp_problem_proposals_writer_delete ON hdp_problem_proposals FOR DELETE TO hub_app USING (app.hdp_can_write());
COMMENT ON POLICY hdp_problem_proposals_internal_select ON hdp_problem_proposals IS 'Предложения читают сотрудники и система. Клиент не читает';
COMMENT ON POLICY hdp_problem_proposals_writer_insert ON hdp_problem_proposals IS 'Предложения черновика всплеска пишет система (и роли ведения проблем)';
COMMENT ON POLICY hdp_problem_proposals_agent_insert ON hdp_problem_proposals IS 'AI-сотрудник предлагает к своему новому черновику только обращения организаций, видных ему';
COMMENT ON POLICY hdp_problem_proposals_writer_delete ON hdp_problem_proposals IS 'Предложение снимает сотрудник с правом ведения проблем после привязки';
GRANT SELECT, INSERT, DELETE ON hdp_problem_proposals TO hub_app;
