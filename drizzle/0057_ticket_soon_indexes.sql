-- hub:no-transaction
-- Индексы задачи раз в минуту для события "срок SLA скоро" (план M8, задача 2): обращения, у которых наступил момент
-- "срок близко" (колонки миграции 0056). Частичные: в них только обращения, которые ждут события.
-- Файл выполняется вне транзакции (решение 0039, пункт 1): таблица обращений большая, запись в неё не блокируется.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i23 ON hdt_tickets (first_response_soon_on) WHERE first_response_soon_on IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i24 ON hdt_tickets (resolution_soon_on) WHERE resolution_soon_on IS NOT NULL;
