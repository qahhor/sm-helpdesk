-- Заметка руководителя о разборе низкой оценки (FR-MET-07; план M8, задача 9, решение 14). Три колонки в конце
-- таблицы обращений: текст заметки, кто и когда её написал. Заметка внутренняя: клиент её не получает. Политики RLS
-- работают по строкам, а не по колонкам, поэтому запросы клиента эти колонки не выбирают (модуль hdt, чтение
-- обращения клиентом; проверяет tests/integration/metrics.test.ts). Писать заметку база даёт только Customer Care
-- и администратору: триггер ниже, а не только проверка в коде.

ALTER TABLE hdt_tickets ADD COLUMN csat_review_note text;
ALTER TABLE hdt_tickets ADD COLUMN csat_reviewed_by uuid;
ALTER TABLE hdt_tickets ADD COLUMN csat_reviewed_on timestamptz;
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c16 CHECK (csat_review_note IS NULL OR length(csat_review_note) BETWEEN 1 AND 2000);
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c17
  CHECK ((csat_review_note IS NULL) = (csat_reviewed_by IS NULL) AND (csat_review_note IS NULL) = (csat_reviewed_on IS NULL));
COMMENT ON COLUMN hdt_tickets.csat_review_note IS 'Заметка руководителя о разборе низкой оценки (FR-MET-07). Внутренняя: клиенту не отдаётся';
COMMENT ON COLUMN hdt_tickets.csat_reviewed_by IS 'Сотрудник, который написал заметку о разборе оценки';
COMMENT ON COLUMN hdt_tickets.csat_reviewed_on IS 'Когда написана заметка о разборе оценки';
COMMENT ON CONSTRAINT hdt_tickets_c16 ON hdt_tickets IS 'Заметка о разборе оценки: от 1 до 2000 знаков';
COMMENT ON CONSTRAINT hdt_tickets_c17 ON hdt_tickets IS 'Заметка о разборе оценки, её автор и время заполняются вместе';

CREATE FUNCTION app.hdt_tickets_csat_review_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.csat_review_note IS NOT NULL OR NEW.csat_reviewed_by IS NOT NULL OR NEW.csat_reviewed_on IS NOT NULL THEN
      RAISE EXCEPTION 'Обращение: заметку о разборе оценки при создании задать нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.csat_review_note, NEW.csat_reviewed_by, NEW.csat_reviewed_on) IS NOT DISTINCT FROM (OLD.csat_review_note, OLD.csat_reviewed_by, OLD.csat_reviewed_on) THEN
    RETURN NEW;
  END IF;
  IF NOT (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin')) THEN
    RAISE EXCEPTION 'Обращение: заметку о разборе оценки пишут только Customer Care и администратор' USING ERRCODE = '42501';
  END IF;
  IF NEW.csat_score IS NULL OR NEW.csat_score > 3 THEN
    RAISE EXCEPTION 'Обращение: заметка о разборе пишется только к оценке от 1 до 3' USING ERRCODE = '42501';
  END IF;
  IF NEW.csat_reviewed_by IS DISTINCT FROM app.user_uuid() THEN
    RAISE EXCEPTION 'Обращение: автор заметки о разборе это сотрудник, который её пишет' USING ERRCODE = '42501';
  END IF;
  NEW.csat_reviewed_on := now();
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_csat_review_guard() IS
  'Триггер: заметку о разборе низкой оценки пишут только Customer Care и администратор, только к оценке 1-3 и от своего имени; время ставит база';

CREATE TRIGGER t_hdt_tickets_csat_review_guard
  BEFORE INSERT OR UPDATE ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdt_tickets_csat_review_guard();

-- Событие истории "разбор оценки": всегда внутреннее (ограничение hdt_ticket_events_c3 видимым клиенту его не примет).
ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound', 'tag', 'dev_task', 'csat_review'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule (срабатывание правила или запуск макроса), merge, type, module, snooze, bound (привязка письма к организации), tag (тег поставлен или снят), dev_task (задача разработки привязана, отвязана или закрыта), csat_review (руководитель написал заметку о разборе низкой оценки)';
