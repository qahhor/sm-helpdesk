-- Журнал аудита и счётчики ограничения частоты (модуль hdc).
-- ТЗ: разделы 10.5 (служебные таблицы), 14.3 (журнал аудита), 14.5 (ограничения частоты). Имена: docs/naming.md.

-- ---------------------------------------------------------------------------
-- hdc_audit_log
-- ---------------------------------------------------------------------------
-- Запись делается в той же транзакции, что и действие. Кто действует, заполняет база по актору транзакции:
-- сервис автора не передаёт и подделать не может. Служебных колонок modified_* нет: запись не меняется.
CREATE TABLE hdc_audit_log (
  org_id      uuid,
  audit_id    uuid        NOT NULL DEFAULT uuidv7(),
  actor_type  text        NOT NULL DEFAULT app.actor_type(),
  actor_id    text                 DEFAULT app.user_id(),
  action      text        NOT NULL,
  object_type text        NOT NULL,
  object_id   text,
  diff        jsonb,
  ip          inet,
  created_on  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_audit_log_pk PRIMARY KEY (audit_id),
  CONSTRAINT hdc_audit_log_c1 CHECK (actor_type IN ('client', 'staff', 'system', 'agent')),
  CONSTRAINT hdc_audit_log_c2 CHECK (action ~ '^[a-z]+\.[a-z_]+$'),
  CONSTRAINT hdc_audit_log_c3 CHECK (object_type <> '' AND object_type = btrim(object_type)),
  CONSTRAINT hdc_audit_log_c4 CHECK (diff IS NULL OR jsonb_typeof(diff) = 'object')
);

CREATE INDEX hdc_audit_log_i1 ON hdc_audit_log (object_type, object_id);
CREATE INDEX hdc_audit_log_i2 ON hdc_audit_log (org_id, created_on);
CREATE INDEX hdc_audit_log_i3 ON hdc_audit_log (action, created_on);

COMMENT ON TABLE hdc_audit_log IS 'Журнал аудита: кто, что и когда сделал с правами и настройками. Только добавление. Текстов обращений, паролей и токенов не содержит';
COMMENT ON COLUMN hdc_audit_log.org_id IS 'Организация клиента, которой касается действие. Пусто, если действие не про организацию';
COMMENT ON COLUMN hdc_audit_log.audit_id IS 'Идентификатор записи';
COMMENT ON COLUMN hdc_audit_log.actor_type IS 'Вид актора: client, staff, system, agent. Заполняет база';
COMMENT ON COLUMN hdc_audit_log.actor_id IS 'Идентификатор пользователя, который действовал. У системы пусто. Заполняет база';
COMMENT ON COLUMN hdc_audit_log.action IS 'Действие вида "объект.действие", например member.role_changed. Перечень: src/modules/hdc/pref.ts';
COMMENT ON COLUMN hdc_audit_log.object_type IS 'Вид объекта: staff, server, membership, invitation, user, session';
COMMENT ON COLUMN hdc_audit_log.object_id IS 'Идентификатор объекта';
COMMENT ON COLUMN hdc_audit_log.diff IS 'Что изменилось: прежнее и новое значение. Без секретов и текстов';
COMMENT ON COLUMN hdc_audit_log.ip IS 'Адрес, с которого пришёл запрос';
COMMENT ON COLUMN hdc_audit_log.created_on IS 'Когда сделана запись. Заполняет база';

ALTER TABLE hdc_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_audit_log FORCE ROW LEVEL SECURITY;

-- Писать может любой актор, но только от своего имени и только текущим временем.
-- Запрос без актора записать ничего не может.
CREATE POLICY hdc_audit_log_actor_insert ON hdc_audit_log FOR INSERT TO hub_app, hub_auth
  WITH CHECK (
    app.actor_type() <> 'none'
    AND actor_type = app.actor_type()
    AND actor_id IS NOT DISTINCT FROM app.user_id()
    AND created_on = now()
  );

-- Только добавление: права чтения, изменения и удаления приложению не выданы (ТЗ 14.3).
-- Чтение для администратора появляется вместе с экраном журнала (FR-ADM-07).
GRANT INSERT ON hdc_audit_log TO hub_app, hub_auth;

-- ---------------------------------------------------------------------------
-- hdc_rate_limits
-- ---------------------------------------------------------------------------
-- Счётчик попыток за окно времени. Ключ это вид действия и хеш того, кого считаем (адрес, учётная запись, IP):
-- сами адреса и IP в таблицу не попадают.
CREATE TABLE hdc_rate_limits (
  rate_limit_id uuid        NOT NULL DEFAULT uuidv7(),
  code          text        NOT NULL,
  window_on     timestamptz NOT NULL,
  hits          integer     NOT NULL,
  CONSTRAINT hdc_rate_limits_pk PRIMARY KEY (rate_limit_id),
  CONSTRAINT hdc_rate_limits_u1 UNIQUE (code),
  CONSTRAINT hdc_rate_limits_c1 CHECK (code <> '' AND code = btrim(code)),
  CONSTRAINT hdc_rate_limits_c2 CHECK (hits > 0)
);

CREATE INDEX hdc_rate_limits_i1 ON hdc_rate_limits (window_on);

COMMENT ON TABLE hdc_rate_limits IS 'Счётчики ограничения частоты (ТЗ 14.5): запросы ссылок для входа, попытки входа и другие';
COMMENT ON COLUMN hdc_rate_limits.rate_limit_id IS 'Идентификатор счётчика';
COMMENT ON COLUMN hdc_rate_limits.code IS 'Ключ счётчика: вид действия и хеш адреса, учётной записи или IP';
COMMENT ON COLUMN hdc_rate_limits.window_on IS 'Начало текущего окна. При превышении предела окно начинается заново: блокировка длится полное окно';
COMMENT ON COLUMN hdc_rate_limits.hits IS 'Сколько попыток сделано в текущем окне';

ALTER TABLE hdc_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_rate_limits FORCE ROW LEVEL SECURITY;

-- Счётчики ведёт только система: ни клиент, ни сотрудник их не видят и не могут сбросить.
CREATE POLICY hdc_rate_limits_system_all ON hdc_rate_limits FOR ALL TO hub_app
  USING (app.actor_type() = 'system')
  WITH CHECK (app.actor_type() = 'system');

GRANT SELECT, INSERT, UPDATE, DELETE ON hdc_rate_limits TO hub_app;
