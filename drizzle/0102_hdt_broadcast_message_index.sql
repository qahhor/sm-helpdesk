-- hub:no-transaction
-- Сообщения рассылки по известной проблеме (веха M5c, задача 5, решение 18). Уникальная пара "обращение, рассылка":
-- база не даёт второго сообщения одной рассылки в обращении даже при двух одновременных задачах. Второй индекс по
-- внешнему ключу broadcast_id. Оба частичные: обычное сообщение в них не входит. Вне транзакции (решение 0039, пункт 1).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS hdt_ticket_messages_u2 ON hdt_ticket_messages (ticket_id, broadcast_id) WHERE broadcast_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_ticket_messages_i4 ON hdt_ticket_messages (broadcast_id) WHERE broadcast_id IS NOT NULL;
