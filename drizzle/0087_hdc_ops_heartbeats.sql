-- Отметка "фоновый процесс жив" (план подготовки M9, задача 3, решение 5; ТЗ 13.8).
-- Если фоновый процесс упал, вместе с ним молчит и задача ops.watch: сигнал дежурным не уходит никому. Поэтому процесс
-- раз в минуту (задача ops.heartbeat) и при запуске ставит отметку, а адрес /api/ready/worker отвечает 503, если
-- отметка старше 3 минут. Его смотрит внешняя проверка доступности. Одна строка на процесс, только время.
-- Ведёт и читает её только система; клиент и сотрудник строк не видят.

CREATE TABLE hdc_ops_heartbeats (
  process     text        NOT NULL,
  beat_on     timestamptz NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_ops_heartbeats_pk PRIMARY KEY (process),
  CONSTRAINT hdc_ops_heartbeats_c1 CHECK (process ~ '^[a-z][a-z0-9_]{1,39}$')
);
COMMENT ON TABLE hdc_ops_heartbeats IS 'Последняя отметка работы фонового процесса (ТЗ 13.8)';
COMMENT ON COLUMN hdc_ops_heartbeats.process IS 'Процесс: worker';
COMMENT ON COLUMN hdc_ops_heartbeats.beat_on IS 'Когда процесс последний раз отметился';
COMMENT ON COLUMN hdc_ops_heartbeats.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdc_ops_heartbeats.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdc_ops_heartbeats.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdc_ops_heartbeats.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdc_ops_heartbeats_stamp
  BEFORE INSERT OR UPDATE ON hdc_ops_heartbeats
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdc_ops_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_ops_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY hdc_ops_heartbeats_system_all ON hdc_ops_heartbeats FOR ALL TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdc_ops_heartbeats_system_all ON hdc_ops_heartbeats IS 'Отметку ставит фоновый процесс, читает проверка /api/ready/worker под системным актором модуля';
GRANT SELECT, INSERT, UPDATE ON hdc_ops_heartbeats TO hub_app;
