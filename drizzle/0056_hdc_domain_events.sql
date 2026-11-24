-- События предметной области (FR-AUTO-02; план M8, задача 2, решение 3). Каждое изменение обращения пишет событие
-- в той же транзакции; фоновая задача automation.process разбирает события пачками и ставит отметку разбора.
-- Таблица лежит в ядре (docs/naming.md): модуль обращений пишет события, не зная о модуле правил.
--
-- Действие над обращением идёт под актором клиента или сотрудника, поэтому вставка разрешена им, как в очереди
-- исходящих (миграция 0031): только неразобранное событие по видимому актору обращению. Читают сотрудники и система,
-- отметку разбора ставит и старые события удаляет только система. Клиент событий не видит.

CREATE TABLE hdc_domain_events (
  org_id       uuid        NOT NULL,
  event_id     uuid        NOT NULL DEFAULT uuidv7(),
  ticket_id    uuid        NOT NULL,
  kind         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}',
  is_by_rule   boolean     NOT NULL DEFAULT false,
  attempts     smallint    NOT NULL DEFAULT 0,
  last_error   text,
  processed_on timestamptz,
  created_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_domain_events_pk PRIMARY KEY (event_id),
  -- Привязка обращения к организации (миграция 0037) меняет org_id обращения: событие идёт следом.
  CONSTRAINT hdc_domain_events_f1 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  CONSTRAINT hdc_domain_events_c1 CHECK (kind IN ('ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed',
                                                  'rated', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff')),
  CONSTRAINT hdc_domain_events_c2 CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4000),
  CONSTRAINT hdc_domain_events_c3 CHECK (attempts >= 0)
);

-- Очередь разбора: неразобранные события по порядку записи (идентификатор uuidv7 растёт со временем).
CREATE INDEX hdc_domain_events_i1 ON hdc_domain_events (event_id) WHERE processed_on IS NULL;
-- События обращения по порядку: внешний ключ и проверка "у обращения нет более раннего неразобранного события".
CREATE INDEX hdc_domain_events_i2 ON hdc_domain_events (ticket_id, event_id);
-- Ночная очистка разобранных событий старше 30 суток.
CREATE INDEX hdc_domain_events_i3 ON hdc_domain_events (processed_on) WHERE processed_on IS NOT NULL;

COMMENT ON TABLE hdc_domain_events IS 'События предметной области для правил автоматизации (FR-AUTO-02): пишутся в транзакции изменения обращения';
COMMENT ON COLUMN hdc_domain_events.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdc_domain_events.event_id IS 'Идентификатор события. Растёт со временем: по нему идёт порядок разбора';
COMMENT ON COLUMN hdc_domain_events.ticket_id IS 'Обращение, с которым произошло событие';
COMMENT ON COLUMN hdc_domain_events.kind IS 'Вид: ticket_created, client_replied, staff_replied, status_changed, priority_changed, rated, sla_soon, sla_breached, no_activity, ai_handoff';
COMMENT ON COLUMN hdc_domain_events.payload IS 'Подробности: источник, прежнее и новое значение, оценка, какой срок. Без текста переписки';
COMMENT ON COLUMN hdc_domain_events.is_by_rule IS 'Событие порождено действием правила или макроса: правила на него не срабатывают (FR-AUTO-07)';
COMMENT ON COLUMN hdc_domain_events.attempts IS 'Сколько раз разбор события закончился сбоем';
COMMENT ON COLUMN hdc_domain_events.last_error IS 'Вид последней ошибки разбора, без текста и данных клиента';
COMMENT ON COLUMN hdc_domain_events.processed_on IS 'Когда событие разобрано. Пусто: ждёт разбора';
COMMENT ON COLUMN hdc_domain_events.created_on IS 'Когда событие записано. Заполняет база';

ALTER TABLE hdc_domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_domain_events FORCE ROW LEVEL SECURITY;

-- Вставка в транзакции действия: клиент пишет событие только своей организации, по видимому ему обращению и без
-- отметки "порождено правилом"; из сотрудников пишет тот, кто ведёт обращения. Новое событие всегда ждёт разбора.
-- К hdt_tickets в подзапросе применяется её политика: по невидимому обращению событие записать нельзя.
CREATE POLICY hdc_domain_events_actor_insert ON hdc_domain_events FOR INSERT TO hub_app
  WITH CHECK (
    processed_on IS NULL AND attempts = 0 AND last_error IS NULL
    AND (
      app.staff_can_write_tickets()
      OR (app.actor_type() = 'client' AND org_id = app.org_id() AND NOT is_by_rule)
    )
    AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdc_domain_events.ticket_id AND t.org_id = hdc_domain_events.org_id)
  );
CREATE POLICY hdc_domain_events_internal_select ON hdc_domain_events FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdc_domain_events_system_update ON hdc_domain_events FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdc_domain_events_system_delete ON hdc_domain_events FOR DELETE TO hub_app
  USING (app.actor_type() = 'system');
COMMENT ON POLICY hdc_domain_events_actor_insert ON hdc_domain_events IS 'Событие пишет действие над видимым обращением (клиент только в своей организации) или система';
COMMENT ON POLICY hdc_domain_events_internal_select ON hdc_domain_events IS 'События читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdc_domain_events_system_update ON hdc_domain_events IS 'Отметку разбора ставит только фоновая задача';
COMMENT ON POLICY hdc_domain_events_system_delete ON hdc_domain_events IS 'Разобранные события удаляет только ночная очистка';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdc_domain_events TO hub_app;

-- Событие "срок SLA скоро" (FR-AUTO-02): момент, когда до срока остаётся меньше 20% рабочего времени (FR-SLA-06).
-- Момент считает пересчёт сроков при каждом изменении срока; задача раз в минуту пишет событие и очищает колонку,
-- поэтому событие приходит один раз на срок и снова после того, как срок сдвинулся. Колонки без значения по
-- умолчанию: добавление мгновенное. У обращений, созданных раньше, момент появится при следующем пересчёте срока.
ALTER TABLE hdt_tickets ADD COLUMN first_response_soon_on timestamptz;
ALTER TABLE hdt_tickets ADD COLUMN resolution_soon_on timestamptz;
COMMENT ON COLUMN hdt_tickets.first_response_soon_on IS 'Когда срок первого ответа станет близким (осталось меньше 20%). Пусто: события "срок скоро" не ждём, оно записано или срок снят';
COMMENT ON COLUMN hdt_tickets.resolution_soon_on IS 'Когда срок решения станет близким (осталось меньше 20%). Пусто: события "срок скоро" не ждём, оно записано или срок снят';
