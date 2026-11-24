-- hub:no-transaction
-- Индекс сигнала дежурным о заражённых файлах (план W3, итоговая проверка). Счёт идёт по времени проверки
-- (scanned_on, миграция 0050), а прежний индекс был по времени изменения строки и запросу больше не подходит.
-- Файл выполняется вне транзакции (решение 0039, пункт 1): таблица вложений большая, запись в неё не блокируется.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_attachments_i7 ON hdt_attachments (scanned_on) WHERE scan_status = 'infected';
DROP INDEX CONCURRENTLY IF EXISTS hdt_attachments_i6;
