-- Права раздела "Настройки" рабочего места (веха M1, задачи 18-20, решение 0019):
-- реестр серверов и проверка связи, сотрудники, карточка организации, чтение журнала аудита.
-- Политики написаны руками, имя по образцу {таблица}_{актор}_{действие}.

-- ---------------------------------------------------------------------------
-- hdu_server_checks: результат последней проверки связи с сервером Smartup (FR-ADM-01)
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_server_checks (
  server_id   uuid        NOT NULL,
  is_ok       boolean     NOT NULL,
  issues      text[]      NOT NULL DEFAULT '{}',
  checked_on  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_server_checks_pk PRIMARY KEY (server_id),
  CONSTRAINT hdu_server_checks_f1 FOREIGN KEY (server_id) REFERENCES hdu_servers (server_id),
  -- Перечень проблем: тип ServerIssue в src/modules/hdu/api/servers.ts.
  CONSTRAINT hdu_server_checks_c1 CHECK (issues <@ ARRAY['unreachable', 'timeout', 'not_json', 'issuer_mismatch',
    'no_authorization_endpoint', 'no_token_endpoint', 'no_userinfo_endpoint', 'no_jwks', 'no_pkce_s256']::text[]),
  CONSTRAINT hdu_server_checks_c2 CHECK (is_ok = (cardinality(issues) = 0))
);

COMMENT ON TABLE hdu_server_checks IS 'Результат последней проверки связи с сервером Smartup. Отдельно от реестра: проверка не меняет настройки входа';
COMMENT ON COLUMN hdu_server_checks.server_id IS 'Сервер Smartup';
COMMENT ON COLUMN hdu_server_checks.is_ok IS 'Проверка прошла: сервер отвечает и годится для входа';
COMMENT ON COLUMN hdu_server_checks.issues IS 'Найденные проблемы: unreachable, timeout, not_json, issuer_mismatch, no_authorization_endpoint, no_token_endpoint, no_userinfo_endpoint, no_jwks, no_pkce_s256';
COMMENT ON COLUMN hdu_server_checks.checked_on IS 'Когда проверка сделана';
COMMENT ON COLUMN hdu_server_checks.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_server_checks.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_server_checks.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_server_checks.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_server_checks_stamp
  BEFORE INSERT OR UPDATE ON hdu_server_checks
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_server_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_server_checks FORCE ROW LEVEL SECURITY;

-- Сотрудники видят результаты, как и сам реестр. Клиенту не видны.
CREATE POLICY hdu_server_checks_internal_select ON hdu_server_checks FOR SELECT TO hub_app
  USING (app.is_internal());

-- Проверку делают команда консоли (system) и администратор портала.
CREATE POLICY hdu_server_checks_system_all ON hdu_server_checks FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

CREATE POLICY hdu_server_checks_admin_all ON hdu_server_checks FOR ALL TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

GRANT SELECT ON hdu_server_checks TO hub_app;
GRANT SELECT, INSERT, UPDATE ON hdu_server_checks TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_staff: сотрудников ведёт администратор портала (FR-ADM-03, задача 19)
-- ---------------------------------------------------------------------------
CREATE POLICY hdu_staff_admin_all ON hdu_staff FOR ALL TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

-- Приглашения сотрудников администратором уже разрешены в 0005 (hdu_invitations_admin_staff_*).

-- ---------------------------------------------------------------------------
-- hdu_organizations: категорию и признак AI задают Customer Care и администратор (FR-ID-13, задача 20)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.hdu_organizations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'staff'
     AND (NEW.org_id, NEW.server_id, NEW.external_company_id, NEW.name, NEW.inn, NEW.state, NEW.created_by, NEW.created_on)
         IS DISTINCT FROM
         (OLD.org_id, OLD.server_id, OLD.external_company_id, OLD.name, OLD.inn, OLD.state, OLD.created_by, OLD.created_on) THEN
    RAISE EXCEPTION 'Организация: сотрудник меняет только категорию и признак AI, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_organizations_guard() IS 'Триггер: сотрудник меняет у организации только категорию и признак AI';

CREATE TRIGGER t_hdu_organizations_guard
  BEFORE UPDATE ON hdu_organizations
  FOR EACH ROW EXECUTE FUNCTION app.hdu_organizations_guard();

-- Изменение с условием по строке требует права её видеть: отсюда пара select и update.
CREATE POLICY hdu_organizations_care_select ON hdu_organizations FOR SELECT TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'));

CREATE POLICY hdu_organizations_care_update ON hdu_organizations FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'))
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'));

-- ---------------------------------------------------------------------------
-- hdc_audit_log: чтение для администратора портала (FR-ADM-07, решение 20 таблицы M1)
-- ---------------------------------------------------------------------------
-- Раздел 14.3 ТЗ говорит "только право вставки", раздел 10.5 говорит "чтение: admin". Принято второе:
-- без чтения нет экрана журнала. Изменение и удаление по-прежнему не разрешены никому.
CREATE POLICY hdc_audit_log_admin_select ON hdc_audit_log FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

GRANT SELECT ON hdc_audit_log TO hub_app;
