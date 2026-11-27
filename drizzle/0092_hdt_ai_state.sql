-- Состояние помощника, передача сотруднику и сроки (ТЗ 7.13, FR-AI-08, 09, 10, 14, 15, FR-SLA-04, 10, 11; план M5b,
-- задача 3, решения 4, 5, 9, 13, 14, 15).
--
-- 1. hdt_tickets.ai_handoff_on: когда помощник передал обращение сотрудникам. От этого момента считается срок первого
--    ответа сотрудника (FR-SLA-10); пусто у обращений без передачи. Причина и состояние уже есть с M2.
-- 2. hdt_ticket_messages.ai_payload: сообщение помощника хранит ссылки, а не текст (решение 9): вид (answer, clarify,
--    handoff), идентификаторы вступления, решения и вопросов, причину и срок передачи. Заголовок и шаги решения
--    рисуются при показе из hdk_published. Колонка есть только у сообщения с типом автора ai, и такое сообщение может
--    записать только система: сотрудник и клиент вид Теза подделать не могут (пункт 9 проверки на AI-инъекции).
-- 3. События истории помощника: ai_state (включение при создании), ai_answer, ai_handoff, ai_feedback (кнопки
--    клиента), triage_accepted (задача 7). Все внутренние: клиенту видны сами сообщения помощника.

ALTER TABLE hdt_tickets ADD COLUMN ai_handoff_on timestamptz;
COMMENT ON COLUMN hdt_tickets.ai_handoff_on IS 'Когда AI-помощник передал обращение сотрудникам: от этого момента считается срок первого ответа сотрудника (FR-SLA-10)';
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c18 CHECK (ai_handoff_on IS NULL OR ai_state = 'handed_off' OR ai_state = 'resolved_by_ai');
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c19 CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
  'customer_request', 'not_helped', 'no_solution', 'restricted_topic', 'p1', 'low_confidence', 'reply_limit',
  'ai_failure', 'ai_disabled', 'ai_limit', 'no_text', 'language'
));
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c20 CHECK (ai_reply_count BETWEEN 0 AND 3);
COMMENT ON CONSTRAINT hdt_tickets_c18 ON hdt_tickets IS 'Момент передачи есть только у переданного (или решённого после передачи) обращения';
COMMENT ON CONSTRAINT hdt_tickets_c19 ON hdt_tickets IS 'Причина передачи из перечня FR-AI-14 и уточнений no_text, language';
COMMENT ON CONSTRAINT hdt_tickets_c20 ON hdt_tickets IS 'Не больше трёх ответов помощника на обращение (FR-AI-09)';

ALTER TABLE hdt_ticket_messages ADD COLUMN ai_payload jsonb;
COMMENT ON COLUMN hdt_ticket_messages.ai_payload IS 'Сообщение помощника: вид (answer, clarify, handoff), introId, articleId и язык, пара решений вопроса, questionIds, причина и срок передачи. Текст решения не хранится: показ берёт его из hdk_published';
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c5 CHECK ((author_type = 'ai') = (ai_payload IS NOT NULL));
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c6 CHECK (ai_payload IS NULL OR (jsonb_typeof(ai_payload) = 'object' AND ai_payload ->> 'kind' IN ('answer', 'clarify', 'handoff', 'ack')));
COMMENT ON CONSTRAINT hdt_ticket_messages_c5 ON hdt_ticket_messages IS 'Ссылки помощника есть ровно у сообщений с типом автора ai';
COMMENT ON CONSTRAINT hdt_ticket_messages_c6 ON hdt_ticket_messages IS 'Вид сообщения помощника: ответ, вопрос, передача, подтверждение без помощника';

CREATE FUNCTION app.hdt_ticket_messages_ai_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.author_type = 'ai' AND (app.actor_type() <> 'system' OR NEW.author_id IS NOT NULL OR NEW.is_internal) THEN
    RAISE EXCEPTION 'Сообщение: сообщение помощника пишет только система, без автора и публично' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdt_ticket_messages_ai_guard() IS 'Триггер: сообщение с типом автора ai пишет только система, без автора-человека и не внутренней заметкой';
CREATE TRIGGER t_hdt_ticket_messages_ai_guard
  BEFORE INSERT ON hdt_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION app.hdt_ticket_messages_ai_guard();

ALTER TABLE hdt_ticket_events DROP CONSTRAINT hdt_ticket_events_c1;
ALTER TABLE hdt_ticket_events ADD CONSTRAINT hdt_ticket_events_c1
  CHECK (kind IN ('created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound', 'tag', 'dev_task', 'csat_review',
                  'ai_state', 'ai_answer', 'ai_handoff', 'ai_feedback', 'triage_accepted'));
COMMENT ON COLUMN hdt_ticket_events.kind IS 'Вид: created, status, visibility, rated, priority, assignee, queue (линия), due, rule (срабатывание правила или запуск макроса), merge, type, module, snooze, bound (привязка письма к организации), tag, dev_task, csat_review, ai_state (помощник включён или нет при создании), ai_answer (ответ или вопрос помощника), ai_handoff (передача сотруднику с причиной), ai_feedback (кнопка клиента под ответом помощника), triage_accepted (принято предложение разбора)';
