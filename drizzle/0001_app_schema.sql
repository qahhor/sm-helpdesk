-- Основа изоляции данных (ТЗ, раздел 10.3).
-- Сервис сообщает базе, от чьего имени идёт запрос: withActor записывает значения
-- в переменные транзакции, функции ниже их читают, политики RLS на них опираются.
-- Если переменные не заданы, app.actor_type() возвращает 'none' и политики не отдают ничего.

-- Блок из раздела 10.3 ТЗ, без изменений.
CREATE SCHEMA app;

CREATE FUNCTION app.actor_type() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.actor_type', true), ''), 'none') $$;

CREATE FUNCTION app.user_id() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '') $$;

CREATE FUNCTION app.org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app.org_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_role', true), '') $$;

CREATE FUNCTION app.staff_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.staff_role', true), '') $$;

CREATE FUNCTION app.is_internal() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() IN ('staff', 'system') $$;

GRANT USAGE ON SCHEMA app TO hub_app;

-- Дополнение к блоку ТЗ: служебные колонки (docs/naming.md, раздел 3).
-- Кто и когда создал и изменил строку, записывает база. Значения, присланные сервисом,
-- отбрасываются: автора и время создания нельзя подделать или переписать.
CREATE FUNCTION app.stamp_row() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := app.user_id();
    NEW.created_on := now();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_on := OLD.created_on;
  END IF;
  NEW.modified_by := app.user_id();
  NEW.modified_on := now();
  RETURN NEW;
END
$$;

COMMENT ON SCHEMA app IS 'Функции изоляции данных: кто выполняет запрос (ТЗ 10.3)';
COMMENT ON FUNCTION app.actor_type() IS 'Вид актора: client, staff, system, agent. Если актор не задан: none';
COMMENT ON FUNCTION app.user_id() IS 'Идентификатор пользователя актора. У системы и AI-сотрудника пусто';
COMMENT ON FUNCTION app.org_id() IS 'Организация клиента. У остальных акторов пусто';
COMMENT ON FUNCTION app.org_role() IS 'Роль клиента в организации: client_user или client_admin';
COMMENT ON FUNCTION app.staff_role() IS 'Роль сотрудника: agent_l1, agent_l2, care, product, admin';
COMMENT ON FUNCTION app.is_internal() IS 'Истина для сотрудника и фоновой задачи';
COMMENT ON FUNCTION app.stamp_row() IS 'Триггер служебных колонок created_by, created_on, modified_by, modified_on';
