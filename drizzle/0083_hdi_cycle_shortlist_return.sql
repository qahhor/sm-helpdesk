-- Возврат пятёрки в голосование при завершении отбора месяца (ТЗ FR-IDEA-09, 10; план M7, задача 9, решения 16, 17).
-- Когда отбор закрывается выбором (decided) или без выбора (lapsed), идеи снимка, которые ещё в шорт-листе, кроме
-- выбранной, возвращаются в open с голосами и участвуют в следующем отборе. Переход shortlisted -> open по таблице
-- переходов делает только система (решение 19), а выбор делает сотрудник product или admin, поэтому возврат идёт
-- триггером от имени системы, тем же приёмом, что пересчёт счётчиков (app.hdi_as_system, миграция 0079): в одной
-- транзакции с выбором, без половинчатого состояния. Возврат в голосование не уведомляет (решение 15).

CREATE FUNCTION app.hdi_cycles_return_shortlist() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  prev text[];
BEGIN
  prev := app.hdi_as_system();
  UPDATE hdi_ideas i
     SET status = 'open'
   WHERE i.status = 'shortlisted'
     AND i.idea_id IN (SELECT (e ->> 'ideaId')::uuid FROM jsonb_array_elements(NEW.shortlist) e)
     AND i.idea_id IS DISTINCT FROM NEW.selected_idea_id;
  PERFORM app.hdi_restore_actor(prev);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_cycles_return_shortlist() IS 'Триггер: при завершении отбора идеи пятёрки, кроме выбранной, из шорт-листа возвращаются в голосование от имени системы (план M7, решение 17)';

CREATE TRIGGER t_hdi_cycles_return_shortlist
  AFTER UPDATE OF status ON hdi_cycles
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status IN ('decided', 'lapsed'))
  EXECUTE FUNCTION app.hdi_cycles_return_shortlist();
