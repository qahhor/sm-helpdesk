-- Приём писем (раздел 7.20, 10.1, 10.5; план M4, задача 8, решения 10-16).
-- Служебная организация "Неопознанные" для писем с неизвестных адресов, гости и их слияние с настоящей учётной
-- записью, домены почты организаций, входящие письма, цепочки писем и отклонённые как спам адреса.

-- --- Служебная организация (раздел 10.1, решение 12) ---

ALTER TABLE hdu_organizations ADD COLUMN kind text NOT NULL DEFAULT 'client';
ALTER TABLE hdu_organizations ALTER COLUMN server_id DROP NOT NULL;
ALTER TABLE hdu_organizations ALTER COLUMN external_company_id DROP NOT NULL;
ALTER TABLE hdu_organizations ADD CONSTRAINT hdu_organizations_c4 CHECK (kind IN ('client', 'service'));
ALTER TABLE hdu_organizations ADD CONSTRAINT hdu_organizations_c5
  CHECK ((kind = 'client') = (server_id IS NOT NULL AND external_company_id IS NOT NULL));
CREATE UNIQUE INDEX hdu_organizations_u2 ON hdu_organizations (kind) WHERE kind = 'service';
COMMENT ON COLUMN hdu_organizations.kind IS 'Вид: client (организация клиента из Smartup) или service (служебная "Неопознанные", одна)';
COMMENT ON COLUMN hdu_organizations.server_id IS 'Сервер Smartup организации. У служебной пусто';
COMMENT ON COLUMN hdu_organizations.external_company_id IS 'Идентификатор компании на сервере Smartup. У служебной пусто';

-- Идентификатор служебной организации закреплён: его знает код (SERVICE_ORG_ID в src/modules/hdu/pref.ts) и триггеры.
-- Вторую служебную организацию не даёт создать уникальный индекс, другой идентификатор не даёт проверка c6.
-- Строку создаёт код при первом письме с неизвестного адреса (ensureServiceOrg): миграция работает от владельца
-- таблиц, а он подчиняется политикам строк, как и роли приложения.
CREATE FUNCTION app.service_org_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-7000-8000-000000000001'::uuid $$;
COMMENT ON FUNCTION app.service_org_id() IS 'Идентификатор служебной организации "Неопознанные"';
ALTER TABLE hdu_organizations ADD CONSTRAINT hdu_organizations_c6 CHECK (kind <> 'service' OR org_id = app.service_org_id());

-- Обращения служебной организации всегда личные (раздел 19.13): гости не видят обращений друг друга.
ALTER TABLE hdt_tickets ADD COLUMN sender_unconfirmed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN hdt_tickets.sender_unconfirmed IS 'Письмо пришло с домена организации от адреса, который не подтверждён пользователем (FR-EM-06)';

CREATE FUNCTION app.hdt_tickets_service_private() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.visibility <> 'private' AND NEW.org_id = app.service_org_id() THEN
    RAISE EXCEPTION 'Обращение: в служебной организации обращение только личное' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_service_private() IS 'Триггер: обращение служебной организации всегда личное';
CREATE TRIGGER t_hdt_tickets_service_private
  BEFORE INSERT OR UPDATE OF visibility, org_id ON hdt_tickets
  FOR EACH ROW EXECUTE FUNCTION app.hdt_tickets_service_private();

-- Защита записи сотрудника (миграция 0030) пересоздаётся: организацию обращения сотрудник меняет только при привязке
-- письма из "Неопознанных" к организации клиента (FR-EM-04), и только роли, которые ведут обращения.
CREATE OR REPLACE FUNCTION app.hdt_tickets_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  development CONSTANT boolean := app.staff_role() IN ('agent_l2', 'care', 'admin');
  binding CONSTANT boolean := NEW.org_id IS DISTINCT FROM OLD.org_id
    AND OLD.org_id = app.service_org_id() AND NEW.org_id <> app.service_org_id()
    AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin');
BEGIN
  IF app.actor_type() <> 'staff' THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id IS DISTINCT FROM OLD.org_id AND NOT binding) OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.created_on IS DISTINCT FROM OLD.created_on OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.csat_score IS DISTINCT FROM OLD.csat_score OR NEW.csat_reason IS DISTINCT FROM OLD.csat_reason
     OR NEW.csat_comment IS DISTINCT FROM OLD.csat_comment OR NEW.last_client_message_on IS DISTINCT FROM OLD.last_client_message_on
     OR (NEW.client_waiting_since IS DISTINCT FROM OLD.client_waiting_since AND NEW.client_waiting_since IS NOT NULL) THEN
    RAISE EXCEPTION 'Обращение: сотруднику менять эти поля нельзя' USING ERRCODE = '42501';
  END IF;
  IF OLD.merged_into_id IS NOT NULL AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id) THEN
    RAISE EXCEPTION 'Обращение: объединённое обращение закрыто навсегда, статус не меняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'in_development' AND OLD.status IS DISTINCT FROM 'in_development' AND NOT development THEN
    RAISE EXCEPTION 'Обращение: "В разработке" ставят вторая линия, care и admin' USING ERRCODE = '42501';
  END IF;
  IF OLD.queue IN ('l2', 'care') AND NEW.queue IS DISTINCT FROM OLD.queue AND NOT development THEN
    RAISE EXCEPTION 'Обращение: со второй линии на первую линию возвращают вторая линия, care и admin' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'closed' AND OLD.status NOT IN ('resolved', 'closed') AND NEW.merged_into_id IS NULL THEN
    RAISE EXCEPTION 'Обращение: сотрудник закрывает только решённое обращение' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_tickets_staff_guard() IS
  'Триггер: сотрудник не меняет организацию (кроме привязки из "Неопознанных"), автора, номер, канал, оценку и колонки клиента, статус объединённого; "В разработке" и возврат со второй линии только agent_l2, care, admin; закрывает только решённое';

-- --- Гости и их переход к настоящей учётной записи (решения 12, 13) ---

ALTER TABLE hdu_invitations ADD COLUMN guest_user_id uuid;
COMMENT ON COLUMN hdu_invitations.guest_user_id IS 'Гость из письма с неизвестного адреса: при принятии приглашения его обращения переходят принявшему';

CREATE TABLE hdu_guest_merges (
  merge_id      uuid        NOT NULL DEFAULT uuidv7(),
  guest_user_id uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  applied_on    timestamptz,
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_guest_merges_pk PRIMARY KEY (merge_id),
  CONSTRAINT hdu_guest_merges_c1 CHECK (guest_user_id <> user_id)
);
CREATE UNIQUE INDEX hdu_guest_merges_u1 ON hdu_guest_merges (guest_user_id, user_id);
CREATE INDEX hdu_guest_merges_i1 ON hdu_guest_merges (created_on) WHERE applied_on IS NULL;
COMMENT ON TABLE hdu_guest_merges IS 'Гость стал пользователем: его обращения, сообщения и подписки переходят пользователю (решение 13 вехи M4)';
COMMENT ON COLUMN hdu_guest_merges.merge_id IS 'Идентификатор слияния';
COMMENT ON COLUMN hdu_guest_merges.guest_user_id IS 'Гость из письма с неизвестного адреса';
COMMENT ON COLUMN hdu_guest_merges.user_id IS 'Пользователь, который доказал владение адресом: принял приглашение или подтвердил адрес';
COMMENT ON COLUMN hdu_guest_merges.applied_on IS 'Когда обращения гостя перешли пользователю. Пусто: ждёт задачи раз в минуту';
COMMENT ON COLUMN hdu_guest_merges.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_guest_merges.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_guest_merges.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_guest_merges.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
CREATE TRIGGER t_hdu_guest_merges_stamp BEFORE INSERT OR UPDATE ON hdu_guest_merges FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
ALTER TABLE hdu_guest_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_guest_merges FORCE ROW LEVEL SECURITY;
-- Пишет принятие приглашения и подтверждение адреса (hub_auth, система), применяет задача раз в минуту (hub_app, система).
CREATE POLICY hdu_guest_merges_auth_insert ON hdu_guest_merges FOR INSERT TO hub_auth WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdu_guest_merges_auth_select ON hdu_guest_merges FOR SELECT TO hub_auth USING (app.actor_type() = 'system');
CREATE POLICY hdu_guest_merges_app_select ON hdu_guest_merges FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hdu_guest_merges_app_update ON hdu_guest_merges FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdu_guest_merges_auth_insert ON hdu_guest_merges IS 'Слияние записывает система при принятии приглашения или подтверждении адреса';
COMMENT ON POLICY hdu_guest_merges_auth_select ON hdu_guest_merges IS 'Повтор слияния система находит по паре гость, пользователь';
COMMENT ON POLICY hdu_guest_merges_app_select ON hdu_guest_merges IS 'Ждущие слияния читает задача раз в минуту';
COMMENT ON POLICY hdu_guest_merges_app_update ON hdu_guest_merges IS 'Отметку применения ставит задача раз в минуту';
GRANT SELECT, INSERT ON hdu_guest_merges TO hub_auth;
GRANT SELECT ON hdu_guest_merges TO hub_app;
GRANT UPDATE (applied_on) ON hdu_guest_merges TO hub_app;

-- --- Домены почты организаций (FR-EM-06) ---

CREATE TABLE hdu_org_email_domains (
  org_id      uuid        NOT NULL,
  domain      text        NOT NULL,
  added_by    uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdu_org_email_domains_pk PRIMARY KEY (org_id, domain),
  CONSTRAINT hdu_org_email_domains_u1 UNIQUE (domain),
  CONSTRAINT hdu_org_email_domains_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdu_org_email_domains_c1 CHECK (domain ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' AND char_length(domain) <= 253)
);
COMMENT ON TABLE hdu_org_email_domains IS 'Домен почты организации: письмо с него с DMARC относится к организации (FR-EM-06)';
COMMENT ON COLUMN hdu_org_email_domains.org_id IS 'Организация клиента';
COMMENT ON COLUMN hdu_org_email_domains.domain IS 'Домен строчными буквами. Один домен принадлежит одной организации';
COMMENT ON COLUMN hdu_org_email_domains.added_by IS 'Сотрудник, который добавил домен';
COMMENT ON COLUMN hdu_org_email_domains.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdu_org_email_domains.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdu_org_email_domains.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdu_org_email_domains.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
CREATE TRIGGER t_hdu_org_email_domains_stamp BEFORE INSERT OR UPDATE ON hdu_org_email_domains FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
ALTER TABLE hdu_org_email_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdu_org_email_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY hdu_org_email_domains_select ON hdu_org_email_domains FOR SELECT TO hub_auth
  USING (app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin', 'product')));
CREATE POLICY hdu_org_email_domains_care_insert ON hdu_org_email_domains FOR INSERT TO hub_auth
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin') AND added_by = app.user_uuid());
CREATE POLICY hdu_org_email_domains_care_delete ON hdu_org_email_domains FOR DELETE TO hub_auth
  USING (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin'));
COMMENT ON POLICY hdu_org_email_domains_select ON hdu_org_email_domains IS 'Домены видят сотрудники и система (подсказка при привязке, приём писем)';
COMMENT ON POLICY hdu_org_email_domains_care_insert ON hdu_org_email_domains IS 'Домен добавляют Customer Care и администратор';
COMMENT ON POLICY hdu_org_email_domains_care_delete ON hdu_org_email_domains IS 'Домен удаляют Customer Care и администратор';
GRANT SELECT, INSERT, DELETE ON hdu_org_email_domains TO hub_auth;

-- --- Входящие письма (10.5 "email_inbound", решение 10) ---

CREATE TABLE hdn_email_inbound (
  inbound_id     uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id      uuid,
  provider_id    text        NOT NULL,
  from_address   text        NOT NULL,
  from_name      text,
  to_addresses   text[]      NOT NULL DEFAULT '{}',
  cc_addresses   text[]      NOT NULL DEFAULT '{}',
  subject        text        NOT NULL DEFAULT '',
  message_id     text,
  headers        jsonb,
  auth_result    jsonb,
  classification text,
  raw_ref        text        NOT NULL,
  received_on    timestamptz NOT NULL,
  processed_on   timestamptz,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_email_inbound_pk PRIMARY KEY (inbound_id),
  CONSTRAINT hdn_email_inbound_u1 UNIQUE (provider_id),
  CONSTRAINT hdn_email_inbound_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdn_email_inbound_c1 CHECK (classification IS NULL OR classification IN ('new', 'reply', 'auto', 'bounce', 'spam', 'review', 'rate_limited', 'ignored')),
  CONSTRAINT hdn_email_inbound_c2 CHECK (char_length(from_address) <= 320 AND char_length(subject) <= 2000),
  CONSTRAINT hdn_email_inbound_c3 CHECK (provider_id ~ '^[A-Za-z0-9_-]{1,100}$')
);
CREATE INDEX hdn_email_inbound_i1 ON hdn_email_inbound (from_address, received_on);
COMMENT ON TABLE hdn_email_inbound IS 'Входящее письмо: сведения из вебхука и итог разбора. Текст письма хранит сообщение обращения';
COMMENT ON COLUMN hdn_email_inbound.inbound_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdn_email_inbound.ticket_id IS 'Обращение, к которому отнесено письмо';
COMMENT ON COLUMN hdn_email_inbound.provider_id IS 'Идентификатор письма у почтового сервиса: повтор вебхука строку не дублирует';
COMMENT ON COLUMN hdn_email_inbound.from_address IS 'Адрес отправителя строчными буквами';
COMMENT ON COLUMN hdn_email_inbound.from_name IS 'Имя отправителя из поля From';
COMMENT ON COLUMN hdn_email_inbound.to_addresses IS 'Получатели из поля To';
COMMENT ON COLUMN hdn_email_inbound.cc_addresses IS 'Получатели из поля Cc';
COMMENT ON COLUMN hdn_email_inbound.subject IS 'Тема письма';
COMMENT ON COLUMN hdn_email_inbound.message_id IS 'Заголовок Message-ID письма';
COMMENT ON COLUMN hdn_email_inbound.headers IS 'Заголовки письма списком пар: записывает разбор';
COMMENT ON COLUMN hdn_email_inbound.auth_result IS 'Итог проверки отправителя: DMARC с совпадением домена (решение 11)';
COMMENT ON COLUMN hdn_email_inbound.classification IS 'new, reply, auto, bounce, spam, review, rate_limited, ignored. Пусто: ещё не разобрано';
COMMENT ON COLUMN hdn_email_inbound.raw_ref IS 'Где лежит исходное письмо: идентификатор у почтового сервиса. Портал исходник не хранит';
COMMENT ON COLUMN hdn_email_inbound.received_on IS 'Когда письмо принял почтовый сервис';
COMMENT ON COLUMN hdn_email_inbound.processed_on IS 'Когда письмо разобрано';
COMMENT ON COLUMN hdn_email_inbound.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_email_inbound.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_email_inbound.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_email_inbound.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
CREATE TRIGGER t_hdn_email_inbound_stamp BEFORE INSERT OR UPDATE ON hdn_email_inbound FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
ALTER TABLE hdn_email_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_email_inbound FORCE ROW LEVEL SECURITY;
CREATE POLICY hdn_email_inbound_internal_select ON hdn_email_inbound FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdn_email_inbound_system_insert ON hdn_email_inbound FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdn_email_inbound_system_update ON hdn_email_inbound FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdn_email_inbound_internal_select ON hdn_email_inbound IS 'Входящие письма читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdn_email_inbound_system_insert ON hdn_email_inbound IS 'Письмо записывает вебхук от актора system';
COMMENT ON POLICY hdn_email_inbound_system_update ON hdn_email_inbound IS 'Итог разбора пишет фоновая задача';
GRANT SELECT, INSERT, UPDATE ON hdn_email_inbound TO hub_app;

-- --- Цепочки писем (10.5 "email_threads", решение 20) ---

CREATE TABLE hdn_email_threads (
  thread_id   uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id   uuid        NOT NULL,
  message_id  text        NOT NULL,
  in_reply_to text,
  direction   text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_email_threads_pk PRIMARY KEY (thread_id),
  CONSTRAINT hdn_email_threads_u1 UNIQUE (message_id),
  CONSTRAINT hdn_email_threads_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdn_email_threads_c1 CHECK (direction IN ('in', 'out')),
  CONSTRAINT hdn_email_threads_c2 CHECK (char_length(message_id) BETWEEN 3 AND 998)
);
CREATE INDEX hdn_email_threads_i1 ON hdn_email_threads (ticket_id);
COMMENT ON TABLE hdn_email_threads IS 'Message-ID писем обращения: ответ со ссылкой на них относится к этому обращению (FR-EM-02)';
COMMENT ON COLUMN hdn_email_threads.thread_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdn_email_threads.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdn_email_threads.message_id IS 'Message-ID письма с угловыми скобками';
COMMENT ON COLUMN hdn_email_threads.in_reply_to IS 'In-Reply-To входящего письма';
COMMENT ON COLUMN hdn_email_threads.direction IS 'in: письмо пришло, out: наше письмо';
COMMENT ON COLUMN hdn_email_threads.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_email_threads.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_email_threads.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_email_threads.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
CREATE TRIGGER t_hdn_email_threads_stamp BEFORE INSERT OR UPDATE ON hdn_email_threads FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
ALTER TABLE hdn_email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_email_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY hdn_email_threads_internal_select ON hdn_email_threads FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdn_email_threads_system_insert ON hdn_email_threads FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdn_email_threads_internal_select ON hdn_email_threads IS 'Цепочки читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdn_email_threads_system_insert ON hdn_email_threads IS 'Цепочку пополняют отправка и разбор писем от актора system';
GRANT SELECT, INSERT ON hdn_email_threads TO hub_app;

-- --- Отклонённые как спам (решение 14, FR-ADM-14) ---

CREATE TABLE hdn_blocked_senders (
  address     text        NOT NULL,
  blocked_by  uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_blocked_senders_pk PRIMARY KEY (address),
  CONSTRAINT hdn_blocked_senders_c1 CHECK (address = lower(address) AND char_length(address) BETWEEN 3 AND 320 AND position('@' IN address) > 1)
);
COMMENT ON TABLE hdn_blocked_senders IS 'Адреса, отмеченные как спам: письма с них сохраняются без обращения и без ответа';
COMMENT ON COLUMN hdn_blocked_senders.address IS 'Адрес отправителя строчными буквами';
COMMENT ON COLUMN hdn_blocked_senders.blocked_by IS 'Сотрудник, который отметил спам';
COMMENT ON COLUMN hdn_blocked_senders.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_blocked_senders.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_blocked_senders.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_blocked_senders.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
CREATE TRIGGER t_hdn_blocked_senders_stamp BEFORE INSERT OR UPDATE ON hdn_blocked_senders FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
ALTER TABLE hdn_blocked_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_blocked_senders FORCE ROW LEVEL SECURITY;
CREATE POLICY hdn_blocked_senders_internal_select ON hdn_blocked_senders FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdn_blocked_senders_staff_insert ON hdn_blocked_senders FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin') AND blocked_by = app.user_uuid());
CREATE POLICY hdn_blocked_senders_admin_delete ON hdn_blocked_senders FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hdn_blocked_senders_internal_select ON hdn_blocked_senders IS 'Список видят сотрудники и система';
COMMENT ON POLICY hdn_blocked_senders_staff_insert ON hdn_blocked_senders IS 'Спам отмечают роли, которые ведут обращения';
COMMENT ON POLICY hdn_blocked_senders_admin_delete ON hdn_blocked_senders IS 'Из списка убирает администратор (FR-ADM-14)';
GRANT SELECT, INSERT, DELETE ON hdn_blocked_senders TO hub_app;
