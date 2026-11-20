-- Таблицы идентичности (модуль hdu): серверы Smartup, организации клиентов, членство, сотрудники,
-- приглашения, подтверждение адреса. ТЗ: разделы 10.2, 10.3, 10.5. Имена: docs/naming.md.
--
-- Кто что может:
--   hub_app  (сервисы модулей через withActor): только чтение, без секретных колонок.
--   hub_auth (модуль hdu через withIdentity):   чтение и изменение от имени актора, политики ниже.
-- Права DELETE на эти таблицы нет ни у одной роли приложения: записи отключаются, а не удаляются.
-- Политики написаны руками, имя по образцу {таблица}_{актор}_{действие}.

-- Идентификатор пользователя актора как uuid. Если в переменной не uuid (фоновая задача,
-- AI-сотрудник), возвращает пусто, а не ошибку: политика просто не отдаёт строк.
CREATE FUNCTION app.user_uuid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN app.user_id() ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               THEN app.user_id()::uuid END $$;
COMMENT ON FUNCTION app.user_uuid() IS 'Идентификатор пользователя актора в виде uuid. Пусто, если актор не пользователь';

-- ---------------------------------------------------------------------------
-- hdu_servers: реестр серверов Smartup (FR-ID-02)
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_servers (
  server_id           uuid        NOT NULL DEFAULT uuidv7(),
  name                text        NOT NULL,
  base_url            text        NOT NULL,
  issuer              text        NOT NULL,
  oauth_client_id     text        NOT NULL,
  oauth_client_secret text        NOT NULL,
  oidc_endpoints      jsonb,
  role_map            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_default          boolean     NOT NULL DEFAULT false,
  state               text        NOT NULL DEFAULT 'active',
  code                text        NOT NULL,
  created_by          text,
  created_on          timestamptz NOT NULL DEFAULT now(),
  modified_by         text,
  modified_on         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_servers_pk PRIMARY KEY (server_id),
  CONSTRAINT hdu_servers_u1 UNIQUE (code),
  CONSTRAINT hdu_servers_u2 UNIQUE (base_url),
  CONSTRAINT hdu_servers_u3 UNIQUE (issuer),
  CONSTRAINT hdu_servers_c1 CHECK (state IN ('active', 'passive')),
  CONSTRAINT hdu_servers_c2 CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
  -- Адрес Smartup Web: только схема, узел и порт.
  CONSTRAINT hdu_servers_c3 CHECK (base_url ~ '^https?://[^/?#@\s]+$'),
  CONSTRAINT hdu_servers_c4 CHECK (issuer ~ '^https?://[^?#@\s]+$'),
  CONSTRAINT hdu_servers_c5 CHECK (jsonb_typeof(role_map) = 'object'),
  CONSTRAINT hdu_servers_c6 CHECK (oidc_endpoints IS NULL OR jsonb_typeof(oidc_endpoints) = 'object'),
  -- Секрет лежит только запечатанным (src/security/secret-box.ts): открытый текст база не примет.
  CONSTRAINT hdu_servers_c7 CHECK (oauth_client_secret ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'),
  CONSTRAINT hdu_servers_c8 CHECK (name <> '' AND oauth_client_id <> '')
);

-- Сервер по умолчанию один (общее облако).
CREATE UNIQUE INDEX hdu_servers_u4 ON hdu_servers (is_default) WHERE is_default;

COMMENT ON TABLE hdu_servers IS 'Реестр серверов Smartup: через них входят клиенты. У каждого сервера свои адреса OAuth, идентификатор клиента и секрет';
COMMENT ON COLUMN hdu_servers.server_id IS 'Идентификатор сервера';
COMMENT ON COLUMN hdu_servers.name IS 'Название сервера для сотрудников';
COMMENT ON COLUMN hdu_servers.base_url IS 'Адрес Smartup Web этого сервера. По нему клиент выделенного сервера находит свой вход';
COMMENT ON COLUMN hdu_servers.issuer IS 'Адрес сервера входа (issuer OpenID Connect)';
COMMENT ON COLUMN hdu_servers.oauth_client_id IS 'Идентификатор портала как клиента OAuth на этом сервере';
COMMENT ON COLUMN hdu_servers.oauth_client_secret IS 'Секрет клиента OAuth, зашифрован ключом ENCRYPTION_KEY. Приложению под ролью hub_app недоступен';
COMMENT ON COLUMN hdu_servers.oidc_endpoints IS 'Явные адреса авторизации, токена, сведений о пользователе и ключей. Пусто, если у сервера есть документ discovery';
COMMENT ON COLUMN hdu_servers.role_map IS 'Соответствие ролей: роль в Smartup и роль портала (client_user или client_admin). FR-ID-13';
COMMENT ON COLUMN hdu_servers.is_default IS 'Сервер по умолчанию: его кнопку видит клиент общего облака';
COMMENT ON COLUMN hdu_servers.state IS 'Состояние: active (вход работает) или passive (вход через сервер закрыт)';
COMMENT ON COLUMN hdu_servers.code IS 'Код сервера, совпадает с кодом в Smartup. Записан в способах входа пользователей, поэтому не меняется';
COMMENT ON COLUMN hdu_servers.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_servers.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_servers.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_servers.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_servers_stamp
  BEFORE INSERT OR UPDATE ON hdu_servers
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

CREATE FUNCTION app.hdu_servers_code() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'Код сервера менять нельзя: он записан в способах входа пользователей' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_servers_code() IS 'Триггер: код сервера Smartup не меняется';

CREATE TRIGGER t_hdu_servers_code
  BEFORE UPDATE ON hdu_servers
  FOR EACH ROW EXECUTE FUNCTION app.hdu_servers_code();

ALTER TABLE hdu_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_servers FORCE ROW LEVEL SECURITY;

-- Клиенту реестр не виден: список раскрыл бы, кто является клиентом Smartup (FR-ID-03).
CREATE POLICY hdu_servers_internal_select ON hdu_servers FOR SELECT TO hub_app
  USING (app.is_internal());

-- Вход (поиск сервера до появления сессии) и команда консоли работают от актора system.
CREATE POLICY hdu_servers_system_all ON hdu_servers FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

-- Реестр ведёт администратор портала.
CREATE POLICY hdu_servers_admin_all ON hdu_servers FOR ALL TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

-- hub_app читает только несекретные колонки.
GRANT SELECT (server_id, name, base_url, issuer, is_default, state, code, created_by, created_on, modified_by, modified_on)
  ON hdu_servers TO hub_app;
GRANT SELECT, INSERT, UPDATE ON hdu_servers TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_organizations: организации клиентов
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_organizations (
  org_id              uuid        NOT NULL DEFAULT uuidv7(),
  server_id           uuid        NOT NULL,
  external_company_id text        NOT NULL,
  name                text        NOT NULL,
  inn                 text,
  category            text,
  is_ai_enabled       boolean     NOT NULL DEFAULT true,
  state               text        NOT NULL DEFAULT 'active',
  created_by          text,
  created_on          timestamptz NOT NULL DEFAULT now(),
  modified_by         text,
  modified_on         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_organizations_pk PRIMARY KEY (org_id),
  -- Организация это пара "сервер и идентификатор компании" (FR-ID-04). Первой колонкой стоит внешний ключ.
  CONSTRAINT hdu_organizations_u1 UNIQUE (server_id, external_company_id),
  CONSTRAINT hdu_organizations_f1 FOREIGN KEY (server_id) REFERENCES hdu_servers (server_id),
  CONSTRAINT hdu_organizations_c1 CHECK (category IS NULL OR category IN ('A', 'B', 'C', 'D')),
  CONSTRAINT hdu_organizations_c2 CHECK (state IN ('active', 'passive')),
  CONSTRAINT hdu_organizations_c3 CHECK (name <> '' AND external_company_id <> '')
);

-- Поиск организаций сотрудниками по части названия.
CREATE INDEX hdu_organizations_i1 ON hdu_organizations USING gin (name gin_trgm_ops);

COMMENT ON TABLE hdu_organizations IS 'Организации клиентов. Создаются сами при первом входе через Smartup по паре "сервер и идентификатор компании"';
COMMENT ON COLUMN hdu_organizations.org_id IS 'Идентификатор организации. По нему разделяются данные клиентов';
COMMENT ON COLUMN hdu_organizations.server_id IS 'Сервер Smartup, на котором работает компания';
COMMENT ON COLUMN hdu_organizations.external_company_id IS 'Идентификатор компании на этом сервере Smartup';
COMMENT ON COLUMN hdu_organizations.name IS 'Название организации. Обновляется из Smartup при каждом входе';
COMMENT ON COLUMN hdu_organizations.inn IS 'ИНН для сопоставления с CRM и биллингом. Обновляется из Smartup';
COMMENT ON COLUMN hdu_organizations.category IS 'Категория клиента: A, B, C или D. Задаёт сотрудник';
COMMENT ON COLUMN hdu_organizations.is_ai_enabled IS 'Обращения организации обрабатывает AI-помощник. Организация может отказаться';
COMMENT ON COLUMN hdu_organizations.state IS 'Состояние: active или passive (организация отключена, её участники не входят)';
COMMENT ON COLUMN hdu_organizations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_organizations.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_organizations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_organizations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_organizations_stamp
  BEFORE INSERT OR UPDATE ON hdu_organizations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_organizations FORCE ROW LEVEL SECURITY;

-- Клиент видит только свою действующую организацию.
CREATE POLICY hdu_organizations_client_select ON hdu_organizations FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND org_id = app.org_id() AND state = 'active');

-- Сотрудники и фоновые задачи видят все организации.
CREATE POLICY hdu_organizations_internal_select ON hdu_organizations FOR SELECT TO hub_app
  USING (app.is_internal());

-- Организацию создаёт и обновляет вход через Smartup, от актора system.
CREATE POLICY hdu_organizations_system_all ON hdu_organizations FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

GRANT SELECT ON hdu_organizations TO hub_app;
GRANT SELECT, INSERT, UPDATE ON hdu_organizations TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_memberships: кто в какой организации состоит
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_memberships (
  org_id         uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  role           text        NOT NULL DEFAULT 'client_user',
  source         text        NOT NULL,
  is_role_manual boolean     NOT NULL DEFAULT false,
  state          text        NOT NULL DEFAULT 'active',
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_memberships_pk PRIMARY KEY (org_id, user_id),
  CONSTRAINT hdu_memberships_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdu_memberships_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdu_memberships_c1 CHECK (role IN ('client_user', 'client_admin')),
  CONSTRAINT hdu_memberships_c2 CHECK (source IN ('smartup', 'invite', 'staff', 'guest')),
  CONSTRAINT hdu_memberships_c3 CHECK (state IN ('active', 'passive'))
);

CREATE INDEX hdu_memberships_i1 ON hdu_memberships (user_id);

COMMENT ON TABLE hdu_memberships IS 'Членство пользователей в организациях клиентов. Один человек может состоять в нескольких организациях';
COMMENT ON COLUMN hdu_memberships.org_id IS 'Организация';
COMMENT ON COLUMN hdu_memberships.user_id IS 'Пользователь';
COMMENT ON COLUMN hdu_memberships.role IS 'Роль в организации: client_user или client_admin';
COMMENT ON COLUMN hdu_memberships.source IS 'Откуда членство: smartup (вход через Smartup), invite (приглашение администратора клиента), staff (приглашение сотрудника), guest (письмо с неизвестного адреса, входа не даёт)';
COMMENT ON COLUMN hdu_memberships.is_role_manual IS 'Роль выдал сотрудник вручную: вход через Smartup её не понижает';
COMMENT ON COLUMN hdu_memberships.state IS 'Состояние: active или passive (участник отключён и доступа к организации не имеет)';
COMMENT ON COLUMN hdu_memberships.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_memberships.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_memberships.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_memberships.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_memberships_stamp
  BEFORE INSERT OR UPDATE ON hdu_memberships
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Страховка от ошибки в сервисе: политика пускает администратора клиента к строке, а что именно он
-- в ней меняет, политика проверить не может. Клиент меняет только состояние участника.
CREATE FUNCTION app.hdu_memberships_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Членство: организацию и пользователя менять нельзя' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'client'
     AND (NEW.role, NEW.is_role_manual, NEW.source) IS DISTINCT FROM (OLD.role, OLD.is_role_manual, OLD.source) THEN
    RAISE EXCEPTION 'Членство: клиенту нельзя менять роль и источник' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_memberships_guard() IS 'Триггер: что можно менять в членстве и кому';

CREATE TRIGGER t_hdu_memberships_guard
  BEFORE UPDATE ON hdu_memberships
  FOR EACH ROW EXECUTE FUNCTION app.hdu_memberships_guard();

ALTER TABLE hdu_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_memberships FORCE ROW LEVEL SECURITY;

-- Клиент видит участников своей организации.
CREATE POLICY hdu_memberships_client_select ON hdu_memberships FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND org_id = app.org_id());

CREATE POLICY hdu_memberships_internal_select ON hdu_memberships FOR SELECT TO hub_app
  USING (app.is_internal());

-- Членство создаёт вход через Smartup и принятие приглашения, от актора system.
CREATE POLICY hdu_memberships_system_all ON hdu_memberships FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

-- Роль и состояние участника меняют Customer Care и администратор портала (FR-ID-13, FR-ADM-02).
CREATE POLICY hdu_memberships_care_select ON hdu_memberships FOR SELECT TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'));

CREATE POLICY hdu_memberships_care_update ON hdu_memberships FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'))
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'));

-- Администратор клиента отключает и включает участников своей организации, кроме себя
-- (решение владельца продукта от 20.11.2026). Роль он не меняет: это проверяет триггер выше.
CREATE POLICY hdu_memberships_client_admin_select ON hdu_memberships FOR SELECT TO hub_auth
  USING (app.actor_type() = 'client' AND app.org_role() = 'client_admin' AND org_id = app.org_id());

CREATE POLICY hdu_memberships_client_admin_update ON hdu_memberships FOR UPDATE TO hub_auth
  USING (
    app.actor_type() = 'client' AND app.org_role() = 'client_admin'
    AND org_id = app.org_id() AND user_id IS DISTINCT FROM app.user_uuid()
  )
  WITH CHECK (
    app.actor_type() = 'client' AND app.org_role() = 'client_admin'
    AND org_id = app.org_id() AND user_id IS DISTINCT FROM app.user_uuid()
  );

-- Представление hdu_user_profiles читает таблицу от имени владельца, а владелец при FORCE ROW LEVEL SECURITY
-- тоже подчиняется политикам. Права владельца это не расширяет: он и так хозяин таблицы.
CREATE POLICY hdu_memberships_owner_select ON hdu_memberships FOR SELECT TO hub_owner
  USING (true);

GRANT SELECT ON hdu_memberships TO hub_app;
GRANT SELECT, INSERT, UPDATE ON hdu_memberships TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_staff: сотрудники Smartup
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_staff (
  user_id     uuid        NOT NULL,
  role        text        NOT NULL,
  is_lead     boolean     NOT NULL DEFAULT false,
  state       text        NOT NULL DEFAULT 'active',
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_staff_pk PRIMARY KEY (user_id),
  CONSTRAINT hdu_staff_f1 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdu_staff_c1 CHECK (role IN ('agent_l1', 'agent_l2', 'care', 'product', 'admin', 'agent_bot')),
  CONSTRAINT hdu_staff_c2 CHECK (state IN ('active', 'passive'))
);

COMMENT ON TABLE hdu_staff IS 'Сотрудники Smartup, которые работают в рабочем месте портала';
COMMENT ON COLUMN hdu_staff.user_id IS 'Пользователь';
COMMENT ON COLUMN hdu_staff.role IS 'Роль: agent_l1, agent_l2, care, product, admin или agent_bot (AI-сотрудник, в рабочее место не входит)';
COMMENT ON COLUMN hdu_staff.is_lead IS 'Руководитель своей линии: получает уведомления о нарушении сроков, прав на данные сверх роли не имеет';
COMMENT ON COLUMN hdu_staff.state IS 'Состояние: active или passive (сотрудник заблокирован)';
COMMENT ON COLUMN hdu_staff.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_staff.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_staff.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_staff.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_staff_stamp
  BEFORE INSERT OR UPDATE ON hdu_staff
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_staff FORCE ROW LEVEL SECURITY;

-- Сотрудника заводит принятие приглашения и команда консоли, от актора system.
-- Проверка роли при входе тоже читает строку от актора system.
CREATE POLICY hdu_staff_system_all ON hdu_staff FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

-- Для представления hdu_user_profiles, как у hdu_memberships.
CREATE POLICY hdu_staff_owner_select ON hdu_staff FOR SELECT TO hub_owner
  USING (true);

-- hub_app прав на таблицу не имеет: признак сотрудника он получает из представления hdu_user_profiles.
GRANT SELECT, INSERT, UPDATE ON hdu_staff TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_invitations: приглашения в организацию клиента и приглашения сотрудников
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_invitations (
  org_id        uuid,
  invitation_id uuid        NOT NULL DEFAULT uuidv7(),
  email         text        NOT NULL,
  role          text        NOT NULL,
  name          text,
  is_lead       boolean     NOT NULL DEFAULT false,
  token_hash    text        NOT NULL,
  invited_by    uuid,
  expires_on    timestamptz NOT NULL,
  accepted_on   timestamptz,
  revoked_on    timestamptz,
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_invitations_pk PRIMARY KEY (invitation_id),
  CONSTRAINT hdu_invitations_u1 UNIQUE (token_hash),
  CONSTRAINT hdu_invitations_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdu_invitations_f2 FOREIGN KEY (invited_by) REFERENCES auth."user" ("id") ON DELETE SET NULL,
  -- Роль клиента только с организацией, роль сотрудника только без неё. Роль agent_bot не приглашается.
  CONSTRAINT hdu_invitations_c1 CHECK (
    (org_id IS NOT NULL AND role IN ('client_user', 'client_admin'))
    OR (org_id IS NULL AND role IN ('agent_l1', 'agent_l2', 'care', 'product', 'admin'))
  ),
  CONSTRAINT hdu_invitations_c2 CHECK (email <> '' AND email = lower(btrim(email))),
  -- Токен хранится только хешем SHA-256 (ТЗ 14.3).
  CONSTRAINT hdu_invitations_c3 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hdu_invitations_c4 CHECK (accepted_on IS NULL OR revoked_on IS NULL),
  -- Руководителем линии может быть только сотрудник.
  CONSTRAINT hdu_invitations_c5 CHECK (NOT is_lead OR org_id IS NULL)
);

CREATE INDEX hdu_invitations_i1 ON hdu_invitations (org_id);
CREATE INDEX hdu_invitations_i2 ON hdu_invitations (email);
CREATE INDEX hdu_invitations_i3 ON hdu_invitations (invited_by);

COMMENT ON TABLE hdu_invitations IS 'Приглашения по одноразовой ссылке: коллег в организацию клиента (7 дней) и сотрудников в рабочее место (24 часа)';
COMMENT ON COLUMN hdu_invitations.org_id IS 'Организация, в которую приглашают. Пусто у приглашения сотрудника';
COMMENT ON COLUMN hdu_invitations.invitation_id IS 'Идентификатор приглашения';
COMMENT ON COLUMN hdu_invitations.email IS 'Адрес приглашённого';
COMMENT ON COLUMN hdu_invitations.role IS 'Роль, которую получит приглашённый';
COMMENT ON COLUMN hdu_invitations.name IS 'Имя приглашённого, если его указал приглашающий';
COMMENT ON COLUMN hdu_invitations.is_lead IS 'Приглашённый сотрудник станет руководителем своей линии';
COMMENT ON COLUMN hdu_invitations.token_hash IS 'Хеш одноразового токена ссылки. Сам токен не хранится. Приложению под ролью hub_app недоступен';
COMMENT ON COLUMN hdu_invitations.invited_by IS 'Кто пригласил. Пусто у приглашения из команды консоли';
COMMENT ON COLUMN hdu_invitations.expires_on IS 'До какого момента ссылка действует';
COMMENT ON COLUMN hdu_invitations.accepted_on IS 'Когда приглашение принято';
COMMENT ON COLUMN hdu_invitations.revoked_on IS 'Когда приглашение отозвано';
COMMENT ON COLUMN hdu_invitations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_invitations.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_invitations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_invitations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_invitations_stamp
  BEFORE INSERT OR UPDATE ON hdu_invitations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Пользователь (клиент или сотрудник) может только отозвать приглашение. Принимает его система.
CREATE FUNCTION app.hdu_invitations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() IN ('client', 'staff')
     AND (NEW.org_id, NEW.email, NEW.role, NEW.name, NEW.is_lead, NEW.token_hash, NEW.invited_by, NEW.expires_on, NEW.accepted_on)
         IS DISTINCT FROM
         (OLD.org_id, OLD.email, OLD.role, OLD.name, OLD.is_lead, OLD.token_hash, OLD.invited_by, OLD.expires_on, OLD.accepted_on) THEN
    RAISE EXCEPTION 'Приглашение: менять можно только отметку об отзыве, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_invitations_guard() IS 'Триггер: пользователь может только отозвать приглашение';

CREATE TRIGGER t_hdu_invitations_guard
  BEFORE UPDATE ON hdu_invitations
  FOR EACH ROW EXECUTE FUNCTION app.hdu_invitations_guard();

ALTER TABLE hdu_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_invitations FORCE ROW LEVEL SECURITY;

-- Администратор клиента видит приглашения своей организации.
CREATE POLICY hdu_invitations_client_admin_select ON hdu_invitations FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND app.org_role() = 'client_admin' AND org_id = app.org_id());

-- Сотрудники видят приглашения организаций. Приглашения сотрудников через hub_app не видны.
CREATE POLICY hdu_invitations_internal_select ON hdu_invitations FOR SELECT TO hub_app
  USING (app.is_internal() AND org_id IS NOT NULL);

-- Принятие приглашения и приглашение из команды консоли идут от актора system.
CREATE POLICY hdu_invitations_system_all ON hdu_invitations FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

-- Администратор клиента приглашает в свою организацию и только от своего имени (FR-ID-08).
CREATE POLICY hdu_invitations_client_admin_select_auth ON hdu_invitations FOR SELECT TO hub_auth
  USING (app.actor_type() = 'client' AND app.org_role() = 'client_admin' AND org_id = app.org_id());

CREATE POLICY hdu_invitations_client_admin_insert ON hdu_invitations FOR INSERT TO hub_auth
  WITH CHECK (
    app.actor_type() = 'client' AND app.org_role() = 'client_admin'
    AND org_id = app.org_id() AND invited_by = app.user_uuid()
  );

CREATE POLICY hdu_invitations_client_admin_update ON hdu_invitations FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'client' AND app.org_role() = 'client_admin' AND org_id = app.org_id())
  WITH CHECK (app.actor_type() = 'client' AND app.org_role() = 'client_admin' AND org_id = app.org_id());

-- Customer Care и администратор портала приглашают в любую организацию клиента.
CREATE POLICY hdu_invitations_care_select ON hdu_invitations FOR SELECT TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin') AND org_id IS NOT NULL);

CREATE POLICY hdu_invitations_care_insert ON hdu_invitations FOR INSERT TO hub_auth
  WITH CHECK (
    app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin')
    AND org_id IS NOT NULL AND invited_by = app.user_uuid()
  );

CREATE POLICY hdu_invitations_care_update ON hdu_invitations FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin') AND org_id IS NOT NULL)
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin') AND org_id IS NOT NULL);

-- Сотрудников приглашает администратор портала (FR-ADM-03): строки без организации.
CREATE POLICY hdu_invitations_admin_staff_select ON hdu_invitations FOR SELECT TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin' AND org_id IS NULL);

CREATE POLICY hdu_invitations_admin_staff_insert ON hdu_invitations FOR INSERT TO hub_auth
  WITH CHECK (
    app.actor_type() = 'staff' AND app.staff_role() = 'admin'
    AND org_id IS NULL AND invited_by = app.user_uuid()
  );

CREATE POLICY hdu_invitations_admin_staff_update ON hdu_invitations FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin' AND org_id IS NULL)
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin' AND org_id IS NULL);

-- hub_app читает приглашения без хеша токена.
GRANT SELECT (org_id, invitation_id, email, role, name, is_lead, invited_by, expires_on, accepted_on, revoked_on,
              created_by, created_on, modified_by, modified_on)
  ON hdu_invitations TO hub_app;
GRANT SELECT, INSERT, UPDATE ON hdu_invitations TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_email_tokens: одноразовые ссылки подтверждения адреса
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_email_tokens (
  token_id    uuid        NOT NULL DEFAULT uuidv7(),
  user_id     uuid        NOT NULL,
  email       text        NOT NULL,
  token_hash  text        NOT NULL,
  expires_on  timestamptz NOT NULL,
  used_on     timestamptz,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_email_tokens_pk PRIMARY KEY (token_id),
  CONSTRAINT hdu_email_tokens_u1 UNIQUE (token_hash),
  CONSTRAINT hdu_email_tokens_f1 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdu_email_tokens_c1 CHECK (email <> '' AND email = lower(btrim(email))),
  CONSTRAINT hdu_email_tokens_c2 CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX hdu_email_tokens_i1 ON hdu_email_tokens (user_id);

COMMENT ON TABLE hdu_email_tokens IS 'Одноразовые ссылки подтверждения адреса email. После подтверждения адрес становится адресом для входа';
COMMENT ON COLUMN hdu_email_tokens.token_id IS 'Идентификатор ссылки';
COMMENT ON COLUMN hdu_email_tokens.user_id IS 'Пользователь, который подтверждает адрес';
COMMENT ON COLUMN hdu_email_tokens.email IS 'Адрес, который подтверждается';
COMMENT ON COLUMN hdu_email_tokens.token_hash IS 'Хеш одноразового токена ссылки. Сам токен не хранится';
COMMENT ON COLUMN hdu_email_tokens.expires_on IS 'До какого момента ссылка действует';
COMMENT ON COLUMN hdu_email_tokens.used_on IS 'Когда ссылка использована или отменена новым запросом';
COMMENT ON COLUMN hdu_email_tokens.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_email_tokens.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_email_tokens.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_email_tokens.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_email_tokens_stamp
  BEFORE INSERT OR UPDATE ON hdu_email_tokens
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_email_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_email_tokens FORCE ROW LEVEL SECURITY;

-- Подтверждение по ссылке выполняет система: человек в этот момент может быть не вошедшим.
CREATE POLICY hdu_email_tokens_system_all ON hdu_email_tokens FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

-- Клиент запрашивает подтверждение только для себя.
CREATE POLICY hdu_email_tokens_owner_select ON hdu_email_tokens FOR SELECT TO hub_auth
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());

CREATE POLICY hdu_email_tokens_owner_insert ON hdu_email_tokens FOR INSERT TO hub_auth
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid());

CREATE POLICY hdu_email_tokens_owner_update ON hdu_email_tokens FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid());

-- hub_app прав на таблицу не имеет.
GRANT SELECT, INSERT, UPDATE ON hdu_email_tokens TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_user_profiles: имя автора рядом с обращением (ТЗ 10.3, справочные данные для соединений)
-- ---------------------------------------------------------------------------
-- Только идентификатор, имя и признак сотрудника. Адрес, сессии и остальные поля учётной записи
-- через представление недоступны. Правило строк: сотрудник и фоновая задача видят всех;
-- клиент видит участников своей организации (включая отключённых: их имена стоят у старых записей)
-- и действующих сотрудников; остальные акторы и запрос без актора не видят никого.
CREATE VIEW hdu_user_profiles WITH (security_barrier = true) AS
SELECT u."id" AS user_id, u."name" AS name, (s.user_id IS NOT NULL) AS is_staff
FROM auth."user" u
LEFT JOIN hdu_staff s ON s.user_id = u."id" AND s.state = 'active'
WHERE app.is_internal()
   OR (
     app.actor_type() = 'client'
     AND (
       s.user_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM hdu_memberships m WHERE m.user_id = u."id" AND m.org_id = app.org_id())
     )
   );

COMMENT ON VIEW hdu_user_profiles IS 'Профили для показа рядом с записями: идентификатор, имя, признак сотрудника. Без адреса и других полей учётной записи';

GRANT SELECT ON hdu_user_profiles TO hub_app;

-- ---------------------------------------------------------------------------
-- Ссылки на организацию из таблиц библиотеки входа (колонки портала, миграция 0003)
-- ---------------------------------------------------------------------------
ALTER TABLE auth."user"
  ADD CONSTRAINT user_f1 FOREIGN KEY ("lastOrgId") REFERENCES hdu_organizations (org_id) ON DELETE SET NULL;
ALTER TABLE auth."session"
  ADD CONSTRAINT session_f2 FOREIGN KEY ("activeOrgId") REFERENCES hdu_organizations (org_id) ON DELETE SET NULL;
CREATE INDEX "user_lastOrgId_idx" ON auth."user" ("lastOrgId");
CREATE INDEX "session_activeOrgId_idx" ON auth."session" ("activeOrgId");
