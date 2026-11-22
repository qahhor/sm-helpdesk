-- Итоговая проверка вехи M3: границы ролей и объединение держит и база, а не только код (план M3, "На что смотреть", 3 и 4).
-- Сотрудник не меняет статус объединённого обращения; "В разработке" ставят и со второй линии возвращают только
-- agent_l2, care и admin; закрывает сотрудник только решённое. Функция защиты пересоздаётся целиком (миграция 0021).

CREATE OR REPLACE FUNCTION app.hdt_tickets_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  development CONSTANT boolean := app.staff_role() IN ('agent_l2', 'care', 'admin');
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
  IF OLD.merged_into_id IS NOT NULL AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id) THEN
    RAISE EXCEPTION 'Обращение: объединённое обращение закрыто навсегда, статус не меняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'in_development' AND OLD.status IS DISTINCT FROM 'in_development' AND NOT development THEN
    RAISE EXCEPTION 'Обращение: "В разработке" ставят вторая линия, care и admin' USING ERRCODE = '42501';
  END IF;
  IF OLD.queue IN ('l2', 'care') AND NEW.queue IS DISTINCT FROM OLD.queue AND NOT development THEN
    RAISE EXCEPTION 'Обращение: со второй линии на первую линию возвращают вторая линия, care и admin' USING ERRCODE = '42501';
  END IF;
  -- Закрыть объединением можно из любого открытого статуса (решение 4): тогда же ставится ссылка на основное.
  IF NEW.status = 'closed' AND OLD.status NOT IN ('resolved', 'closed') AND NEW.merged_into_id IS NULL THEN
    RAISE EXCEPTION 'Обращение: сотрудник закрывает только решённое обращение' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_staff_guard() IS
  'Триггер: сотрудник не меняет организацию, автора, номер, канал, оценку и колонки клиента, статус объединённого; "В разработке" и возврат со второй линии только agent_l2, care, admin; закрывает только решённое';

-- Возврат на первую линию записывают те же роли (FR-LINE-04).
DROP POLICY hdt_ticket_line_transfers_staff_insert ON hdt_ticket_line_transfers;
CREATE POLICY hdt_ticket_line_transfers_staff_insert ON hdt_ticket_line_transfers FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_can_write_tickets() AND (to_line <> 'l1' OR app.staff_role() IN ('agent_l2', 'care', 'admin')));
COMMENT ON POLICY hdt_ticket_line_transfers_staff_insert ON hdt_ticket_line_transfers IS
  'Передачу на вторую линию записывает сотрудник, который ведёт обращения; возврат на первую только agent_l2, care, admin';
