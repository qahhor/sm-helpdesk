-- Передача между линиями и памятки первой линии (план M3, задача 9; ТЗ FR-LINE-03..10, 10.5, 8.12).
-- Клиент не видит ни одной строки (10.5: "К: нет", FR-LINE-07).

-- Передача на вторую линию с запиской и возврат на первую с пояснением. Строка нужна для записки (FR-LINE-03),
-- срока "взять в работу" (FR-LINE-06) и показателей по линиям (FR-LINE-08).
CREATE TABLE hdt_ticket_line_transfers (
  transfer_id   uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id     uuid        NOT NULL,
  from_line     text        NOT NULL,
  to_line       text        NOT NULL,
  reason_code   text,
  checked       text,
  needed        text,
  explanation   text,
  checklist     jsonb       NOT NULL DEFAULT '[]',
  by_user       uuid        NOT NULL,
  pickup_due_on timestamptz,
  picked_up_on  timestamptz,
  picked_up_by  uuid,
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_line_transfers_pk PRIMARY KEY (transfer_id),
  CONSTRAINT hdt_ticket_line_transfers_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdt_ticket_line_transfers_f2 FOREIGN KEY (by_user) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_ticket_line_transfers_f3 FOREIGN KEY (picked_up_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hdt_ticket_line_transfers_c1 CHECK (from_line IN ('l1', 'l2', 'care') AND to_line IN ('l1', 'l2', 'care') AND from_line <> to_line),
  -- На вторую линию: причина, что проверено, что требуется (FR-LINE-03). На первую: пояснение (FR-LINE-04).
  CONSTRAINT hdt_ticket_line_transfers_c2 CHECK (
    (to_line = 'l1' AND explanation IS NOT NULL AND char_length(explanation) BETWEEN 1 AND 2000)
    OR (to_line <> 'l1' AND reason_code IN ('needs_client_data', 'suspected_bug', 'client_configuration', 'data_fix', 'not_in_playbook', 'other')
        AND char_length(checked) BETWEEN 1 AND 2000 AND char_length(needed) BETWEEN 1 AND 2000 AND pickup_due_on IS NOT NULL)
  ),
  CONSTRAINT hdt_ticket_line_transfers_c3 CHECK (jsonb_typeof(checklist) = 'array'),
  CONSTRAINT hdt_ticket_line_transfers_c4 CHECK ((picked_up_on IS NULL) = (picked_up_by IS NULL))
);

CREATE INDEX hdt_ticket_line_transfers_i1 ON hdt_ticket_line_transfers (ticket_id, created_on);
CREATE INDEX hdt_ticket_line_transfers_i2 ON hdt_ticket_line_transfers (pickup_due_on) WHERE picked_up_on IS NULL;

COMMENT ON TABLE hdt_ticket_line_transfers IS 'Передача обращения на вторую линию с запиской и возврат на первую с пояснением';
COMMENT ON COLUMN hdt_ticket_line_transfers.transfer_id IS 'Идентификатор передачи';
COMMENT ON COLUMN hdt_ticket_line_transfers.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_line_transfers.from_line IS 'Откуда: l1 первая линия, l2 и care вторая';
COMMENT ON COLUMN hdt_ticket_line_transfers.to_line IS 'Куда: l1 первая линия, l2 и care вторая';
COMMENT ON COLUMN hdt_ticket_line_transfers.reason_code IS 'Причина передачи на вторую линию из списка (решение 3 плана M3)';
COMMENT ON COLUMN hdt_ticket_line_transfers.checked IS 'Что первая линия уже проверила по регламенту';
COMMENT ON COLUMN hdt_ticket_line_transfers.needed IS 'Что требуется от второй линии';
COMMENT ON COLUMN hdt_ticket_line_transfers.explanation IS 'Пояснение второй линии при возврате на первую';
COMMENT ON COLUMN hdt_ticket_line_transfers.checklist IS 'Отмеченные пункты памятки первой линии';
COMMENT ON COLUMN hdt_ticket_line_transfers.by_user IS 'Кто передал или вернул';
COMMENT ON COLUMN hdt_ticket_line_transfers.pickup_due_on IS 'Внутренний срок "взять в работу" для второй линии, от момента передачи';
COMMENT ON COLUMN hdt_ticket_line_transfers.picked_up_on IS 'Когда вторая линия взяла обращение или ответила';
COMMENT ON COLUMN hdt_ticket_line_transfers.picked_up_by IS 'Кто из второй линии взял обращение';
COMMENT ON COLUMN hdt_ticket_line_transfers.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_line_transfers.created_on IS 'Когда передача сделана. Заполняет база';
COMMENT ON COLUMN hdt_ticket_line_transfers.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_line_transfers.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_line_transfers_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_line_transfers
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Записку не переписывают: после передачи меняется только отметка "взято в работу", и только один раз.
CREATE FUNCTION app.hdt_line_transfers_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.by_user IS DISTINCT FROM app.user_uuid() OR NEW.picked_up_on IS NOT NULL THEN
      RAISE EXCEPTION 'Передача: автор передачи только текущий сотрудник, отметка "взято" ставится позже' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['picked_up_on', 'picked_up_by', 'modified_by', 'modified_on'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['picked_up_on', 'picked_up_by', 'modified_by', 'modified_on'])
     OR OLD.picked_up_on IS NOT NULL OR NEW.picked_up_by IS DISTINCT FROM app.user_uuid() THEN
    RAISE EXCEPTION 'Передача: записку не меняют, отметку "взято" ставит один раз взявший сотрудник' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_line_transfers_guard() IS
  'Триггер: передачу записывает текущий сотрудник, затем меняется только отметка "взято в работу", один раз';

CREATE TRIGGER t_hdt_ticket_line_transfers_guard
  BEFORE INSERT OR UPDATE ON hdt_ticket_line_transfers
  FOR EACH ROW EXECUTE FUNCTION app.hdt_line_transfers_guard();

ALTER TABLE hdt_ticket_line_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_line_transfers FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_line_transfers_internal_select ON hdt_ticket_line_transfers FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdt_ticket_line_transfers_staff_insert ON hdt_ticket_line_transfers FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_can_write_tickets());
CREATE POLICY hdt_ticket_line_transfers_staff_update ON hdt_ticket_line_transfers FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_can_write_tickets())
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_can_write_tickets());
COMMENT ON POLICY hdt_ticket_line_transfers_internal_select ON hdt_ticket_line_transfers IS 'Передачи видят сотрудники и система';
COMMENT ON POLICY hdt_ticket_line_transfers_staff_insert ON hdt_ticket_line_transfers IS 'Передачу записывает сотрудник, который ведёт обращения';
COMMENT ON POLICY hdt_ticket_line_transfers_staff_update ON hdt_ticket_line_transfers IS 'Отметку "взято в работу" ставит сотрудник, который ведёт обращения';

GRANT SELECT, INSERT, UPDATE ON hdt_ticket_line_transfers TO hub_app;

-- Памятка первой линии (FR-LINE-10): "что проверить до передачи" по модулю и типу обращения.
-- Модуль пустой: общая памятка типа. Ведут вторая линия, care и admin (10.5).
CREATE TABLE hdr_l1_playbooks (
  playbook_id uuid        NOT NULL DEFAULT uuidv7(),
  module_id   uuid,
  ticket_type text        NOT NULL,
  body        text        NOT NULL,
  owner_id    uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdr_l1_playbooks_pk PRIMARY KEY (playbook_id),
  CONSTRAINT hdr_l1_playbooks_u1 UNIQUE NULLS NOT DISTINCT (module_id, ticket_type),
  CONSTRAINT hdr_l1_playbooks_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdr_l1_playbooks_f2 FOREIGN KEY (owner_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdr_l1_playbooks_c1 CHECK (ticket_type IN ('bug', 'question', 'service_request')),
  CONSTRAINT hdr_l1_playbooks_c2 CHECK (char_length(body) BETWEEN 1 AND 10000)
);

COMMENT ON TABLE hdr_l1_playbooks IS 'Памятка первой линии: что проверить до передачи на вторую, по модулю и типу обращения';
COMMENT ON COLUMN hdr_l1_playbooks.playbook_id IS 'Идентификатор памятки';
COMMENT ON COLUMN hdr_l1_playbooks.module_id IS 'Модуль продукта. Пусто: общая памятка для типа';
COMMENT ON COLUMN hdr_l1_playbooks.ticket_type IS 'Тип обращения: bug, question, service_request';
COMMENT ON COLUMN hdr_l1_playbooks.body IS 'Пункты памятки, по одному в строке';
COMMENT ON COLUMN hdr_l1_playbooks.owner_id IS 'Кто последним сохранил памятку и отвечает за неё';
COMMENT ON COLUMN hdr_l1_playbooks.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdr_l1_playbooks.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdr_l1_playbooks.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdr_l1_playbooks.modified_on IS 'Когда памятка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdr_l1_playbooks_stamp
  BEFORE INSERT OR UPDATE ON hdr_l1_playbooks
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdr_l1_playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdr_l1_playbooks FORCE ROW LEVEL SECURITY;

CREATE POLICY hdr_l1_playbooks_internal_select ON hdr_l1_playbooks FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdr_l1_playbooks_keepers_write ON hdr_l1_playbooks FOR ALL TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin'))
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l2', 'care', 'admin') AND owner_id = app.user_uuid());
COMMENT ON POLICY hdr_l1_playbooks_internal_select ON hdr_l1_playbooks IS 'Памятки читают сотрудники и система';
COMMENT ON POLICY hdr_l1_playbooks_keepers_write ON hdr_l1_playbooks IS 'Памятки ведут вторая линия, care и admin; ответственный тот, кто сохранил';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdr_l1_playbooks TO hub_app;
