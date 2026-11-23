-- Уведомления клиентам в Telegram (план M4b, задачи 1 и 3; FR-NT-04, FR-NT-13, FR-NT-14; решения 3 и 6 вехи M4b).
-- Настройка "О своих обращениях" появляется отдельной строкой: почту о своих обращениях можно выключить, если
-- действует Telegram. Хотя бы один внешний канал остаётся: строка с выключенными обоими каналами запрещена.
-- Привязка Telegram даёт уведомление в портале вида telegram_linked.

ALTER TABLE hdn_notification_prefs DROP CONSTRAINT hdn_notification_prefs_c1;
ALTER TABLE hdn_notification_prefs
  ADD CONSTRAINT hdn_notification_prefs_c1 CHECK (kind IN ('own_tickets', 'watched_tickets', 'staff_mention', 'staff_breach'));
ALTER TABLE hdn_notification_prefs
  ADD CONSTRAINT hdn_notification_prefs_c2 CHECK (kind <> 'own_tickets' OR email_enabled OR telegram_enabled);

COMMENT ON TABLE hdn_notification_prefs IS 'Какие письма и сообщения Telegram получать (FR-NT-04, FR-NT-14). Нет строки: канал включён';
COMMENT ON COLUMN hdn_notification_prefs.kind IS 'Вид: о своих обращениях, об обращениях коллег, об упоминаниях, о нарушениях сроков';
COMMENT ON COLUMN hdn_notification_prefs.email_enabled IS 'Получать ли письма этого вида. О своих обращениях выключается только при действующем Telegram';
COMMENT ON COLUMN hdn_notification_prefs.telegram_enabled IS 'Получать ли сообщения этого вида в Telegram, если он привязан';

ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked'
));
