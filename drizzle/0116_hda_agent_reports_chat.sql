-- Веха M8b, задача 10: сообщение в служебный чат команды по сводке AI-сотрудника (ТЗ 7.21 FR-AGT-13; план M8b,
-- решение 24). Сообщение собирает портал по шаблону из чисел и номеров сводки; отметка chat_sent_on не даёт отправить
-- его второй раз. Ставит её только система, один раз. Сотрудник по-прежнему меняет только отметку "просмотрено".

ALTER TABLE hda_agent_reports ADD COLUMN chat_sent_on timestamptz;
COMMENT ON COLUMN hda_agent_reports.chat_sent_on IS 'Когда портал отправил сообщение по сводке в служебный чат команды. Пусто: не отправлял (нет полей для чата или нет настройки чата)';

CREATE OR REPLACE FUNCTION app.hda_agent_reports_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to
     OR NEW.chat_fields IS DISTINCT FROM OLD.chat_fields OR NEW.token_id IS DISTINCT FROM OLD.token_id THEN
    RAISE EXCEPTION 'Сводка агента: текст и поля сводки не меняются, меняется только отметка "просмотрено"' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'reviewed' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'Сводка агента: отметка "просмотрено" не снимается и не переписывается' USING ERRCODE = '42501';
  END IF;
  IF NEW.chat_sent_on IS DISTINCT FROM OLD.chat_sent_on AND (app.actor_type() <> 'system' OR OLD.chat_sent_on IS NOT NULL) THEN
    RAISE EXCEPTION 'Сводка агента: отметку отправки в чат ставит только система, один раз' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'system' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'Сводка агента: отметку "просмотрено" ставит сотрудник' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_agent_reports_guard() IS 'Сводка агента: сотрудник меняет только отметку "просмотрено", один раз; система только отметку отправки в чат, один раз';

CREATE POLICY hda_agent_reports_system_update ON hda_agent_reports FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hda_agent_reports_system_update ON hda_agent_reports IS 'Отметку отправки сообщения в чат команды ставит система; остальные поля закрывает t_hda_agent_reports_guard';
