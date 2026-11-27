-- Веха M8c, задача 7: "Разобрать по коду" (ТЗ 7.22 FR-CODE-08, 10, 7.21 FR-AGT-08; план M8c, решения 18-21).
--
-- 1. Вид события предметной области code_analysis_requested: сотрудник второй линии или правило запросили анализ
--    обращения по коду. Разбор событий ставит событие AI-сотруднику (очередь hda_agent_events, вид был
--    зарезервирован в вехе M8b) с токеном запуска на одно обращение.
-- 2. Вид записи AI-сотрудника code_analysis: внутренняя заметка с ответом на запрос анализа. Как и другие записи
--    агента, только внутренняя; клиентские политики сообщений её не пропускают.

ALTER TABLE hdc_domain_events DROP CONSTRAINT hdc_domain_events_c1;
ALTER TABLE hdc_domain_events ADD CONSTRAINT hdc_domain_events_c1 CHECK (kind IN ('ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed',
                                                                                  'rated', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff', 'line_transferred',
                                                                                  'code_analysis_requested')) NOT VALID;
ALTER TABLE hdc_domain_events VALIDATE CONSTRAINT hdc_domain_events_c1;
COMMENT ON CONSTRAINT hdc_domain_events_c1 ON hdc_domain_events IS 'Виды событий предметной области; line_transferred: передача на вторую линию (веха M8b); code_analysis_requested: запрошен анализ по коду (веха M8c)';

ALTER TABLE hdt_ticket_messages DROP CONSTRAINT hdt_ticket_messages_c8;
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c8 CHECK (
  (author_type = 'agent') = (agent_note_kind IS NOT NULL)
  AND (agent_note_kind IS NULL OR (is_internal AND agent_note_kind IN ('note', 'handoff_memo', 'code_analysis')))
) NOT VALID;
ALTER TABLE hdt_ticket_messages VALIDATE CONSTRAINT hdt_ticket_messages_c8;
COMMENT ON CONSTRAINT hdt_ticket_messages_c8 ON hdt_ticket_messages IS 'Запись AI-сотрудника всегда внутренняя и с видом note, handoff_memo или code_analysis (ответ на запрос анализа по коду, веха M8c); у остальных авторов вида нет';
COMMENT ON COLUMN hdt_ticket_messages.agent_note_kind IS 'Вид записи AI-сотрудника: note (внутренняя заметка), handoff_memo (черновик записки второй линии), code_analysis (анализ по коду). Только у author_type = agent';
