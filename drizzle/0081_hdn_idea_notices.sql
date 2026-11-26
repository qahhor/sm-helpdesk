-- Уведомления по идеям (ТЗ FR-IDEA-11, FR-NT-01, 03, 04; план M7, задача 8, решения 14, 15). Колокольчик получает
-- каждое событие идеи, письмо не чаще одного в сутки по одной идее на пользователя, кроме "Выпущена". Письма об идеях
-- отключаются всегда (настройка ideas, по умолчанию включена). Уведомления по идеям ставят только сотрудники и система
-- (действия модератора, ответ Smartup, задания): политика вставки hdn_notifications_insert уже требует этого для
-- уведомления без обращения, поэтому политики не меняются. Номер и статус идеи лежат в payload, текста клиентов там нет.
-- Номер миграции: план отдаёт 0080 привязке идеи к задаче разработки (задача 9), эта миграция идёт под 0081.

-- Переход из колокольчика к идее и очистка при удалении идеи (по образцу ticket_id).
ALTER TABLE hdn_notifications ADD COLUMN idea_id uuid;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_f2 FOREIGN KEY (idea_id) REFERENCES hdi_ideas (idea_id) ON DELETE CASCADE;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c4 CHECK (idea_id IS NULL OR ticket_id IS NULL);
CREATE INDEX hdn_notifications_i3 ON hdn_notifications (idea_id) WHERE idea_id IS NOT NULL;
COMMENT ON COLUMN hdn_notifications.idea_id IS 'Идея уведомления (план M7, задача 8): переход из колокольчика; удаляется вместе с идеей';
COMMENT ON CONSTRAINT hdn_notifications_c4 ON hdn_notifications IS 'Уведомление относится к обращению или к идее, не к обоим';

ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed', 'csat_low', 'rule_paused',
  'idea_published', 'idea_declined', 'idea_status', 'idea_merged', 'idea_comment_hidden', 'idea_official_reply',
  'idea_cycle', 'idea_moderation_due', 'idea_dev_task_closed'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, правило приостановлено или выключено, закрытие задачи разработки, низкая оценка, события идей (публикация, отклонение, смена статуса, объединение, скрытие комментария, ответ Smartup, отбор месяца, идеи ждут модерации, задача разработки идеи закрыта) и другие';

ALTER TABLE hdn_notification_prefs DROP CONSTRAINT hdn_notification_prefs_c1;
ALTER TABLE hdn_notification_prefs ADD CONSTRAINT hdn_notification_prefs_c1
  CHECK (kind IN ('own_tickets', 'watched_tickets', 'staff_mention', 'staff_breach', 'ideas'));
COMMENT ON COLUMN hdn_notification_prefs.kind IS 'Вид писем: свои обращения, обращения коллег, упоминания и нарушения сроков у сотрудника, письма об идеях (ideas, у клиентов и сотрудников)';

-- Правило "одно письмо в сутки по идее" ищет последнее письмо получателя по идее.
CREATE INDEX hdn_outbox_i5 ON hdn_outbox (recipient_user_id, (payload ->> 'ideaId'), created_on) WHERE template IN ('idea_status', 'staff_idea_moderation');
COMMENT ON INDEX hdn_outbox_i5 IS 'Письма об идеях по получателю и идее: не больше одного письма в сутки (план M7, решение 14)';
