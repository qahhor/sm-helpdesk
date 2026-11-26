-- Отметки резервных копий (план подготовки M9, задача 3, решение 6; ТЗ 13.7, 13.8).
-- Сценарии scripts/ops/backup.sh (ночная логическая копия) и scripts/ops/base-backup.sh (базовая копия для
-- восстановления на момент времени) после удачной выгрузки вызывают команду hub ops:backup-mark. По возрасту
-- последней отметки задача ops.watch шлёт дежурным сигнал backup_stale. Адресов бакета и имён файлов в таблице нет.
-- Пишет только система (команда консоли), читает администратор портала; клиент и остальные сотрудники строк не видят.

CREATE TABLE hdc_ops_backups (
  backup_id   uuid        NOT NULL DEFAULT uuidv7(),
  kind        text        NOT NULL,
  size_bytes  bigint,
  finished_on timestamptz NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_ops_backups_pk PRIMARY KEY (backup_id),
  CONSTRAINT hdc_ops_backups_c1 CHECK (kind IN ('dump', 'base')),
  CONSTRAINT hdc_ops_backups_c2 CHECK (size_bytes IS NULL OR size_bytes > 0)
);
COMMENT ON TABLE hdc_ops_backups IS 'Удачные резервные копии базы: отметка сценария копий через hub ops:backup-mark (ТЗ 13.7)';
COMMENT ON COLUMN hdc_ops_backups.backup_id IS 'Идентификатор отметки';
COMMENT ON COLUMN hdc_ops_backups.kind IS 'Вид копии: dump (ночная логическая, backup.sh) или base (базовая для восстановления на момент времени, base-backup.sh)';
COMMENT ON COLUMN hdc_ops_backups.size_bytes IS 'Размер зашифрованного файла копии в байтах, если сценарий его передал';
COMMENT ON COLUMN hdc_ops_backups.finished_on IS 'Когда копия выгружена в хранилище копий';
COMMENT ON COLUMN hdc_ops_backups.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdc_ops_backups.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdc_ops_backups.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdc_ops_backups.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

-- Последняя отметка каждого вида: задача ops.watch раз в 5 минут.
CREATE INDEX hdc_ops_backups_i1 ON hdc_ops_backups (kind, finished_on DESC);
COMMENT ON INDEX hdc_ops_backups_i1 IS 'Последняя отметка каждого вида копии';

CREATE TRIGGER t_hdc_ops_backups_stamp
  BEFORE INSERT OR UPDATE ON hdc_ops_backups
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdc_ops_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_ops_backups FORCE ROW LEVEL SECURITY;
CREATE POLICY hdc_ops_backups_system_insert ON hdc_ops_backups FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdc_ops_backups_system_insert ON hdc_ops_backups IS 'Отметку копии ставит только команда консоли hub ops:backup-mark';
CREATE POLICY hdc_ops_backups_system_select ON hdc_ops_backups FOR SELECT TO hub_app
  USING (app.actor_type() = 'system');
COMMENT ON POLICY hdc_ops_backups_system_select ON hdc_ops_backups IS 'Возраст копий проверяет фоновая задача ops.watch';
CREATE POLICY hdc_ops_backups_admin_select ON hdc_ops_backups FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hdc_ops_backups_admin_select ON hdc_ops_backups IS 'Отметки копий читает администратор портала';
GRANT SELECT, INSERT ON hdc_ops_backups TO hub_app;
