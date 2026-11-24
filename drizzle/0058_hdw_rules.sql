-- Правила автоматизации (ТЗ 7.17, FR-AUTO-01..09, 11; план M8, задача 3, решения 3-6). Правило это данные: событие,
-- условия и действия, проверенные схемой приложения. Срабатывания пишет фоновая задача automation.process под
-- системным актором. Клиент не видит ни правил, ни срабатываний.
--
-- Правила читают сотрудники и система; создаёт, меняет и удаляет администратор портала. Предустановленное правило
-- (pcode задан) удалить нельзя. Система меняет у правила только включение и причину выключения: защита от
-- зацикливания выключает правило сама (FR-AUTO-07).

CREATE TABLE hdw_rules (
  rule_id         uuid        NOT NULL DEFAULT uuidv7(),
  name            text        NOT NULL,
  event           text        NOT NULL,
  hours           integer,
  conditions      jsonb       NOT NULL DEFAULT '{"match": "all", "items": []}',
  actions         jsonb       NOT NULL,
  order_no        integer     NOT NULL,
  is_stop         boolean     NOT NULL DEFAULT false,
  is_enabled      boolean     NOT NULL DEFAULT false,
  disabled_reason text,
  pcode           text,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_rules_pk PRIMARY KEY (rule_id),
  CONSTRAINT hdw_rules_u1 UNIQUE (pcode),
  CONSTRAINT hdw_rules_c1 CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  CONSTRAINT hdw_rules_c2 CHECK (event IN ('ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed',
                                           'rated', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff')),
  -- Срок молчания задаётся только у события "нет активности": от часа до года.
  CONSTRAINT hdw_rules_c3 CHECK ((event = 'no_activity') = (hours IS NOT NULL) AND (hours IS NULL OR hours BETWEEN 1 AND 8760)),
  CONSTRAINT hdw_rules_c4 CHECK (jsonb_typeof(conditions) = 'object' AND jsonb_typeof(actions) = 'array'
                                 AND octet_length(conditions::text) <= 20000 AND octet_length(actions::text) <= 40000),
  -- Причина выключения есть только у выключенного правила.
  CONSTRAINT hdw_rules_c5 CHECK (disabled_reason IS NULL OR (disabled_reason IN ('loop') AND NOT is_enabled)),
  CONSTRAINT hdw_rules_c6 CHECK (pcode IS NULL OR pcode ~ '^[a-z][a-z0-9_]{1,39}$')
);

-- Правила события по порядку: их читает разбор каждого события.
CREATE INDEX hdw_rules_i1 ON hdw_rules (event, order_no) WHERE is_enabled;

COMMENT ON TABLE hdw_rules IS 'Правила автоматизации "событие, условия, действия" (ТЗ 7.17)';
COMMENT ON COLUMN hdw_rules.rule_id IS 'Идентификатор правила';
COMMENT ON COLUMN hdw_rules.name IS 'Название правила: его видят сотрудники в истории обращения';
COMMENT ON COLUMN hdw_rules.event IS 'Событие, на которое срабатывает правило (виды hdc_domain_events и no_activity)';
COMMENT ON COLUMN hdw_rules.hours IS 'Через сколько часов молчания срабатывает правило. Только у события no_activity';
COMMENT ON COLUMN hdw_rules.conditions IS 'Условия: {"match": "all" или "any", "items": [...]}. Проверяет схема приложения';
COMMENT ON COLUMN hdw_rules.actions IS 'Действия по порядку: закрытый перечень, проверяет схема приложения';
COMMENT ON COLUMN hdw_rules.order_no IS 'Порядок применения правил одного события: меньшее раньше';
COMMENT ON COLUMN hdw_rules.is_stop IS 'После этого правила следующие правила события не применяются';
COMMENT ON COLUMN hdw_rules.is_enabled IS 'Включено ли правило. Новое правило выключено';
COMMENT ON COLUMN hdw_rules.disabled_reason IS 'Почему правило выключила система: loop (защита от зацикливания). Пусто: выключил администратор или включено';
COMMENT ON COLUMN hdw_rules.pcode IS 'Код предустановленного правила. Такое правило нельзя удалить';
COMMENT ON COLUMN hdw_rules.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdw_rules.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdw_rules.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdw_rules.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdw_rules_stamp
  BEFORE INSERT OR UPDATE ON hdw_rules
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Код предустановленного правила не меняется. Система меняет только включение и причину выключения.
CREATE FUNCTION app.hdw_rules_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'none' THEN
    RETURN NEW;
  END IF;
  IF NEW.rule_id IS DISTINCT FROM OLD.rule_id OR NEW.pcode IS DISTINCT FROM OLD.pcode THEN
    RAISE EXCEPTION 'Правило: идентификатор и код предустановленного правила не меняются' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'system'
     AND (to_jsonb(NEW) - ARRAY['is_enabled', 'disabled_reason', 'modified_by', 'modified_on'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_enabled', 'disabled_reason', 'modified_by', 'modified_on']) THEN
    RAISE EXCEPTION 'Правило: система меняет только включение и причину выключения' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdw_rules_guard() IS
  'Триггер: код предустановленного правила не меняется; система меняет у правила только включение и причину выключения';

CREATE TRIGGER t_hdw_rules_guard
  BEFORE UPDATE ON hdw_rules
  FOR EACH ROW EXECUTE FUNCTION app.hdw_rules_guard();

ALTER TABLE hdw_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY hdw_rules_internal_select ON hdw_rules FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdw_rules_admin_insert ON hdw_rules FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin' AND pcode IS NULL);
CREATE POLICY hdw_rules_admin_update ON hdw_rules FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdw_rules_system_update ON hdw_rules FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system')
  WITH CHECK (app.actor_type() = 'system' AND NOT is_enabled);
CREATE POLICY hdw_rules_admin_delete ON hdw_rules FOR DELETE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin' AND pcode IS NULL);
COMMENT ON POLICY hdw_rules_internal_select ON hdw_rules IS 'Правила читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdw_rules_admin_insert ON hdw_rules IS 'Правило создаёт администратор портала; предустановленные правила поставляют миграции';
COMMENT ON POLICY hdw_rules_admin_update ON hdw_rules IS 'Правило меняет администратор портала';
COMMENT ON POLICY hdw_rules_system_update ON hdw_rules IS 'Система только выключает правило: защита от зацикливания (FR-AUTO-07)';
COMMENT ON POLICY hdw_rules_admin_delete ON hdw_rules IS 'Правило удаляет администратор портала; предустановленное удалить нельзя';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdw_rules TO hub_app;

-- ---------------------------------------------------------------------------
-- hdw_rule_runs: журнал срабатываний правил
-- ---------------------------------------------------------------------------
CREATE TABLE hdw_rule_runs (
  org_id       uuid        NOT NULL,
  run_id       uuid        NOT NULL DEFAULT uuidv7(),
  rule_id      uuid        NOT NULL,
  ticket_id    uuid        NOT NULL,
  event_id     uuid,
  result       text        NOT NULL,
  actions_done jsonb       NOT NULL DEFAULT '[]',
  is_dry_run   boolean     NOT NULL DEFAULT false,
  marker       text,
  created_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdw_rule_runs_pk PRIMARY KEY (run_id),
  -- Удаление правила администратором убирает и его журнал срабатываний: след остаётся в журнале аудита.
  CONSTRAINT hdw_rule_runs_f1 FOREIGN KEY (rule_id) REFERENCES hdw_rules (rule_id) ON DELETE CASCADE,
  -- Привязка обращения к организации (миграция 0037) меняет org_id обращения: срабатывание идёт следом.
  CONSTRAINT hdw_rule_runs_f2 FOREIGN KEY (ticket_id, org_id) REFERENCES hdt_tickets (ticket_id, org_id) ON UPDATE CASCADE,
  CONSTRAINT hdw_rule_runs_c1 CHECK (result IN ('applied', 'no_match', 'partial', 'failed', 'skipped_loop')),
  CONSTRAINT hdw_rule_runs_c2 CHECK (jsonb_typeof(actions_done) = 'array' AND octet_length(actions_done::text) <= 8000),
  CONSTRAINT hdw_rule_runs_c3 CHECK (marker IS NULL OR char_length(marker) BETWEEN 1 AND 60)
);

-- Журнал срабатываний правила, новые сверху: экран администратора.
CREATE INDEX hdw_rule_runs_i1 ON hdw_rule_runs (rule_id, created_on DESC);
-- Защита от зацикливания: срабатывания правила на обращении за последний час. Он же покрывает внешний ключ обращения.
CREATE INDEX hdw_rule_runs_i2 ON hdw_rule_runs (ticket_id, rule_id, created_on);
-- Ночная очистка срабатываний старше 90 суток.
CREATE INDEX hdw_rule_runs_i3 ON hdw_rule_runs (created_on);
-- Событие "нет активности": одно срабатывание правила на обращении на каждое молчание.
CREATE UNIQUE INDEX hdw_rule_runs_u1 ON hdw_rule_runs (rule_id, ticket_id, marker) WHERE marker IS NOT NULL;

COMMENT ON TABLE hdw_rule_runs IS 'Срабатывания правил автоматизации на обращениях (FR-AUTO-09). Хранятся 90 суток';
COMMENT ON COLUMN hdw_rule_runs.org_id IS 'Организация обращения (совпадает с обращением по внешнему ключу)';
COMMENT ON COLUMN hdw_rule_runs.run_id IS 'Идентификатор срабатывания';
COMMENT ON COLUMN hdw_rule_runs.rule_id IS 'Правило';
COMMENT ON COLUMN hdw_rule_runs.ticket_id IS 'Обращение, на котором сработало правило';
COMMENT ON COLUMN hdw_rule_runs.event_id IS 'Событие hdc_domain_events. Пусто: событие "нет активности". Без внешнего ключа: события хранятся 30 суток';
COMMENT ON COLUMN hdw_rule_runs.result IS 'Итог: applied (все действия выполнены), partial (часть), failed (ни одного), skipped_loop (защита от зацикливания), no_match';
COMMENT ON COLUMN hdw_rule_runs.actions_done IS 'Действия по порядку: код действия, выполнено ли, код причины отказа, прежнее и новое значение. Без текста переписки';
COMMENT ON COLUMN hdw_rule_runs.is_dry_run IS 'Пробный прогон. Пробный прогон в базу не пишет, значение всегда false: колонка оставлена для выгрузок';
COMMENT ON COLUMN hdw_rule_runs.marker IS 'Отметка молчания для события "нет активности": идентификатор последнего сообщения. По ней правило срабатывает один раз на молчание';
COMMENT ON COLUMN hdw_rule_runs.created_on IS 'Когда правило сработало. Заполняет база';

ALTER TABLE hdw_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdw_rule_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY hdw_rule_runs_internal_select ON hdw_rule_runs FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdw_rule_runs_system_insert ON hdw_rule_runs FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'system' AND NOT is_dry_run);
CREATE POLICY hdw_rule_runs_system_delete ON hdw_rule_runs FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hdw_rule_runs_internal_select ON hdw_rule_runs IS 'Срабатывания читают сотрудники и система, клиент не видит';
COMMENT ON POLICY hdw_rule_runs_system_insert ON hdw_rule_runs IS 'Срабатывание пишет только фоновая задача';
COMMENT ON POLICY hdw_rule_runs_system_delete ON hdw_rule_runs IS 'Срабатывания старше 90 суток удаляет только ночная очистка';

GRANT SELECT, INSERT, DELETE ON hdw_rule_runs TO hub_app;

-- ---------------------------------------------------------------------------
-- Автоматический ответ и заметка правила (FR-AUTO-11)
-- ---------------------------------------------------------------------------
-- Колонка с постоянным значением по умолчанию: добавление мгновенное, таблица не переписывается.
ALTER TABLE hdt_ticket_messages ADD COLUMN is_auto boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN hdt_ticket_messages.is_auto IS 'Сообщение написано правилом автоматизации: ответ по шаблону или внутренняя заметка (FR-AUTO-11)';
-- Автоматическим бывает только сообщение системы: клиент и сотрудник такую отметку поставить не могут.
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c4 CHECK (NOT is_auto OR author_type = 'system') NOT VALID;
ALTER TABLE hdt_ticket_messages VALIDATE CONSTRAINT hdt_ticket_messages_c4;

-- Уведомления в портале: правило уведомило сотрудника (rule), система выключила правило (rule_disabled).
ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации и другие';
