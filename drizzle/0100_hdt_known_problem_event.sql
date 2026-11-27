-- Веха M5c, задачи 2 и 3: событие истории "известная проблема" (привязка и отвязка обращения, FR-KP-04; план M5c,
-- решение 9). Всегда внутреннее: ограничение hdt_ticket_events_c3 видимым клиенту его не примет. Клиент видит
-- привязку только блоком "Известная проблема" по признаку показа (решение 15).
ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound', 'tag', 'dev_task', 'csat_review',
                  'ai_state', 'ai_answer', 'ai_handoff', 'ai_feedback', 'triage_accepted', 'known_problem'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule (срабатывание правила или запуск макроса), merge, type, module, snooze, bound (привязка письма к организации), tag, dev_task, csat_review, ai_state (помощник включён или нет при создании), ai_answer (ответ или вопрос помощника), ai_handoff (передача сотруднику с причиной), ai_feedback (кнопка клиента под ответом помощника), triage_accepted (принято предложение разбора), known_problem (привязка к известной проблеме и отвязка)';
