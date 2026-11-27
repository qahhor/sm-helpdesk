-- Веха M8b, задача 2: представления для AI-сотрудника (ТЗ 7.21 FR-AGT-03, 06, 12, 14.3 "Внутренние агенты", 10.4;
-- план M8b, решения 1, 6, 7, 15, 17).
--
-- Актор agent не читает ни одной базовой таблицы предметной области (миграция 0109, набор изоляции): его данные только
-- эти представления. Каждое отбирает строки само и пусто для любого другого актора и для недействующего токена
-- (app.agent_token_active()): отзыв закрывает данные со следующего запроса. Колонок контактов, имён, названия и ИНН
-- организации, сервера, авторов-пользователей, вложений и имён файлов в представлениях нет; организация отдаётся
-- идентификатором и категорией. Свободный текст (тема, описание, сообщения, тексты сотрудников) представление отдаёт
-- как есть: имена, почту и телефоны в нём заменяет код сервера MCP функцией anonymizeForAgent до ответа агенту.
--
-- Видимость (решения 6, 7, 15): обращения только организаций клиентов с включённой AI-обработкой, без служебной
-- "Неопознанные"; видимость private не мешает (агент внутренний). Из переписки только публичные сообщения, сообщения
-- помощника, заметки агента и поля передачи на другую линию; внутренних заметок сотрудников нет. Токен запуска по
-- обращению видит только своё обращение и его сообщения, остальные представления для него пусты.
--
-- Представления принадлежат hub_owner (security_barrier), как hdp_problems_public: владелец читает базовые таблицы
-- своими политиками owner_select ниже, а представление само отбирает строки для агента.

CREATE FUNCTION app.agent_can_see_org(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT app.agent_token_active() AND EXISTS (
    SELECT 1 FROM public.hdu_organizations o
     WHERE o.org_id = org AND o.kind = 'client' AND o.is_ai_enabled AND o.org_id <> app.service_org_id())
$$;
COMMENT ON FUNCTION app.agent_can_see_org(uuid) IS 'Истина, если токен агента действует и организация клиента с включённой AI-обработкой, не "Неопознанные" (FR-AGT-06, решение 6)';

CREATE POLICY hdu_organizations_owner_select ON hdu_organizations FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdt_tickets_owner_select ON hdt_tickets FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdt_ticket_messages_owner_select ON hdt_ticket_messages FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdt_ticket_line_transfers_owner_select ON hdt_ticket_line_transfers FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdk_articles_owner_select ON hdk_articles FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdk_published_owner_select ON hdk_published FOR SELECT TO hub_owner USING (true);
CREATE POLICY hda_solution_candidates_owner_select ON hda_solution_candidates FOR SELECT TO hub_owner USING (true);
CREATE POLICY hda_candidate_sources_owner_select ON hda_candidate_sources FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdp_problem_signatures_owner_select ON hdp_problem_signatures FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdi_ideas_owner_select ON hdi_ideas FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdi_idea_translations_owner_select ON hdi_idea_translations FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hdu_organizations_owner_select ON hdu_organizations IS 'Владелец читает строки для функции app.agent_can_see_org() и представлений агента, которые сами отбирают строки';
COMMENT ON POLICY hdt_tickets_owner_select ON hdt_tickets IS 'Владелец читает строки для представлений агента hda_agent_*, которые сами отбирают строки';
COMMENT ON POLICY hdt_ticket_messages_owner_select ON hdt_ticket_messages IS 'Владелец читает строки для представления hda_agent_messages, которое само отбирает строки';
COMMENT ON POLICY hdt_ticket_line_transfers_owner_select ON hdt_ticket_line_transfers IS 'Владелец читает строки для представления hda_agent_messages, которое само отбирает строки';
COMMENT ON POLICY hdk_articles_owner_select ON hdk_articles IS 'Владелец читает строки для представления hda_agent_solutions, которое само отбирает строки';
COMMENT ON POLICY hdk_published_owner_select ON hdk_published IS 'Владелец читает строки для представления hda_agent_solutions, которое само отбирает строки';
COMMENT ON POLICY hda_solution_candidates_owner_select ON hda_solution_candidates IS 'Владелец читает строки для представления hda_agent_candidates, которое само отбирает строки';
COMMENT ON POLICY hda_candidate_sources_owner_select ON hda_candidate_sources IS 'Владелец читает строки для представления hda_agent_candidates, которое само отбирает строки';
COMMENT ON POLICY hdp_problem_signatures_owner_select ON hdp_problem_signatures IS 'Владелец читает строки для представления hda_agent_problems, которое само отбирает строки';
COMMENT ON POLICY hdi_ideas_owner_select ON hdi_ideas IS 'Владелец читает строки для представления hda_agent_ideas, которое само отбирает строки';
COMMENT ON POLICY hdi_idea_translations_owner_select ON hdi_idea_translations IS 'Владелец читает строки для представления hda_agent_ideas, которое само отбирает строки';

-- ---------------------------------------------------------------------------
-- hda_agent_tickets: обращения для агента
-- ---------------------------------------------------------------------------
CREATE VIEW hda_agent_tickets WITH (security_barrier = true) AS
SELECT t.ticket_id, t.number, t.org_id, o.category AS org_category, t.type, t.status, t.impact, t.priority, t.queue,
       t.module_id, t.error_signature, t.title, t.description, t.locale, t.source, t.created_on, t.modified_on,
       t.first_response_due_on, t.resolution_due_on, t.first_responded_on, t.resolved_on, t.closed_on,
       t.first_response_breached_on, t.resolution_breached_on, t.sla_paused_on, t.client_waiting_since,
       t.resolution_type, t.solution_id, t.known_problem_id, t.merged_into_id, t.ai_state, t.ai_handoff_reason, t.ai_handoff_on
  FROM hdt_tickets t
  JOIN hdu_organizations o ON o.org_id = t.org_id
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND o.kind = 'client' AND o.is_ai_enabled AND o.org_id <> app.service_org_id()
   AND (app.agent_ticket_id() IS NULL OR t.ticket_id = app.agent_ticket_id());
COMMENT ON VIEW hda_agent_tickets IS 'Обращения для AI-сотрудника (FR-AGT-03, 06): организации с AI-обработкой, без "Неопознанных", организация идентификатором и категорией, без автора, исполнителя, контекста и контактов. Тема и описание обезличивает код до ответа агенту';
COMMENT ON COLUMN hda_agent_tickets.org_category IS 'Категория организации A-D: вместо названия (FR-AGT-06)';
GRANT SELECT ON hda_agent_tickets TO hub_app;

-- ---------------------------------------------------------------------------
-- hda_agent_messages: переписка обращения для агента (решение 7)
-- ---------------------------------------------------------------------------
-- Сообщения: публичные (клиент, сотрудник, помощник, система) и заметки агента; автор условным номером внутри вида
-- (author_no: первый клиент, второй клиент). Сообщение помощника с кодом вида и номером решения или проблемы. Передача
-- на другую линию отдельной строкой: причина кодом, "что проверено", "что требуется", пояснение сотрудника.
CREATE VIEW hda_agent_messages WITH (security_barrier = true) AS
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
   AND (NOT m.is_internal OR m.author_type = 'agent')
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
COMMENT ON VIEW hda_agent_messages IS 'Переписка обращения для AI-сотрудника (решение 7): публичные сообщения, сообщения помощника кодом вида и номером решения, заметки агента и поля передачи на другую линию. Без внутренних заметок сотрудников, вложений и авторов-пользователей';
COMMENT ON COLUMN hda_agent_messages.item_kind IS 'message (сообщение) или line_transfer (передача на другую линию)';
COMMENT ON COLUMN hda_agent_messages.author_no IS 'Условный номер автора внутри вида в этом обращении: первый клиент, второй клиент. Пусто у помощника и системы';
COMMENT ON COLUMN hda_agent_messages.ai_kind IS 'Вид сообщения помощника: answer, clarify, handoff, ack, known_problem, outage';
COMMENT ON COLUMN hda_agent_messages.checked IS 'Передача: что проверено (текст сотрудника)';
COMMENT ON COLUMN hda_agent_messages.needed IS 'Передача: что требуется (текст сотрудника)';
GRANT SELECT ON hda_agent_messages TO hub_app;

-- ---------------------------------------------------------------------------
-- hda_agent_solutions: опубликованные решения обеих аудиторий со статистикой
-- ---------------------------------------------------------------------------
CREATE VIEW hda_agent_solutions WITH (security_barrier = true) AS
SELECT p.article_id, p.article_number AS number, p.locale, p.type, p.audience, p.title, p.body_text, p.module_ids,
       p.is_machine, p.is_outdated, p.published_on, a.shown_count, a.helped_count, a.not_helped_count,
       a.staff_useful_count, a.modified_on AS article_modified_on
  FROM hdk_published p
  JOIN hdk_articles a ON a.article_id = p.article_id
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL;
COMMENT ON VIEW hda_agent_solutions IS 'Опубликованные решения для AI-сотрудника (FR-AGT-03): копия публикации обеих аудиторий и статистика (просмотры, помогло, не помогло, пригодилось сотрудникам). Черновиков нет. Токену запуска пусто';
GRANT SELECT ON hda_agent_solutions TO hub_app;

-- ---------------------------------------------------------------------------
-- hda_agent_candidates: кандидаты в решения
-- ---------------------------------------------------------------------------
-- Источники только номерами обращений. Кандидат, у которого есть источник организации без AI-обработки, агенту не
-- выдаётся: его текст сделан и из её обращения.
CREATE VIEW hda_agent_candidates WITH (security_barrier = true) AS
SELECT c.candidate_id, c.module_id, c.article_id, c.locale, c.title, c.problem, c.steps, c.status, c.source_count,
       c.org_count, c.created_on, c.modified_on,
       ARRAY(SELECT t.number FROM hda_candidate_sources s JOIN hdt_tickets t ON t.ticket_id = s.ticket_id
              WHERE s.candidate_id = c.candidate_id ORDER BY t.number) AS source_numbers
  FROM hda_solution_candidates c
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL
   AND NOT EXISTS (SELECT 1 FROM hda_candidate_sources s WHERE s.candidate_id = c.candidate_id AND NOT app.agent_can_see_org(s.org_id));
COMMENT ON VIEW hda_agent_candidates IS 'Кандидаты в решения для AI-сотрудника (FR-AGT-03): текст черновика AI и номера обращений-источников. Кандидат с источником организации без AI-обработки не выдаётся. Токену запуска пусто';
COMMENT ON COLUMN hda_agent_candidates.source_numbers IS 'Номера обращений-источников по возрастанию';
GRANT SELECT ON hda_agent_candidates TO hub_app;

-- ---------------------------------------------------------------------------
-- hda_agent_problems: известные проблемы без разбивки по организациям
-- ---------------------------------------------------------------------------
CREATE VIEW hda_agent_problems WITH (security_barrier = true) AS
SELECT p.problem_id, p.number, p.status, p.module_id, p.workaround_solution_id, p.internal_title, p.show_to_clients,
       p.first_seen_on, p.last_seen_on, p.fixed_on, p.closed_on, p.ticket_count, p.org_count, p.created_on, p.modified_on,
       ARRAY(SELECT s.signature FROM hdp_problem_signatures s WHERE s.problem_id = p.problem_id AND s.is_active ORDER BY s.signature) AS signatures
  FROM hdp_problems p
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL;
COMMENT ON VIEW hda_agent_problems IS 'Известные проблемы для AI-сотрудника (FR-AGT-03): внутреннее название, статус, счётчики и действующие сигнатуры. Без владельца и разбивки по организациям. Токену запуска пусто';
COMMENT ON COLUMN hda_agent_problems.signatures IS 'Действующие сигнатуры проблемы';
GRANT SELECT ON hda_agent_problems TO hub_app;

-- ---------------------------------------------------------------------------
-- hda_agent_ideas: опубликованные идеи без авторов
-- ---------------------------------------------------------------------------
CREATE VIEW hda_agent_ideas WITH (security_barrier = true) AS
SELECT i.idea_id, i.number, i.status, i.module_id, i.merged_into_id, i.vote_count, i.org_count, i.comment_count,
       i.published_on, i.released_in, i.released_on, i.original_locale, tr.title, tr.body
  FROM hdi_ideas i
  JOIN hdi_idea_translations tr ON tr.idea_id = i.idea_id AND tr.locale = i.original_locale AND tr.status = 'original'
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL
   AND i.status NOT IN ('pending_review', 'declined') AND i.published_on IS NOT NULL
   AND app.agent_can_see_org(i.org_id);
COMMENT ON VIEW hda_agent_ideas IS 'Опубликованные идеи для AI-сотрудника (FR-AGT-03): статус, голоса, текст автора на языке оригинала. Без автора, организации и комментариев; идеи организаций без AI-обработки не выдаются. Токену запуска пусто';
GRANT SELECT ON hda_agent_ideas TO hub_app;
