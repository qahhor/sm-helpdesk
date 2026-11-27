-- Веха M8c, задача 3: инструменты сервера MCP для знаний из кода (ТЗ 7.22 FR-CODE-01, 08, 7.21 FR-AGT-04, 12; план
-- M8c, решения 3, 19, 20).
--
-- 1. Каталог инструментов токена: code_catalog_upsert (отчёт о сканировании), search_code_catalog (сохранённые
--    выводы), submit_code_analysis (ответ на "Разобрать по коду"). Перечень токена до 20 инструментов.
-- 2. Токен запуска по обращению: к get_ticket и add_internal_note добавлены search_code_catalog и
--    submit_code_analysis (запуск по событию "запрошен анализ по коду"). Заметка по-прежнему одна (note_limit).
-- Инструментов, которые показывают что-либо клиенту или меняют состояние обращения, в каталоге по-прежнему нет.

ALTER TABLE hda_agent_tokens DROP CONSTRAINT hda_agent_tokens_c3;
ALTER TABLE hda_agent_tokens ADD CONSTRAINT hda_agent_tokens_c3 CHECK (
  cardinality(tools) BETWEEN 1 AND 20
  AND tools <@ ARRAY['search_tickets', 'get_ticket', 'similar_tickets', 'sla_risk_tickets', 'unsolved_signatures', 'signature_spikes',
                     'search_solutions', 'get_solution', 'list_candidates', 'list_known_problems', 'list_ideas', 'assistant_metrics',
                     'search_code_catalog',
                     'add_internal_note', 'draft_solution', 'draft_known_problem', 'create_report',
                     'code_catalog_upsert', 'submit_code_analysis']::text[]) NOT VALID;
ALTER TABLE hda_agent_tokens VALIDATE CONSTRAINT hda_agent_tokens_c3;
COMMENT ON CONSTRAINT hda_agent_tokens_c3 ON hda_agent_tokens IS 'Перечень инструментов не пустой и только из каталога: инструментов ответа клиенту, смены статуса и других из FR-AGT-05 в каталоге нет (веха M8c: знания из кода)';

ALTER TABLE hda_agent_tokens DROP CONSTRAINT hda_agent_tokens_c7;
ALTER TABLE hda_agent_tokens ADD CONSTRAINT hda_agent_tokens_c7 CHECK (
  parent_token_id IS NULL
  OR (note_limit IS NOT NULL AND NOT is_event_parent AND tools <@ ARRAY['get_ticket', 'add_internal_note', 'search_code_catalog', 'submit_code_analysis']::text[])) NOT VALID;
ALTER TABLE hda_agent_tokens VALIDATE CONSTRAINT hda_agent_tokens_c7;
COMMENT ON CONSTRAINT hda_agent_tokens_c7 ON hda_agent_tokens IS 'Токен запуска: предел заметок, не "для событий", перечень только чтение обращения, заметка и для анализа по коду каталог и ответ анализа (FR-AGT-12)';
