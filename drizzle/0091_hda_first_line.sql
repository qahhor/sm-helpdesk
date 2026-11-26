-- AI первой линии: журнал вызовов, пределы и расходы (ТЗ 7.13, FR-AI-17, FR-AI-21, 9.2, 10.5 ai_runs; план M5b,
-- задача 1, решения 1, 2, 11, 12, 13).
--
-- 1. Журнал вызовов hda_runs получает колонки первой линии в конце таблицы: обращение и автор текста (пределы на
--    пользователя и организацию), решение кода (answer, clarify, handoff), причина передачи, выбранное решение и его
--    уверенность, HMAC очищенного входа (повтор того же текста модель не вызывает), отметка "неверно" и итог разбора
--    (FR-AI-16, задача 8). Текста запроса и ответа по-прежнему нет ни в одной колонке (поправка 101): хеш не обратим.
--    Решение кода записывает фоновый процесс после вызова той же строкой: системе разрешено обновление строки.
-- 2. hda_org_cutoffs: организации, отключённые от помощника до конца месяца, когда расход подошёл к месячному пределу
--    (решение 11). Строка без организации: предел исчерпан, помощник отключён для всех. Пишет система (задача
--    ai.budget), снимает отключение администратор портала, читают сотрудники, клиент не видит ни одной строки.
-- 3. Уведомление администраторам о пределе расходов (вид ai_budget) в колокольчике.

ALTER TABLE hda_runs ADD COLUMN ticket_id uuid;
ALTER TABLE hda_runs ADD COLUMN user_id uuid;
ALTER TABLE hda_runs ADD COLUMN decision text;
ALTER TABLE hda_runs ADD COLUMN handoff_reason text;
ALTER TABLE hda_runs ADD COLUMN solution_id uuid;
ALTER TABLE hda_runs ADD COLUMN confidence numeric(10,6);
ALTER TABLE hda_runs ADD COLUMN input_hash text;
ALTER TABLE hda_runs ADD COLUMN flagged_by uuid;
ALTER TABLE hda_runs ADD COLUMN flagged_on timestamptz;
ALTER TABLE hda_runs ADD COLUMN flag_reason text;
ALTER TABLE hda_runs ADD COLUMN review_result text;

ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id");
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_f3 FOREIGN KEY (flagged_by) REFERENCES auth."user" ("id");

ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c1;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c1 CHECK (purpose IN ('solution_draft', 'translation', 'idea_translation', 'first_line', 'triage', 'message_translation', 'thanks'));
ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c2;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c2 CHECK (outcome IN ('ok', 'invalid_response', 'failed', 'limited', 'repeated'));
ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c6;
-- Модель не вызывалась (предел или повтор): ни модели, ни токенов.
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c6 CHECK (outcome NOT IN ('limited', 'repeated') OR (model IS NULL AND input_tokens = 0 AND output_tokens = 0));
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c7 CHECK (decision IS NULL OR decision IN ('answer', 'clarify', 'handoff'));
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c8 CHECK (handoff_reason IS NULL OR handoff_reason IN (
  'customer_request', 'not_helped', 'no_solution', 'restricted_topic', 'p1', 'low_confidence', 'reply_limit',
  'ai_failure', 'ai_disabled', 'ai_limit', 'no_text', 'language'
));
-- Хеш только шестнадцатеричный: текст сюда не положить.
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c9 CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$');
-- Причина отметки и итог разбора: коды из закрытых списков (задача 8), не свободный текст.
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c10 CHECK (flag_reason IS NULL OR flag_reason ~ '^[a-z_]{1,40}$');
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c11 CHECK (review_result IS NULL OR review_result ~ '^[a-z_]{1,40}$');
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c12 CHECK ((flagged_by IS NULL) = (flagged_on IS NULL));

-- Пределы на пользователя и организацию и повтор считают вызовы за сутки; ответы помощника ищутся по обращению.
CREATE INDEX hda_runs_i4 ON hda_runs (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX hda_runs_i5 ON hda_runs (user_id, created_on) WHERE user_id IS NOT NULL;
CREATE INDEX hda_runs_i6 ON hda_runs (org_id, input_hash, created_on) WHERE input_hash IS NOT NULL;
CREATE INDEX hda_runs_i7 ON hda_runs (flagged_by) WHERE flagged_by IS NOT NULL;
CREATE INDEX hda_runs_i8 ON hda_runs (org_id, created_on);
COMMENT ON INDEX hda_runs_i4 IS 'Вызовы по обращению: ответы помощника, разбор, блок AI у сотрудника';
COMMENT ON INDEX hda_runs_i5 IS 'Суточный предел вызовов первой линии на пользователя (план M5b, решение 11)';
COMMENT ON INDEX hda_runs_i6 IS 'Повтор того же входа в организации за 24 часа (решение 12)';
COMMENT ON INDEX hda_runs_i7 IS 'Внешний ключ: кто отметил ответ неверным';
COMMENT ON INDEX hda_runs_i8 IS 'Суточный предел на организацию и расход организации за месяц (решение 11)';

COMMENT ON COLUMN hda_runs.purpose IS 'Цель вызова: solution_draft, translation, idea_translation, first_line (ответ и разбор первой линии одним вызовом), triage (только разбор), message_translation (перевод сообщения клиента), thanks (благодарность)';
COMMENT ON COLUMN hda_runs.outcome IS 'Итог: ok, invalid_response (ответ не прошёл разбор или схему), failed (нет ответа), limited (предел, модель не вызывалась), repeated (тот же вход в организации за 24 часа, модель не вызывалась)';
COMMENT ON COLUMN hda_runs.cost_usd IS 'Стоимость вызова в долларах по цене модели из ответа API (src/modules/hda/pref.ts, план M5b, решение 2)';
COMMENT ON COLUMN hda_runs.ticket_id IS 'Обращение вызова (первая линия, разбор, перевод сообщения, благодарность). Без внешнего ключа: журнал переживает объект';
COMMENT ON COLUMN hda_runs.user_id IS 'Автор текста, ушедшего в модель: суточный предел на пользователя. Пусто у целей без автора (перевод решения)';
COMMENT ON COLUMN hda_runs.decision IS 'Решение кода по вызову первой линии: answer (ответ решением), clarify (уточняющий вопрос), handoff (передача сотруднику)';
COMMENT ON COLUMN hda_runs.handoff_reason IS 'Причина передачи сотруднику (FR-AI-14 и уточнения no_text, language)';
COMMENT ON COLUMN hda_runs.solution_id IS 'Решение hdk_articles, выбранное ответом. Без внешнего ключа: журнал переживает решение';
COMMENT ON COLUMN hda_runs.confidence IS 'Оценка выбранного решения по ранжированию подсказки (score)';
COMMENT ON COLUMN hda_runs.input_hash IS 'HMAC очищенного входа модели с ключом из ENCRYPTION_KEY: повтор того же текста модель не вызывает. Текст по нему не восстанавливается';
COMMENT ON COLUMN hda_runs.flagged_by IS 'Сотрудник, отметивший ответ помощника неверным (FR-AI-16)';
COMMENT ON COLUMN hda_runs.flagged_on IS 'Когда ответ отмечен неверным';
COMMENT ON COLUMN hda_runs.flag_reason IS 'Причина отметки: код из списка';
COMMENT ON COLUMN hda_runs.review_result IS 'Итог разбора отмеченного ответа: код из списка';
COMMENT ON CONSTRAINT hda_runs_c9 ON hda_runs IS 'В колонке хеша только 64 шестнадцатеричных знака: текста входа там быть не может';

CREATE POLICY hda_runs_system_update ON hda_runs FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hda_runs_system_update ON hda_runs IS 'Решение кода (ответ, вопрос, передача) фоновый процесс записывает в строку вызова после разбора ответа';
GRANT UPDATE ON hda_runs TO hub_app;

CREATE TABLE hda_org_cutoffs (
  cutoff_id   uuid        NOT NULL DEFAULT uuidv7(),
  org_id      uuid,
  month       date        NOT NULL,
  reason      text        NOT NULL,
  lifted_on   timestamptz,
  lifted_by   uuid,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_org_cutoffs_pk PRIMARY KEY (cutoff_id),
  CONSTRAINT hda_org_cutoffs_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hda_org_cutoffs_f2 FOREIGN KEY (lifted_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_org_cutoffs_c1 CHECK (reason IN ('budget_share', 'budget_total')),
  -- Отключение всех без организации, отключение одной с организацией.
  CONSTRAINT hda_org_cutoffs_c2 CHECK ((reason = 'budget_total') = (org_id IS NULL)),
  CONSTRAINT hda_org_cutoffs_c3 CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT hda_org_cutoffs_c4 CHECK ((lifted_on IS NULL) = (lifted_by IS NULL))
);

-- Одна строка на организацию и месяц и одна строка "отключено для всех" на месяц: уведомление уходит один раз.
CREATE UNIQUE INDEX hda_org_cutoffs_u1 ON hda_org_cutoffs (org_id, month) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX hda_org_cutoffs_u2 ON hda_org_cutoffs (month) WHERE org_id IS NULL;
CREATE INDEX hda_org_cutoffs_i1 ON hda_org_cutoffs (lifted_by) WHERE lifted_by IS NOT NULL;
COMMENT ON INDEX hda_org_cutoffs_u1 IS 'Одна строка на организацию и месяц';
COMMENT ON INDEX hda_org_cutoffs_u2 IS 'Одна строка "помощник отключён для всех" на месяц';
COMMENT ON INDEX hda_org_cutoffs_i1 IS 'Внешний ключ: кто снял отключение';

COMMENT ON TABLE hda_org_cutoffs IS 'Отключение помощника до конца месяца пределом расходов (FR-AI-17, план M5b, решение 11). Пишет фоновый процесс, снимает администратор портала, клиент не видит';
COMMENT ON COLUMN hda_org_cutoffs.cutoff_id IS 'Идентификатор отключения';
COMMENT ON COLUMN hda_org_cutoffs.org_id IS 'Организация, израсходовавшая больше доли месячного предела. Пусто: предел исчерпан, отключены все';
COMMENT ON COLUMN hda_org_cutoffs.month IS 'Месяц отключения: первое число месяца по Ташкенту';
COMMENT ON COLUMN hda_org_cutoffs.reason IS 'Причина: budget_share (организация расходует предел), budget_total (предел исчерпан)';
COMMENT ON COLUMN hda_org_cutoffs.lifted_on IS 'Когда администратор снял отключение. Пусто: действует до конца месяца';
COMMENT ON COLUMN hda_org_cutoffs.lifted_by IS 'Кто снял отключение';
COMMENT ON COLUMN hda_org_cutoffs.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_org_cutoffs.created_on IS 'Когда создана строка (отключение). Заполняет база';
COMMENT ON COLUMN hda_org_cutoffs.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_org_cutoffs.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hda_org_cutoffs_stamp
  BEFORE INSERT OR UPDATE ON hda_org_cutoffs
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_org_cutoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_org_cutoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_org_cutoffs_internal_select ON hda_org_cutoffs FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hda_org_cutoffs_system_insert ON hda_org_cutoffs FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_org_cutoffs_admin_update ON hda_org_cutoffs FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hda_org_cutoffs_internal_select ON hda_org_cutoffs IS 'Отключения читают сотрудники (настройки AI) и система (проверка перед вызовом). Клиент не читает';
COMMENT ON POLICY hda_org_cutoffs_system_insert ON hda_org_cutoffs IS 'Отключение ставит только задача ai.budget фонового процесса';
COMMENT ON POLICY hda_org_cutoffs_admin_update ON hda_org_cutoffs IS 'Снять отключение до конца месяца может только администратор портала';
GRANT SELECT, INSERT, UPDATE ON hda_org_cutoffs TO hub_app;

ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed', 'csat_low', 'rule_paused',
  'idea_published', 'idea_declined', 'idea_status', 'idea_merged', 'idea_comment_hidden', 'idea_official_reply',
  'idea_cycle', 'idea_moderation_due', 'idea_dev_task_closed',
  'ai_budget'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, правило приостановлено или выключено, закрытие задачи разработки, низкая оценка, события идей, предел расходов на AI (ai_budget, администраторам) и другие';
