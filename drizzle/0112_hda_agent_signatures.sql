-- Веха M8b, задача 5: сигнатуры ошибок для инструмента unsolved_signatures (ТЗ 7.21 FR-AGT-03, 06; план M8b, решение
-- 17). Актор agent не читает базовых таблиц знаний (миграция 0109): сигнатуры отдаёт это представление. Счётчики
-- организаций и появлений общие для всех организаций (это числа, данных клиентов в них нет), а образец текста ошибки
-- отдаётся, только если все организации сигнатуры видны агенту: образец сделан из текста одной из них. Организаций
-- сигнатуры представление не отдаёт. Токену запуска по обращению пусто.

CREATE POLICY hdk_error_signatures_owner_select ON hdk_error_signatures FOR SELECT TO hub_owner USING (true);
CREATE POLICY hdk_signature_orgs_owner_select ON hdk_signature_orgs FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hdk_error_signatures_owner_select ON hdk_error_signatures IS 'Владелец читает строки для представления hda_agent_signatures, которое само отбирает строки';
COMMENT ON POLICY hdk_signature_orgs_owner_select ON hdk_signature_orgs IS 'Владелец читает строки для представления hda_agent_signatures, которое само отбирает строки';

CREATE VIEW hda_agent_signatures WITH (security_barrier = true) AS
SELECT s.signature, s.module_id, s.sample_code,
       CASE WHEN NOT EXISTS (SELECT 1 FROM hdk_signature_orgs o WHERE o.signature_id = s.signature_id AND NOT app.agent_can_see_org(o.org_id))
            THEN s.sample_message END AS sample_message,
       s.org_count, s.occurrences, s.last_seen_on, (s.article_id IS NOT NULL) AS has_solution, s.created_on
  FROM hdk_error_signatures s
 WHERE app.actor_type() = 'agent'
   AND app.agent_token_active()
   AND app.agent_ticket_id() IS NULL;
COMMENT ON VIEW hda_agent_signatures IS 'Сигнатуры ошибок для AI-сотрудника (FR-AGT-03): счётчики, код и образец текста ошибки, есть ли решение. Без организаций; образец только если все организации сигнатуры видны агенту. Токену запуска пусто';
COMMENT ON COLUMN hda_agent_signatures.sample_message IS 'Образец текста ошибки, уже очищенный stripClientData; пусто, если у сигнатуры есть организация, невидимая агенту';
COMMENT ON COLUMN hda_agent_signatures.has_solution IS 'К сигнатуре привязано решение';
GRANT SELECT ON hda_agent_signatures TO hub_app;
