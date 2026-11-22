-- Уведомления сотрудникам и сообщение дежурным о P1 (FR-SLA-07, FR-SLA-09; план M4, задача 6, решения 7 и 8).
-- Отметки однократных сообщений в обращении и зашифрованный токен отдельного бота дежурных.

ALTER TABLE hdt_tickets ADD COLUMN oncall_notified_on timestamptz;
ALTER TABLE hdt_tickets ADD COLUMN update_reminded_on timestamptz;
COMMENT ON COLUMN hdt_tickets.oncall_notified_on IS 'Когда дежурным ушло сообщение о P1 без первого ответа. Сообщение одно на обращение';
COMMENT ON COLUMN hdt_tickets.update_reminded_on IS 'Когда исполнителю ушло напоминание о регулярном обновлении "В разработке" (FR-SLA-09). Ставит фоновая задача';

-- Секреты каналов, которые администратор задаёт в портале (решение 8): сейчас токен отдельного бота дежурных.
-- Значение зашифровано ключом ENCRYPTION_KEY, как секреты серверов Smartup. Читает только фоновая задача.
CREATE TABLE hdn_channel_secrets (
  code        text        NOT NULL,
  sealed      text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdn_channel_secrets_pk PRIMARY KEY (code),
  CONSTRAINT hdn_channel_secrets_c1 CHECK (code IN ('oncall_telegram_bot')),
  CONSTRAINT hdn_channel_secrets_c2 CHECK (sealed ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
);

COMMENT ON TABLE hdn_channel_secrets IS 'Секреты каналов уведомлений, заданные администратором в портале (решение 8 вехи M4)';
COMMENT ON COLUMN hdn_channel_secrets.code IS 'Что за секрет: oncall_telegram_bot (токен отдельного бота дежурных)';
COMMENT ON COLUMN hdn_channel_secrets.sealed IS 'Значение, зашифрованное ключом ENCRYPTION_KEY. Открытый текст база не принимает';
COMMENT ON COLUMN hdn_channel_secrets.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdn_channel_secrets.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdn_channel_secrets.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdn_channel_secrets.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdn_channel_secrets_stamp
  BEFORE INSERT OR UPDATE ON hdn_channel_secrets
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdn_channel_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdn_channel_secrets FORCE ROW LEVEL SECURITY;

-- Пишет тоже система: право администратора проверяет код экрана настроек (решение 8, запись в журнал аудита).
-- Запись от имени администратора потребовала бы права читать строку, а токен читает только фоновая задача.
CREATE POLICY hdn_channel_secrets_system_select ON hdn_channel_secrets FOR SELECT TO hub_app USING (app.actor_type() = 'system');
CREATE POLICY hdn_channel_secrets_system_insert ON hdn_channel_secrets FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdn_channel_secrets_system_update ON hdn_channel_secrets FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdn_channel_secrets_system_select ON hdn_channel_secrets IS 'Секрет читает только система: на экране токен не показывается';
COMMENT ON POLICY hdn_channel_secrets_system_insert ON hdn_channel_secrets IS 'Секрет записывает система после проверки, что действует администратор';
COMMENT ON POLICY hdn_channel_secrets_system_update ON hdn_channel_secrets IS 'Секрет меняет система после проверки, что действует администратор';

GRANT SELECT, INSERT, UPDATE ON hdn_channel_secrets TO hub_app;
