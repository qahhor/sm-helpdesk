-- Исправления по независимой проверке вехи M8 в модуле автоматизации (находки S1, S2, I4).

-- S1. Защита от зацикливания больше не выключает правило после одиннадцати срабатываний на одном обращении: правило
-- приостанавливается на этом обращении, администраторы получают уведомление "правило приостановлено" (rule_paused).
-- Выключение (rule_disabled) остаётся для случая, когда предел достигнут на обращениях трёх организаций.
ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed', 'csat_low', 'rule_paused'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, правило приостановлено или выключено защитой от зацикливания, закрытие задачи разработки, низкая оценка клиента и другие';

-- S2. На обращении не больше 20 тегов. Названия тегов идут в тело исходящего вебхука (не больше 8000 байт,
-- ограничение hdw_webhook_deliveries_c3): сотня длинных тегов делала постановку доставки невозможной. Предел
-- проверяет приложение (понятный отказ сотруднику, отказ действия правила), триггер держит его для любой вставки.
-- Обращения, на которых тегов уже больше, не меняются: новые теги на них не ставятся, пока лишние не сняты.
CREATE FUNCTION app.hdt_ticket_tags_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF (SELECT count(*) FROM hdt_ticket_tags tt WHERE tt.ticket_id = NEW.ticket_id AND tt.tag_id <> NEW.tag_id) >= 20 THEN
    RAISE EXCEPTION 'Теги: на обращении не больше 20 тегов' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_ticket_tags_guard() IS 'Триггер: на одном обращении не больше 20 тегов';

CREATE TRIGGER t_hdt_ticket_tags_guard
  BEFORE INSERT ON hdt_ticket_tags
  FOR EACH ROW EXECUTE FUNCTION app.hdt_ticket_tags_guard();

-- I4. Опрос таск-менеджера брал задачи по давности сверки, а после сбоя момент сверки не менялся: пять задач,
-- которые не читаются постоянно, каждый запуск стояли первыми и останавливали опрос остальных. Момент последней
-- неудачной попытки отодвигает такую задачу в конец очереди опроса; момент сверки по-прежнему значит "статус прочитан".
ALTER TABLE hdw_dev_tasks ADD COLUMN sync_attempted_on timestamptz;
COMMENT ON COLUMN hdw_dev_tasks.sync_attempted_on IS 'Когда опрос таск-менеджера последний раз не смог прочитать задачу. Такая задача опрашивается после тех, что давно не пробовали. Пусто: сбоев не было';
