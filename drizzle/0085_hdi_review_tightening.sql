-- Ужесточения по итоговой проверке M7 (пункты M3 и M6; решение 0065). Политики только сужаются.
--
-- M3. Роль product заводит задачу разработки для выбранной идеи (политика hdw_dev_tasks_moderator_insert, миграция
-- 0082). Теперь только открытую (todo, in_progress), без отметки напоминания о закрытии и без даты сверки: дату сверки
-- ставит только задача из API таск-менеджера при создании (не позже текущего момента). Оригинал текста опубликованной
-- идеи не меняет никто, кроме миграций и суперпользователя (план M7, решение 5: модератор правит до публикации).
--
-- M6. Машинный черновик объяснения отбора на узбекском и английском: отметка по языку. Ставит сотрудник, сохраняя
-- черновик без правки; снимается, когда он правит текст этого языка или отмечает его проверенным. Пока отметка стоит,
-- клиент видит объяснение с пометкой "Машинный перевод".

ALTER POLICY hdw_dev_tasks_moderator_insert ON hdw_dev_tasks
  WITH CHECK (
    app.actor_type() = 'staff' AND app.staff_role() = 'product'
    AND status IN ('todo', 'in_progress') AND closed_notified_on IS NULL
    AND (synced_on IS NULL OR (tracker = 'smartup' AND synced_on <= now()))
  );
COMMENT ON POLICY hdw_dev_tasks_moderator_insert ON hdw_dev_tasks IS 'Роль product заводит открытую задачу разработки для выбранной идеи (план M7, решение 18; решение 0065): без отметки напоминания, дату сверки только у задачи API. Статус задачи она не меняет';

-- Прежние правила (миграция 0079) и запрет правки оригинала опубликованной идеи.
CREATE OR REPLACE FUNCTION app.hdi_idea_translations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  client_cols CONSTANT text[] := ARRAY['title', 'body', 'source_hash', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.actor_type() = 'client' AND (NEW.status <> 'original' OR NEW.is_machine) THEN
      RAISE EXCEPTION 'Перевод идеи: клиент пишет только оригинал, остальное нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.idea_id IS DISTINCT FROM OLD.idea_id OR NEW.locale IS DISTINCT FROM OLD.locale THEN
    RAISE EXCEPTION 'Перевод идеи: идея и язык не меняются, нельзя' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'client' AND (to_jsonb(NEW) - client_cols) IS DISTINCT FROM (to_jsonb(OLD) - client_cols) THEN
    RAISE EXCEPTION 'Перевод идеи: клиенту менять эти поля нельзя' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'original' AND app.actor_type() <> 'none'
     AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
          OR NEW.status IS DISTINCT FROM OLD.status OR NEW.is_machine IS DISTINCT FROM OLD.is_machine)
     AND NOT EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = NEW.idea_id AND i.status = 'pending_review') THEN
    RAISE EXCEPTION 'Перевод идеи: оригинал опубликованной идеи не меняется, нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdi_idea_translations_guard() IS 'Триггер: клиент пишет только текст оригинала, оригинал меняется только у идеи на модерации, идея и язык строки не меняются (решение 0065)';

ALTER TABLE hdi_cycles ADD COLUMN explanation_uz_machine boolean NOT NULL DEFAULT false;
ALTER TABLE hdi_cycles ADD COLUMN explanation_en_machine boolean NOT NULL DEFAULT false;
ALTER TABLE hdi_cycles ADD CONSTRAINT hdi_cycles_c8 CHECK ((NOT explanation_uz_machine OR explanation_uz IS NOT NULL) AND (NOT explanation_en_machine OR explanation_en IS NOT NULL));
COMMENT ON COLUMN hdi_cycles.explanation_uz_machine IS 'Объяснение на узбекском сохранено из машинного черновика без правки и не отмечено проверенным: клиент видит пометку "Машинный перевод"';
COMMENT ON COLUMN hdi_cycles.explanation_en_machine IS 'Объяснение на английском сохранено из машинного черновика без правки и не отмечено проверенным: клиент видит пометку "Машинный перевод"';
COMMENT ON CONSTRAINT hdi_cycles_c8 ON hdi_cycles IS 'Отметка машинного черновика только при тексте этого языка';

-- Прежние правила (миграция 0079); сотрудник при выборе ставит и отметки машинного черновика.
CREATE OR REPLACE FUNCTION app.hdi_cycles_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  staff_cols CONSTANT text[] := ARRAY['selected_idea_id', 'decided_by', 'explanation_ru', 'explanation_uz', 'explanation_en', 'explanation_uz_machine', 'explanation_en_machine',
                                      'decided_on', 'status', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF NEW.cycle IS DISTINCT FROM OLD.cycle OR NEW.shortlist IS DISTINCT FROM OLD.shortlist OR NEW.vote_mode IS DISTINCT FROM OLD.vote_mode
     OR NEW.leader_idea_id IS DISTINCT FROM OLD.leader_idea_id THEN
    RAISE EXCEPTION 'Отбор: снимок, месяц, способ подсчёта и лидер не меняются, нельзя' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Отбор: завершённый отбор не меняется, нельзя' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'staff' THEN
    IF (to_jsonb(NEW) - staff_cols) IS DISTINCT FROM (to_jsonb(OLD) - staff_cols) OR NEW.status <> 'decided' THEN
      RAISE EXCEPTION 'Отбор: сотрудник только выбирает идею месяца, остальное нельзя' USING ERRCODE = '42501';
    END IF;
    NEW.decided_by := app.user_uuid();
  END IF;
  IF NEW.status = 'decided' THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.shortlist) e WHERE e ->> 'ideaId' = NEW.selected_idea_id::text) THEN
      RAISE EXCEPTION 'Отбор: выбрать можно только идею из пятёрки, нельзя' USING ERRCODE = '42501';
    END IF;
    NEW.decided_on := now();
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdi_cycles_guard() IS 'Триггер: сотрудник только выбирает идею из снимка (с объяснениями и отметками машинного черновика), завершённый отбор не меняется (план M7, решения 16, 17)';
