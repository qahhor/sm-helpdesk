-- Исходящие вебхуки (ТЗ 7.17, FR-AUTO-10, FR-ADM-11; план M8, задача 5, решения 9-11). Адреса задаёт администратор
-- портала: вызов уходит только по адресу из этого списка. Секрет подписи хранится зашифрованным в отдельной таблице,
-- как токен бота дежурных (hdn_channel_secrets), и на экран не выводится. Доставки ставит и отправляет только
-- система: действие правила "вызвать вебхук", подписка адреса на события и проверочная отправка.
-- Клиент не видит ничего; из сотрудников адреса и журнал доставок читает только администратор.

CREATE TABLE hdw_webhook_endpoints (
  endpoint_id uuid        NOT NULL DEFAULT uuidv7(),
  name        text        NOT NULL,
  url         text        NOT NULL,
  events      text[]      NOT NULL DEFAULT '{}',
  is_enabled  boolean     NOT NULL DEFAULT true,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_webhook_endpoints_pk PRIMARY KEY (endpoint_id),
  CONSTRAINT hdw_webhook_endpoints_c1 CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  -- Схему и узел проверяет приложение при сохранении и сетевой слой при соединении. http бывает только у
  -- локального приёмника в разработке: вне localhost приложение принимает один https.
  CONSTRAINT hdw_webhook_endpoints_c2 CHECK (url ~ '^https?://[^[:space:]]+$' AND char_length(url) <= 2000),
  CONSTRAINT hdw_webhook_endpoints_c3 CHECK (
    cardinality(events) <= 10
    AND events <@ ARRAY['ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed',
                        'rated', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff']::text[]
  )
);

COMMENT ON TABLE hdw_webhook_endpoints IS 'Разрешённые адреса исходящих вебхуков (FR-AUTO-10, FR-ADM-11)';
COMMENT ON COLUMN hdw_webhook_endpoints.endpoint_id IS 'Идентификатор адреса';
COMMENT ON COLUMN hdw_webhook_endpoints.name IS 'Название адреса: его видит администратор в списке и в редакторе правил';
COMMENT ON COLUMN hdw_webhook_endpoints.url IS 'Адрес приёмника. Только https и только внешний узел: проверяется при сохранении и при каждом соединении';
COMMENT ON COLUMN hdw_webhook_endpoints.events IS 'Виды событий hdc_domain_events, на которые подписан адрес. Пусто: адрес вызывает только действие правила';
COMMENT ON COLUMN hdw_webhook_endpoints.is_enabled IS 'Включён ли адрес. На выключенный адрес доставки не ставятся и не отправляются';
COMMENT ON COLUMN hdw_webhook_endpoints.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_webhook_endpoints.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_webhook_endpoints.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_webhook_endpoints.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_webhook_endpoints_stamp
  BEFORE INSERT OR UPDATE ON hdw_webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdw_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_webhook_endpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY hdw_webhook_endpoints_admin_select ON hdw_webhook_endpoints FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_webhook_endpoints_system_select ON hdw_webhook_endpoints FOR SELECT TO hub_app
  USING (app.actor_type() = 'system');
CREATE POLICY hdw_webhook_endpoints_admin_insert ON hdw_webhook_endpoints FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_webhook_endpoints_admin_update ON hdw_webhook_endpoints FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_webhook_endpoints_admin_delete ON hdw_webhook_endpoints FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hdw_webhook_endpoints_admin_select ON hdw_webhook_endpoints IS 'Адреса вебхуков из сотрудников читает только администратор портала';
COMMENT ON POLICY hdw_webhook_endpoints_system_select ON hdw_webhook_endpoints IS 'Адреса читает система: постановка и отправка доставок';
COMMENT ON POLICY hdw_webhook_endpoints_admin_insert ON hdw_webhook_endpoints IS 'Адрес добавляет администратор портала';
COMMENT ON POLICY hdw_webhook_endpoints_admin_update ON hdw_webhook_endpoints IS 'Адрес меняет администратор портала';
COMMENT ON POLICY hdw_webhook_endpoints_admin_delete ON hdw_webhook_endpoints IS 'Адрес удаляет администратор портала';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdw_webhook_endpoints TO hub_app;

-- ---------------------------------------------------------------------------
-- hdw_webhook_secrets: секрет подписи адреса
-- ---------------------------------------------------------------------------
CREATE TABLE hdw_webhook_secrets (
  endpoint_id uuid        NOT NULL,
  sealed      text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_webhook_secrets_pk PRIMARY KEY (endpoint_id),
  -- Удаление адреса убирает и его секрет.
  CONSTRAINT hdw_webhook_secrets_f1 FOREIGN KEY (endpoint_id) REFERENCES hdw_webhook_endpoints (endpoint_id) ON DELETE CASCADE,
  CONSTRAINT hdw_webhook_secrets_c1 CHECK (sealed ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
);

COMMENT ON TABLE hdw_webhook_secrets IS 'Секреты подписи исходящих вебхуков (решение 9 вехи M8). Показываются один раз при создании';
COMMENT ON COLUMN hdw_webhook_secrets.endpoint_id IS 'Адрес вебхука, которому принадлежит секрет';
COMMENT ON COLUMN hdw_webhook_secrets.sealed IS 'Секрет, зашифрованный ключом ENCRYPTION_KEY. Открытый текст база не принимает';
COMMENT ON COLUMN hdw_webhook_secrets.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_webhook_secrets.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_webhook_secrets.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_webhook_secrets.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_webhook_secrets_stamp
  BEFORE INSERT OR UPDATE ON hdw_webhook_secrets
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdw_webhook_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_webhook_secrets FORCE ROW LEVEL SECURITY;

-- Читает секрет только система (подпись при отправке, замена ключа шифрования): ни один сотрудник его не видит.
-- Первый секрет записывает администратор в транзакции создания адреса: вставка права читать строку не требует.
-- Смену секрета пишет система после проверки, что действует администратор: правка от его имени потребовала бы
-- права читать строку (как у hdn_channel_secrets, миграция 0034).
CREATE POLICY hdw_webhook_secrets_system_select ON hdw_webhook_secrets FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hdw_webhook_secrets_admin_insert ON hdw_webhook_secrets FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_webhook_secrets_system_insert ON hdw_webhook_secrets FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdw_webhook_secrets_system_update ON hdw_webhook_secrets FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdw_webhook_secrets_system_select ON hdw_webhook_secrets IS 'Секрет читает только система: на экране он показывается один раз, из памяти запроса';
COMMENT ON POLICY hdw_webhook_secrets_admin_insert ON hdw_webhook_secrets IS 'Первый секрет записывает администратор вместе с адресом, в одной транзакции';
COMMENT ON POLICY hdw_webhook_secrets_system_insert ON hdw_webhook_secrets IS 'Секрет записывает система после проверки, что действует администратор';
COMMENT ON POLICY hdw_webhook_secrets_system_update ON hdw_webhook_secrets IS 'Секрет меняет система: смена секрета администратором и замена ключа шифрования';

GRANT SELECT, INSERT, UPDATE ON hdw_webhook_secrets TO hub_app;

-- ---------------------------------------------------------------------------
-- hdw_webhook_deliveries: очередь и журнал доставок
-- ---------------------------------------------------------------------------
CREATE TABLE hdw_webhook_deliveries (
  org_id          uuid,
  delivery_id     uuid        NOT NULL DEFAULT uuidv7(),
  endpoint_id     uuid        NOT NULL,
  event_id        uuid,
  ticket_id       uuid,
  kind            text        NOT NULL,
  body            jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'queued',
  attempts        smallint    NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_on timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_webhook_deliveries_pk PRIMARY KEY (delivery_id),
  -- Удаление адреса отменяет его доставки и убирает их журнал: след остаётся в журнале аудита.
  CONSTRAINT hdw_webhook_deliveries_f1 FOREIGN KEY (endpoint_id) REFERENCES hdw_webhook_endpoints (endpoint_id) ON DELETE CASCADE,
  -- Привязка обращения к организации (миграция 0037) меняет org_id обращения: доставка идёт следом.
  CONSTRAINT hdw_webhook_deliveries_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  -- Проверочная отправка идёт без обращения, остальные доставки всегда об обращении.
  CONSTRAINT hdw_webhook_deliveries_c1 CHECK ((ticket_id IS NULL) = (org_id IS NULL) AND (ticket_id IS NULL) = (kind = 'test')),
  CONSTRAINT hdw_webhook_deliveries_c2 CHECK (kind IN ('ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed',
                                                       'rated', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff', 'test')),
  CONSTRAINT hdw_webhook_deliveries_c3 CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 8000),
  CONSTRAINT hdw_webhook_deliveries_c4 CHECK (status IN ('queued', 'sent', 'failed')),
  CONSTRAINT hdw_webhook_deliveries_c5 CHECK (attempts >= 0),
  CONSTRAINT hdw_webhook_deliveries_c6 CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{1,40}$')
);

-- Журнал доставок адреса, новые сверху (идентификатор uuidv7 растёт со временем). Он же покрывает внешний ключ адреса.
CREATE INDEX hdw_webhook_deliveries_i1 ON hdw_webhook_deliveries (endpoint_id, delivery_id DESC);
-- Очередь отправки: ждущие доставки по времени следующей попытки.
CREATE INDEX hdw_webhook_deliveries_i2 ON hdw_webhook_deliveries (next_attempt_on) WHERE status = 'queued';
-- Внешний ключ обращения.
CREATE INDEX hdw_webhook_deliveries_i3 ON hdw_webhook_deliveries (ticket_id) WHERE ticket_id IS NOT NULL;
-- Ночная очистка доставок старше 30 суток.
CREATE INDEX hdw_webhook_deliveries_i4 ON hdw_webhook_deliveries (created_on);
-- Одно событие уходит на адрес один раз: и когда адрес подписан на событие, и когда его вызвало правило этого события.
CREATE UNIQUE INDEX hdw_webhook_deliveries_u1 ON hdw_webhook_deliveries (endpoint_id, event_id) WHERE event_id IS NOT NULL;

COMMENT ON TABLE hdw_webhook_deliveries IS 'Доставки исходящих вебхуков: очередь отправки и журнал (решение 10 вехи M8). Хранятся 30 суток';
COMMENT ON COLUMN hdw_webhook_deliveries.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу). Пусто у проверочной отправки';
COMMENT ON COLUMN hdw_webhook_deliveries.delivery_id IS 'Идентификатор доставки. Уходит в заголовке X-Hub-Delivery и не меняется при повторах';
COMMENT ON COLUMN hdw_webhook_deliveries.endpoint_id IS 'Адрес вебхука';
COMMENT ON COLUMN hdw_webhook_deliveries.event_id IS 'Событие hdc_domain_events. Пусто: событие "нет активности" или проверочная отправка. Без внешнего ключа: события хранятся 30 суток';
COMMENT ON COLUMN hdw_webhook_deliveries.ticket_id IS 'Обращение. Пусто у проверочной отправки';
COMMENT ON COLUMN hdw_webhook_deliveries.kind IS 'Вид события (как в hdc_domain_events) или test для проверочной отправки';
COMMENT ON COLUMN hdw_webhook_deliveries.body IS 'Тело запроса: вид события, время, идентификаторы и поля обращения. Без темы, описания и переписки (решение 11)';
COMMENT ON COLUMN hdw_webhook_deliveries.status IS 'queued (ждёт отправки или повтора), sent (приёмник ответил 2xx), failed (повторы исчерпаны или адрес выключен)';
COMMENT ON COLUMN hdw_webhook_deliveries.attempts IS 'Сколько попыток отправки сделано: первая и до пяти повторов';
COMMENT ON COLUMN hdw_webhook_deliveries.last_error IS 'Код последней неудачи: http_503, timeout, unreachable, blocked_address, secret_unreadable, endpoint_disabled. Тела ответа здесь нет';
COMMENT ON COLUMN hdw_webhook_deliveries.next_attempt_on IS 'Когда доставку можно отправлять: время повтора или конец срока захвата отправкой';
COMMENT ON COLUMN hdw_webhook_deliveries.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_webhook_deliveries.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_webhook_deliveries.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_webhook_deliveries.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_webhook_deliveries_stamp
  BEFORE INSERT OR UPDATE ON hdw_webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdw_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY hdw_webhook_deliveries_admin_select ON hdw_webhook_deliveries FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_webhook_deliveries_system_select ON hdw_webhook_deliveries FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hdw_webhook_deliveries_system_insert ON hdw_webhook_deliveries FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'system' AND status = 'queued' AND attempts = 0 AND last_error IS NULL);
CREATE POLICY hdw_webhook_deliveries_system_update ON hdw_webhook_deliveries FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdw_webhook_deliveries_system_delete ON hdw_webhook_deliveries FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdw_webhook_deliveries_admin_select ON hdw_webhook_deliveries IS 'Журнал доставок из сотрудников читает только администратор портала';
COMMENT ON POLICY hdw_webhook_deliveries_system_select ON hdw_webhook_deliveries IS 'Очередь доставок читает фоновая задача';
COMMENT ON POLICY hdw_webhook_deliveries_system_insert ON hdw_webhook_deliveries IS 'Доставку ставит только система: действие правила, подписка на событие, проверочная отправка';
COMMENT ON POLICY hdw_webhook_deliveries_system_update ON hdw_webhook_deliveries IS 'Итог отправки пишет только фоновая задача';
COMMENT ON POLICY hdw_webhook_deliveries_system_delete ON hdw_webhook_deliveries IS 'Доставки старше 30 суток удаляет только ночная очистка';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdw_webhook_deliveries TO hub_app;
