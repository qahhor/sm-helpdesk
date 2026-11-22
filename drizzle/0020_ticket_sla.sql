-- Сроки обращения (план M3, задача 3; решения 0032 и плана M3 1, 8, 12). Пауза считается в рабочих минутах,
-- поэтому колонка паузы переименована: обращений с паузой до этой миграции не было (сроки появились только сейчас).
-- Новые колонки пустые: отметки нарушения ставит задача раз в минуту, "клиент ждёт с" ставит триггер (миграция 0021),
-- номер версии нужен итогу "исправлено в версии".

ALTER TABLE hdt_tickets RENAME COLUMN sla_paused_seconds TO sla_paused_minutes;
COMMENT ON COLUMN hdt_tickets.sla_paused_minutes IS 'Рабочие минуты, которые обращение провело в "Ждём вашего ответа": на столько сдвинут срок решения';

ALTER TABLE hdt_tickets ADD COLUMN first_response_breached_on timestamptz;
ALTER TABLE hdt_tickets ADD COLUMN resolution_breached_on timestamptz;
ALTER TABLE hdt_tickets ADD COLUMN client_waiting_since timestamptz;
ALTER TABLE hdt_tickets ADD COLUMN resolved_version text;
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c14 CHECK (sla_paused_minutes >= 0);
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c15 CHECK (resolved_version IS NULL OR length(resolved_version) BETWEEN 1 AND 50);

COMMENT ON COLUMN hdt_tickets.first_response_breached_on IS 'Когда нарушен срок первого ответа. Ставит задача раз в минуту, один раз';
COMMENT ON COLUMN hdt_tickets.resolution_breached_on IS 'Когда нарушен срок решения. Ставит задача раз в минуту, один раз';
COMMENT ON COLUMN hdt_tickets.client_waiting_since IS 'С какого времени клиент ждёт ответа сотрудника: первое сообщение клиента без ответа. Ставит база';
COMMENT ON COLUMN hdt_tickets.resolved_version IS 'Версия Smartup для итога "исправлено в версии"';

CREATE INDEX hdt_tickets_i12 ON hdt_tickets (status, first_response_due_on) WHERE status NOT IN ('resolved', 'closed');
CREATE INDEX hdt_tickets_i13 ON hdt_tickets (status, resolution_due_on) WHERE status NOT IN ('resolved', 'closed');

-- Защита записи клиента (миграция 0018) называет колонку паузы: функция пересоздаётся с новым именем, правила те же.
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
