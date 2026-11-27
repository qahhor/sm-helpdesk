-- Независимая проверка вехи M8b, находка I2: известные проблемы и идеи для AI-сотрудника (ТЗ 7.21 FR-AGT-03, 06,
-- 14.3 "Внутренние агенты"; план M8b, решения 6, 8, 17; docs/decisions/0123). Применённая миграция 0110 не правится:
-- представления заменяются с теми же колонками, новые колонки только в конце.
--
-- hda_agent_problems: проблема, у которой есть привязанные обращения и все они из организаций без AI-обработки (или
-- "Неопознанных"), агенту не выдаётся: её название сотрудник писал по этим обращениям. Проблема без привязанных
-- обращений (новая, черновик) выдаётся как прежде. Организации привязанных обращений для обезличивания названия читает
-- система кодом сервера MCP, представление их не отдаёт.
--
-- hda_agent_ideas: в конце колонка org_id, организация автора идеи. Её читает только код сервера MCP, чтобы обезличить
-- текст идеи словами этой организации; агенту она не отдаётся. Организации без AI-обработки закрыты, как в 0110.

CREATE OR REPLACE VIEW hda_agent_problems WITH (security_barrier = true) AS
SELECT p.problem_id, p.number, p.status, p.module_id, p.workaround_solution_id, p.internal_title, p.show_to_clients,
       p.first_seen_on, p.last_seen_on, p.fixed_on, p.closed_on, p.ticket_count, p.org_count, p.created_on, p.modified_on,
       ARRAY(SELECT s.signature FROM hdp_problem_signatures s WHERE s.problem_id = p.problem_id AND s.is_active ORDER BY s.signature) AS signatures
  FROM hdp_problems p
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL
   AND (NOT EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.known_problem_id = p.problem_id)
        OR EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.known_problem_id = p.problem_id AND app.agent_can_see_org(t.org_id)));
COMMENT ON VIEW hda_agent_problems IS 'Известные проблемы для AI-сотрудника (FR-AGT-03): внутреннее название, статус, счётчики и действующие сигнатуры. Без владельца и разбивки по организациям. Проблема, все привязанные обращения которой из организаций без AI-обработки, не выдаётся. Токену запуска пусто';

CREATE OR REPLACE VIEW hda_agent_ideas WITH (security_barrier = true) AS
SELECT i.idea_id, i.number, i.status, i.module_id, i.merged_into_id, i.vote_count, i.org_count, i.comment_count,
       i.published_on, i.released_in, i.released_on, i.original_locale, tr.title, tr.body, i.org_id
  FROM hdi_ideas i
  JOIN hdi_idea_translations tr ON tr.idea_id = i.idea_id AND tr.locale = i.original_locale AND tr.status = 'original'
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL
   AND i.status NOT IN ('pending_review', 'declined') AND i.published_on IS NOT NULL
   AND app.agent_can_see_org(i.org_id);
COMMENT ON VIEW hda_agent_ideas IS 'Опубликованные идеи для AI-сотрудника (FR-AGT-03): статус, голоса, текст автора на языке оригинала. Без автора и комментариев; идеи организаций без AI-обработки не выдаются. Токену запуска пусто';
COMMENT ON COLUMN hda_agent_ideas.org_id IS 'Организация автора идеи: по ней код сервера MCP обезличивает текст, агенту не отдаётся';
