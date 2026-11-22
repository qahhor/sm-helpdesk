-- Уведомления в портале и настройки писем (раздел 10.5 "notifications", "notification_prefs"; FR-NT-03, FR-NT-04;
-- план M4, задача 4, решение 5). Уведомление читает и отмечает прочитанным только адресат. Ставит его действие
-- над видимым обращением в своей транзакции. Настройки писем ведёт владелец; читают их ещё сотрудники и система:
-- действие сотрудника решает, уходит ли письмо наблюдателю (решение 6).

CREATE TABLE hdn_notifications (
  org_id          uuid,
  notification_id uuid        NOT NULL DEFAULT uuidv7(),
  user_id         uuid        NOT NULL,
  ticket_id       uuid,
  kind            text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  read_on         timestamptz,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_notifications_pk PRIMARY KEY (notification_id),
  CONSTRAINT hdn_notifications_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
    'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
    'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder'
  )),
  CONSTRAINT hdn_notifications_c2 CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4000),
  CONSTRAINT hdn_notifications_c3 CHECK ((ticket_id IS NULL) = (org_id IS NULL))
);

CREATE INDEX hdn_notifications_i1 ON hdn_notifications (user_id, created_on DESC);
CREATE INDEX hdn_notifications_i2 ON hdn_notifications (user_id) WHERE read_on IS NULL;

COMMENT ON TABLE hdn_notifications IS 'Уведомление в портале: колокольчик со счётчиком непрочитанных (FR-NT-03)';
COMMENT ON COLUMN hdn_notifications.org_id IS 'Организация обращения. Пусто: уведомление не об обращении';
COMMENT ON COLUMN hdn_notifications.notification_id IS 'Идентификатор уведомления';
COMMENT ON COLUMN hdn_notifications.user_id IS 'Адресат: клиент или сотрудник';
COMMENT ON COLUMN hdn_notifications.ticket_id IS 'Обращение, о котором уведомление';
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока и другие';
COMMENT ON COLUMN hdn_notifications.payload IS 'Данные для текста: номер, тема, новый статус. Без текста переписки';
COMMENT ON COLUMN hdn_notifications.read_on IS 'Когда адресат открыл уведомление. Пусто: не прочитано';
COMMENT ON COLUMN hdn_notifications.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_notifications.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_notifications.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_notifications.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdn_notifications_stamp
  BEFORE INSERT OR UPDATE ON hdn_notifications
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdn_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY hdn_notifications_owner_select ON hdn_notifications FOR SELECT TO hub_app
  USING ((app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid()) OR app.actor_type() = 'system');
-- Действие ставит уведомление по видимому ему обращению; уведомление не об обращении ставят сотрудник и система.
CREATE POLICY hdn_notifications_insert ON hdn_notifications FOR INSERT TO hub_app
  WITH CHECK (
    read_on IS NULL
    AND (
      (ticket_id IS NULL AND app.is_internal())
      OR (ticket_id IS NOT NULL AND app.actor_type() IN ('client', 'staff', 'system')
          AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdn_notifications.ticket_id AND t.org_id = hdn_notifications.org_id))
    )
  );
CREATE POLICY hdn_notifications_owner_update ON hdn_notifications FOR UPDATE TO hub_app
  USING (app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid());
CREATE POLICY hdn_notifications_system_delete ON hdn_notifications FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdn_notifications_owner_select ON hdn_notifications IS 'Уведомление видит только адресат; система для ночной очистки';
COMMENT ON POLICY hdn_notifications_insert ON hdn_notifications IS 'Уведомление ставит действие над видимым обращением или система';
COMMENT ON POLICY hdn_notifications_owner_update ON hdn_notifications IS 'Отметку прочтения ставит только адресат';
COMMENT ON POLICY hdn_notifications_system_delete ON hdn_notifications IS 'Прочитанные старше 90 дней удаляет ночная очистка';

GRANT SELECT, INSERT, DELETE ON hdn_notifications TO hub_app;
GRANT UPDATE (read_on) ON hdn_notifications TO hub_app;

CREATE TABLE hdn_notification_prefs (
  user_id          uuid        NOT NULL,
  kind             text        NOT NULL,
  email_enabled    boolean     NOT NULL DEFAULT true,
  telegram_enabled boolean     NOT NULL DEFAULT true,
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_notification_prefs_pk PRIMARY KEY (user_id, kind),
  -- Письма о своих обращениях не отключаются (FR-NT-04): такой строки быть не может.
  CONSTRAINT hdn_notification_prefs_c1 CHECK (kind IN ('watched_tickets', 'staff_mention', 'staff_breach'))
);

COMMENT ON TABLE hdn_notification_prefs IS 'Какие письма получать (FR-NT-04). Нет строки: письмо уходит';
COMMENT ON COLUMN hdn_notification_prefs.user_id IS 'Владелец настройки';
COMMENT ON COLUMN hdn_notification_prefs.kind IS 'Вид писем: об обращениях коллег, об упоминаниях, о нарушениях сроков';
COMMENT ON COLUMN hdn_notification_prefs.email_enabled IS 'Получать ли такие письма';
COMMENT ON COLUMN hdn_notification_prefs.telegram_enabled IS 'Получать ли такие сообщения в Telegram (веха M4b)';
COMMENT ON COLUMN hdn_notification_prefs.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_notification_prefs.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_notification_prefs.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_notification_prefs.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdn_notification_prefs_stamp
  BEFORE INSERT OR UPDATE ON hdn_notification_prefs
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdn_notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_notification_prefs FORCE ROW LEVEL SECURITY;

CREATE POLICY hdn_notification_prefs_select ON hdn_notification_prefs FOR SELECT TO hub_app
  USING ((app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid()) OR app.is_internal());
CREATE POLICY hdn_notification_prefs_owner_insert ON hdn_notification_prefs FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid());
CREATE POLICY hdn_notification_prefs_owner_update ON hdn_notification_prefs FOR UPDATE TO hub_app
  USING (app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() IN ('client', 'staff') AND user_id = app.user_uuid());
COMMENT ON POLICY hdn_notification_prefs_select ON hdn_notification_prefs IS 'Настройку видят владелец, сотрудники и система: от неё зависит письмо наблюдателю';
COMMENT ON POLICY hdn_notification_prefs_owner_insert ON hdn_notification_prefs IS 'Настройку создаёт только владелец';
COMMENT ON POLICY hdn_notification_prefs_owner_update ON hdn_notification_prefs IS 'Настройку меняет только владелец';

GRANT SELECT, INSERT, UPDATE ON hdn_notification_prefs TO hub_app;
