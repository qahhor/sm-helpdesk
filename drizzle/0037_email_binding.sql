-- Привязка письма из "Неопознанных" и закрытие такого письма (план M4, задача 11, решения 13 и 14).
-- 1. Обращение переходит в организацию клиента вместе с сообщениями, событиями, подписками и вложениями: внешние
--    ключи (ticket_id, org_id) переносят организацию дочерних строк каскадом. Других путей сменить организацию нет:
--    защита записи сотрудника пускает только привязку из служебной организации.
-- 2. Событие bound (внутреннее): кто и в какую организацию привязал.
-- 3. "Это не клиент" и "Спам" закрывают обращение служебной организации из любого статуса.

ALTER TABLE hdt_ticket_messages DROP CONSTRAINT hdt_ticket_messages_f1;
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_f1
  FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE;
ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_f1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_f1
  FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE;
ALTER TABLE hdt_ticket_watchers DROP CONSTRAINT hdt_ticket_watchers_f1;
ALTER TABLE hdt_ticket_watchers ADD CONSTRAINT hdt_ticket_watchers_f1
  FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE;
ALTER TABLE hdt_attachments DROP CONSTRAINT hdt_attachments_f1;
ALTER TABLE hdt_attachments ADD CONSTRAINT hdt_attachments_f1
  FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE;

ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule, merge, type, module, snooze, bound (привязка письма к организации)';

CREATE OR REPLACE FUNCTION app.hdt_tickets_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  development CONSTANT boolean := app.staff_role() IN ('agent_l2', 'care', 'admin');
  binding CONSTANT boolean := NEW.org_id IS DISTINCT FROM OLD.org_id
    AND OLD.org_id = app.service_org_id() AND NEW.org_id <> app.service_org_id()
    AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin');
BEGIN
  IF app.actor_type() <> 'staff' THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id IS DISTINCT FROM OLD.org_id AND NOT binding) OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.created_on IS DISTINCT FROM OLD.created_on OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.csat_score IS DISTINCT FROM OLD.csat_score OR NEW.csat_reason IS DISTINCT FROM OLD.csat_reason
     OR NEW.csat_comment IS DISTINCT FROM OLD.csat_comment OR NEW.last_client_message_on IS DISTINCT FROM OLD.last_client_message_on
     OR (NEW.client_waiting_since IS DISTINCT FROM OLD.client_waiting_since AND NEW.client_waiting_since IS NOT NULL) THEN
    RAISE EXCEPTION 'Обращение: сотруднику менять эти поля нельзя' USING ERRCODE = '42501';
  END IF;
  IF OLD.merged_into_id IS NOT NULL AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id) THEN
    RAISE EXCEPTION 'Обращение: объединённое обращение закрыто навсегда, статус не меняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'in_development' AND OLD.status IS DISTINCT FROM 'in_development' AND NOT development THEN
    RAISE EXCEPTION 'Обращение: "В разработке" ставят вторая линия, care и admin' USING ERRCODE = '42501';
  END IF;
  IF OLD.queue IN ('l2', 'care') AND NEW.queue IS DISTINCT FROM OLD.queue AND NOT development THEN
    RAISE EXCEPTION 'Обращение: со второй линии на первую линию возвращают вторая линия, care и admin' USING ERRCODE = '42501';
  END IF;
  -- Письмо из "Неопознанных" ("Это не клиент", "Спам") закрывается из любого статуса ролями, которые ведут обращения.
  IF NEW.status = 'closed' AND OLD.status NOT IN ('resolved', 'closed') AND NEW.merged_into_id IS NULL
     AND NOT (OLD.org_id = app.service_org_id() AND NEW.org_id = app.service_org_id()
              AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin')) THEN
    RAISE EXCEPTION 'Обращение: сотрудник закрывает только решённое обращение' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_staff_guard() IS
  'Триггер: сотрудник не меняет организацию (кроме привязки из "Неопознанных"), автора, номер, канал, оценку и колонки клиента, статус объединённого; "В разработке" и возврат со второй линии только agent_l2, care, admin; закрывает только решённое, кроме письма из "Неопознанных"';

-- 4. Гость стал пользователем (решение 13): его сообщения переходят пользователю. Сообщения в остальном неизменны:
--    роль портала получает право менять только автора, и только системе (задача раз в минуту). Организацию
--    сообщения меняет лишь каскад внешнего ключа при привязке.
GRANT UPDATE (author_id) ON hdt_ticket_messages TO hub_app;

CREATE FUNCTION app.hdt_ticket_messages_author_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.author_id IS DISTINCT FROM OLD.author_id AND app.actor_type() <> 'system' THEN
    RAISE EXCEPTION 'Сообщение: автора меняет только система при переходе гостя к пользователю' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_ticket_messages_author_guard() IS 'Триггер: автора сообщения меняет только система (переход гостя к пользователю)';

CREATE TRIGGER t_hdt_ticket_messages_author_guard
  BEFORE UPDATE ON hdt_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION app.hdt_ticket_messages_author_guard();
