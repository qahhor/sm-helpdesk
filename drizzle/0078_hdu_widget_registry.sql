-- Виджет (план M6, задача 1; ТЗ 11.4, 14.4, FR-WG-09, FR-ADM-01; решения 2, 4 и 6 плана M6).
-- Реестр серверов получает настройки токена контекста и встраивания: как сервер Smartup подписывает токен контекста
-- (ключи по адресу JWKS или общий секрет), каким издателем он себя называет, ключ встраивания страниц виджета и
-- дополнительные адреса, с которых виджет разрешено встраивать. Одноразовость токенов контекста держит таблица
-- hdu_context_token_uses.

-- --- Настройки сервера ---

-- Новые колонки добавляются в конец таблицы: описание Drizzle сверяет порядок колонок.
ALTER TABLE hdu_servers ADD COLUMN context_issuer text;
ALTER TABLE hdu_servers ADD COLUMN context_key_mode text;
ALTER TABLE hdu_servers ADD COLUMN context_jwks_url text;
ALTER TABLE hdu_servers ADD COLUMN context_secret text;
-- 128 случайных бит строкой из 32 шестнадцатеричных знаков. В базе нет pgcrypto: значение получается из хеша двух
-- случайных uuid (в каждом 122 случайных бита), это не меньше 128 бит неопределённости.
ALTER TABLE hdu_servers ADD COLUMN embed_key text NOT NULL
  DEFAULT substr(encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), 1, 32);
ALTER TABLE hdu_servers ADD COLUMN embed_origins text[] NOT NULL DEFAULT '{}';

-- Издатель токена контекста по умолчанию равен адресу сервера входа OAuth (решение 4): у действующих серверов он
-- уникален (hdu_servers_u3), поэтому заполнение не нарушит уникальности.
-- Таблица под FORCE ROW LEVEL SECURITY, политик для владельца базы нет: без снятия принуждения UPDATE не увидел бы
-- ни одной строки. Принуждение снимается только на заполнение и возвращается в этой же транзакции (как в миграции
-- 0067): ALTER TABLE держит исключительную блокировку таблицы до фиксации, другие подключения её без принуждения не видят.
ALTER TABLE hdu_servers NO FORCE ROW LEVEL SECURITY;
UPDATE hdu_servers SET context_issuer = issuer;
ALTER TABLE hdu_servers FORCE ROW LEVEL SECURITY;
ALTER TABLE hdu_servers ALTER COLUMN context_issuer SET NOT NULL;

-- Новый сервер без явного издателя получает адрес сервера входа: так работают и команда консоли, и любая вставка.
CREATE FUNCTION app.hdu_servers_context_issuer() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  NEW.context_issuer := coalesce(NEW.context_issuer, NEW.issuer);
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_servers_context_issuer() IS 'Триггер: издатель токена контекста по умолчанию равен адресу сервера входа';

CREATE TRIGGER t_hdu_servers_context_issuer
  BEFORE INSERT ON hdu_servers
  FOR EACH ROW EXECUTE FUNCTION app.hdu_servers_context_issuer();

ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_u5 UNIQUE (context_issuer);
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_u6 UNIQUE (embed_key);
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c9 CHECK (context_issuer ~ '^https?://[^?#@\s]+$');
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c10 CHECK (context_key_mode IS NULL OR context_key_mode IN ('jwks', 'secret'));
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c11 CHECK (context_jwks_url IS NULL OR context_jwks_url ~ '^https?://[^#@\s]+$');
-- Секрет лежит только запечатанным (src/security/secret-box.ts), как секрет клиента OAuth.
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c12
  CHECK (context_secret IS NULL OR context_secret ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$');
-- Режим без того, чем проверять подпись, не сохраняется: ключи по адресу или общий секрет.
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c13 CHECK (context_key_mode IS DISTINCT FROM 'jwks' OR context_jwks_url IS NOT NULL);
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c14 CHECK (context_key_mode IS DISTINCT FROM 'secret' OR context_secret IS NOT NULL);
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c15 CHECK (embed_key ~ '^[0-9a-f]{32}$');
-- Не больше пяти адресов, каждый только схема, узел и порт. Пробелов в адресе нет, поэтому список проверяется строкой.
ALTER TABLE hdu_servers ADD CONSTRAINT hdu_servers_c16 CHECK (
  cardinality(embed_origins) <= 5
  AND array_to_string(embed_origins, ' ') ~ '^(https?://[^/?#@\s]+( https?://[^/?#@\s]+)*)?$'
);

COMMENT ON COLUMN hdu_servers.context_issuer IS 'Издатель токена контекста виджета (iss). Уникален в реестре, по умолчанию равен адресу сервера входа';
COMMENT ON COLUMN hdu_servers.context_key_mode IS 'Чем проверяется подпись токена контекста: jwks (ES256, EdDSA, RS256 по адресу ключей) или secret (HS256 общим секретом). Пусто: виджет с этим сервером не работает';
COMMENT ON COLUMN hdu_servers.context_jwks_url IS 'Адрес открытых ключей токена контекста (JWKS) для режима jwks. Только внешний узел (угроза T16)';
COMMENT ON COLUMN hdu_servers.context_secret IS 'Общий секрет подписи токена контекста для режима secret, зашифрован ключом ENCRYPTION_KEY. Приложению под ролью hub_app недоступен';
COMMENT ON COLUMN hdu_servers.embed_key IS 'Ключ встраивания: 128 случайных бит. Стоит в адресе страниц виджета и выбирает адреса для frame-ancestors. Не секрет';
COMMENT ON COLUMN hdu_servers.embed_origins IS 'Дополнительные адреса, с которых разрешено встраивать виджет, кроме адреса Smartup Web: до пяти, только схема, узел и порт';

-- Права hub_app на колонки не расширяются: новые колонки ему не нужны, секрет ему закрыт (GRANT в миграции 0005
-- перечисляет колонки). Роль hub_auth уже имеет SELECT, INSERT, UPDATE на всю таблицу.

-- --- Одноразовость токенов контекста (решение 4) ---

CREATE TABLE hdu_context_token_uses (
  server_id   uuid        NOT NULL,
  jti         text        NOT NULL,
  expires_on  timestamptz NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  -- Первой колонкой стоит внешний ключ: первичный ключ служит и его индексом.
  CONSTRAINT hdu_context_token_uses_pk PRIMARY KEY (server_id, jti),
  CONSTRAINT hdu_context_token_uses_f1 FOREIGN KEY (server_id) REFERENCES hdu_servers (server_id),
  CONSTRAINT hdu_context_token_uses_c1 CHECK (length(jti) BETWEEN 1 AND 200)
);

-- Ночная очистка ищет строки с вышедшим сроком.
CREATE INDEX hdu_context_token_uses_i1 ON hdu_context_token_uses (expires_on);

COMMENT ON TABLE hdu_context_token_uses IS 'Использованные токены контекста виджета: повторный токен с тем же jti от того же сервера отклоняется (ТЗ 11.4)';
COMMENT ON COLUMN hdu_context_token_uses.server_id IS 'Сервер Smartup, который выпустил токен';
COMMENT ON COLUMN hdu_context_token_uses.jti IS 'Уникальный номер токена (jti) на этом сервере';
COMMENT ON COLUMN hdu_context_token_uses.expires_on IS 'Срок токена с допуском часов 60 секунд. После него строка не нужна: просроченный токен и так не принимается';
COMMENT ON COLUMN hdu_context_token_uses.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_context_token_uses.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_context_token_uses.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_context_token_uses.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdu_context_token_uses_stamp
  BEFORE INSERT OR UPDATE ON hdu_context_token_uses
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdu_context_token_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_context_token_uses FORCE ROW LEVEL SECURITY;

-- Строки пишет обмен токена контекста от имени системы под ролью hub_auth. Клиент и сотрудник их не видят.
CREATE POLICY hdu_context_token_uses_system_all ON hdu_context_token_uses FOR ALL TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdu_context_token_uses_system_all ON hdu_context_token_uses IS 'Использованные токены контекста ведёт только система';

-- Удалить можно только строку с вышедшим сроком: иначе удаление открыло бы повтор токена.
CREATE POLICY hdu_context_token_uses_system_cleanup ON hdu_context_token_uses AS RESTRICTIVE FOR DELETE TO hub_auth
  USING (app.actor_type() = 'system' AND expires_on < now());
COMMENT ON POLICY hdu_context_token_uses_system_cleanup ON hdu_context_token_uses IS 'Удаление только системой и только строк с вышедшим сроком';

GRANT SELECT, INSERT, DELETE ON hdu_context_token_uses TO hub_auth;
