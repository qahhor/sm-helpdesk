-- Веха M5c, задача 8: задача разработки у известной проблемы (ТЗ FR-KP-11, FR-DEV-06; план M5c, решение 25).
--
-- Известная проблема привязывается к задаче разработки строкой той же таблицы hdw_dev_task_links, что обращения и
-- идеи: колонка known_problem_id, в строке ровно одно из обращения (с организацией), идеи или проблемы (обе без
-- организации). У проблемы не больше одной задачи; к одной задаче привязываются несколько обращений, идей и проблем.
-- Номер миграции сдвинут на два от плана (0103): индексы задач 1 и 5 вынесены в отдельные файлы вне транзакции.
--
-- Политики. Защита привязок обращений и идей не меняется: прежние политики вставки и удаления уже требуют
-- ticket_id или idea_id. Привязку проблемы ставят и снимают те, кто ведёт проблемы (app.hdp_can_write: agent_l2,
-- care, admin, система). Чтение не меняется: сотрудники и система, клиент не видит ничего.
--
-- Смена статуса задачи даёт владельцу проблемы уведомление вида problem_dev_task ("обновите статус проблемы").
-- Клиентам ничего не уходит, статус проблемы сам не меняется.

ALTER TABLE hdw_dev_task_links ADD COLUMN known_problem_id uuid;
-- Проблемы не удаляются (у hdp_problems нет права DELETE): ключ без каскада.
ALTER TABLE hdw_dev_task_links ADD CONSTRAINT hdw_dev_task_links_f4 FOREIGN KEY (known_problem_id) REFERENCES hdp_problems (problem_id);
ALTER TABLE hdw_dev_task_links DROP CONSTRAINT hdw_dev_task_links_c1;
ALTER TABLE hdw_dev_task_links ADD CONSTRAINT hdw_dev_task_links_c1 CHECK (
  (ticket_id IS NOT NULL AND org_id IS NOT NULL AND idea_id IS NULL AND known_problem_id IS NULL)
  OR (ticket_id IS NULL AND org_id IS NULL AND idea_id IS NOT NULL AND known_problem_id IS NULL)
  OR (ticket_id IS NULL AND org_id IS NULL AND idea_id IS NULL AND known_problem_id IS NOT NULL)
);
-- У проблемы не больше одной задачи разработки. Индекс покрывает и внешний ключ f4.
CREATE UNIQUE INDEX hdw_dev_task_links_u4 ON hdw_dev_task_links (known_problem_id) WHERE known_problem_id IS NOT NULL;

COMMENT ON TABLE hdw_dev_task_links IS 'Привязки обращений, идей и известных проблем к задачам разработки (FR-DEV-06, FR-IDEA-12, FR-KP-11): в строке ровно одно из обращения, идеи или проблемы';
COMMENT ON COLUMN hdw_dev_task_links.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу). У привязки идеи и проблемы пусто: они общие для клиентов всех организаций';
COMMENT ON COLUMN hdw_dev_task_links.ticket_id IS 'Обращение, переданное в разработку. У привязки идеи и проблемы пусто';
COMMENT ON COLUMN hdw_dev_task_links.idea_id IS 'Идея, переданная в разработку (план M7, решение 18). У привязки обращения и проблемы пусто';
COMMENT ON COLUMN hdw_dev_task_links.known_problem_id IS 'Известная проблема с задачей разработки (план M5c, решение 25). У привязки обращения и идеи пусто';
COMMENT ON CONSTRAINT hdw_dev_task_links_c1 ON hdw_dev_task_links IS 'Ровно одно из обращения (с организацией), идеи или известной проблемы (обе без организации)';
COMMENT ON CONSTRAINT hdw_dev_task_links_f4 ON hdw_dev_task_links IS 'Известная проблема привязки';
COMMENT ON INDEX hdw_dev_task_links_u4 IS 'У известной проблемы не больше одной задачи разработки (план M5c, решение 25)';

CREATE POLICY hdw_dev_task_links_problem_insert ON hdw_dev_task_links FOR INSERT TO hub_app
  WITH CHECK (known_problem_id IS NOT NULL AND ticket_id IS NULL AND idea_id IS NULL AND org_id IS NULL AND app.hdp_can_write());
CREATE POLICY hdw_dev_task_links_problem_delete ON hdw_dev_task_links FOR DELETE TO hub_app
  USING (known_problem_id IS NOT NULL AND app.hdp_can_write());
COMMENT ON POLICY hdw_dev_task_links_problem_insert ON hdw_dev_task_links IS 'Известную проблему к задаче привязывают те, кто ведёт проблемы: agent_l2, care, admin, система';
COMMENT ON POLICY hdw_dev_task_links_problem_delete ON hdw_dev_task_links IS 'Привязку известной проблемы снимают те, кто ведёт проблемы: agent_l2, care, admin, система';

-- Уведомление владельцу проблемы о смене статуса её задачи разработки (решение 25).
ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed', 'csat_low', 'rule_paused',
  'idea_published', 'idea_declined', 'idea_status', 'idea_merged', 'idea_comment_hidden', 'idea_official_reply',
  'idea_cycle', 'idea_moderation_due', 'idea_dev_task_closed',
  'ai_budget', 'problem_update', 'problem_dev_task'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, правило приостановлено или выключено, закрытие задачи разработки, низкая оценка, события идей, предел расходов на AI (ai_budget, администраторам), обновление по известной проблеме (problem_update), смена статуса задачи разработки проблемы (problem_dev_task, владельцу) и другие';
