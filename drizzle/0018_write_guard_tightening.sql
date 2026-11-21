-- Второй слой защиты записи (вторая проверка M2). Только ужесточение: права не расширяются, база перестаёт
-- принимать то, чего не делает ни одна операция портала. Решение 0026, пункт 24.
-- 1. Обращение клиента: статус меняется только переходами его операций (ответ, подтверждение, повторное открытие),
--    дату закрытия и последнего сообщения ставит база, оценку ставит автор закрытого обращения один раз.
--    При создании оценки и даты последнего сообщения нет.
-- 2. Сообщение клиента: только из его каналов (портал, виджет) и без идентификатора письма.
-- 3. Вложение: новая загрузка (клиента и сотрудника) лежит в карантине под ключом quarantine/<attachment_id> без
--    результатов проверки. Результат проверки и ключ хранилища меняет только система. Клиент прикрепляет загрузку
--    к своему сообщению или к описанию своего обращения.

CREATE OR REPLACE FUNCTION app.hdt_tickets_client_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  allowed CONSTANT text[] := ARRAY['status', 'visibility', 'closed_on', 'last_client_message_on',
                                   'csat_score', 'csat_reason', 'csat_comment', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  -- Переходы операций клиента (раздел 7.2): ответ из ожидания и решённого, повторное открытие, подтверждение.
  transitions CONSTANT text[] := ARRAY['waiting_customer>in_progress', 'resolved>in_progress', 'closed>in_progress', 'resolved>closed'];
BEGIN
  IF app.actor_type() <> 'client' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'new' OR NEW.queue <> 'l1' OR NEW.assignee_id IS NOT NULL OR NEW.priority_confirmed
       OR NEW.ai_state <> 'none' OR NEW.ai_reply_count <> 0 OR NEW.closed_on IS NOT NULL
       OR NEW.csat_score IS NOT NULL OR NEW.csat_reason IS NOT NULL OR NEW.csat_comment IS NOT NULL
       OR NEW.last_client_message_on IS NOT NULL
       OR NEW.resolved_on IS NOT NULL OR NEW.merged_into_id IS NOT NULL OR NEW.solution_id IS NOT NULL
       OR NEW.first_response_due_on IS NOT NULL OR NEW.resolution_due_on IS NOT NULL
       OR NEW.first_responded_on IS NOT NULL OR NEW.sla_paused_on IS NOT NULL OR NEW.sla_paused_seconds <> 0
       OR NEW.resolution_type IS NOT NULL OR NEW.known_problem_id IS NOT NULL OR NEW.snoozed_until IS NOT NULL
       OR NEW.ai_handoff_reason IS NOT NULL
       OR NEW.source NOT IN ('portal', 'widget_web', 'widget_mobile')
       OR NEW.priority IS DISTINCT FROM (CASE NEW.impact WHEN 'blocker' THEN 'p1' WHEN 'major' THEN 'p2'
                                                         WHEN 'minor' THEN 'p3' WHEN 'question' THEN 'p4' END) THEN
      RAISE EXCEPTION 'Обращение: клиент создаёт только новое обращение без полей сотрудника, остальное нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Обращение: клиенту менять эти поля нельзя' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status || '>' || NEW.status) = ANY (transitions) THEN
    RAISE EXCEPTION 'Обращение: клиенту такой переход статуса нельзя' USING ERRCODE = '42501';
  END IF;
  -- Дату закрытия ставит база при подтверждении решения. Иначе она не меняется: от неё считается срок
  -- повторного открытия (FR-TK-12).
  IF OLD.status = 'resolved' AND NEW.status = 'closed' THEN
    NEW.closed_on := now();
  ELSIF NEW.closed_on IS DISTINCT FROM OLD.closed_on THEN
    RAISE EXCEPTION 'Обращение: дату закрытия клиенту менять нельзя' USING ERRCODE = '42501';
  END IF;
  IF NEW.last_client_message_on IS DISTINCT FROM OLD.last_client_message_on THEN
    NEW.last_client_message_on := now();
  END IF;
  IF (NEW.csat_score, NEW.csat_reason, NEW.csat_comment) IS DISTINCT FROM (OLD.csat_score, OLD.csat_reason, OLD.csat_comment)
     AND (OLD.csat_score IS NOT NULL OR NEW.csat_score IS NULL OR OLD.status <> 'closed' OR NEW.status <> 'closed'
          OR OLD.author_id IS DISTINCT FROM app.user_uuid()) THEN
    RAISE EXCEPTION 'Обращение: оценку ставит автор закрытого обращения один раз, иначе нельзя' USING ERRCODE = '42501';
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility AND NOT (OLD.author_id = app.user_uuid() OR app.org_role() = 'client_admin') THEN
    RAISE EXCEPTION 'Обращение: видимость меняют только автор и администратор клиента, остальным нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_client_guard() IS
  'Триггер: клиент создаёт новое обращение без полей сотрудника и меняет только колонки и переходы своих операций; даты ставит база';

DROP POLICY hdt_ticket_messages_client_insert ON hdt_ticket_messages;
CREATE POLICY hdt_ticket_messages_client_insert ON hdt_ticket_messages FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client' AND NOT is_internal AND author_type = 'client'
    AND author_id = app.user_uuid() AND org_id = app.org_id()
    AND source IN ('portal', 'widget_web', 'widget_mobile') AND email_message_id IS NULL
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_ticket_messages.ticket_id)
  );
COMMENT ON POLICY hdt_ticket_messages_client_insert ON hdt_ticket_messages IS
  'Клиент пишет от своего имени в видимое обращение своей организации, из своих каналов, без внутренних заметок';

CREATE OR REPLACE FUNCTION app.hdt_attachments_client_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  allowed CONSTANT text[] := ARRAY['ticket_id', 'message_id', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  -- Система проверяет и переносит файлы; без актора работают только миграции и тесты под суперпользователем.
  IF app.actor_type() IN ('system', 'none') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.storage_key IS DISTINCT FROM 'quarantine/' || NEW.attachment_id::text OR NEW.scan_status <> 'pending'
       OR NEW.scan_signature IS NOT NULL OR NEW.detected_type IS NOT NULL OR NEW.sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'Вложение: новая загрузка лежит в карантине под своим ключом и без результатов проверки, иначе нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.scan_status, NEW.scan_signature, NEW.detected_type, NEW.sha256, NEW.storage_key)
     IS DISTINCT FROM (OLD.scan_status, OLD.scan_signature, OLD.detected_type, OLD.sha256, OLD.storage_key) THEN
    RAISE EXCEPTION 'Вложение: результат проверки и ключ хранилища меняет только система, остальным нельзя' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'client'
     AND ((to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)
          OR (OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id)
          OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id)) THEN
    RAISE EXCEPTION 'Вложение: клиент только прикрепляет свою загрузку, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_attachments_client_guard() IS
  'Триггер: загрузка начинается в карантине, результат проверки меняет только система, клиент только прикрепляет свою загрузку';

DROP TRIGGER t_hdt_attachments_client_guard ON hdt_attachments;
CREATE TRIGGER t_hdt_attachments_client_guard
  BEFORE INSERT OR UPDATE ON hdt_attachments
  FOR EACH ROW EXECUTE FUNCTION app.hdt_attachments_client_guard();

DROP POLICY hdt_attachments_client_update ON hdt_attachments;
CREATE POLICY hdt_attachments_client_update ON hdt_attachments FOR UPDATE TO hub_app
  USING (app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid())
  WITH CHECK (
    app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid()
    AND (
      ticket_id IS NULL
      -- Описание обращения: только своего.
      OR (message_id IS NULL AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_attachments.ticket_id AND t.author_id = app.user_uuid()))
      -- Ответ: только своё сообщение в этом обращении. Подзапрос идёт под политикой сообщений: невидимое не найдётся.
      OR (message_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM hdt_ticket_messages m
             WHERE m.message_id = hdt_attachments.message_id AND m.ticket_id = hdt_attachments.ticket_id
               AND m.author_type = 'client' AND m.author_id = app.user_uuid()))
    )
  );
COMMENT ON POLICY hdt_attachments_client_update ON hdt_attachments IS
  'Клиент прикрепляет свою загрузку к описанию своего обращения или к своему сообщению в видимом обращении';
