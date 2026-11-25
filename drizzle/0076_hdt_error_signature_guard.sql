-- План M5, задача 8 (сигнатуры ошибок, решение 7). Сигнатуру ошибки обращения считает сервер от имени системы после
-- создания обращения: из кода и текста ошибки контекста или из строки ошибки в описании (ТЗ 11.5). Клиент её не
-- задаёт: иначе он накручивал бы число организаций "встречалось у N клиентов" любой сигнатуры (решение 8) и получал
-- бы точное совпадение подсказки по чужой сигнатуре. Функция повторяет миграцию 0070 дословно, добавлен только запрет
-- error_signature во вставке клиента; правка обращения клиентом и раньше не меняла эту колонку (она не в списке
-- разрешённых).

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
       OR NEW.first_responded_on IS NOT NULL OR NEW.sla_paused_on IS NOT NULL OR NEW.sla_paused_minutes <> 0
       OR NEW.resolution_type IS NOT NULL OR NEW.known_problem_id IS NOT NULL OR NEW.snoozed_until IS NOT NULL
       OR NEW.ai_handoff_reason IS NOT NULL
       -- Служебные отметки, добавленные после миграции 0027: их ставят сотрудник, фоновая задача и правила.
       OR NEW.first_response_breached_on IS NOT NULL OR NEW.resolution_breached_on IS NOT NULL
       OR NEW.first_response_soon_on IS NOT NULL OR NEW.resolution_soon_on IS NOT NULL
       OR NEW.oncall_notified_on IS NOT NULL OR NEW.waiting_reminded_on IS NOT NULL OR NEW.update_reminded_on IS NOT NULL
       OR NEW.snooze_returned_on IS NOT NULL OR NEW.resolved_version IS NOT NULL OR NEW.sender_unconfirmed
       OR NEW.csat_review_note IS NOT NULL OR NEW.csat_reviewed_by IS NOT NULL OR NEW.csat_reviewed_on IS NOT NULL
       -- Сигнатуру ошибки считает сервер от имени системы после создания обращения (миграция 0076).
       OR NEW.error_signature IS NOT NULL
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
  -- Объединённое обращение закрыто навсегда: клиент продолжает в основном (решение 4 плана M3).
  IF OLD.merged_into_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Обращение: объединённое обращение клиент открыть заново не может' USING ERRCODE = '42501';
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
    -- Клиент ждёт ответа с первого сообщения без ответа сотрудника (решение 12 плана M3).
    NEW.client_waiting_since := coalesce(OLD.client_waiting_since, now());
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
  'Триггер: клиент создаёт новое обращение без полей сотрудника, служебных отметок и сигнатуры ошибки и меняет только колонки и переходы своих операций; даты ставит база; объединённое обращение клиент не открывает';

COMMENT ON COLUMN hdt_tickets.error_signature IS 'Сигнатура ошибки (ТЗ 11.5): первые 32 знака sha256 от кода, нормализованного текста и модуля. Пишет система после создания обращения, клиент не задаёт и не читает (план M5, задача 8)';
