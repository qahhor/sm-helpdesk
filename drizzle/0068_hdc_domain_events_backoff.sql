-- Исправления по независимой проверке вехи M8 (находки C1 и m1).
--
-- 1. Пауза перед повтором разбора события. Раньше пять попыток могли уйти за секунды (задачу automation.process будит
--    каждое изменение обращения), и событие снималось с очереди из-за короткого сбоя. Теперь после сбоя событие ждёт:
--    10 секунд, 1, 5 и 15 минут. Пока оно ждёт, следующие события того же обращения тоже ждут: порядок сохраняется.
-- 2. Клиент пишет только события своих действий: создание обращения, ответ, смена статуса (подтверждение, повторное
--    открытие), оценка. Остальные виды (нарушение срока, смена приоритета и другие) пишут сотрудник и система.

ALTER TABLE hdc_domain_events ADD COLUMN next_attempt_on timestamptz;
COMMENT ON COLUMN hdc_domain_events.next_attempt_on IS 'Не раньше какого момента разбирать событие снова после сбоя. Пусто: сбоев не было, событие берётся сразу';

-- Политика только ужесточается: новое событие всегда без срока повтора, клиенту доступны четыре вида событий.
ALTER POLICY hdc_domain_events_actor_insert ON hdc_domain_events
  WITH CHECK (
    processed_on IS NULL AND attempts = 0 AND last_error IS NULL AND next_attempt_on IS NULL
    AND (
      app.staff_can_write_tickets()
      OR (app.actor_type() = 'client' AND org_id = app.org_id() AND NOT is_by_rule
          AND kind IN ('ticket_created', 'client_replied', 'status_changed', 'rated'))
    )
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdc_domain_events.ticket_id AND t.org_id = hdc_domain_events.org_id)
  );
COMMENT ON POLICY hdc_domain_events_actor_insert ON hdc_domain_events IS 'Событие пишет действие над видимым обращением (клиент только в своей организации и только события своих действий) или система';
