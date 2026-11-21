-- Адрес запроса в журнале аудита у всех действий пользователей (проверка main, S5; ТЗ 14.3 "с какого адреса").
-- Сервис кладёт проверенный адрес посетителя в переменную транзакции вместе с актором, база ставит его
-- в запись журнала сама: адрес не нужно передавать в каждую функцию, и его нельзя забыть.
CREATE FUNCTION app.client_ip() RETURNS inet LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.client_ip', true), '')::inet $$;
COMMENT ON FUNCTION app.client_ip() IS 'Адрес посетителя текущего запроса из переменной транзакции. Пусто у фоновых задач и команды консоли';

ALTER TABLE hdc_audit_log ALTER COLUMN ip SET DEFAULT app.client_ip();

-- Просмотр журнала (FR-ADM-07) отбирает по времени и листает по паре "время, идентификатор" (проверка main, Q13).
CREATE INDEX hdc_audit_log_i4 ON hdc_audit_log (created_on DESC, audit_id DESC);
