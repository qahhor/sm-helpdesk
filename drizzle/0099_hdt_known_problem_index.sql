-- hub:no-transaction
-- Обращения известной проблемы (веха M5c, задача 1): пересчёт счётчиков проблемы, вкладка "Обращения" карточки и
-- рассылка ищут обращения по known_problem_id. Индекс частичный: обычное обращение к проблеме не привязано и в него
-- не входит, обновление такого обращения индекс не пишет (тест tests/integration/ticket-indexes.test.ts).
-- Файл выполняется вне транзакции (решение 0039, пункт 1): таблица обращений большая, запись в неё не блокируется.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i28
  ON hdt_tickets (known_problem_id)
  WHERE known_problem_id IS NOT NULL;
