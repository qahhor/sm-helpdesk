-- Веха M8b, задача 8: всплески сигнатур (ТЗ 7.21 FR-AGT-11, 10.5 "настройка порога всплеска"; план M8b, решение 25).
--
-- 1. hda_signature_spikes: всплеск, который нашла задача agent.spikes. Сигнатура, число разных организаций и
--    обращений за окно, окно, момент и известная проблема, созданная по всплеску. Организаций и обращений строка не
--    хранит: это счётчик. Пишет и меняет система; известную проблему ставит сотрудник с правом ведения проблем
--    кнопкой "Создать известную проблему"; читают сотрудники. Клиент не видит ни одной строки.
-- 2. hda_agent_spikes: всплески для инструмента signature_spikes актора agent. К числам добавлены номера обращений
--    окна всплеска, видимые агенту (организации с AI-обработкой, без "Неопознанных"). Токену запуска пусто.

CREATE TABLE hda_signature_spikes (
  spike_id       uuid        NOT NULL DEFAULT uuidv7(),
  problem_id     uuid,
  signature      text        NOT NULL,
  org_count      integer     NOT NULL,
  ticket_count   integer     NOT NULL,
  window_minutes integer     NOT NULL,
  detected_on    timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_signature_spikes_pk PRIMARY KEY (spike_id),
  CONSTRAINT hda_signature_spikes_f1 FOREIGN KEY (problem_id) REFERENCES hdp_problems (problem_id),
  CONSTRAINT hda_signature_spikes_c1 CHECK (signature ~ '^[0-9a-f]{32}$'),
  CONSTRAINT hda_signature_spikes_c2 CHECK (org_count >= 1 AND ticket_count >= org_count),
  CONSTRAINT hda_signature_spikes_c3 CHECK (window_minutes BETWEEN 5 AND 1440)
);
CREATE INDEX hda_signature_spikes_i1 ON hda_signature_spikes (signature, detected_on DESC);
CREATE INDEX hda_signature_spikes_i2 ON hda_signature_spikes (problem_id) WHERE problem_id IS NOT NULL;
CREATE INDEX hda_signature_spikes_i3 ON hda_signature_spikes (detected_on DESC);
COMMENT ON INDEX hda_signature_spikes_i1 IS 'Был ли всплеск этой сигнатуры за последние 24 часа (решение 25)';
COMMENT ON INDEX hda_signature_spikes_i2 IS 'Внешний ключ: известная проблема, созданная по всплеску';
COMMENT ON INDEX hda_signature_spikes_i3 IS 'Блок "Всплески сигнатур" и инструмент signature_spikes: новые сверху';

COMMENT ON TABLE hda_signature_spikes IS 'Всплески сигнатур ошибок (FR-AGT-11): сигнатура у обращений многих организаций за короткое окно. Пишет система, читают сотрудники, клиент не видит';
COMMENT ON COLUMN hda_signature_spikes.spike_id IS 'Идентификатор всплеска';
COMMENT ON COLUMN hda_signature_spikes.problem_id IS 'Известная проблема, созданная по всплеску кнопкой "Создать известную проблему". Пусто, пока её нет';
COMMENT ON COLUMN hda_signature_spikes.signature IS 'Сигнатура ошибки (32 знака sha256)';
COMMENT ON COLUMN hda_signature_spikes.org_count IS 'Сколько разных организаций клиентов прислали обращения с сигнатурой за окно';
COMMENT ON COLUMN hda_signature_spikes.ticket_count IS 'Сколько обращений с сигнатурой за окно';
COMMENT ON COLUMN hda_signature_spikes.window_minutes IS 'Окно подсчёта в минутах на момент всплеска (настройка agent.spike_window_minutes)';
COMMENT ON COLUMN hda_signature_spikes.detected_on IS 'Когда задача agent.spikes нашла всплеск';
COMMENT ON COLUMN hda_signature_spikes.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_signature_spikes.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hda_signature_spikes.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_signature_spikes.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_signature_spikes_c3 ON hda_signature_spikes IS 'Окно от 5 минут до суток, как у настройки';

CREATE TRIGGER t_hda_signature_spikes_stamp
  BEFORE INSERT OR UPDATE ON hda_signature_spikes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Сотрудник меняет в строке только ссылку на проблему, и только пустую.
CREATE FUNCTION app.hda_signature_spikes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'staff' AND ((to_jsonb(NEW) - ARRAY['problem_id', 'modified_by', 'modified_on']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['problem_id', 'modified_by', 'modified_on'])
     OR OLD.problem_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Всплеск: сотрудник только ставит созданную по нему проблему' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_signature_spikes_guard() IS 'Триггер: сотрудник меняет во всплеске только пустую ссылку на проблему';
CREATE TRIGGER t_hda_signature_spikes_guard
  BEFORE UPDATE ON hda_signature_spikes
  FOR EACH ROW EXECUTE FUNCTION app.hda_signature_spikes_guard();

ALTER TABLE hda_signature_spikes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_signature_spikes FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_signature_spikes_internal_select ON hda_signature_spikes FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hda_signature_spikes_system_insert ON hda_signature_spikes FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_signature_spikes_system_update ON hda_signature_spikes FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_signature_spikes_writer_update ON hda_signature_spikes FOR UPDATE TO hub_app USING (app.hdp_can_write()) WITH CHECK (app.hdp_can_write());
CREATE POLICY hda_signature_spikes_owner_select ON hda_signature_spikes FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hda_signature_spikes_internal_select ON hda_signature_spikes IS 'Всплески читают сотрудники (блок на странице известных проблем) и система';
COMMENT ON POLICY hda_signature_spikes_system_insert ON hda_signature_spikes IS 'Всплеск записывает только задача agent.spikes';
COMMENT ON POLICY hda_signature_spikes_system_update ON hda_signature_spikes IS 'Строку меняет система';
COMMENT ON POLICY hda_signature_spikes_writer_update ON hda_signature_spikes IS 'Проблему по всплеску ставит сотрудник с правом ведения проблем; остальные поля закрывает t_hda_signature_spikes_guard';
COMMENT ON POLICY hda_signature_spikes_owner_select ON hda_signature_spikes IS 'Владелец читает строки для представления hda_agent_spikes, которое само отбирает строки';
GRANT SELECT, INSERT, UPDATE ON hda_signature_spikes TO hub_app;

-- Представление читает hdp_problems по политике владельца hdp_problems_owner_select (миграция 0098).
CREATE VIEW hda_agent_spikes WITH (security_barrier = true) AS
SELECT s.spike_id, s.signature, s.org_count, s.ticket_count, s.window_minutes, s.detected_on, p.number AS problem_number,
       ARRAY(SELECT t.number FROM hdt_tickets t
              WHERE t.error_signature = s.signature
                AND t.created_on > s.detected_on - make_interval(mins => s.window_minutes) AND t.created_on <= s.detected_on
                AND app.agent_can_see_org(t.org_id)
              ORDER BY t.number LIMIT 50) AS ticket_numbers
  FROM hda_signature_spikes s
  LEFT JOIN hdp_problems p ON p.problem_id = s.problem_id
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL;
COMMENT ON VIEW hda_agent_spikes IS 'Всплески сигнатур для AI-сотрудника (FR-AGT-11, инструмент signature_spikes): сигнатура, числа, номер проблемы и до 50 номеров обращений окна, видимых агенту. Без организаций. Токену запуска пусто';
COMMENT ON COLUMN hda_agent_spikes.ticket_numbers IS 'Номера обращений окна всплеска из организаций, видимых агенту';
GRANT SELECT ON hda_agent_spikes TO hub_app;
