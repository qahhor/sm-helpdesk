-- Веха M5c, независимая проверка: закрытие проблемы прямо из активного статуса (например, "Исправляем") оставляло
-- fixed_on пустым, и такая проблема не попадала в показатель "исправлено за период" (FR-MET-08). Теперь переход в
-- "Закрыто" без момента исправления ставит его в момент закрытия. Функция триггера заменяется целиком (миграция 0098
-- не правится); уже закрытые проблемы без момента исправления получают момент закрытия.

CREATE OR REPLACE FUNCTION app.hdp_problems_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  counted CONSTANT text[] := ARRAY['ticket_count', 'org_count', 'first_seen_on', 'last_seen_on', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  total integer;
  orgs integer;
  first_on timestamptz;
  last_on timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'investigating' AND NEW.status <> 'cause_found' AND NEW.status <> 'fixing' THEN
      RAISE EXCEPTION 'Проблема: новая проблема бывает только активной' USING ERRCODE = '42501';
    END IF;
    NEW.ticket_count := 0;
    NEW.org_count := 0;
    NEW.first_seen_on := NULL;
    NEW.last_seen_on := NULL;
    NEW.fixed_on := NULL;
    NEW.closed_on := NULL;
    RETURN NEW;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.problem_id IS DISTINCT FROM OLD.problem_id THEN
    RAISE EXCEPTION 'Проблема: номер не меняется' USING ERRCODE = '42501';
  END IF;
  -- Без актора пишут только миграции и суперпользователь (подготовка данных): у hub_app без актора нет доступа к
  -- строкам вовсе. Им моменты статуса ставятся только недостающие, пересчёта нет.
  IF app.actor_type() = 'none' THEN
    IF NEW.status = 'fixed' AND NEW.fixed_on IS NULL THEN NEW.fixed_on := now(); END IF;
    IF NEW.status = 'closed' AND NEW.fixed_on IS NULL THEN NEW.fixed_on := coalesce(NEW.closed_on, now()); END IF;
    IF NEW.status = 'closed' AND NEW.closed_on IS NULL THEN NEW.closed_on := now(); END IF;
    RETURN NEW;
  END IF;
  IF NOT app.hdp_can_write() AND (to_jsonb(NEW) - counted) IS DISTINCT FROM (to_jsonb(OLD) - counted) THEN
    RAISE EXCEPTION 'Проблема: менять проблему может только вторая линия, Customer Care и администратор' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'closed' AND (to_jsonb(NEW) - counted) IS DISTINCT FROM (to_jsonb(OLD) - counted) THEN
    RAISE EXCEPTION 'Проблема: закрытая проблема не меняется' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.fixed_on := CASE WHEN NEW.status = 'fixed' THEN now() WHEN NEW.status = 'closed' THEN coalesce(OLD.fixed_on, now()) ELSE NULL END;
    NEW.closed_on := CASE WHEN NEW.status = 'closed' THEN now() ELSE NULL END;
  ELSE
    NEW.fixed_on := OLD.fixed_on;
    NEW.closed_on := OLD.closed_on;
  END IF;
  SELECT count(*), count(DISTINCT t.org_id), min(t.created_on), max(t.created_on)
    INTO total, orgs, first_on, last_on
    FROM hdt_tickets t WHERE t.known_problem_id = NEW.problem_id;
  NEW.ticket_count := total;
  NEW.org_count := orgs;
  -- Все обращения отвязаны: моменты появления остаются прежними, история не теряется.
  NEW.first_seen_on := coalesce(first_on, OLD.first_seen_on);
  NEW.last_seen_on := coalesce(last_on, OLD.last_seen_on);
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdp_problems_guard() IS
  'Триггер: номер не меняется, закрытая проблема не меняется, моменты статуса ставит база (закрытие без исправления ставит и момент исправления), без права ведения меняется только пересчёт; счётчики и моменты появления пересчитываются по привязанным обращениям';

-- Закрытые раньше без момента исправления: момент закрытия. Без актора триггер ставит только недостающие моменты.
UPDATE hdp_problems SET fixed_on = closed_on WHERE status = 'closed' AND fixed_on IS NULL;
