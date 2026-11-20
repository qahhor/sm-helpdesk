-- Контакты пользователя в Telegram, одноразовые коды привязки и входа, события бота (ТЗ: FR-ID-14,
-- решение 94, раздел 19.17; план M1, задачи 16 и 17; решение 0018). Имена: docs/naming.md.
--
-- Кто что может:
--   hub_app  (сервисы через withActor): клиент читает свою привязку, сотрудник все; коды не читает никто.
--   hub_auth (модуль hdu через withIdentity): система всё; клиент удаляет свою привязку и создаёт свои коды привязки.
-- Право DELETE на привязку выдано: отвязка удаляет идентификатор Telegram (раздел 19.17).

-- ---------------------------------------------------------------------------
-- Колонки портала в учётной записи
-- ---------------------------------------------------------------------------
ALTER TABLE auth."user" ADD COLUMN "locale" text, ADD COLUMN "policyVersion" text;
ALTER TABLE auth."user" ADD CONSTRAINT user_c2 CHECK ("locale" IS NULL OR "locale" IN ('ru', 'uz', 'en'));

COMMENT ON COLUMN auth."user"."locale" IS 'Колонка портала. Язык писем и сообщений бота: выбор в портале, команда бота или язык из Smartup при первом входе';
COMMENT ON COLUMN auth."user"."policyVersion" IS 'Колонка портала. Версия политики обработки данных, с которой пользователь ознакомлен';

-- ---------------------------------------------------------------------------
-- hdu_contact_identities: аккаунты пользователя в каналах связи (сейчас только Telegram)
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_contact_identities (
  identity_id  uuid        NOT NULL DEFAULT uuidv7(),
  user_id      uuid        NOT NULL,
  kind         text        NOT NULL,
  external_id  text        NOT NULL,
  display_name text,
  verified     text        NOT NULL,
  verified_on  timestamptz NOT NULL,
  is_blocked   boolean     NOT NULL DEFAULT false,
  created_by   text,
  created_on   timestamptz NOT NULL DEFAULT now(),
  modified_by  text,
  modified_on  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_contact_identities_pk PRIMARY KEY (identity_id),
  -- Один аккаунт Telegram принадлежит одному пользователю, у пользователя одна привязка канала.
  CONSTRAINT hdu_contact_identities_u1 UNIQUE (kind, external_id),
  CONSTRAINT hdu_contact_identities_u2 UNIQUE (user_id, kind),
  CONSTRAINT hdu_contact_identities_f1 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdu_contact_identities_c1 CHECK (kind IN ('telegram')),
  CONSTRAINT hdu_contact_identities_c2 CHECK (verified IN ('linked')),
  CONSTRAINT hdu_contact_identities_c3 CHECK (external_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT hdu_contact_identities_c4 CHECK (display_name IS NULL OR length(display_name) <= 100)
);

COMMENT ON TABLE hdu_contact_identities IS 'Аккаунты пользователя в каналах связи. Сейчас только Telegram: привязка по одноразовому коду из портала';
COMMENT ON COLUMN hdu_contact_identities.identity_id IS 'Идентификатор привязки';
COMMENT ON COLUMN hdu_contact_identities.user_id IS 'Пользователь портала';
COMMENT ON COLUMN hdu_contact_identities.kind IS 'Канал: telegram';
COMMENT ON COLUMN hdu_contact_identities.external_id IS 'Идентификатор пользователя в канале (у Telegram: числовой id)';
COMMENT ON COLUMN hdu_contact_identities.display_name IS 'Как показать аккаунт: @имя или имя из Telegram';
COMMENT ON COLUMN hdu_contact_identities.verified IS 'Как подтверждена привязка: linked (одноразовый код из сессии портала)';
COMMENT ON COLUMN hdu_contact_identities.verified_on IS 'Когда привязка подтверждена';
COMMENT ON COLUMN hdu_contact_identities.is_blocked IS 'Пользователь заблокировал бота: сообщения не отправляются';
COMMENT ON COLUMN hdu_contact_identities.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_contact_identities.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_contact_identities.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_contact_identities.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_contact_identities_stamp
  BEFORE INSERT OR UPDATE ON hdu_contact_identities
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_contact_identities FORCE ROW LEVEL SECURITY;

-- Клиент видит только свою привязку: администратор клиента привязок участников не видит.
CREATE POLICY hdu_contact_identities_owner_select ON hdu_contact_identities FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdu_contact_identities_internal_select ON hdu_contact_identities FOR SELECT TO hub_app
  USING (app.is_internal());

-- Привязку создаёт система по коду из бота. Отвязать может система (команда бота) и сам клиент (кнопка в портале).
CREATE POLICY hdu_contact_identities_system_all ON hdu_contact_identities FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdu_contact_identities_owner_select_auth ON hdu_contact_identities FOR SELECT TO hub_auth
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdu_contact_identities_owner_delete ON hdu_contact_identities FOR DELETE TO hub_auth
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());

GRANT SELECT ON hdu_contact_identities TO hub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hdu_contact_identities TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_link_codes: одноразовые коды привязки канала (ссылка t.me/<бот>?start=<код>)
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_link_codes (
  link_code_id uuid        NOT NULL DEFAULT uuidv7(),
  user_id      uuid        NOT NULL,
  kind         text        NOT NULL,
  code_hash    text        NOT NULL,
  expires_on   timestamptz NOT NULL,
  used_on      timestamptz,
  created_by   text,
  created_on   timestamptz NOT NULL DEFAULT now(),
  modified_by  text,
  modified_on  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_link_codes_pk PRIMARY KEY (link_code_id),
  CONSTRAINT hdu_link_codes_u1 UNIQUE (code_hash),
  CONSTRAINT hdu_link_codes_f1 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdu_link_codes_c1 CHECK (kind IN ('telegram')),
  CONSTRAINT hdu_link_codes_c2 CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX hdu_link_codes_i1 ON hdu_link_codes (user_id);

COMMENT ON TABLE hdu_link_codes IS 'Одноразовые коды привязки канала связи. Код создаёт сессия портала, живёт 10 минут, хранится хешем';
COMMENT ON COLUMN hdu_link_codes.link_code_id IS 'Идентификатор кода';
COMMENT ON COLUMN hdu_link_codes.user_id IS 'Пользователь, который привязывает канал';
COMMENT ON COLUMN hdu_link_codes.kind IS 'Канал: telegram';
COMMENT ON COLUMN hdu_link_codes.code_hash IS 'Хеш одноразового кода. Сам код не хранится';
COMMENT ON COLUMN hdu_link_codes.expires_on IS 'До какого момента код действует';
COMMENT ON COLUMN hdu_link_codes.used_on IS 'Когда код использован или отменён новым кодом';
COMMENT ON COLUMN hdu_link_codes.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_link_codes.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_link_codes.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_link_codes.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_link_codes_stamp
  BEFORE INSERT OR UPDATE ON hdu_link_codes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_link_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY hdu_link_codes_system_all ON hdu_link_codes FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
-- Клиент создаёт коды только для себя и отменяет свои прежние неиспользованные.
CREATE POLICY hdu_link_codes_owner_insert ON hdu_link_codes FOR INSERT TO hub_auth
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdu_link_codes_owner_select ON hdu_link_codes FOR SELECT TO hub_auth
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdu_link_codes_owner_update ON hdu_link_codes FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid());

-- hub_app прав на таблицу не имеет.
GRANT SELECT, INSERT, UPDATE ON hdu_link_codes TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdu_login_codes: одноразовые ссылки запасного входа из канала связи (задача 17)
-- ---------------------------------------------------------------------------
CREATE TABLE hdu_login_codes (
  login_code_id uuid        NOT NULL DEFAULT uuidv7(),
  user_id       uuid        NOT NULL,
  channel       text        NOT NULL,
  code_hash     text        NOT NULL,
  expires_on    timestamptz NOT NULL,
  used_on       timestamptz,
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_login_codes_pk PRIMARY KEY (login_code_id),
  CONSTRAINT hdu_login_codes_u1 UNIQUE (code_hash),
  CONSTRAINT hdu_login_codes_f1 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdu_login_codes_c1 CHECK (channel IN ('telegram')),
  CONSTRAINT hdu_login_codes_c2 CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX hdu_login_codes_i1 ON hdu_login_codes (user_id);

COMMENT ON TABLE hdu_login_codes IS 'Одноразовые ссылки запасного входа из бота. Живут 10 минут, хранятся хешем, код на сайте не вводится';
COMMENT ON COLUMN hdu_login_codes.login_code_id IS 'Идентификатор ссылки';
COMMENT ON COLUMN hdu_login_codes.user_id IS 'Пользователь, который входит';
COMMENT ON COLUMN hdu_login_codes.channel IS 'Откуда пришла ссылка: telegram';
COMMENT ON COLUMN hdu_login_codes.code_hash IS 'Хеш одноразового токена ссылки. Сам токен не хранится';
COMMENT ON COLUMN hdu_login_codes.expires_on IS 'До какого момента ссылка действует';
COMMENT ON COLUMN hdu_login_codes.used_on IS 'Когда ссылка использована или отменена новым запросом';
COMMENT ON COLUMN hdu_login_codes.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_login_codes.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_login_codes.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_login_codes.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_login_codes_stamp
  BEFORE INSERT OR UPDATE ON hdu_login_codes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_login_codes FORCE ROW LEVEL SECURITY;

-- Ссылки создаёт и принимает только система: человек в этот момент не вошёл.
CREATE POLICY hdu_login_codes_system_all ON hdu_login_codes FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

GRANT SELECT, INSERT, UPDATE ON hdu_login_codes TO hub_auth;

-- ---------------------------------------------------------------------------
-- hdn_telegram_updates: номера принятых событий бота (повторная доставка ничего не делает)
-- ---------------------------------------------------------------------------
CREATE TABLE hdn_telegram_updates (
  update_id   bigint      NOT NULL,
  received_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_telegram_updates_pk PRIMARY KEY (update_id)
);

COMMENT ON TABLE hdn_telegram_updates IS 'Номера событий Telegram, которые портал уже принял: повторная доставка того же события ничего не делает';
COMMENT ON COLUMN hdn_telegram_updates.update_id IS 'Номер события (update_id из Bot API)';
COMMENT ON COLUMN hdn_telegram_updates.received_on IS 'Когда событие принято';

ALTER TABLE hdn_telegram_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_telegram_updates FORCE ROW LEVEL SECURITY;

-- Только обработчик вебхука от имени системы. Удаление нужно: при сбое обработки номер снимается,
-- и Telegram доставляет событие снова.
CREATE POLICY hdn_telegram_updates_system_all ON hdn_telegram_updates FOR ALL TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');

GRANT SELECT, INSERT, DELETE ON hdn_telegram_updates TO hub_app;
