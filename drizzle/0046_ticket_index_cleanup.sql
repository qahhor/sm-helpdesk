-- hub:no-transaction
-- Индексы таблицы обращений (аудит 23.11.2026, находка P8; план W2, задача 3). Файл выполняется вне транзакции:
-- индексы строятся и удаляются без остановки записи в таблицу (решение 0039, пункт 1).
--
-- Подпись ошибки, основное обращение дубля и связанное обращение у большинства строк пусты. Полный индекс хранил
-- запись и для пустого значения, и каждое обновление строки её переписывало. Частичный индекс хранит только
-- заполненные значения: поиск по значению и проверка внешнего ключа работают как раньше.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i18 ON hdt_tickets (error_signature) WHERE error_signature IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i19 ON hdt_tickets (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i20 ON hdt_tickets (related_ticket_id) WHERE related_ticket_id IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS hdt_tickets_i9;
DROP INDEX CONCURRENTLY IF EXISTS hdt_tickets_i10;
DROP INDEX CONCURRENTLY IF EXISTS hdt_tickets_i11;
-- Срок решения ищется только у открытых обращений: для них есть частичный hdt_tickets_i13 (status, resolution_due_on).
DROP INDEX CONCURRENTLY IF EXISTS hdt_tickets_i8;
