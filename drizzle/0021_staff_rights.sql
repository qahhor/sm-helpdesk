-- Права сотрудников по ролям и защита колонок (ТЗ 5.2, 5.3, 10.3; план M3, задача 4; решение 0031).
-- Ужесточение: роль product читает обращения, но ничего не пишет; прежде любой сотрудник мог всё. Сотрудник не меняет
-- организацию, автора, номер, канал, оценку и колонки, которые ставит база. События, которых клиент видеть не должен,
-- база не даёт записать видимыми.

CREATE FUNCTION app.staff_can_write_tickets() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin')) $$;
COMMENT ON FUNCTION app.staff_can_write_tickets() IS 'Истина для системы и сотрудника, который ведёт обращения: все роли, кроме product';

DROP POLICY hdt_tickets_internal_all ON hdt_tickets;
CREATE POLICY hdt_tickets_internal_select ON hdt_tickets FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_tickets_internal_write ON hdt_tickets FOR ALL TO hub_app
  USING (app.staff_can_write_tickets()) WITH CHECK (app.staff_can_write_tickets());
DROP POLICY hdt_ticket_messages_internal_all ON hdt_ticket_messages;
CREATE POLICY hdt_ticket_messages_internal_select ON hdt_ticket_messages FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_ticket_messages_internal_write ON hdt_ticket_messages FOR ALL TO hub_app
  USING (app.staff_can_write_tickets()) WITH CHECK (app.staff_can_write_tickets());
DROP POLICY hdt_ticket_events_internal_all ON hdt_ticket_events;
CREATE POLICY hdt_ticket_events_internal_select ON hdt_ticket_events FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_ticket_events_internal_write ON hdt_ticket_events FOR ALL TO hub_app
  USING (app.staff_can_write_tickets()) WITH CHECK (app.staff_can_write_tickets());
DROP POLICY hdt_ticket_watchers_internal_all ON hdt_ticket_watchers;
CREATE POLICY hdt_ticket_watchers_internal_select ON hdt_ticket_watchers FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_ticket_watchers_internal_write ON hdt_ticket_watchers FOR ALL TO hub_app
  USING (app.staff_can_write_tickets()) WITH CHECK (app.staff_can_write_tickets());
DROP POLICY hdt_attachments_internal_all ON hdt_attachments;
CREATE POLICY hdt_attachments_internal_select ON hdt_attachments FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_attachments_internal_write ON hdt_attachments FOR ALL TO hub_app
  USING (app.staff_can_write_tickets()) WITH CHECK (app.staff_can_write_tickets());

CREATE FUNCTION app.hdt_tickets_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() <> 'staff' THEN
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.created_on IS DISTINCT FROM OLD.created_on OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.csat_score IS DISTINCT FROM OLD.csat_score OR NEW.csat_reason IS DISTINCT FROM OLD.csat_reason
     OR NEW.csat_comment IS DISTINCT FROM OLD.csat_comment OR NEW.last_client_message_on IS DISTINCT FROM OLD.last_client_message_on
     OR (NEW.client_waiting_since IS DISTINCT FROM OLD.client_waiting_since AND NEW.client_waiting_since IS NOT NULL) THEN
    RAISE EXCEPTION 'Обращение: сотруднику менять эти поля нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_staff_guard() IS
  'Триггер: сотрудник не меняет организацию, автора, номер, канал, оценку и колонки клиента; "клиент ждёт с" может только снять';

CREATE TRIGGER t_hdt_tickets_staff_guard
  BEFORE UPDATE ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdt_tickets_staff_guard();

-- Новое обращение: клиент ждёт ответа с момента создания, кто бы его ни создал.
CREATE FUNCTION app.hdt_tickets_waiting_since() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  NEW.client_waiting_since := now();
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_waiting_since() IS 'Триггер: при создании обращения ставит "клиент ждёт с"';

CREATE TRIGGER t_hdt_tickets_waiting_since
  BEFORE INSERT ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdt_tickets_waiting_since();

-- Новые виды событий и запрет видимых клиенту событий рабочего места (FR-LINE-07).
ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze'));
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c3
  CHECK (is_internal OR kind IN ('created', 'status', 'visibility', 'rated', 'merge'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule, merge, type, module, snooze';

-- Защита записи клиента (миграции 0018 и 0020) дополнена отметкой "клиент ждёт с".
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
  'Триггер: клиент создаёт новое обращение без полей сотрудника и меняет только колонки и переходы своих операций; даты ставит база';
