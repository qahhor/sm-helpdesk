-- hub:no-transaction
-- Индексы поиска подсказки (ТЗ 10.4, 11.6; план M5, задача 9): полнотекстовый GIN по tsv, триграммный по заголовку и
-- HNSW по смысловому вектору (косинусное расстояние, как в запросе 11.6). Файл выполняется вне транзакции (решение
-- 0039, пункт 1), как drizzle/0052_text_search_indexes.sql: построение HNSW на большом индексе долгое, а запись
-- задания kb.index в это время не блокируется.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdk_search_documents_i3 ON hdk_search_documents USING gin (tsv);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdk_search_documents_i4 ON hdk_search_documents USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hdk_search_documents_i5 ON hdk_search_documents USING hnsw (embedding vector_cosine_ops);
