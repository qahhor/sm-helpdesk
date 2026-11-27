-- Веха M5c, задача 7: Тез отвечает известной проблемой и сбоем (ТЗ FR-KP-12, FR-ANN-03, FR-AI-02, 11.12; план M5c,
-- решения 22, 23).
--
-- 1. Причины передачи known_problem (обращение привязано к активной показанной проблеме, ответ её публичным текстом)
--    и outage (действует объявление "сбой" аудитории обращения) в hdt_tickets_c19 и hda_runs_c8.
-- 2. Виды сообщения помощника known_problem (номер проблемы и язык) и outage (идентификатор объявления и язык) в
--    hdt_ticket_messages_c6. Текст в сообщении не хранится: показ берёт публичное название, статус и обходной путь из
--    hdp_problems_public, заголовок и текст объявления из hdp_announcement_translations на языке клиента.

ALTER TABLE hdt_tickets DROP CONSTRAINT hdt_tickets_c19;
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c19 CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
  'customer_request', 'not_helped', 'no_solution', 'restricted_topic', 'p1', 'low_confidence', 'reply_limit',
  'ai_failure', 'ai_disabled', 'ai_limit', 'no_text', 'language', 'known_problem', 'outage'
));
COMMENT ON CONSTRAINT hdt_tickets_c19 ON hdt_tickets IS 'Причина передачи из перечня FR-AI-14, уточнений no_text, language и причин M5c known_problem, outage';

ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c8;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c8 CHECK (handoff_reason IS NULL OR handoff_reason IN (
  'customer_request', 'not_helped', 'no_solution', 'restricted_topic', 'p1', 'low_confidence', 'reply_limit',
  'ai_failure', 'ai_disabled', 'ai_limit', 'no_text', 'language', 'known_problem', 'outage'
));
COMMENT ON CONSTRAINT hda_runs_c8 ON hda_runs IS 'Причина передачи из того же перечня, что hdt_tickets_c19';

ALTER TABLE hdt_ticket_messages DROP CONSTRAINT hdt_ticket_messages_c6;
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c6 CHECK (ai_payload IS NULL OR (jsonb_typeof(ai_payload) = 'object' AND ai_payload ->> 'kind' IN ('answer', 'clarify', 'handoff', 'ack', 'known_problem', 'outage')));
COMMENT ON CONSTRAINT hdt_ticket_messages_c6 ON hdt_ticket_messages IS 'Вид сообщения помощника: ответ, вопрос, передача, подтверждение без помощника, известная проблема, сбой';
COMMENT ON COLUMN hdt_ticket_messages.ai_payload IS 'Сообщение помощника: вид (answer, clarify, handoff, ack, known_problem, outage), introId, articleId и язык, пара решений вопроса, questionIds, причина и срок передачи, номер известной проблемы, идентификатор объявления. Текст решения, проблемы и объявления не хранится: показ берёт его из hdk_published, hdp_problems_public и hdp_announcement_translations';
