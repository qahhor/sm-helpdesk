-- Веха M5c, задача 5: рассылка обновления по известной проблеме и её закрытие (ТЗ FR-KP-06, 07, 11.14, FR-NT-12, T23;
-- план M5c, решения 17-21).
--
-- Рассылка пишет сотрудник на своём языке, машинные переводы на языки получателей готовит задача, сотрудник их
-- принимает или правит и подтверждает. Подтверждение записывает получателей (привязанные открытые обращения на этот
-- момент) и ставит задачу problems.broadcast. Задача по одному обращению за транзакцию пишет публичное сообщение с
-- broadcast_id; второй строки "обращение, рассылка" не даёт частичный уникальный индекс (миграция 0102), поэтому повтор
-- задачи и две задачи одновременно не создают дублей. Клиент строки рассылки не видит: только сообщение в обращении.

CREATE TABLE hdp_broadcasts (
  broadcast_id     uuid        NOT NULL DEFAULT uuidv7(),
  problem_id       uuid        NOT NULL,
  author_id        uuid        NOT NULL,
  kind             text        NOT NULL,
  source_locale    text        NOT NULL,
  body             jsonb       NOT NULL,
  machine          jsonb       NOT NULL DEFAULT '{}',
  recipient_ids    uuid[]      NOT NULL DEFAULT '{}',
  recipients_count integer     NOT NULL DEFAULT 0,
  org_count        integer     NOT NULL DEFAULT 0,
  delivered_count  integer     NOT NULL DEFAULT 0,
  confirmed_on     timestamptz,
  sent_on          timestamptz,
  status           text        NOT NULL DEFAULT 'draft',
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_broadcasts_pk PRIMARY KEY (broadcast_id),
  CONSTRAINT hdp_broadcasts_f1 FOREIGN KEY (problem_id) REFERENCES hdp_problems (problem_id),
  CONSTRAINT hdp_broadcasts_f2 FOREIGN KEY (author_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdp_broadcasts_c1 CHECK (kind IN ('update', 'closing')),
  CONSTRAINT hdp_broadcasts_c2 CHECK (source_locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdp_broadcasts_c3 CHECK (status IN ('draft', 'queued', 'sending', 'done')),
  CONSTRAINT hdp_broadcasts_c4 CHECK (jsonb_typeof(body) = 'object' AND body ? source_locale),
  CONSTRAINT hdp_broadcasts_c5 CHECK (jsonb_typeof(machine) = 'object'),
  CONSTRAINT hdp_broadcasts_c6 CHECK (recipients_count >= 0 AND org_count >= 0 AND delivered_count >= 0 AND org_count <= recipients_count),
  CONSTRAINT hdp_broadcasts_c7 CHECK ((status = 'draft') = (confirmed_on IS NULL)),
  CONSTRAINT hdp_broadcasts_c8 CHECK (status <> 'done' OR sent_on IS NOT NULL)
);

CREATE INDEX hdp_broadcasts_i1 ON hdp_broadcasts (problem_id, created_on DESC);
CREATE INDEX hdp_broadcasts_i2 ON hdp_broadcasts (author_id);

COMMENT ON TABLE hdp_broadcasts IS 'Рассылки обновлений и закрытия известной проблемы (FR-KP-06, 07, 11.14). Клиент не читает: он видит только сообщение в своём обращении';
COMMENT ON COLUMN hdp_broadcasts.broadcast_id IS 'Идентификатор рассылки: по нему повтор задачи не создаёт дублей (11.14, пункт 4)';
COMMENT ON COLUMN hdp_broadcasts.problem_id IS 'Проблема';
COMMENT ON COLUMN hdp_broadcasts.author_id IS 'Сотрудник, который написал и подтвердил рассылку: от его имени сообщение в обращениях';
COMMENT ON COLUMN hdp_broadcasts.kind IS 'update (обновление) или closing (итог закрытия: обращения переходят в "Решено")';
COMMENT ON COLUMN hdp_broadcasts.source_locale IS 'Язык, на котором написал сотрудник';
COMMENT ON COLUMN hdp_broadcasts.body IS 'Текст по языкам {"ru": "..."}: оригинал сотрудника и переводы, принятые или написанные сотрудником. Только из него собирается сообщение (T23)';
COMMENT ON COLUMN hdp_broadcasts.machine IS 'Машинные переводы по языкам для окна подтверждения. Клиенту не уходят: в сообщение идёт только body';
COMMENT ON COLUMN hdp_broadcasts.recipient_ids IS 'Получатели: привязанные открытые обращения на момент подтверждения. Привязанное позже рассылку не получает';
COMMENT ON COLUMN hdp_broadcasts.recipients_count IS 'Сколько обращений получат рассылку ("Получат: N обращений")';
COMMENT ON COLUMN hdp_broadcasts.org_count IS 'Сколько организаций среди получателей';
COMMENT ON COLUMN hdp_broadcasts.delivered_count IS 'Сколько обращений получили сообщение. Пишет задача problems.broadcast';
COMMENT ON COLUMN hdp_broadcasts.confirmed_on IS 'Когда сотрудник подтвердил отправку. Пусто у черновика';
COMMENT ON COLUMN hdp_broadcasts.sent_on IS 'Когда задача разослала сообщения всем получателям';
COMMENT ON COLUMN hdp_broadcasts.status IS 'draft (окно подтверждения), queued (подтверждена), sending (идёт задача), done (разослано)';
COMMENT ON COLUMN hdp_broadcasts.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_broadcasts.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_broadcasts.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_broadcasts.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_broadcasts_stamp
  BEFORE INSERT OR UPDATE ON hdp_broadcasts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Подтверждённая рассылка не меняется ни сотрудником, ни задачей: задача ведёт только статус, счётчик и момент.
CREATE FUNCTION app.hdp_broadcasts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  progress CONSTANT text[] := ARRAY['status', 'delivered_count', 'sent_on', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'Рассылка: подтверждённую рассылку менять нельзя' USING ERRCODE = '42501';
  END IF;
  IF NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.problem_id IS DISTINCT FROM OLD.problem_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Рассылка: автор, проблема и вид не меняются' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdp_broadcasts_guard() IS 'Триггер: подтверждённая рассылка меняет только статус, счётчик доставленных и момент отправки; автор, проблема и вид не меняются';
CREATE TRIGGER t_hdp_broadcasts_guard
  BEFORE UPDATE ON hdp_broadcasts
  FOR EACH ROW EXECUTE FUNCTION app.hdp_broadcasts_guard();

ALTER TABLE hdp_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_broadcasts_internal_select ON hdp_broadcasts FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdp_broadcasts_writer_insert ON hdp_broadcasts FOR INSERT TO hub_app WITH CHECK (app.hdp_can_write());
CREATE POLICY hdp_broadcasts_writer_update ON hdp_broadcasts FOR UPDATE TO hub_app USING (app.hdp_can_write()) WITH CHECK (app.hdp_can_write());
COMMENT ON POLICY hdp_broadcasts_internal_select ON hdp_broadcasts IS 'Рассылки читают сотрудники и система (история рассылок, FR-ADM-12). Клиент не читает';
COMMENT ON POLICY hdp_broadcasts_writer_insert ON hdp_broadcasts IS 'Рассылку готовят agent_l2, care, admin';
COMMENT ON POLICY hdp_broadcasts_writer_update ON hdp_broadcasts IS 'Черновик правят и подтверждают agent_l2, care, admin; ход отправки ведёт система';
GRANT SELECT, INSERT, UPDATE ON hdp_broadcasts TO hub_app;

-- Сообщение рассылки в обращении. Колонка в конце таблицы; индексы по ней создаёт миграция 0102 вне транзакции.
ALTER TABLE hdt_ticket_messages ADD COLUMN broadcast_id uuid;
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_f3 FOREIGN KEY (broadcast_id) REFERENCES hdp_broadcasts (broadcast_id) NOT VALID;
ALTER TABLE hdt_ticket_messages VALIDATE CONSTRAINT hdt_ticket_messages_f3;
-- Сообщение рассылки всегда публичное сообщение сотрудника.
ALTER TABLE hdt_ticket_messages ADD CONSTRAINT hdt_ticket_messages_c7 CHECK (broadcast_id IS NULL OR (author_type = 'staff' AND NOT is_internal)) NOT VALID;
ALTER TABLE hdt_ticket_messages VALIDATE CONSTRAINT hdt_ticket_messages_c7;
COMMENT ON COLUMN hdt_ticket_messages.broadcast_id IS 'Рассылка по известной проблеме, из которой это сообщение (веха M5c). Одно сообщение рассылки на обращение';

-- Уведомление клиенту об обновлении по известной проблеме (FR-NT-12).
ALTER TABLE hdn_notifications DROP CONSTRAINT hdn_notifications_c1;
ALTER TABLE hdn_notifications ADD CONSTRAINT hdn_notifications_c1 CHECK (kind IN (
  'ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'client_replied',
  'mention', 'sla_breach', 'snooze_returned', 'update_due', 'holidays_reminder', 'telegram_linked', 'rule', 'rule_disabled',
  'dev_task_closed', 'csat_low', 'rule_paused',
  'idea_published', 'idea_declined', 'idea_status', 'idea_merged', 'idea_comment_hidden', 'idea_official_reply',
  'idea_cycle', 'idea_moderation_due', 'idea_dev_task_closed',
  'ai_budget', 'problem_update'
));
COMMENT ON COLUMN hdn_notifications.kind IS 'Что произошло: ответ, смена статуса, упоминание, нарушение срока, уведомление правила автоматизации, правило приостановлено или выключено, закрытие задачи разработки, низкая оценка, события идей, предел расходов на AI (ai_budget, администраторам), обновление по известной проблеме (problem_update) и другие';
