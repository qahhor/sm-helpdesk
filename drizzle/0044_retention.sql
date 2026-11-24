-- Сроки хранения служебных данных почты и индекс отметки "Письмо не доставлено"
-- (аудит 23.11.2026, находка P6; план W1, задача 4).
-- Отправленные строки очереди исходящих хранят текст письма: через 30 суток он больше не нужен.
-- Разобранные входящие письма (адрес, тема, заголовки) через 90 суток не нужны ни для повторов, ни для цепочек:
-- цепочки живут в hdn_email_threads. Удаляет только ночная очистка под системным актором.

-- Страница обращения сотрудника ищет не доставленные письма по сообщению.
CREATE INDEX hdn_outbox_i4 ON hdn_outbox (message_id) WHERE status = 'failed' AND channel = 'email';

GRANT DELETE ON hdn_outbox TO hub_app;
CREATE POLICY hdn_outbox_system_delete ON hdn_outbox FOR DELETE TO hub_app
  USING (app.actor_type() = 'system' AND status IN ('sent', 'delivered', 'skipped'));
COMMENT ON POLICY hdn_outbox_system_delete ON hdn_outbox IS 'Ночная очистка удаляет только отправленные и пропущенные строки; ждущие и не отправленные остаются';

GRANT DELETE ON hdn_email_inbound TO hub_app;
CREATE POLICY hdn_email_inbound_system_delete ON hdn_email_inbound FOR DELETE TO hub_app
  USING (app.actor_type() = 'system' AND processed_on IS NOT NULL);
COMMENT ON POLICY hdn_email_inbound_system_delete ON hdn_email_inbound IS 'Ночная очистка удаляет только разобранные письма';
