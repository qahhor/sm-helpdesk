-- Независимая проверка вехи M8c "Знания из кода", часть 2: права и защита (решение 0134; находки I2-I6). Миграции
-- 0118-0121 не меняются; политики только сужаются, кроме одной узкой политики второй линии (п. 4).
--
-- 1. Заметку анализа по коду (agent_note_kind = code_analysis) из сотрудников читают только agent_l2, care, admin
--    (FR-CODE-11, находка I2): ограничивающая политика чтения сообщений обращения.
-- 2. Токен запуска хранит назначение (purpose): повторный выпуск отзывает только токен того же назначения (I3).
-- 3. Агент не читает и не меняет таблицу запросов анализа (I5): политики агента сняты, ответ отмечает функция
--    app.hda_code_analysis_answer() с правами владельца и проверкой видимости; наружу только номер запроса и прежний
--    статус, без сотрудника и организации.
-- 4. Ожидающий запрос с вышедшим сроком вторая линия переводит в timeout той же транзакцией, что и новый запрос (I4):
--    политика изменения только для pending с due_on в прошлом и только в timeout.
-- 5. Агент не переписывает утверждённое (I6): у утверждённой или отклонённой записи без сброса в черновик меняются
--    только сканирование, вид изменения и служебные колонки; шаблоны таких записей агент не пишет и не удаляет.

-- ---------------------------------------------------------------------------
-- 1. Заметка анализа по коду
-- ---------------------------------------------------------------------------
CREATE POLICY hdt_ticket_messages_code_restrict ON hdt_ticket_messages AS RESTRICTIVE FOR SELECT TO hub_app
  USING (agent_note_kind IS DISTINCT FROM 'code_analysis' OR app.actor_type() <> 'staff' OR app.hda_code_reader());
COMMENT ON POLICY hdt_ticket_messages_code_restrict ON hdt_ticket_messages IS 'Заметку анализа по коду из сотрудников видят только agent_l2, care, admin (FR-CODE-11; решение 0134, находка I2)';

-- ---------------------------------------------------------------------------
-- 2. Назначение токена запуска
-- ---------------------------------------------------------------------------
ALTER TABLE hda_agent_tokens ADD COLUMN purpose text NOT NULL DEFAULT 'ticket';
ALTER TABLE hda_agent_tokens ADD CONSTRAINT hda_agent_tokens_c10 CHECK (purpose IN ('ticket', 'code_analysis') AND (purpose = 'ticket' OR parent_token_id IS NOT NULL));
COMMENT ON COLUMN hda_agent_tokens.purpose IS 'Назначение токена запуска: ticket (событие по обращению) или code_analysis (анализ по коду). У основного токена ticket и не используется (решение 0134)';
COMMENT ON CONSTRAINT hda_agent_tokens_c10 ON hda_agent_tokens IS 'Назначение из перечня; code_analysis только у токена запуска';

-- ---------------------------------------------------------------------------
-- 3, 4. Запросы анализа
-- ---------------------------------------------------------------------------
DROP POLICY hda_code_analysis_requests_agent_select ON hda_code_analysis_requests;
DROP POLICY hda_code_analysis_requests_agent_update ON hda_code_analysis_requests;
CREATE POLICY hda_code_analysis_requests_owner_select ON hda_code_analysis_requests FOR SELECT TO hub_owner USING (true);
CREATE POLICY hda_code_analysis_requests_owner_update ON hda_code_analysis_requests FOR UPDATE TO hub_owner
  USING (app.actor_type() = 'agent') WITH CHECK (app.actor_type() = 'agent' AND status = 'done');
COMMENT ON POLICY hda_code_analysis_requests_owner_select ON hda_code_analysis_requests IS 'Владелец читает строки для функции app.hda_code_analysis_answer(), которая сама проверяет видимость агенту';
COMMENT ON POLICY hda_code_analysis_requests_owner_update ON hda_code_analysis_requests IS 'Ответ агента функцией app.hda_code_analysis_answer(): только в done; остальное закрывает триггер';
CREATE POLICY hda_code_analysis_requests_reader_update ON hda_code_analysis_requests FOR UPDATE TO hub_app
  USING (app.hda_code_reader() AND status = 'pending' AND due_on <= now())
  WITH CHECK (app.hda_code_reader() AND status = 'timeout');
COMMENT ON POLICY hda_code_analysis_requests_reader_update ON hda_code_analysis_requests IS 'Вторая линия переводит ожидающий запрос с вышедшим сроком в timeout перед новым запросом (решение 0134, находка I4)';

CREATE OR REPLACE FUNCTION app.hda_code_analysis_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
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
     OR (app.actor_type() = 'staff' AND NOT (OLD.status = 'pending' AND OLD.due_on <= now() AND NEW.status = 'timeout' AND NEW.note_message_id IS NULL))
     OR app.actor_type() NOT IN ('agent', 'system', 'staff') THEN
    RAISE EXCEPTION 'Знания из кода: запрос анализа закрывает только ответ агента или истечение срока' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_code_analysis_requests_guard() IS 'Триггер: запрос создаётся ожидающим от своего имени; агент только отвечает, система и вторая линия только ставят истечение вышедшего срока';

-- Ответ агента: последний запрос обращения, видимого агенту, переходит в done со ссылкой на его заметку анализа.
CREATE FUNCTION app.hda_code_analysis_answer(p_ticket_id uuid, p_message_id uuid)
RETURNS TABLE (request_id uuid, previous_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
DECLARE
  v_request uuid;
  v_org uuid;
  v_status text;
BEGIN
  IF app.actor_type() <> 'agent' OR NOT app.agent_token_active() OR (app.agent_ticket_id() IS NOT NULL AND app.agent_ticket_id() <> p_ticket_id) THEN
    RETURN;
  END IF;
  SELECT q.request_id, q.org_id, q.status INTO v_request, v_org, v_status
    FROM public.hda_code_analysis_requests q
   WHERE q.ticket_id = p_ticket_id
   ORDER BY q.created_on DESC
   LIMIT 1
     FOR UPDATE;
  IF v_request IS NULL OR NOT app.agent_can_see_org(v_org) THEN
    RETURN;
  END IF;
  -- Ссылка только на заметку анализа этого обращения от учётной записи агента.
  IF p_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.hdt_ticket_messages m
     WHERE m.message_id = p_message_id AND m.ticket_id = p_ticket_id AND m.agent_note_kind = 'code_analysis' AND m.author_id::text = app.user_id()) THEN
    RETURN;
  END IF;
  IF v_status <> 'done' THEN
    UPDATE public.hda_code_analysis_requests q
       SET status = 'done', note_message_id = p_message_id, finished_on = now()
     WHERE q.request_id = v_request;
  END IF;
  request_id := v_request;
  previous_status := v_status;
  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION app.hda_code_analysis_answer(uuid, uuid) IS 'Ответ агента на запрос анализа: последний запрос видимого агенту обращения в done со ссылкой на его заметку анализа. Отдаёт номер запроса и прежний статус, без сотрудника и организации (решение 0134, находка I5)';

-- ---------------------------------------------------------------------------
-- 5. Агент и утверждённое
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.hda_code_error_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  -- signature генерируется после триггеров BEFORE: в NEW она ещё пуста и в сравнение не входит.
  v_editable CONSTANT text[] := ARRAY['conditions', 'user_cause', 'what_to_check', 'kind', 'status', 'approved_by', 'approved_on', 'reject_reason', 'signature', 'modified_by', 'modified_on'];
  -- Агент переносит решённую запись в новое сканирование без изменения содержимого.
  v_carry CONSTANT text[] := ARRAY['scan_id', 'change_kind', 'signature', 'modified_by', 'modified_on'];
  -- Исчезновение меняет только статус и снимает утверждение.
  v_remove CONSTANT text[] := ARRAY['scan_id', 'change_kind', 'status', 'approved_by', 'approved_on', 'signature', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF app.actor_type() = 'agent' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'Знания из кода: AI-сотрудник пишет только черновики' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.key IS DISTINCT FROM OLD.key
       OR NOT (
         -- Черновик (в том числе сброс решённой записи): содержимое меняется, утверждения нет.
         (NEW.status = 'draft' AND NEW.approved_by IS NULL AND NEW.approved_on IS NULL)
         OR (NEW.status = 'removed' AND NEW.approved_by IS NULL AND NEW.approved_on IS NULL AND (to_jsonb(NEW) - v_remove) = (to_jsonb(OLD) - v_remove))
         OR (NEW.status = OLD.status AND (to_jsonb(NEW) - v_carry) = (to_jsonb(OLD) - v_carry))) THEN
      RAISE EXCEPTION 'Знания из кода: AI-сотрудник не утверждает записи и не меняет решённые, не вернув их в черновик' USING ERRCODE = '42501';
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
COMMENT ON FUNCTION app.hda_code_error_entries_guard() IS 'Триггер: AI-сотрудник не утверждает записи и меняет утверждённую или отклонённую только сбросом в черновик; сотрудник меняет только поля правки и статус и утверждает от своего имени (решение 0134, находка I6)';

-- Шаблоны утверждённой или отклонённой записи агент не пишет: сканирование сначала сбрасывает запись в черновик.
CREATE FUNCTION app.hda_code_error_templates_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'agent' AND EXISTS (
       SELECT 1 FROM public.hda_code_error_entries e
        WHERE e.entry_id IN (CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END, CASE WHEN TG_OP = 'INSERT' THEN NEW.entry_id ELSE OLD.entry_id END)
          AND e.status IN ('approved', 'rejected')) THEN
    RAISE EXCEPTION 'Знания из кода: AI-сотрудник не меняет шаблоны решённой записи, не вернув её в черновик' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
COMMENT ON FUNCTION app.hda_code_error_templates_guard() IS 'Триггер: AI-сотрудник не пишет и не удаляет шаблоны утверждённой или отклонённой записи (решение 0134, находка I6)';
CREATE TRIGGER t_hda_code_error_templates_guard
  BEFORE INSERT OR UPDATE OR DELETE ON hda_code_error_templates
  FOR EACH ROW EXECUTE FUNCTION app.hda_code_error_templates_guard();
