-- Веха M8b, задача 1: токены AI-сотрудников, журнал вызовов инструментов, сводки и актор agent (ТЗ 7.21 FR-AGT-02, 09,
-- 10.4, 10.5 agent_tokens, agent_tool_calls, agent_reports; план M8b, решения 1, 5, 10, 14, 15, 23).
--
-- 1. hda_agent_tokens: токен агента. Значение токена не хранится: только SHA-256 и последние 4 знака для узнавания.
--    Основной токен выпускает и меняет администратор портала, токен запуска по обращению (parent_token_id, ticket_id)
--    выпускает система при отправке события. Учётная запись токена всегда с ролью agent_bot.
-- 2. hda_agent_tool_calls: журнал вызовов без аргументов и ответов. Пишет агент своим токеном и система (отказ до
--    транзакции инструмента), читает администратор, строки не меняются, ночная очистка удаляет старше 365 суток.
-- 3. hda_agent_reports: сводки агента для раздела "Сводки". Пишет агент основным токеном, читают сотрудники, отметку
--    "просмотрено" ставит сотрудник от своего имени. Клиент не видит ни одной строки.
-- 4. Функции актора agent: app.agent_token_id(), app.agent_ticket_id() и app.agent_token_active(). Каждая политика и
--    представление актора agent включает app.agent_token_active(): отзыв закрывает данные даже в начатом запросе.

CREATE FUNCTION app.agent_token_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN app.actor_type() = 'agent' THEN nullif(current_setting('app.agent_token_id', true), '')::uuid END $$;
COMMENT ON FUNCTION app.agent_token_id() IS 'Токен актора agent из переменной транзакции. У остальных акторов пусто';

CREATE FUNCTION app.agent_ticket_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN app.actor_type() = 'agent' THEN nullif(current_setting('app.agent_ticket_id', true), '')::uuid END $$;
COMMENT ON FUNCTION app.agent_ticket_id() IS 'Обращение токена запуска актора agent (FR-AGT-12). Пусто у основного токена и у остальных акторов';

CREATE TABLE hda_agent_tokens (
  token_id        uuid        NOT NULL DEFAULT uuidv7(),
  name            text        NOT NULL,
  staff_user_id   uuid        NOT NULL,
  token_hash      text        NOT NULL,
  token_last4     text        NOT NULL,
  tools           text[]      NOT NULL,
  allowed_ips     cidr[]      NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  daily_limit     integer     NOT NULL DEFAULT 2000,
  parent_token_id uuid,
  ticket_id       uuid,
  note_limit      integer,
  notes_written   integer     NOT NULL DEFAULT 0,
  is_event_parent boolean     NOT NULL DEFAULT false,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_agent_tokens_pk PRIMARY KEY (token_id),
  CONSTRAINT hda_agent_tokens_f1 FOREIGN KEY (staff_user_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_agent_tokens_f2 FOREIGN KEY (parent_token_id) REFERENCES hda_agent_tokens (token_id),
  CONSTRAINT hda_agent_tokens_f3 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hda_agent_tokens_u1 UNIQUE (token_hash),
  CONSTRAINT hda_agent_tokens_c1 CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT hda_agent_tokens_c2 CHECK (token_hash ~ '^[0-9a-f]{64}$' AND token_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  CONSTRAINT hda_agent_tokens_c3 CHECK (
    cardinality(tools) BETWEEN 1 AND 16
    AND tools <@ ARRAY['search_tickets', 'get_ticket', 'similar_tickets', 'sla_risk_tickets', 'unsolved_signatures', 'signature_spikes',
                       'search_solutions', 'get_solution', 'list_candidates', 'list_known_problems', 'list_ideas', 'assistant_metrics',
                       'add_internal_note', 'draft_solution', 'draft_known_problem', 'create_report']::text[]),
  CONSTRAINT hda_agent_tokens_c4 CHECK (cardinality(allowed_ips) BETWEEN 1 AND 50),
  CONSTRAINT hda_agent_tokens_c5 CHECK (daily_limit BETWEEN 1 AND 10000),
  CONSTRAINT hda_agent_tokens_c6 CHECK ((parent_token_id IS NULL) = (ticket_id IS NULL)),
  CONSTRAINT hda_agent_tokens_c7 CHECK (
    parent_token_id IS NULL
    OR (note_limit IS NOT NULL AND NOT is_event_parent AND tools <@ ARRAY['get_ticket', 'add_internal_note']::text[])),
  CONSTRAINT hda_agent_tokens_c8 CHECK (note_limit IS NULL OR note_limit BETWEEN 0 AND 10),
  CONSTRAINT hda_agent_tokens_c9 CHECK (notes_written >= 0 AND (note_limit IS NULL OR notes_written <= note_limit))
);

CREATE INDEX hda_agent_tokens_i1 ON hda_agent_tokens (staff_user_id);
CREATE INDEX hda_agent_tokens_i2 ON hda_agent_tokens (parent_token_id) WHERE parent_token_id IS NOT NULL;
CREATE INDEX hda_agent_tokens_i3 ON hda_agent_tokens (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE UNIQUE INDEX hda_agent_tokens_u2 ON hda_agent_tokens (is_event_parent) WHERE is_event_parent AND revoked_at IS NULL;
COMMENT ON INDEX hda_agent_tokens_i1 IS 'Внешний ключ: учётная запись agent_bot; токены одного AI-сотрудника';
COMMENT ON INDEX hda_agent_tokens_i2 IS 'Внешний ключ: основной токен; отзыв родителя отзывает его токены запуска';
COMMENT ON INDEX hda_agent_tokens_i3 IS 'Внешний ключ: обращение токена запуска';
COMMENT ON INDEX hda_agent_tokens_u2 IS 'Токен "для событий" один среди неотозванных (план M8b, решение 27)';

COMMENT ON TABLE hda_agent_tokens IS 'Токены AI-сотрудников (логическое имя agent_tokens, FR-AGT-02). Значение токена не хранится. Основной выпускает администратор портала, токен запуска по обращению система. Клиент не видит';
COMMENT ON COLUMN hda_agent_tokens.token_id IS 'Идентификатор токена';
COMMENT ON COLUMN hda_agent_tokens.name IS 'Имя токена для администратора, например "Hermes: поддержка" (до 80 знаков)';
COMMENT ON COLUMN hda_agent_tokens.staff_user_id IS 'Учётная запись с ролью agent_bot, от имени которой работает агент: автор его записей';
COMMENT ON COLUMN hda_agent_tokens.token_hash IS 'SHA-256 значения токена в шестнадцатеричном виде: по нему сервер MCP находит токен';
COMMENT ON COLUMN hda_agent_tokens.token_last4 IS 'Последние 4 знака значения: администратор узнаёт токен в списке';
COMMENT ON COLUMN hda_agent_tokens.tools IS 'Разрешённые инструменты из каталога сервера MCP, хотя бы один';
COMMENT ON COLUMN hda_agent_tokens.allowed_ips IS 'Сети, с которых принимаются запросы с этим токеном (IPv4 и IPv6), хотя бы одна';
COMMENT ON COLUMN hda_agent_tokens.expires_at IS 'Срок действия: не больше 365 суток от выпуска или продления';
COMMENT ON COLUMN hda_agent_tokens.revoked_at IS 'Когда токен отозван. Отзыв не снимается';
COMMENT ON COLUMN hda_agent_tokens.last_used_at IS 'Время последнего принятого запроса с токеном. Ставит система';
COMMENT ON COLUMN hda_agent_tokens.daily_limit IS 'Суточный предел вызовов инструментов, от 1 до 10000 (по умолчанию 2000)';
COMMENT ON COLUMN hda_agent_tokens.parent_token_id IS 'Основной токен, от которого выпущен токен запуска по обращению. Пусто у основного';
COMMENT ON COLUMN hda_agent_tokens.ticket_id IS 'Единственное обращение токена запуска (FR-AGT-12). Пусто у основного';
COMMENT ON COLUMN hda_agent_tokens.note_limit IS 'Сколько внутренних заметок может записать токен запуска. Пусто у основного: без отдельного предела';
COMMENT ON COLUMN hda_agent_tokens.notes_written IS 'Сколько заметок уже записал токен запуска';
COMMENT ON COLUMN hda_agent_tokens.is_event_parent IS 'Основной токен, от которого система выпускает токены запуска в событиях по обращениям';
COMMENT ON COLUMN hda_agent_tokens.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_agent_tokens.created_on IS 'Когда выпущен токен. Заполняет база';
COMMENT ON COLUMN hda_agent_tokens.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_agent_tokens.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_agent_tokens_c3 ON hda_agent_tokens IS 'Перечень инструментов не пустой и только из каталога: инструментов ответа клиенту, смены статуса и других из FR-AGT-05 в каталоге нет';
COMMENT ON CONSTRAINT hda_agent_tokens_c4 ON hda_agent_tokens IS 'Список адресов обязателен (FR-AGT-02)';
COMMENT ON CONSTRAINT hda_agent_tokens_c6 ON hda_agent_tokens IS 'Токен запуска всегда с основным токеном и обращением, основной без них';
COMMENT ON CONSTRAINT hda_agent_tokens_c7 ON hda_agent_tokens IS 'Токен запуска только читает своё обращение и пишет заметку с пределом; токеном "для событий" не бывает';
COMMENT ON CONSTRAINT hda_agent_tokens_c9 ON hda_agent_tokens IS 'Токен запуска не пишет заметок сверх предела';

CREATE TRIGGER t_hda_agent_tokens_stamp
  BEFORE INSERT OR UPDATE ON hda_agent_tokens
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Проверки, которых не выразить ограничением: роль учётной записи (таблица hdu_staff закрыта роли hub_app, поэтому
-- функция выполняется от владельца), срок от сегодняшнего дня, неизменные поля и необратимый отзыв.
CREATE FUNCTION app.hda_agent_tokens_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.hdu_staff s WHERE s.user_id = NEW.staff_user_id AND s.role = 'agent_bot') THEN
      RAISE EXCEPTION 'Токен агента: учётная запись только с ролью agent_bot' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.token_last4 IS DISTINCT FROM OLD.token_last4 OR NEW.parent_token_id IS DISTINCT FROM OLD.parent_token_id
       OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.note_limit IS DISTINCT FROM OLD.note_limit THEN
      RAISE EXCEPTION 'Токен агента: значение, учётная запись, родитель, обращение и предел заметок не меняются' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.tools IS DISTINCT FROM OLD.tools
       OR NEW.allowed_ips IS DISTINCT FROM OLD.allowed_ips OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.daily_limit IS DISTINCT FROM OLD.daily_limit OR (NEW.is_event_parent AND NOT OLD.is_event_parent)) THEN
      RAISE EXCEPTION 'Токен агента: отозванный токен не меняется' USING ERRCODE = '42501';
    END IF;
    IF app.actor_type() = 'staff' AND (NEW.last_used_at IS DISTINCT FROM OLD.last_used_at OR NEW.notes_written IS DISTINCT FROM OLD.notes_written) THEN
      RAISE EXCEPTION 'Токен агента: время вызова и число заметок ставит система' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) AND NEW.expires_at > now() + interval '365 days' THEN
    RAISE EXCEPTION 'Токен агента: срок действия не больше 365 суток' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_agent_tokens_guard() IS 'Токен агента: учётная запись agent_bot, срок не больше 365 суток, неизменные поля, отзыв не снимается';
CREATE TRIGGER t_hda_agent_tokens_guard
  BEFORE INSERT OR UPDATE ON hda_agent_tokens
  FOR EACH ROW EXECUTE FUNCTION app.hda_agent_tokens_guard();

ALTER TABLE hda_agent_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_agent_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_agent_tokens_admin_select ON hda_agent_tokens FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hda_agent_tokens_system_select ON hda_agent_tokens FOR SELECT TO hub_app
  USING (app.actor_type() = 'system');
CREATE POLICY hda_agent_tokens_admin_insert ON hda_agent_tokens FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin' AND parent_token_id IS NULL);
CREATE POLICY hda_agent_tokens_system_insert ON hda_agent_tokens FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'system' AND parent_token_id IS NOT NULL);
CREATE POLICY hda_agent_tokens_admin_update ON hda_agent_tokens FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hda_agent_tokens_system_update ON hda_agent_tokens FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_agent_tokens_system_delete ON hda_agent_tokens FOR DELETE TO hub_app
  USING (app.actor_type() = 'system' AND parent_token_id IS NOT NULL AND expires_at < now() - interval '7 days');
CREATE POLICY hda_agent_tokens_owner_select ON hda_agent_tokens FOR SELECT TO hub_owner USING (true);
COMMENT ON POLICY hda_agent_tokens_admin_select ON hda_agent_tokens IS 'Токены из сотрудников читает только администратор портала (10.5 "Только admin")';
COMMENT ON POLICY hda_agent_tokens_system_select ON hda_agent_tokens IS 'Токены читает система: проверка токена на входе сервера MCP, события';
COMMENT ON POLICY hda_agent_tokens_admin_insert ON hda_agent_tokens IS 'Основной токен выпускает администратор портала';
COMMENT ON POLICY hda_agent_tokens_system_insert ON hda_agent_tokens IS 'Токен запуска по обращению выпускает только система при отправке события';
COMMENT ON POLICY hda_agent_tokens_admin_update ON hda_agent_tokens IS 'Перечень, адреса, предел, срок, отметку "для событий" и отзыв меняет администратор портала';
COMMENT ON POLICY hda_agent_tokens_system_update ON hda_agent_tokens IS 'Время последнего вызова, число заметок и отзыв прежнего токена запуска ставит система';
COMMENT ON POLICY hda_agent_tokens_system_delete ON hda_agent_tokens IS 'Ночная очистка удаляет только токены запуска, истёкшие больше 7 суток назад. Токен со строками журнала вызовов держит внешний ключ: журнал хранится 365 суток';
COMMENT ON POLICY hda_agent_tokens_owner_select ON hda_agent_tokens IS 'Владелец читает строки для функции app.agent_token_active()';
GRANT SELECT, INSERT, UPDATE, DELETE ON hda_agent_tokens TO hub_app;

-- Действует ли токен актора agent: не отозван, не истёк, учётная запись agent_bot активна и совпадает с переменной
-- app.user_id, обращение совпадает с переменной app.agent_ticket_id, у токена запуска действует и родитель.
CREATE FUNCTION app.agent_token_active() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT app.actor_type() = 'agent' AND EXISTS (
    SELECT 1
      FROM public.hda_agent_tokens t
      JOIN public.hdu_staff s ON s.user_id = t.staff_user_id AND s.role = 'agent_bot' AND s.state = 'active'
      LEFT JOIN public.hda_agent_tokens p ON p.token_id = t.parent_token_id
     WHERE t.token_id = app.agent_token_id()
       AND t.staff_user_id::text = app.user_id()
       AND t.ticket_id IS NOT DISTINCT FROM app.agent_ticket_id()
       AND t.revoked_at IS NULL AND t.expires_at > now()
       AND (t.parent_token_id IS NULL OR (p.revoked_at IS NULL AND p.expires_at > now())))
$$;
COMMENT ON FUNCTION app.agent_token_active() IS 'Истина, если актор agent и его токен действует: не отозван, не истёк, учётная запись agent_bot активна, у токена запуска действует родитель (план M8b, решение 5)';

CREATE TABLE hda_agent_tool_calls (
  call_id     uuid        NOT NULL DEFAULT uuidv7(),
  token_id    uuid        NOT NULL,
  tool        text        NOT NULL,
  args_digest text,
  object_refs jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status      text        NOT NULL,
  duration_ms integer     NOT NULL DEFAULT 0,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_agent_tool_calls_pk PRIMARY KEY (call_id),
  CONSTRAINT hda_agent_tool_calls_f1 FOREIGN KEY (token_id) REFERENCES hda_agent_tokens (token_id),
  CONSTRAINT hda_agent_tool_calls_c1 CHECK (char_length(tool) BETWEEN 1 AND 64),
  CONSTRAINT hda_agent_tool_calls_c2 CHECK (args_digest IS NULL OR args_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hda_agent_tool_calls_c3 CHECK (jsonb_typeof(object_refs) = 'array' AND jsonb_array_length(object_refs) <= 100),
  CONSTRAINT hda_agent_tool_calls_c4 CHECK (status IN ('ok', 'refused', 'invalid', 'rate_limited', 'error')),
  CONSTRAINT hda_agent_tool_calls_c5 CHECK (duration_ms >= 0)
);
CREATE INDEX hda_agent_tool_calls_i1 ON hda_agent_tool_calls (token_id, call_id DESC);
CREATE INDEX hda_agent_tool_calls_i2 ON hda_agent_tool_calls (created_on);
COMMENT ON INDEX hda_agent_tool_calls_i1 IS 'Внешний ключ: токен; журнал вызовов токена страницами, новые сверху';
COMMENT ON INDEX hda_agent_tool_calls_i2 IS 'Ночная очистка строк старше 365 суток';
COMMENT ON TABLE hda_agent_tool_calls IS 'Журнал вызовов инструментов сервера MCP (логическое имя agent_tool_calls, FR-AGT-09): токен, инструмент, объекты, итог, длительность. Аргументов и текста ответов нет. Клиент не видит';
COMMENT ON COLUMN hda_agent_tool_calls.call_id IS 'Идентификатор вызова';
COMMENT ON COLUMN hda_agent_tool_calls.token_id IS 'Токен, с которым пришёл вызов';
COMMENT ON COLUMN hda_agent_tool_calls.tool IS 'Имя инструмента из запроса (до 64 знаков), в том числе вне каталога при отказе';
COMMENT ON COLUMN hda_agent_tool_calls.args_digest IS 'SHA-256 аргументов вызова: повтор виден, сами аргументы не хранятся';
COMMENT ON COLUMN hda_agent_tool_calls.object_refs IS 'Объекты вызова: номера обращений, решений, проблем, идей, кандидатов (массив до 100)';
COMMENT ON COLUMN hda_agent_tool_calls.status IS 'Итог: ok, refused (вне перечня или адреса), invalid (аргументы), rate_limited (предел), error (сбой)';
COMMENT ON COLUMN hda_agent_tool_calls.duration_ms IS 'Длительность вызова в миллисекундах';
COMMENT ON COLUMN hda_agent_tool_calls.created_by IS 'Кто создал строку: учётная запись агента или пусто у системы. Заполняет база';
COMMENT ON COLUMN hda_agent_tool_calls.created_on IS 'Когда сделан вызов. Заполняет база';
COMMENT ON COLUMN hda_agent_tool_calls.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_agent_tool_calls.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hda_agent_tool_calls_stamp
  BEFORE INSERT OR UPDATE ON hda_agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_agent_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_agent_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_agent_tool_calls_agent_insert ON hda_agent_tool_calls FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'agent' AND token_id = app.agent_token_id() AND app.agent_token_active());
CREATE POLICY hda_agent_tool_calls_system_insert ON hda_agent_tool_calls FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_agent_tool_calls_admin_select ON hda_agent_tool_calls FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hda_agent_tool_calls_system_select ON hda_agent_tool_calls FOR SELECT TO hub_app
  USING (app.actor_type() = 'system');
CREATE POLICY hda_agent_tool_calls_system_delete ON hda_agent_tool_calls FOR DELETE TO hub_app
  USING (app.actor_type() = 'system' AND created_on < now() - interval '365 days');
COMMENT ON POLICY hda_agent_tool_calls_agent_insert ON hda_agent_tool_calls IS 'Агент пишет строку вызова только своим действующим токеном, в транзакции инструмента';
COMMENT ON POLICY hda_agent_tool_calls_system_insert ON hda_agent_tool_calls IS 'Отказ до транзакции инструмента (вне перечня, предел, адрес) пишет система';
COMMENT ON POLICY hda_agent_tool_calls_admin_select ON hda_agent_tool_calls IS 'Журнал вызовов из сотрудников читает только администратор портала';
COMMENT ON POLICY hda_agent_tool_calls_system_select ON hda_agent_tool_calls IS 'Журнал читает система: ночная очистка';
COMMENT ON POLICY hda_agent_tool_calls_system_delete ON hda_agent_tool_calls IS 'Ночная очистка удаляет только строки старше 365 суток; строки не меняются';
GRANT SELECT, INSERT, DELETE ON hda_agent_tool_calls TO hub_app;

CREATE TABLE hda_agent_reports (
  report_id   uuid        NOT NULL DEFAULT uuidv7(),
  kind        text        NOT NULL,
  title       text        NOT NULL,
  body        text        NOT NULL,
  period_from timestamptz,
  period_to   timestamptz,
  chat_fields jsonb,
  token_id    uuid        NOT NULL,
  status      text        NOT NULL DEFAULT 'unverified',
  reviewed_by uuid,
  reviewed_on timestamptz,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_agent_reports_pk PRIMARY KEY (report_id),
  CONSTRAINT hda_agent_reports_f1 FOREIGN KEY (token_id) REFERENCES hda_agent_tokens (token_id),
  CONSTRAINT hda_agent_reports_f2 FOREIGN KEY (reviewed_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_agent_reports_c1 CHECK (kind IN ('morning', 'kb_hygiene', 'ideas', 'code_scan')),
  CONSTRAINT hda_agent_reports_c2 CHECK (char_length(title) BETWEEN 1 AND 200 AND char_length(body) <= 20000),
  CONSTRAINT hda_agent_reports_c3 CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to),
  CONSTRAINT hda_agent_reports_c4 CHECK (chat_fields IS NULL OR jsonb_typeof(chat_fields) = 'object'),
  CONSTRAINT hda_agent_reports_c5 CHECK (status IN ('unverified', 'reviewed')),
  CONSTRAINT hda_agent_reports_c6 CHECK ((status = 'reviewed') = (reviewed_by IS NOT NULL AND reviewed_on IS NOT NULL))
);
CREATE INDEX hda_agent_reports_i1 ON hda_agent_reports (token_id);
CREATE INDEX hda_agent_reports_i2 ON hda_agent_reports (reviewed_by) WHERE reviewed_by IS NOT NULL;
COMMENT ON INDEX hda_agent_reports_i1 IS 'Внешний ключ: токен, которым записана сводка';
COMMENT ON INDEX hda_agent_reports_i2 IS 'Внешний ключ: кто отметил сводку просмотренной';
COMMENT ON TABLE hda_agent_reports IS 'Сводки AI-сотрудника для раздела "Сводки" (логическое имя agent_reports, FR-AGT-04). Пишет агент основным токеном, читают сотрудники, клиент не видит';
COMMENT ON COLUMN hda_agent_reports.report_id IS 'Идентификатор сводки';
COMMENT ON COLUMN hda_agent_reports.kind IS 'Вид: morning (утренняя), kb_hygiene (гигиена решений), ideas (идеи), code_scan (сканирование кода, M8c)';
COMMENT ON COLUMN hda_agent_reports.title IS 'Заголовок от агента (до 200 знаков): недоверенный текст, показывается без разметки';
COMMENT ON COLUMN hda_agent_reports.body IS 'Текст от агента (до 20000 знаков): недоверенный текст, показывается без разметки и активных ссылок';
COMMENT ON COLUMN hda_agent_reports.period_from IS 'Начало периода сводки';
COMMENT ON COLUMN hda_agent_reports.period_to IS 'Конец периода сводки';
COMMENT ON COLUMN hda_agent_reports.chat_fields IS 'Числа по фиксированным ключам и номера обращений для сообщения в чат команды, которое собирает портал (FR-AGT-13). Текста агента нет';
COMMENT ON COLUMN hda_agent_reports.token_id IS 'Токен, которым записана сводка';
COMMENT ON COLUMN hda_agent_reports.status IS 'unverified (не проверено) до отметки сотрудника, reviewed (просмотрено)';
COMMENT ON COLUMN hda_agent_reports.reviewed_by IS 'Сотрудник, который отметил сводку просмотренной';
COMMENT ON COLUMN hda_agent_reports.reviewed_on IS 'Когда сводка отмечена просмотренной';
COMMENT ON COLUMN hda_agent_reports.created_by IS 'Кто создал строку: учётная запись агента. Заполняет база';
COMMENT ON COLUMN hda_agent_reports.created_on IS 'Когда записана сводка. Заполняет база';
COMMENT ON COLUMN hda_agent_reports.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_agent_reports.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_agent_reports_c6 ON hda_agent_reports IS 'У просмотренной сводки есть сотрудник и время отметки, у непросмотренной нет';

CREATE TRIGGER t_hda_agent_reports_stamp
  BEFORE INSERT OR UPDATE ON hda_agent_reports
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

CREATE FUNCTION app.hda_agent_reports_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to
     OR NEW.chat_fields IS DISTINCT FROM OLD.chat_fields OR NEW.token_id IS DISTINCT FROM OLD.token_id THEN
    RAISE EXCEPTION 'Сводка агента: текст и поля сводки не меняются, меняется только отметка "просмотрено"' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'reviewed' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'Сводка агента: отметка "просмотрено" не снимается и не переписывается' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hda_agent_reports_guard() IS 'Сводка агента: меняется только отметка "просмотрено", один раз';
CREATE TRIGGER t_hda_agent_reports_guard
  BEFORE UPDATE ON hda_agent_reports
  FOR EACH ROW EXECUTE FUNCTION app.hda_agent_reports_guard();

ALTER TABLE hda_agent_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_agent_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_agent_reports_agent_insert ON hda_agent_reports FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'agent' AND app.agent_token_active() AND app.agent_ticket_id() IS NULL
              AND token_id = app.agent_token_id() AND status = 'unverified');
CREATE POLICY hda_agent_reports_staff_select ON hda_agent_reports FOR SELECT TO hub_app
  USING (app.actor_type() = 'staff');
CREATE POLICY hda_agent_reports_system_select ON hda_agent_reports FOR SELECT TO hub_app
  USING (app.actor_type() = 'system');
CREATE POLICY hda_agent_reports_staff_update ON hda_agent_reports FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff')
  WITH CHECK (app.actor_type() = 'staff' AND reviewed_by = app.user_uuid());
COMMENT ON POLICY hda_agent_reports_agent_insert ON hda_agent_reports IS 'Сводку пишет агент основным действующим токеном, всегда непроверенной. Токен запуска сводок не пишет (FR-AGT-12)';
COMMENT ON POLICY hda_agent_reports_staff_select ON hda_agent_reports IS 'Сводки читают все сотрудники (10.5 "Чтение: С")';
COMMENT ON POLICY hda_agent_reports_system_select ON hda_agent_reports IS 'Сводку читает система: сообщение в чат команды';
COMMENT ON POLICY hda_agent_reports_staff_update ON hda_agent_reports IS 'Отметку "просмотрено" ставит сотрудник только от своего имени; остальные поля закрывает t_hda_agent_reports_guard';
GRANT SELECT, INSERT, UPDATE ON hda_agent_reports TO hub_app;
