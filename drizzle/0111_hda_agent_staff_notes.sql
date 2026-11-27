-- Веха M8b: AI-сотрудник читает внутренние заметки сотрудников (решение владельца 27.11.2026, docs/decisions/0114;
-- решение 7 плана M8b). Применённая миграция 0110 не правится: представление hda_agent_messages заменяется целиком с теми
-- же колонками. Внутренняя заметка сотрудника отдаётся как свободный текст, его обезличивает код сервера MCP функцией
-- anonymizeForAgent и кладёт только в поле untrusted_* (в заметках бывает текст клиента). Остальные внутренние строки
-- (черновики помощника, служебные) по-прежнему не выдаются. Вложений и имён файлов в представлении нет. Организации без
-- AI-обработки, "Неопознанные" и чужие обращения токена запуска закрыты теми же условиями, что в 0110.

CREATE OR REPLACE VIEW hda_agent_messages WITH (security_barrier = true) AS
SELECT 'message'::text AS item_kind, m.message_id AS item_id, m.ticket_id, m.org_id, m.created_on,
       m.author_type,
       CASE WHEN m.author_id IS NULL THEN NULL
            ELSE dense_rank() OVER (PARTITION BY m.ticket_id, m.author_type ORDER BY m.author_id)::integer END AS author_no,
       m.body, m.is_internal, m.source, m.is_auto, m.is_thanks,
       m.ai_payload ->> 'kind' AS ai_kind,
       CASE WHEN m.ai_payload ->> 'articleNumber' ~ '^[0-9]{1,15}$' THEN (m.ai_payload ->> 'articleNumber')::bigint END AS ai_solution_number,
       CASE WHEN m.ai_payload ->> 'problemNumber' ~ '^[0-9]{1,15}$' THEN (m.ai_payload ->> 'problemNumber')::bigint END AS ai_problem_number,
       m.ai_payload ->> 'reason' AS ai_handoff_reason,
       NULL::text AS from_line, NULL::text AS to_line, NULL::text AS reason_code, NULL::text AS checked, NULL::text AS needed, NULL::text AS explanation
  FROM hdt_ticket_messages m
  JOIN hdt_tickets t ON t.ticket_id = m.ticket_id
 WHERE app.actor_type() = 'agent'
   AND app.agent_can_see_org(t.org_id)
   AND (app.agent_ticket_id() IS NULL OR m.ticket_id = app.agent_ticket_id())
   AND (NOT m.is_internal OR m.author_type IN ('agent', 'staff'))
UNION ALL
SELECT 'line_transfer'::text, l.transfer_id, l.ticket_id, t.org_id, l.created_on,
       'staff'::text, NULL::integer, NULL::text, true, NULL::text, false, false,
       NULL::text, NULL::bigint, NULL::bigint, NULL::text,
       l.from_line, l.to_line, l.reason_code, l.checked, l.needed, l.explanation
  FROM hdt_ticket_line_transfers l
  JOIN hdt_tickets t ON t.ticket_id = l.ticket_id
 WHERE app.actor_type() = 'agent'
   AND app.agent_can_see_org(t.org_id)
   AND (app.agent_ticket_id() IS NULL OR l.ticket_id = app.agent_ticket_id());
COMMENT ON VIEW hda_agent_messages IS 'Переписка обращения для AI-сотрудника (решение 7, решение 0114): публичные сообщения, сообщения помощника кодом вида и номером решения, заметки агента, внутренние заметки сотрудников и поля передачи на другую линию. Без вложений и авторов-пользователей';
