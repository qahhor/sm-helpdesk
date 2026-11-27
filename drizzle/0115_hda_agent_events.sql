-- Веха M8b, задача 9: события для AI-сотрудника (ТЗ 7.21 FR-AGT-08, 10, 12; план M8b, решения 26, 27).
--
-- 1. Вид события предметной области line_transferred: передача на вторую линию пишет его в своей транзакции.
-- 2. hda_agent_events: исходящая очередь событий агенту (Hermes Agent, AGENT_WEBHOOK_URL). Тело только из кодов и
--    идентификаторов: вид, момент, номер и идентификатор обращения, организация идентификатором и категорией,
--    приоритет, очередь, модуль, причина кодом; у всплеска сигнатура и числа. Токен запуска по обращению выпускается в
--    момент отправки и в строке не хранится: только ссылка run_token_id на строку токена (там хеш). До пяти попыток,
--    затем failed; ночная очистка удаляет строки старше 30 суток. Только система; клиент и сотрудник ничего.

ALTER TABLE hdc_domain_events DROP CONSTRAINT hdc_domain_events_c1;
ALTER TABLE hdc_domain_events ADD CONSTRAINT hdc_domain_events_c1 CHECK (kind IN ('ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed',
                                                                                  'rated', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff', 'line_transferred')) NOT VALID;
ALTER TABLE hdc_domain_events VALIDATE CONSTRAINT hdc_domain_events_c1;
COMMENT ON CONSTRAINT hdc_domain_events_c1 ON hdc_domain_events IS 'Виды событий предметной области; line_transferred: передача на вторую линию (веха M8b)';

CREATE TABLE hda_agent_events (
  event_id        uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id       uuid,
  spike_id        uuid,
  run_token_id    uuid,
  kind            text        NOT NULL,
  body            jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'queued',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_on timestamptz NOT NULL DEFAULT now(),
  last_status     integer,
  sent_on         timestamptz,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_agent_events_pk PRIMARY KEY (event_id),
  CONSTRAINT hda_agent_events_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hda_agent_events_f2 FOREIGN KEY (spike_id) REFERENCES hda_signature_spikes (spike_id),
  CONSTRAINT hda_agent_events_f3 FOREIGN KEY (run_token_id) REFERENCES hda_agent_tokens (token_id),
  CONSTRAINT hda_agent_events_c1 CHECK (kind IN ('ai_handoff', 'line_transferred', 'sla_breached', 'signature_spike', 'code_analysis_requested')),
  CONSTRAINT hda_agent_events_c2 CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 8000 AND NOT body ? 'run_token'),
  CONSTRAINT hda_agent_events_c3 CHECK (status IN ('queued', 'sent', 'failed')),
  CONSTRAINT hda_agent_events_c4 CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT hda_agent_events_c5 CHECK ((status = 'sent') = (sent_on IS NOT NULL)),
  CONSTRAINT hda_agent_events_c6 CHECK ((kind = 'signature_spike') = (spike_id IS NOT NULL) AND (kind = 'signature_spike' OR ticket_id IS NOT NULL))
);
CREATE INDEX hda_agent_events_i1 ON hda_agent_events (next_attempt_on) WHERE status = 'queued';
CREATE INDEX hda_agent_events_i2 ON hda_agent_events (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX hda_agent_events_i3 ON hda_agent_events (spike_id) WHERE spike_id IS NOT NULL;
CREATE INDEX hda_agent_events_i4 ON hda_agent_events (run_token_id) WHERE run_token_id IS NOT NULL;
CREATE INDEX hda_agent_events_i5 ON hda_agent_events (created_on);
COMMENT ON INDEX hda_agent_events_i1 IS 'Отправка: строки, которые пора отправлять';
COMMENT ON INDEX hda_agent_events_i2 IS 'Внешний ключ: обращение события';
COMMENT ON INDEX hda_agent_events_i3 IS 'Внешний ключ: всплеск сигнатуры';
COMMENT ON INDEX hda_agent_events_i4 IS 'Внешний ключ: токен запуска, выпущенный при отправке';
COMMENT ON INDEX hda_agent_events_i5 IS 'Ночная очистка строк старше 30 суток';

COMMENT ON TABLE hda_agent_events IS 'Исходящая очередь событий для AI-сотрудника (FR-AGT-08): тело только из кодов и идентификаторов, без текстов, имён и названий. Значения токена запуска нет. Только система';
COMMENT ON COLUMN hda_agent_events.event_id IS 'Идентификатор события: заголовок X-Hub-Delivery и поле id тела';
COMMENT ON COLUMN hda_agent_events.ticket_id IS 'Обращение события. Пусто у всплеска';
COMMENT ON COLUMN hda_agent_events.spike_id IS 'Всплеск сигнатуры. Только у вида signature_spike';
COMMENT ON COLUMN hda_agent_events.run_token_id IS 'Токен запуска по обращению, выпущенный при последней попытке отправки (FR-AGT-12). Значение токена не хранится';
COMMENT ON COLUMN hda_agent_events.kind IS 'Вид: ai_handoff, line_transferred, sla_breached, signature_spike; code_analysis_requested для вехи M8c';
COMMENT ON COLUMN hda_agent_events.body IS 'Тело события без токена запуска: коды и идентификаторы (решение 26)';
COMMENT ON COLUMN hda_agent_events.status IS 'queued (ждёт отправки), sent (принято приёмником), failed (пять неудачных попыток)';
COMMENT ON COLUMN hda_agent_events.attempts IS 'Сколько попыток отправки закончились неудачей';
COMMENT ON COLUMN hda_agent_events.next_attempt_on IS 'Когда пробовать: сразу, после паузы 1, 5, 15, 60 минут или после срока захвата';
COMMENT ON COLUMN hda_agent_events.last_status IS 'Код ответа приёмника последней попытки; пусто при сбое сети';
COMMENT ON COLUMN hda_agent_events.sent_on IS 'Когда приёмник принял событие';
COMMENT ON COLUMN hda_agent_events.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_agent_events.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hda_agent_events.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_agent_events.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_agent_events_c2 ON hda_agent_events IS 'Тело объект не больше 8000 байт и без поля run_token: значение токена в строке очереди не хранится';
COMMENT ON CONSTRAINT hda_agent_events_c6 ON hda_agent_events IS 'У всплеска ссылка на всплеск, у остальных видов обращение';

CREATE TRIGGER t_hda_agent_events_stamp
  BEFORE INSERT OR UPDATE ON hda_agent_events
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_agent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_agent_events_system_select ON hda_agent_events FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hda_agent_events_system_insert ON hda_agent_events FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_agent_events_system_update ON hda_agent_events FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_agent_events_system_delete ON hda_agent_events FOR DELETE TO hub_app USING (app.actor_type() = 'system' AND created_on < now() - interval '30 days');
COMMENT ON POLICY hda_agent_events_system_select ON hda_agent_events IS 'Очередь читает только система: отправка и наблюдение';
COMMENT ON POLICY hda_agent_events_system_insert ON hda_agent_events IS 'Событие ставит разбор событий и задача всплесков';
COMMENT ON POLICY hda_agent_events_system_update ON hda_agent_events IS 'Попытки и итог отправки отмечает система';
COMMENT ON POLICY hda_agent_events_system_delete ON hda_agent_events IS 'Ночная очистка удаляет только строки старше 30 суток';
GRANT SELECT, INSERT, UPDATE, DELETE ON hda_agent_events TO hub_app;
