-- Запасное письмо к сообщению в Telegram (итоговая проверка M4b, замечание I1; решение 0036, пункт 3).
-- Если клиент выключил письма о своих обращениях, письмо об этом событии всё равно ставится, но ждёт 5 минут и
-- уходит, только если связанная строка Telegram не отправлена (бот заблокирован, Telegram недоступен, отвязка).

ALTER TABLE hdn_outbox ADD COLUMN fallback_for uuid;
ALTER TABLE hdn_outbox
  ADD CONSTRAINT hdn_outbox_f3 FOREIGN KEY (fallback_for) REFERENCES hdn_outbox (outbox_id) ON DELETE SET NULL;
ALTER TABLE hdn_outbox ADD CONSTRAINT hdn_outbox_c11 CHECK (fallback_for IS NULL OR channel = 'email');
COMMENT ON COLUMN hdn_outbox.fallback_for IS 'Строка Telegram, к которой это письмо запасное: письмо уходит, только если она не отправлена';
