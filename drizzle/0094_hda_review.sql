-- Отметка неверных ответов помощника и разбор (ТЗ FR-AI-16, экран "Разбор ответов AI", 10.5 ai_runs; план M5b,
-- задача 8).
--
-- 1. hda_runs.flag_comment: комментарий сотрудника к отметке "неверно" (до 500 знаков). Это текст сотрудника, а не
--    текст запроса или ответа модели: правило "журнал без текста" (поправка 101) он не нарушает.
-- 2. Сотрудник, который ведёт обращения, ставит отметку (flagged_by, flagged_on, flag_reason, flag_comment), а
--    agent_l2, care и admin пишут итог разбора (review_result). Политика разрешает обновление строки, триггер не даёт
--    сотруднику изменить ничего другого и поставить отметку от чужого имени. Клиент по-прежнему не видит ни одной строки.

ALTER TABLE hda_runs ADD COLUMN flag_comment text;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c14 CHECK (flag_comment IS NULL OR char_length(flag_comment) BETWEEN 1 AND 500);
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c15 CHECK ((flag_reason IS NULL) = (flagged_by IS NULL) AND (flag_comment IS NULL OR flagged_by IS NOT NULL));
COMMENT ON COLUMN hda_runs.flag_comment IS 'Комментарий сотрудника к отметке ответа помощника неверным (FR-AI-16). Текст сотрудника, не текст запроса или ответа модели';
COMMENT ON CONSTRAINT hda_runs_c14 ON hda_runs IS 'Комментарий к отметке не длиннее 500 знаков';
COMMENT ON CONSTRAINT hda_runs_c15 ON hda_runs IS 'Причина отметки есть ровно у отмеченного ответа, комментарий только у отмеченного';

CREATE FUNCTION app.hda_runs_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'staff' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.ref_id IS DISTINCT FROM OLD.ref_id
       OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens
       OR NEW.cost_usd IS DISTINCT FROM OLD.cost_usd OR NEW.latency_ms IS DISTINCT FROM OLD.latency_ms
       OR NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.error_code IS DISTINCT FROM OLD.error_code
       OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.decision IS DISTINCT FROM OLD.decision OR NEW.handoff_reason IS DISTINCT FROM OLD.handoff_reason
       OR NEW.solution_id IS DISTINCT FROM OLD.solution_id OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.input_hash IS DISTINCT FROM OLD.input_hash OR NEW.found IS DISTINCT FROM OLD.found THEN
      RAISE EXCEPTION 'Журнал вызовов: сотрудник меняет только отметку и итог разбора' USING ERRCODE = '42501';
    END IF;
    IF NEW.flagged_by IS DISTINCT FROM OLD.flagged_by AND NEW.flagged_by::text IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'Журнал вызовов: отметку ставят только от своего имени' USING ERRCODE = '42501';
    END IF;
    IF NEW.review_result IS DISTINCT FROM OLD.review_result AND app.staff_role() NOT IN ('agent_l2', 'care', 'admin') THEN
      RAISE EXCEPTION 'Журнал вызовов: итог разбора пишут вторая линия, care и администратор' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_runs_staff_guard() IS 'Триггер: сотрудник меняет в строке журнала вызовов только отметку "неверно" (от своего имени) и итог разбора';
CREATE TRIGGER t_hda_runs_staff_guard
  BEFORE UPDATE ON hda_runs
  FOR EACH ROW EXECUTE FUNCTION app.hda_runs_staff_guard();

CREATE POLICY hda_runs_staff_update ON hda_runs FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin') AND decision IN ('answer', 'clarify'))
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin') AND decision IN ('answer', 'clarify'));
COMMENT ON POLICY hda_runs_staff_update ON hda_runs IS 'Отметку "неверно" и итог разбора сотрудники пишут только в строки ответов и вопросов помощника; остальные колонки держит триггер t_hda_runs_staff_guard';
