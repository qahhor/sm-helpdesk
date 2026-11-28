-- search_path функций SECURITY DEFINER оканчивается на pg_temp (волна 7, находка S-A2 проверки на инъекции;
-- решение 0156). Функция с правами владельца, у которой в search_path нет pg_temp, ищет таблицы и типы сначала во
-- временной схеме вызывающего: временная таблица с именем таблицы портала подменила бы её внутри функции. Права TEMP
-- у ролей приложения нет (scripts/db/bootstrap.mjs: REVOKE ALL ON DATABASE ... FROM PUBLIC), это вторая линия.
--
-- Применённые миграции не правятся, поэтому путь меняется командой ALTER FUNCTION ... SET search_path у каждой
-- функции SECURITY DEFINER владельца миграций: прежний путь и pg_temp в конце. Новая функция SECURITY DEFINER пишет
-- pg_temp в своём определении: это проверяет тест tests/integration/db-roles.test.ts.

-- Функции счётчиков идей принадлежат роли hub_hdi_counter (миграция 0084): их путь меняет она сама, владелец
-- миграций переключается на неё на время команды (членство WITH SET TRUE из начальной настройки).

DO $$
DECLARE
  f record;
  new_path text;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature,
           pg_get_userbyid(p.proowner) AS owner,
           (SELECT substring(c FROM 13) FROM unnest(p.proconfig) AS c WHERE c LIKE 'search_path=%') AS path
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND (pg_get_userbyid(p.proowner) = current_user OR pg_has_role(current_user, p.proowner, 'SET'))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    CONTINUE WHEN f.path ~ '(^|,\s*)pg_temp$';
    new_path := coalesce(f.path, 'pg_catalog, public') || ', pg_temp';
    IF f.owner <> current_user THEN
      EXECUTE format('SET LOCAL ROLE %I', f.owner);
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s', f.signature, new_path);
    RESET ROLE;
  END LOOP;
END
$$;
