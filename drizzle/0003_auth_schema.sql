-- Схема auth: таблицы библиотеки входа Better Auth 1.7.22 (ТЗ, разделы 10.1 и 11.2; решение 0012).
--
-- Имена таблиц и колонок задаёт библиотека: camelCase в кавычках. Состав получен командой
-- getMigrations(...).compileMigrations() с настройками портала и поправлен руками:
--   - идентификаторы получают uuidv7() от базы, как остальные таблицы портала;
--   - добавлены свои колонки (отмечены комментариями) и два ограничения;
--   - ограничения названы явно.
-- При первом вызове библиотека сверяет таблицы с ожидаемыми: не хватает колонки, и вход перестаёт работать.
-- Поэтому состав проверяет тест tests/integration/auth-instance.test.ts.
--
-- Доступ: только роль hub_auth. Роль hub_app в этой схеме не имеет никаких прав.

CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO hub_auth;
COMMENT ON SCHEMA auth IS 'Таблицы библиотеки входа Better Auth. Доступны только роли hub_auth';

-- Подключение hub_auth тоже работает от имени актора (src/db/with-identity.ts): ему нужны функции app.*.
GRANT USAGE ON SCHEMA app TO hub_auth;

-- ---------------------------------------------------------------------------
-- Пользователь
-- ---------------------------------------------------------------------------
CREATE TABLE auth."user" (
  "id"               uuid        NOT NULL DEFAULT uuidv7(),
  "name"             text        NOT NULL,
  "email"            text        NOT NULL,
  "emailVerified"    boolean     NOT NULL,
  "image"            text,
  "createdAt"        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "twoFactorEnabled" boolean,
  "claimedEmail"     text,
  "onboardedAt"      timestamptz,
  "lastOrgId"        uuid,
  CONSTRAINT user_pk PRIMARY KEY ("id"),
  CONSTRAINT user_email_key UNIQUE ("email"),
  -- Адрес хранится в одном виде, иначе уникальность не работает.
  CONSTRAINT user_c1 CHECK ("email" = lower(btrim("email")))
);

COMMENT ON TABLE auth."user" IS 'Учётные записи клиентов и сотрудников. Ведёт библиотека входа';
COMMENT ON COLUMN auth."user"."email" IS 'Адрес для входа. У клиента без подтверждённого адреса стоит служебный вида u-...@users.invalid';
COMMENT ON COLUMN auth."user"."claimedEmail" IS 'Колонка портала. Адрес, который передал Smartup или указал пользователь. Не подтверждён, для входа не используется';
COMMENT ON COLUMN auth."user"."onboardedAt" IS 'Колонка портала. Когда пользователь прошёл шаг первого входа';
COMMENT ON COLUMN auth."user"."lastOrgId" IS 'Колонка портала. Организация, с которой пользователь работал последней: с неё начинается новая сессия';

-- ---------------------------------------------------------------------------
-- Сессия
-- ---------------------------------------------------------------------------
CREATE TABLE auth."session" (
  "id"          uuid        NOT NULL DEFAULT uuidv7(),
  "expiresAt"   timestamptz NOT NULL,
  "token"       text        NOT NULL,
  "createdAt"   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   timestamptz NOT NULL,
  "ipAddress"   text,
  "userAgent"   text,
  "userId"      uuid        NOT NULL,
  "activeOrgId" uuid,
  CONSTRAINT session_pk PRIMARY KEY ("id"),
  CONSTRAINT session_token_key UNIQUE ("token"),
  CONSTRAINT session_f1 FOREIGN KEY ("userId") REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX "session_userId_idx" ON auth."session" ("userId");

COMMENT ON TABLE auth."session" IS 'Сессии входа. Удаление строки завершает сессию на следующем запросе';
COMMENT ON COLUMN auth."session"."activeOrgId" IS 'Колонка портала. Организация, в которой работает клиент в этой сессии. Меняет только сервер после проверки членства';

-- ---------------------------------------------------------------------------
-- Способ входа: пароль сотрудника или учётная запись сервера Smartup
-- ---------------------------------------------------------------------------
CREATE TABLE auth."account" (
  "id"                    uuid        NOT NULL DEFAULT uuidv7(),
  "accountId"             text        NOT NULL,
  "providerId"            text        NOT NULL,
  "userId"                uuid        NOT NULL,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz NOT NULL,
  CONSTRAINT account_pk PRIMARY KEY ("id"),
  CONSTRAINT account_f1 FOREIGN KEY ("userId") REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX "account_userId_idx" ON auth."account" ("userId");
-- Библиотека этот индекс не создаёт. На нём держится правило "один пользователь Smartup, одна учётная запись":
-- личность клиента это пара "сервер и идентификатор пользователя" (решение 93 ТЗ).
CREATE UNIQUE INDEX account_provider_account_u1 ON auth."account" ("providerId", "accountId");

COMMENT ON TABLE auth."account" IS 'Способы входа пользователя. providerId: credential (пароль сотрудника) или код сервера Smartup; accountId: идентификатор пользователя на этом сервере';

-- ---------------------------------------------------------------------------
-- Одноразовые значения библиотеки (ссылки для входа)
-- ---------------------------------------------------------------------------
CREATE TABLE auth."verification" (
  "id"         uuid        NOT NULL DEFAULT uuidv7(),
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT verification_pk PRIMARY KEY ("id")
);

CREATE INDEX "verification_identifier_idx" ON auth."verification" ("identifier");

COMMENT ON TABLE auth."verification" IS 'Одноразовые ссылки для входа. Токен хранится хешем';

-- ---------------------------------------------------------------------------
-- Второй фактор сотрудника
-- ---------------------------------------------------------------------------
CREATE TABLE auth."twoFactor" (
  "id"                      uuid    NOT NULL DEFAULT uuidv7(),
  "secret"                  text    NOT NULL,
  "backupCodes"             text    NOT NULL,
  "userId"                  uuid    NOT NULL,
  "verified"                boolean,
  "failedVerificationCount" integer,
  "lockedUntil"             timestamptz,
  CONSTRAINT "twoFactor_pk" PRIMARY KEY ("id"),
  CONSTRAINT "twoFactor_f1" FOREIGN KEY ("userId") REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX "twoFactor_secret_idx" ON auth."twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON auth."twoFactor" ("userId");

COMMENT ON TABLE auth."twoFactor" IS 'Второй фактор TOTP. Секрет зашифрован библиотекой. Резервные коды портал не показывает и не принимает';

-- ---------------------------------------------------------------------------
-- Серверы входа библиотеки. Портал ею не пользуется: серверы Smartup лежат в реестре hdu_servers
-- с зашифрованным секретом и передаются библиотеке настройкой. Таблица нужна проверке схемы и остаётся пустой.
-- ---------------------------------------------------------------------------
CREATE TABLE auth."ssoProvider" (
  "id"             uuid NOT NULL DEFAULT uuidv7(),
  "issuer"         text NOT NULL,
  "oidcConfig"     text,
  "samlConfig"     text,
  "userId"         uuid NOT NULL,
  "providerId"     text NOT NULL,
  "organizationId" text,
  "domain"         text NOT NULL,
  CONSTRAINT "ssoProvider_pk" PRIMARY KEY ("id"),
  CONSTRAINT "ssoProvider_providerId_key" UNIQUE ("providerId"),
  CONSTRAINT "ssoProvider_f1" FOREIGN KEY ("userId") REFERENCES auth."user" ("id") ON DELETE CASCADE
);

COMMENT ON TABLE auth."ssoProvider" IS 'Не используется и остаётся пустой: серверы Smartup хранятся в hdu_servers';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO hub_auth;
-- Таблица не используется: в неё ничего не пишется даже при ошибке в коде.
REVOKE INSERT, UPDATE ON auth."ssoProvider" FROM hub_auth;
