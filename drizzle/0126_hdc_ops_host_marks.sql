-- Отметки ресурсов сервера (план M9, задача 9, решение 17; ТЗ 13.8 "диск, память, процессор"). Агента хостинга нет:
-- таймер systemd раз в 5 минут запускает scripts/ops/host-watch.sh, тот считает доли занятого диска томов базы и копий,
-- памяти и нагрузки процессора и вызывает команду hub ops:host-mark. По отметкам задача ops.watch шлёт дежурным сигналы
-- host_pressure (80% и выше) и host_mark_stale (отметок нет 15 минут). Одна строка на сервер, только числа и время;
-- путей томов в таблице нет. Пишет и читает только система; клиент, сотрудник и агент строк не видят.

CREATE TABLE hdc_ops_host_marks (
  host        text        NOT NULL,
  disk_pct    smallint    NOT NULL,
  mem_pct     smallint    NOT NULL,
  cpu_pct     smallint    NOT NULL,
  marked_on   timestamptz NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_ops_host_marks_pk PRIMARY KEY (host),
  CONSTRAINT hdc_ops_host_marks_c1 CHECK (host ~ '^[a-z0-9][a-z0-9.-]{0,62}$'),
  CONSTRAINT hdc_ops_host_marks_c2 CHECK (disk_pct BETWEEN 0 AND 100 AND mem_pct BETWEEN 0 AND 100 AND cpu_pct BETWEEN 0 AND 100)
);
COMMENT ON TABLE hdc_ops_host_marks IS 'Последняя отметка ресурсов каждого сервера: доли диска, памяти и процессора (ТЗ 13.8)';
COMMENT ON COLUMN hdc_ops_host_marks.host IS 'Имя сервера строчными буквами (hostname), в сигналы не попадает';
COMMENT ON COLUMN hdc_ops_host_marks.disk_pct IS 'Наибольшая доля занятого места томов базы и копий, проценты';
COMMENT ON COLUMN hdc_ops_host_marks.mem_pct IS 'Доля занятой памяти без кеша (MemTotal - MemAvailable), проценты';
COMMENT ON COLUMN hdc_ops_host_marks.cpu_pct IS 'Нагрузка процессора за минуту на одно ядро, проценты, не больше 100';
COMMENT ON COLUMN hdc_ops_host_marks.marked_on IS 'Когда сделан замер';
COMMENT ON COLUMN hdc_ops_host_marks.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdc_ops_host_marks.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdc_ops_host_marks.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdc_ops_host_marks.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hdc_ops_host_marks_c1 ON hdc_ops_host_marks IS 'Имя сервера: строчные латинские буквы, цифры, точка и дефис, до 63 знаков';
COMMENT ON CONSTRAINT hdc_ops_host_marks_c2 ON hdc_ops_host_marks IS 'Доли от 0 до 100 процентов';

CREATE TRIGGER t_hdc_ops_host_marks_stamp
  BEFORE INSERT OR UPDATE ON hdc_ops_host_marks
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdc_ops_host_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_ops_host_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY hdc_ops_host_marks_system_all ON hdc_ops_host_marks FOR ALL TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdc_ops_host_marks_system_all ON hdc_ops_host_marks IS 'Отметку ставит команда hub ops:host-mark, читает задача ops.watch; оба под системным актором';
GRANT SELECT, INSERT, UPDATE ON hdc_ops_host_marks TO hub_app;
