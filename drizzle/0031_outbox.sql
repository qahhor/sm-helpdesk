-- Очередь исходящих (раздел 10.5 "outbox", FR-NT-09; план M4, задача 3, решения 1, 2 и 3).
-- Письмо или сообщение ставится строкой в транзакции действия и уходит после фиксации фоновой задачей
-- outbox.dispatch. Адрес и язык получателя берутся в момент отправки. Клиент строки не видит (10.5: "К: нет").

CREATE TABLE hdn_outbox (
  outbox_id         uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id         uuid,
  message_id        uuid,
  channel           text        NOT NULL,
  recipient_kind    text        NOT NULL,
  recipient_user_id uuid,
  recipient         text,
  template          text        NOT NULL,
  locale            text,
  settings_path     text,
  payload           jsonb       NOT NULL,
  status            text        NOT NULL DEFAULT 'queued',
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_on   timestamptz NOT NULL DEFAULT now(),
  sent_on           timestamptz,
  external_id       text,
  last_error        text,
  created_by        text,
  created_on        timestamptz NOT NULL DEFAULT now(),
  modified_by       text,
  modified_on       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_outbox_pk PRIMARY KEY (outbox_id),
  CONSTRAINT hdn_outbox_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdn_outbox_f2 FOREIGN KEY (message_id) REFERENCES hdt_ticket_messages (message_id),
  CONSTRAINT hdn_outbox_c1 CHECK (channel IN ('email', 'telegram')),
  CONSTRAINT hdn_outbox_c2 CHECK (
    (recipient_kind = 'user' AND recipient_user_id IS NOT NULL) OR (recipient_kind = 'oncall' AND recipient_user_id IS NULL)
  ),
  CONSTRAINT hdn_outbox_c3 CHECK (template ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT hdn_outbox_c4 CHECK (locale IS NULL OR locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdn_outbox_c5 CHECK (settings_path IS NULL OR settings_path ~ '^/[a-z0-9/-]{1,60}$'),
  CONSTRAINT hdn_outbox_c6 CHECK (jsonb_typeof(payload) = 'object' AND payload ->> 'template' = template),
  CONSTRAINT hdn_outbox_c7 CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  CONSTRAINT hdn_outbox_c8 CHECK (attempts BETWEEN 0 AND 20),
  CONSTRAINT hdn_outbox_c9 CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  CONSTRAINT hdn_outbox_c10 CHECK (recipient IS NULL OR char_length(recipient) <= 320)
);

CREATE INDEX hdn_outbox_i1 ON hdn_outbox (next_attempt_on) WHERE status = 'queued';
CREATE UNIQUE INDEX hdn_outbox_u1 ON hdn_outbox (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX hdn_outbox_i2 ON hdn_outbox (ticket_id) WHERE ticket_id IS NOT NULL;

COMMENT ON TABLE hdn_outbox IS 'Очередь исходящих писем и сообщений: строка ставится в транзакции действия, отправляет фоновая задача';
COMMENT ON COLUMN hdn_outbox.outbox_id IS 'Идентификатор строки. Он же ключ идемпотентности почтового сервиса';
COMMENT ON COLUMN hdn_outbox.ticket_id IS 'Обращение, о котором письмо. Пусто: письмо не об обращении';
COMMENT ON COLUMN hdn_outbox.message_id IS 'Сообщение обращения, о котором письмо (ответ сотрудника)';
COMMENT ON COLUMN hdn_outbox.channel IS 'Канал: email или telegram (служебный чат дежурных, решение 8)';
COMMENT ON COLUMN hdn_outbox.recipient_kind IS 'Получатель: user (пользователь портала) или oncall (дежурные из настроек)';
COMMENT ON COLUMN hdn_outbox.recipient_user_id IS 'Пользователь-получатель. Адрес берётся в момент отправки';
COMMENT ON COLUMN hdn_outbox.recipient IS 'Адрес, на который ушло письмо. Записывается при отправке';
COMMENT ON COLUMN hdn_outbox.template IS 'Шаблон письма (src/modules/hdn/mail/render.ts)';
COMMENT ON COLUMN hdn_outbox.locale IS 'Язык обращения: письмо уходит на языке получателя, иначе на этом';
COMMENT ON COLUMN hdn_outbox.settings_path IS 'Путь настроек уведомлений для отключаемого письма. Пусто: письмо не отключается';
COMMENT ON COLUMN hdn_outbox.payload IS 'Данные шаблона без адреса и языка получателя';
COMMENT ON COLUMN hdn_outbox.status IS 'queued, sent, delivered, failed или skipped (у получателя нет адреса)';
COMMENT ON COLUMN hdn_outbox.attempts IS 'Сколько раз строку брали в отправку';
COMMENT ON COLUMN hdn_outbox.next_attempt_on IS 'Когда строку можно брать в отправку: повтор после сбоя или конец захвата';
COMMENT ON COLUMN hdn_outbox.sent_on IS 'Когда сервис принял письмо';
COMMENT ON COLUMN hdn_outbox.external_id IS 'Идентификатор письма у почтового сервиса: по нему приходят события доставки';
COMMENT ON COLUMN hdn_outbox.last_error IS 'Последняя ошибка: код ответа сервиса или событие недоставки, без адреса и текста письма';
COMMENT ON COLUMN hdn_outbox.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_outbox.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_outbox.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_outbox.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdn_outbox_stamp
  BEFORE INSERT OR UPDATE ON hdn_outbox
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdn_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_outbox FORCE ROW LEVEL SECURITY;

-- Вставка в транзакции действия: клиент и сотрудник ставят письмо только по видимому им обращению,
-- письмо не об обращении ставят сотрудник и система. Новая строка всегда ждёт отправки.
CREATE POLICY hdn_outbox_insert ON hdn_outbox FOR INSERT TO hub_app
  WITH CHECK (
    status = 'queued' AND attempts = 0 AND external_id IS NULL AND recipient IS NULL
    AND (
      (ticket_id IS NULL AND app.is_internal())
      OR (ticket_id IS NOT NULL AND app.actor_type() IN ('client', 'staff', 'system')
          AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdn_outbox.ticket_id))
    )
  );
CREATE POLICY hdn_outbox_internal_select ON hdn_outbox FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdn_outbox_system_update ON hdn_outbox FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdn_outbox_insert ON hdn_outbox IS 'Строку ставит действие над видимым обращением или система';
COMMENT ON POLICY hdn_outbox_internal_select ON hdn_outbox IS 'Очередь читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdn_outbox_system_update ON hdn_outbox IS 'Отправку и статусы ведёт только фоновая задача';

GRANT SELECT, INSERT, UPDATE ON hdn_outbox TO hub_app;
