-- Индексы очередей сотрудника и задачи раз в минуту (аудит 23.11.2026, находки P2 и P3; план W1, задачи 2 и 3).
-- На 200 тысячах обращений счётчики очередей и шаги фоновой задачи просматривали всю таблицу обращений.
-- Частичные индексы малы: в них только отложенные, решённые, поставленные на паузу и неразобранные строки.

-- Очередь "Все" по последнему изменению.
CREATE INDEX hdt_tickets_i14 ON hdt_tickets (modified_on DESC, ticket_id DESC);
-- Возврат отложенных, когда их время пришло.
CREATE INDEX hdt_tickets_i15 ON hdt_tickets (snoozed_until) WHERE snoozed_until IS NOT NULL;
-- Автозакрытие решённых без ответа клиента.
CREATE INDEX hdt_tickets_i16 ON hdt_tickets (resolved_on) WHERE status = 'resolved';
-- Сверка паузы срока со статусом: статус с паузой, а отметки паузы нет. Таких строк почти не бывает, индекс крошечный.
CREATE INDEX hdt_tickets_i17 ON hdt_tickets (created_on)
  WHERE sla_paused_on IS NULL AND status IN ('waiting_customer', 'resolved', 'closed');
-- Входящие письма, разбор которых не закончился.
CREATE INDEX hdn_email_inbound_i3 ON hdn_email_inbound (created_on) WHERE processed_on IS NULL;
