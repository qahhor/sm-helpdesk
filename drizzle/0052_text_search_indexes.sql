-- hub:no-transaction
-- Индексы поиска по тексту (вопрос 19, решение владельца 24.11.2026; решение 0041). Начальная настройка базы
-- отмечает функцию оператора ILIKE как безопасную, и PostgreSQL берёт эти индексы под политиками RLS.
-- Сотрудник ищет по теме и описанию обращения, по названию, ИНН и идентификатору компании организации.
-- Файл выполняется вне транзакции (решение 0039, пункт 1): таблицы большие, запись в них не блокируется.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i21 ON hdt_tickets USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdt_tickets_i22 ON hdt_tickets USING gin (description gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdu_organizations_i2 ON hdu_organizations USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdu_organizations_i3 ON hdu_organizations USING gin (inn gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdu_organizations_i4 ON hdu_organizations USING gin (external_company_id gin_trgm_ops);
