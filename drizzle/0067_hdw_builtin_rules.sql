-- Предустановленные правила вместо встроенных уведомлений (FR-AUTO-12; план M8, задача 10, решения 1 и 2).
-- Три уведомления портала становятся правилами, которые администратор может выключить и изменить, но не удалить
-- (pcode задан: политика hdw_rules_admin_delete и триггер t_hdw_rules_guard). Сами уведомления остались прежними:
-- те же получатели, шаблоны и однократность. Изменился запуск: их вызывает действие правила, когда фоновая задача
-- automation.process разбирает событие обращения.
--
--   p1_oncall        дежурным о P1 без первого ответа: при создании обращения и при поднятии приоритета
--                    (второе событие правилу добавляет приложение: src/modules/hdw/builtin.ts)
--   sla_breach_lead  руководителям линии обращения о нарушении срока
--   csat_low_manager сотрудникам Customer Care об оценке 1 или 2 (раньше такого уведомления не было)
--
-- Правила включены поставкой: enabled_on пуст. Они встают первыми по порядку: правило администратора с флагом
-- "остановить обработку следующих" не должно молча отменить сообщение дежурным. Порядок можно поменять.
-- Значения совпадают с src/modules/hdw/builtin.ts: оттуда их берёт "Вернуть исходное", тест сверяет оба места.

--
-- Таблица под FORCE ROW LEVEL SECURITY, политик для владельца базы нет: правило с pcode не вставит никто, кроме
-- миграции. На время вставки принуждение снимается и возвращается в этой же транзакции: ALTER TABLE держит
-- исключительную блокировку таблицы до фиксации, другие подключения таблицу без принуждения не видят.
ALTER TABLE hdw_rules NO FORCE ROW LEVEL SECURITY;

UPDATE hdw_rules SET order_no = order_no + 3;

INSERT INTO hdw_rules (name, event, conditions, actions, order_no, is_stop, is_enabled, pcode) VALUES
  ('P1: сообщение дежурным', 'ticket_created',
   '{"match": "all", "items": [{"field": "priority", "op": "is", "values": ["p1"]}]}',
   '[{"action": "notify_oncall_p1"}]', 1, false, true, 'p1_oncall'),
  ('Нарушение срока: руководителю линии', 'sla_breached',
   '{"match": "all", "items": []}',
   '[{"action": "notify_sla_breach"}]', 2, false, true, 'sla_breach_lead'),
  ('Оценка 1-2: руководителю', 'rated',
   '{"match": "all", "items": [{"field": "rating", "op": "lte", "value": 2}]}',
   '[{"action": "notify_csat_low"}]', 3, false, true, 'csat_low_manager');

ALTER TABLE hdw_rules FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN hdw_rules.pcode IS 'Код предустановленного правила (p1_oncall, sla_breach_lead, csat_low_manager). Такое правило нельзя удалить и нельзя перевесить на другое событие';

-- Уведомление в портале: клиент поставил оценку 1 или 2 (правило csat_low_manager).
ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed', 'csat_low'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, закрытие задачи разработки, низкая оценка клиента и другие';

COMMENT ON COLUMN hdt_tickets.oncall_notified_on IS 'Когда дежурным ушло сообщение о P1 без первого ответа. Сообщение одно на обращение. Ставит действие предустановленного правила p1_oncall';
