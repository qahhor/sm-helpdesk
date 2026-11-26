-- Счётчики идей, возврат пятёрки отбора и перенос голосов объединения без подмены актора (итоговая проверка M7,
-- пункты I1 и M2; решение 0065).
--
-- Было (миграции 0079, 0083): триггеры на время пересчёта ставили переменные актора системы (app.hdi_as_system) и
-- возвращали прежние. Это обход RLS на уровне базы, на который владелец не соглашался. Стало: функции SECURITY
-- DEFINER роли hub_hdi_counter (без входа, без BYPASSRLS, создаёт scripts/db/bootstrap.mjs). Переменные актора
-- функции не трогают. Роль видит только нужные колонки и меняет только vote_count, org_count, comment_count и status
-- (права на колонки); политики RLS для неё ровно на эти операции, FORCE остаётся. Триггер t_hdi_ideas_guard
-- пропускает от неё только счётчики и переход shortlisted -> open.
--
-- Функции принимают только идентификатор и сами решают по настоящим строкам: пересчёт ставит count(*), возврат
-- пятёрки идёт только у завершённого отбора и не трогает идеи открытого отбора, перенос голосов только у объединённой
-- идеи и только модератором. Поэтому прямой вызов функции из hub_app ничего не даёт (проверяет
-- tests/integration/isolation/ideas-counter-role.test.ts).
--
-- Перенос голосов при объединении теперь делает только app.hdi_merge_votes: политики модератора на вставку и удаление
-- голосов (hdi_votes_moderator_insert, hdi_votes_moderator_delete) удалены, взамен ничего (пункт M2).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_hdi_counter') THEN
    RAISE EXCEPTION 'Роль hub_hdi_counter не создана: выполните начальную настройку базы (scripts/db/bootstrap.mjs) и повторите миграции';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO hub_hdi_counter;
GRANT SELECT (idea_id, status, merged_into_id, vote_count, org_count, comment_count) ON hdi_ideas TO hub_hdi_counter;
GRANT UPDATE (vote_count, org_count, comment_count, status) ON hdi_ideas TO hub_hdi_counter;
GRANT SELECT (org_id, idea_id, user_id), INSERT (org_id, idea_id, user_id), DELETE ON hdi_votes TO hub_hdi_counter;
GRANT SELECT (idea_id, status) ON hdi_comments TO hub_hdi_counter;
GRANT SELECT (cycle_id, status, shortlist, selected_idea_id) ON hdi_cycles TO hub_hdi_counter;

CREATE POLICY hdi_ideas_counter_select ON hdi_ideas FOR SELECT TO hub_hdi_counter USING (true);
CREATE POLICY hdi_ideas_counter_update ON hdi_ideas FOR UPDATE TO hub_hdi_counter USING (true) WITH CHECK (true);
CREATE POLICY hdi_votes_counter_select ON hdi_votes FOR SELECT TO hub_hdi_counter USING (true);
CREATE POLICY hdi_votes_counter_insert ON hdi_votes FOR INSERT TO hub_hdi_counter
  WITH CHECK (EXISTS (SELECT 1 FROM hdi_ideas s WHERE s.merged_into_id = hdi_votes.idea_id AND s.status = 'merged'));
CREATE POLICY hdi_votes_counter_delete ON hdi_votes FOR DELETE TO hub_hdi_counter
  USING (EXISTS (SELECT 1 FROM hdi_ideas s WHERE s.idea_id = hdi_votes.idea_id AND s.status = 'merged'));
CREATE POLICY hdi_comments_counter_select ON hdi_comments FOR SELECT TO hub_hdi_counter USING (true);
CREATE POLICY hdi_cycles_counter_select ON hdi_cycles FOR SELECT TO hub_hdi_counter USING (true);
COMMENT ON POLICY hdi_ideas_counter_select ON hdi_ideas IS 'Роль пересчёта читает идеи (только колонки idea_id, status, merged_into_id и счётчики по правам)';
COMMENT ON POLICY hdi_ideas_counter_update ON hdi_ideas IS 'Роль пересчёта меняет только счётчики и возврат shortlisted -> open: колонки ограничены правами, переход проверяет t_hdi_ideas_guard';
COMMENT ON POLICY hdi_votes_counter_select ON hdi_votes IS 'Роль пересчёта считает голоса по всем организациям';
COMMENT ON POLICY hdi_votes_counter_insert ON hdi_votes IS 'Роль пересчёта переносит голоса только в идею, с которой объединена другая (app.hdi_merge_votes)';
COMMENT ON POLICY hdi_votes_counter_delete ON hdi_votes IS 'Роль пересчёта снимает голоса только у объединённой идеи после переноса (app.hdi_merge_votes)';
COMMENT ON POLICY hdi_comments_counter_select ON hdi_comments IS 'Роль пересчёта считает опубликованные комментарии (только колонки idea_id, status)';
COMMENT ON POLICY hdi_cycles_counter_select ON hdi_cycles IS 'Роль пересчёта читает снимок и выбор завершённого отбора (только колонки cycle_id, status, shortlist, selected_idea_id)';

DROP POLICY hdi_votes_moderator_insert ON hdi_votes;
DROP POLICY hdi_votes_moderator_delete ON hdi_votes;

-- ---------------------------------------------------------------------------
-- Функции роли hub_hdi_counter
-- ---------------------------------------------------------------------------
-- Блокировка NO KEY UPDATE: вставка голоса уже держит KEY SHARE на строке идеи (внешний ключ), FOR UPDATE с ней
-- конфликтует и дал бы взаимную блокировку параллельных голосов. Отдельная команда после блокировки: в READ
-- COMMITTED она видит голоса транзакций, закончившихся до блокировки.
CREATE FUNCTION app.hdi_recount_votes(idea uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  PERFORM 1 FROM public.hdi_ideas WHERE idea_id = idea FOR NO KEY UPDATE;
  UPDATE public.hdi_ideas i
     SET vote_count = (SELECT count(*) FROM public.hdi_votes v WHERE v.idea_id = i.idea_id),
         org_count = (SELECT count(DISTINCT v.org_id) FROM public.hdi_votes v WHERE v.idea_id = i.idea_id)
   WHERE i.idea_id = idea;
END
$$;
COMMENT ON FUNCTION app.hdi_recount_votes(uuid) IS 'Полный пересчёт vote_count и org_count идеи по таблице голосов под блокировкой строки идеи. Владелец hub_hdi_counter (решение 0065)';

CREATE FUNCTION app.hdi_recount_comments(idea uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  PERFORM 1 FROM public.hdi_ideas WHERE idea_id = idea FOR NO KEY UPDATE;
  UPDATE public.hdi_ideas i SET comment_count = (SELECT count(*) FROM public.hdi_comments c WHERE c.idea_id = i.idea_id AND c.status = 'published')
   WHERE i.idea_id = idea AND i.comment_count IS DISTINCT FROM (SELECT count(*) FROM public.hdi_comments c WHERE c.idea_id = i.idea_id AND c.status = 'published');
END
$$;
COMMENT ON FUNCTION app.hdi_recount_comments(uuid) IS 'Полный пересчёт comment_count идеи (только опубликованные) под блокировкой строки идеи. Владелец hub_hdi_counter (решение 0065)';

-- Возврат пятёрки завершённого отбора (план M7, решение 17): идеи снимка в шорт-листе, кроме выбранной, и только те,
-- которых нет в снимке открытого отбора. Шорт-лист ставит только снимок открытого отбора, поэтому для таких идей
-- open и есть верное состояние: повторный или поздний вызов ничего лишнего не меняет.
CREATE FUNCTION app.hdi_return_shortlist(closed_cycle uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  UPDATE public.hdi_ideas i
     SET status = 'open'
    FROM public.hdi_cycles c
   WHERE c.cycle_id = closed_cycle
     AND c.status IN ('decided', 'lapsed')
     AND i.status = 'shortlisted'
     AND c.shortlist @> jsonb_build_array(jsonb_build_object('ideaId', i.idea_id::text))
     AND i.idea_id IS DISTINCT FROM c.selected_idea_id
     AND NOT EXISTS (SELECT 1 FROM public.hdi_cycles o
                      WHERE o.status = 'open' AND o.shortlist @> jsonb_build_array(jsonb_build_object('ideaId', i.idea_id::text)));
END
$$;
COMMENT ON FUNCTION app.hdi_return_shortlist(uuid) IS 'Возврат в голосование идей пятёрки завершённого отбора, кроме выбранной и кроме идей открытого отбора. Владелец hub_hdi_counter (решение 0065)';

-- Перенос голосов объединённой идеи в цель (план M7, решение 6): только модератор (product, admin, система) и только
-- после того, как идея получила merged. Одним оператором без задвоения, затем голоса источника снимаются; счётчики
-- обеих идей пересчитывает триггер голосов. Возвращает число перенесённых голосов.
CREATE FUNCTION app.hdi_merge_votes(source uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
DECLARE
  target uuid;
  moved integer;
BEGIN
  IF NOT app.ideas_can_moderate() THEN
    RAISE EXCEPTION 'Голоса: переносит только модератор идей, остальным нельзя' USING ERRCODE = '42501';
  END IF;
  SELECT s.merged_into_id INTO target FROM public.hdi_ideas s WHERE s.idea_id = source AND s.status = 'merged';
  IF target IS NULL THEN
    RAISE EXCEPTION 'Голоса: переносятся только у объединённой идеи, у этой нельзя' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.hdi_votes (org_id, idea_id, user_id)
  SELECT v.org_id, target, v.user_id FROM public.hdi_votes v WHERE v.idea_id = source
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;
  DELETE FROM public.hdi_votes WHERE idea_id = source;
  RETURN moved;
END
$$;
COMMENT ON FUNCTION app.hdi_merge_votes(uuid) IS 'Перенос голосов объединённой идеи в цель модератором, без задвоения. Владелец hub_hdi_counter (решения 6 плана M7 и 0065)';

-- Вызывать функции может только hub_app (триггеры его транзакций), не PUBLIC. Права раздаются до передачи владения:
-- при передаче выданные права переходят к новому владельцу, а отозвать их потом hub_owner уже не может.
REVOKE ALL ON FUNCTION app.hdi_recount_votes(uuid), app.hdi_recount_comments(uuid), app.hdi_return_shortlist(uuid), app.hdi_merge_votes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.hdi_recount_votes(uuid), app.hdi_recount_comments(uuid), app.hdi_return_shortlist(uuid), app.hdi_merge_votes(uuid) TO hub_app;
-- Владелец функций hub_hdi_counter. Новому владельцу нужно право CREATE на схему только в момент передачи.
GRANT CREATE ON SCHEMA app TO hub_hdi_counter;
ALTER FUNCTION app.hdi_recount_votes(uuid) OWNER TO hub_hdi_counter;
ALTER FUNCTION app.hdi_recount_comments(uuid) OWNER TO hub_hdi_counter;
ALTER FUNCTION app.hdi_return_shortlist(uuid) OWNER TO hub_hdi_counter;
ALTER FUNCTION app.hdi_merge_votes(uuid) OWNER TO hub_hdi_counter;
REVOKE CREATE ON SCHEMA app FROM hub_hdi_counter;


-- ---------------------------------------------------------------------------
-- Триггеры вызывают функции роли вместо подмены актора
-- ---------------------------------------------------------------------------
-- Голос принимается и отзывается клиентом только в статусах open и shortlisted (решение 4; автор ещё и у своей идеи на
-- модерации: его голос ставится при подаче); перенос голосов при объединении (app.hdi_merge_votes) допускается в любую
-- опубликованную цель. Сначала блокировка и пересчёт каждой идеи по порядку идентификаторов, затем проверка статуса
-- уже после блокировки: голос, ждавший объединения, видит merged и отклоняется (пункт M1). Ошибка откатывает пересчёт
-- вместе с голосом. Один запуск на оператор.
CREATE OR REPLACE FUNCTION app.hdi_votes_count() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  actor CONSTANT text := app.actor_type();
  me CONSTANT uuid := app.user_uuid();
  ids uuid[];
  id uuid;
  own boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT idea_id ORDER BY idea_id), bool_or(user_id = me) INTO ids, own FROM new_rows;
  ELSE
    SELECT array_agg(DISTINCT idea_id ORDER BY idea_id) INTO ids FROM old_rows;
  END IF;
  IF ids IS NULL THEN
    RETURN NULL;
  END IF;
  IF actor NOT IN ('client', 'staff', 'system', 'none') OR (actor = 'staff' AND coalesce(own, false)) THEN
    RAISE EXCEPTION 'Голос: голосуют только клиенты, сотруднику нельзя' USING ERRCODE = '42501';
  END IF;
  FOREACH id IN ARRAY ids LOOP
    PERFORM app.hdi_recount_votes(id);
  END LOOP;
  -- Автор голосует за свою идею ещё на модерации: голос ставится сам при подаче (решение 4).
  -- Вложенные IF: права на колонки проверяются у всего запроса, а роль пересчёта (перенос голосов) author_id не читает.
  IF actor = 'client' THEN
    IF EXISTS (SELECT 1 FROM unnest(ids) AS x(id) WHERE NOT EXISTS (
         SELECT 1 FROM hdi_ideas i WHERE i.idea_id = x.id AND (i.status IN ('open', 'shortlisted') OR (i.status = 'pending_review' AND i.author_id = me)))) THEN
      RAISE EXCEPTION 'Голос: голосовать и отзывать голос можно только у идеи в голосовании, нельзя' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM unnest(ids) AS x(id) WHERE NOT EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = x.id AND i.status NOT IN ('pending_review', 'declined', 'merged'))) THEN
    RAISE EXCEPTION 'Голос: голос переносится только в опубликованную идею, нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_votes_count() IS 'Триггер: голос только клиента и только в голосовании (решения 3, 4), полный пересчёт vote_count и org_count функцией app.hdi_recount_votes';

CREATE OR REPLACE FUNCTION app.hdi_comments_count() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  ids uuid[];
  id uuid;
BEGIN
  SELECT array_agg(DISTINCT idea_id ORDER BY idea_id) INTO ids FROM new_rows;
  IF ids IS NULL THEN
    RETURN NULL;
  END IF;
  FOREACH id IN ARRAY ids LOOP
    PERFORM app.hdi_recount_comments(id);
  END LOOP;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_comments_count() IS 'Триггер: полный пересчёт comment_count (только опубликованные) функцией app.hdi_recount_comments';

CREATE OR REPLACE FUNCTION app.hdi_cycles_return_shortlist() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  PERFORM app.hdi_return_shortlist(NEW.cycle_id);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_cycles_return_shortlist() IS 'Триггер: при завершении отбора идеи пятёрки, кроме выбранной, возвращаются в голосование функцией app.hdi_return_shortlist (план M7, решение 17)';

-- Защита идеи: прежние правила (миграция 0079) и ветка роли hub_hdi_counter. Роль меняет только счётчики и возвращает
-- идею из шорт-листа в голосование; current_user подделать нельзя, войти под ролью нельзя.
CREATE OR REPLACE FUNCTION app.hdi_ideas_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  actor CONSTANT text := app.actor_type();
  client_cols CONSTANT text[] := ARRAY['module_id', 'show_org', 'author_org_name', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  staff_cols CONSTANT text[] := ARRAY['module_id', 'merged_into_id', 'decline_reason', 'findings_checked', 'selected_cycle', 'released_in', 'released_on',
                                      'status', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  counter_cols CONSTANT text[] := ARRAY['vote_count', 'org_count', 'comment_count', 'status', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  rule text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'hub_hdi_counter' THEN
      RAISE EXCEPTION 'Идея: роль пересчёта идей не создаёт, нельзя' USING ERRCODE = '42501';
    END IF;
    IF actor = 'client' THEN
      IF NEW.status <> 'pending_review' OR NEW.vote_count <> 0 OR NEW.org_count <> 0 OR NEW.comment_count <> 0 OR NEW.merged_into_id IS NOT NULL
         OR NEW.moderated_by IS NOT NULL OR NEW.decline_reason IS NOT NULL OR NEW.findings_checked OR NEW.selected_cycle IS NOT NULL
         OR NEW.released_in IS NOT NULL OR NEW.released_on IS NOT NULL OR NEW.published_on IS NOT NULL THEN
        RAISE EXCEPTION 'Идея: клиент подаёт только новую идею на модерацию без полей модератора, остальное нельзя' USING ERRCODE = '42501';
      END IF;
      IF NEW.author_name IS DISTINCT FROM (SELECT p.name FROM hdu_user_profiles p WHERE p.user_id = NEW.author_id) THEN
        RAISE EXCEPTION 'Идея: имя автора берётся из его профиля, другое нельзя' USING ERRCODE = '42501';
      END IF;
    ELSIF actor NOT IN ('system', 'none') THEN
      RAISE EXCEPTION 'Идея: подаёт только клиент, остальным нельзя' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.idea_id IS DISTINCT FROM OLD.idea_id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.original_locale IS DISTINCT FROM OLD.original_locale THEN
      RAISE EXCEPTION 'Идея: номер, автор, организация и язык оригинала не меняются, нельзя' USING ERRCODE = '42501';
    END IF;
    IF current_user = 'hub_hdi_counter' THEN
      IF (to_jsonb(NEW) - counter_cols) IS DISTINCT FROM (to_jsonb(OLD) - counter_cols)
         OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'shortlisted' AND NEW.status = 'open')) THEN
        RAISE EXCEPTION 'Идея: роль пересчёта меняет только счётчики и возвращает идею из шорт-листа, остальное нельзя' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF actor = 'client' THEN
      IF (to_jsonb(NEW) - client_cols) IS DISTINCT FROM (to_jsonb(OLD) - client_cols) THEN
        RAISE EXCEPTION 'Идея: клиенту менять эти поля нельзя' USING ERRCODE = '42501';
      END IF;
      IF NEW.module_id IS DISTINCT FROM OLD.module_id AND OLD.status <> 'pending_review' THEN
        RAISE EXCEPTION 'Идея: модуль автор меняет только до публикации, потом нельзя' USING ERRCODE = '42501';
      END IF;
    ELSIF actor = 'staff' THEN
      IF NOT app.ideas_can_moderate() THEN
        RAISE EXCEPTION 'Идея: менять идеи могут только product и admin, остальным нельзя' USING ERRCODE = '42501';
      END IF;
      IF (to_jsonb(NEW) - staff_cols) IS DISTINCT FROM (to_jsonb(OLD) - staff_cols) THEN
        RAISE EXCEPTION 'Идея: сотруднику менять эти поля нельзя (счётчики, автор, показ организации)' USING ERRCODE = '42501';
      END IF;
    ELSIF actor NOT IN ('system', 'none') THEN
      RAISE EXCEPTION 'Идея: менять нельзя' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      rule := app.hdi_idea_transition(OLD.status, NEW.status);
      IF rule IS NULL OR (rule = 'system' AND actor NOT IN ('system', 'none')) OR actor = 'client' THEN
        RAISE EXCEPTION 'Идея: переход из % в % нельзя', OLD.status, NEW.status USING ERRCODE = '42501';
      END IF;
      IF OLD.status = 'pending_review' THEN
        NEW.moderated_by := app.user_uuid();
        IF NEW.status = 'open' THEN
          NEW.published_on := now();
        END IF;
      END IF;
    END IF;
    IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id AND NEW.merged_into_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM hdi_ideas t WHERE t.idea_id = NEW.merged_into_id AND t.status NOT IN ('pending_review', 'declined', 'merged')) THEN
      RAISE EXCEPTION 'Идея: объединять можно только с опубликованной идеей, не отклонённой и не объединённой, с другой нельзя' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF actor = 'client' AND NEW.author_org_name IS DISTINCT FROM (CASE WHEN NEW.show_org THEN (SELECT o.name FROM hdu_organizations o WHERE o.org_id = NEW.org_id) END) THEN
    RAISE EXCEPTION 'Идея: название организации берётся из её карточки и только при показе, другое нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdi_ideas_guard() IS 'Триггер: что клиент, модератор, система и роль пересчёта hub_hdi_counter могут менять в идее; переходы статуса по app.hdi_idea_transition (план M7, решение 19; решение 0065)';

DROP FUNCTION app.hdi_as_system();
DROP FUNCTION app.hdi_restore_actor(text[]);

COMMENT ON COLUMN hdi_ideas.vote_count IS 'Число голосов. Меняет только функция app.hdi_recount_votes (триггер t_hdi_votes_count)';
COMMENT ON COLUMN hdi_ideas.org_count IS 'Число организаций, из которых есть хотя бы один голос. Меняет только функция app.hdi_recount_votes (триггер t_hdi_votes_count)';
COMMENT ON COLUMN hdi_ideas.comment_count IS 'Число опубликованных комментариев. Меняет только функция app.hdi_recount_comments (триггер t_hdi_comments_count)';
