-- Схема фоновых задач pg-boss (раздел 11.10, решение 0028). Таблицы создаёт и обновляет сама библиотека
-- от роли hub_owner (scripts/db/pgboss.mjs) после SQL-миграций. Портал и фоновый процесс работают под hub_app:
-- они ставят и берут задачи, но не создают и не меняют объекты схемы.
--
-- Файл выполняется повторно после каждой установки pg-boss, поэтому каждая команда в нём повторяема.
-- Таблицы pg-boss не предметные и в набор изоляции не входят: в задачах только идентификаторы.

CREATE SCHEMA IF NOT EXISTS pgboss;
COMMENT ON SCHEMA pgboss IS 'Очередь фоновых задач pg-boss (решение 0028). Объекты создаёт hub_owner, hub_app только читает и пишет строки';

REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE ON SCHEMA pgboss TO hub_app;

-- Таблицы, последовательности и функции, которые pg-boss создаст позже от hub_owner.
ALTER DEFAULT PRIVILEGES FOR ROLE hub_owner IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hub_owner IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hub_owner IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO hub_app;

-- Уже созданные объекты (повторный запуск после обновления pg-boss).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO hub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO hub_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO hub_app;
