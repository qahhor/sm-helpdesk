-- Сигналы дежурным о состоянии портала (аудит 23.11.2026, находки O2 и S4; ТЗ 13.8; план W0, задача 4).
-- Таблица хранит только время последнего сигнала каждого вида: один вид уходит дежурным не чаще раза в час.
-- Ведёт её фоновая задача ops.watch под системным актором; клиент и сотрудник строк не видят.

CREATE TABLE hdc_ops_alerts (
  code         text        NOT NULL,
  last_sent_on timestamptz NOT NULL,
  created_by   text,
  created_on   timestamptz NOT NULL DEFAULT now(),
  modified_by  text,
  modified_on  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_ops_alerts_pk PRIMARY KEY (code),
  CONSTRAINT hdc_ops_alerts_c1 CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$')
);
COMMENT ON TABLE hdc_ops_alerts IS 'Когда дежурным последний раз ушёл сигнал каждого вида (ТЗ 13.8)';
COMMENT ON COLUMN hdc_ops_alerts.code IS 'Вид сигнала: упавшие задачи, очередь исходящих, письма без разбора, неудачные входы, заражённые файлы';
COMMENT ON COLUMN hdc_ops_alerts.last_sent_on IS 'Когда сигнал этого вида ушёл последний раз';
COMMENT ON COLUMN hdc_ops_alerts.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdc_ops_alerts.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdc_ops_alerts.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdc_ops_alerts.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdc_ops_alerts_stamp
  BEFORE INSERT OR UPDATE ON hdc_ops_alerts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdc_ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_ops_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY hdc_ops_alerts_system_all ON hdc_ops_alerts FOR ALL TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdc_ops_alerts_system_all ON hdc_ops_alerts IS 'Отметки сигналов ведёт только фоновая задача';
GRANT SELECT, INSERT, UPDATE ON hdc_ops_alerts TO hub_app;

-- Неудачные входы сотрудников за последние минуты считаются по журналу аудита: индекс (action, created_on) уже есть.
