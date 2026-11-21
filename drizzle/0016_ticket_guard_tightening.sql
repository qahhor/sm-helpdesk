-- Второй слой защиты обращений (итоговая проверка M2, отложенное замечание 2). Ужесточение, права не расширяются.
-- 1. Клиент создаёт обращение только с приоритетом, который следует из влияния (FR-TK-03), только из своих каналов
--    (портал, виджет) и без служебных полей сроков, отложения, известной проблемы и передачи от помощника.
-- 2. Связь с прежним обращением и привязка вложения к сообщению проверяются парой ключей: прежнее обращение той же
--    организации, сообщение того же обращения. Одиночный ключ проверялся в обход политик RLS.

CREATE OR REPLACE FUNCTION app.hdt_tickets_client_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  allowed CONSTANT text[] := ARRAY['status', 'visibility', 'closed_on', 'resolved_on', 'last_client_message_on',
                                   'csat_score', 'csat_reason', 'csat_comment', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() <> 'client' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'new' OR NEW.queue <> 'l1' OR NEW.assignee_id IS NOT NULL OR NEW.priority_confirmed
       OR NEW.ai_state <> 'none' OR NEW.ai_reply_count <> 0 OR NEW.csat_score IS NOT NULL OR NEW.closed_on IS NOT NULL
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
  IF NEW.visibility IS DISTINCT FROM OLD.visibility AND NOT (OLD.author_id = app.user_uuid() OR app.org_role() = 'client_admin') THEN
    RAISE EXCEPTION 'Обращение: видимость меняют только автор и администратор клиента, остальным нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_client_guard() IS
  'Триггер: клиент создаёт новое обращение без полей сотрудника, с приоритетом из влияния и из своих каналов, и меняет только колонки своих операций';

ALTER TABLE hdt_tickets DROP CONSTRAINT hdt_tickets_f6;
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_f6 FOREIGN KEY (related_ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id);
COMMENT ON CONSTRAINT hdt_tickets_f6 ON hdt_tickets IS 'Прежнее обращение той же организации (FR-TK-12)';

ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_u1 UNIQUE (message_id, ticket_id);

ALTER TABLE hdt_attachments DROP CONSTRAINT hdt_attachments_f2;
ALTER TABLE hdt_attachments ADD CONSTRAINT hdt_attachments_f2 FOREIGN KEY (message_id, ticket_id) REFERENCES hdt_ticket_messages (message_id, ticket_id);
COMMENT ON CONSTRAINT hdt_attachments_f2 ON hdt_attachments IS 'Сообщение того же обращения, что и вложение';
