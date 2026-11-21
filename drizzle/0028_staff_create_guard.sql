-- Обращение от имени клиента (FR-AG-08; план M3, задача 12). Сотрудник создаёт обращение только с источником
-- staff и без полей, которые появляются позже (оценка, закрытие, объединение, сообщение клиента): обращение
-- "с портала" или уже закрытое в обход сервиса не завести. Остальные проверки сотрудника без изменений (0021).

CREATE FUNCTION app.hdt_tickets_staff_insert_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() <> 'staff' THEN
    RETURN NEW;
  END IF;
  IF NEW.source <> 'staff' OR NEW.status <> 'new' OR NEW.closed_on IS NOT NULL OR NEW.resolved_on IS NOT NULL
     OR NEW.merged_into_id IS NOT NULL OR NEW.csat_score IS NOT NULL OR NEW.csat_reason IS NOT NULL OR NEW.csat_comment IS NOT NULL
     OR NEW.last_client_message_on IS NOT NULL OR NEW.first_responded_on IS NOT NULL OR NEW.ai_state <> 'none' THEN
    RAISE EXCEPTION 'Обращение: сотрудник создаёт только новое обращение с источником staff, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_staff_insert_guard() IS
  'Триггер: сотрудник создаёт только новое обращение с источником staff, без полей оценки, закрытия и объединения';

CREATE TRIGGER t_hdt_tickets_staff_insert_guard
  BEFORE INSERT ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdt_tickets_staff_insert_guard();
