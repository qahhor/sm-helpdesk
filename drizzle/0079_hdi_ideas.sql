-- Идеи (ТЗ 7.7 FR-IDEA-01..16, 10.2, 10.3, 10.5, 15.2; план M7, задача 1, решения 1-12, 19, 23). Имена: docs/naming.md,
-- соответствие логических имён (ideas, idea_translations, idea_votes, idea_comments, idea_subscriptions, idea_cycles)
-- в плане M7, решение 1.
--
-- Главное отличие от обращений: опубликованная идея общая для клиентов всех организаций (FR-IDEA-06), поэтому
-- политика чтения идеи у клиента не ограничена организацией. Граница проходит по статусу: опубликованную идею видят
-- все клиенты, идею на модерации только автор, отклонённую автор и (если она была опубликована) проголосовавшие и
-- подписчики (решение 2). Голоса и подписки видны только их владельцу, разбивка голосов только сотрудникам.
--
-- Счётчики голосов, организаций и комментариев меняют только триггеры этой миграции. Голос клиента не видит чужих
-- голосов, а число организаций нужно считать по всем, поэтому пересчёт идёт от имени системы: триггер на время
-- пересчёта ставит переменные актора системы и возвращает прежние (app.hdi_as_system). Переменные актора ставит
-- только withActor, своего SQL у клиента нет, поэтому новой возможности приём не открывает. Пересчёт полный
-- (count(*)) под блокировкой строки идеи: счётчик не расходится с таблицей ни при параллельных голосах, ни после
-- объединения (план M7, на что смотреть при проверке, пункт 2).
--
-- Права сотрудников: модерацию, правку до публикации, смену статуса и отбор месяца делают product и admin (и система).
-- Остальные роли идеи только читают и отвечают в комментариях со значком Smartup (решение 8). Роль product получает
-- право записи только в таблицы hdi (решение 0031 для обращений не меняется).
--
-- Здесь же: удаление строк индекса идей модератором в транзакции отклонения и объединения (решение 23) и цель вызова
-- модели idea_translation (решение 11).

CREATE FUNCTION app.ideas_can_moderate() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('product', 'admin')) $$;
COMMENT ON FUNCTION app.ideas_can_moderate() IS 'Истина для системы и модератора идей: product, admin (план M7, решения 5, 17, 18)';

-- Пересчёт счётчиков от имени системы (см. шапку). Пользователь актора остаётся: служебные колонки показывают, чьё
-- действие вызвало пересчёт.
CREATE FUNCTION app.hdi_as_system() RETURNS text[] LANGUAGE plpgsql AS
$$
DECLARE
  prev text[] := ARRAY[current_setting('app.actor_type', true), current_setting('app.org_id', true),
                       current_setting('app.org_role', true), current_setting('app.staff_role', true)];
BEGIN
  PERFORM set_config('app.actor_type', 'system', true), set_config('app.org_id', '', true),
          set_config('app.org_role', '', true), set_config('app.staff_role', '', true);
  RETURN prev;
END
$$;
COMMENT ON FUNCTION app.hdi_as_system() IS 'Ставит переменные актора системы до конца пересчёта счётчиков идей и возвращает прежние. Вызывают только триггеры hdi';

CREATE FUNCTION app.hdi_restore_actor(prev text[]) RETURNS void LANGUAGE plpgsql AS
$$
BEGIN
  PERFORM set_config('app.actor_type', coalesce(prev[1], ''), true), set_config('app.org_id', coalesce(prev[2], ''), true),
          set_config('app.org_role', coalesce(prev[3], ''), true), set_config('app.staff_role', coalesce(prev[4], ''), true);
END
$$;
COMMENT ON FUNCTION app.hdi_restore_actor(text[]) IS 'Возвращает переменные актора, сохранённые app.hdi_as_system';

CREATE SEQUENCE hdi_ideas_sq START 1;
COMMENT ON SEQUENCE hdi_ideas_sq IS 'Номера идей для адреса /ideas/<номер> и показа I-<номер> (план M7, решение 1). Пропуски возможны';

-- ---------------------------------------------------------------------------
-- hdi_ideas: идеи
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_ideas (
  org_id           uuid        NOT NULL,
  idea_id          uuid        NOT NULL DEFAULT uuidv7(),
  author_id        uuid        NOT NULL,
  module_id        uuid,
  merged_into_id   uuid,
  moderated_by     uuid,
  number           bigint      NOT NULL DEFAULT nextval('hdi_ideas_sq'),
  author_name      text        NOT NULL,
  author_org_name  text,
  show_org         boolean     NOT NULL DEFAULT false,
  original_locale  text        NOT NULL,
  vote_count       integer     NOT NULL DEFAULT 0,
  org_count        integer     NOT NULL DEFAULT 0,
  comment_count    integer     NOT NULL DEFAULT 0,
  decline_reason   text,
  findings_checked boolean     NOT NULL DEFAULT false,
  selected_cycle   date,
  released_in      text,
  released_on      date,
  published_on     timestamptz,
  status           text        NOT NULL DEFAULT 'pending_review',
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdi_ideas_pk PRIMARY KEY (idea_id),
  CONSTRAINT hdi_ideas_f1 FOREIGN KEY (org_id, author_id) REFERENCES hdu_memberships (org_id, user_id),
  CONSTRAINT hdi_ideas_f2 FOREIGN KEY (author_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdi_ideas_f3 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdi_ideas_f4 FOREIGN KEY (merged_into_id) REFERENCES hdi_ideas (idea_id),
  CONSTRAINT hdi_ideas_f5 FOREIGN KEY (moderated_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hdi_ideas_u1 UNIQUE (number),
  -- Цель составного внешнего ключа вложений: вложение принадлежит организации автора идеи.
  CONSTRAINT hdi_ideas_u2 UNIQUE (idea_id, org_id),
  CONSTRAINT hdi_ideas_c1 CHECK (status IN ('pending_review', 'open', 'shortlisted', 'selected', 'in_development', 'released', 'declined', 'merged')),
  CONSTRAINT hdi_ideas_c2 CHECK (original_locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdi_ideas_c3 CHECK (vote_count >= 0 AND org_count >= 0 AND org_count <= vote_count AND comment_count >= 0),
  CONSTRAINT hdi_ideas_c4 CHECK (char_length(author_name) BETWEEN 1 AND 200 AND (author_org_name IS NULL OR char_length(author_org_name) BETWEEN 1 AND 300)),
  -- Название организации лежит снимком только при включённом показе (решение 7).
  CONSTRAINT hdi_ideas_c5 CHECK (show_org OR author_org_name IS NULL),
  CONSTRAINT hdi_ideas_c6 CHECK ((status = 'declined') = (decline_reason IS NOT NULL) AND (decline_reason IS NULL OR char_length(decline_reason) BETWEEN 1 AND 1000)),
  CONSTRAINT hdi_ideas_c7 CHECK ((status = 'merged') = (merged_into_id IS NOT NULL) AND merged_into_id IS DISTINCT FROM idea_id),
  -- Опубликованные статусы всегда с датой публикации; на модерации её нет. Отклонённая и объединённая могли не
  -- побывать опубликованными: по дате видно, была ли публикация (решение 2).
  CONSTRAINT hdi_ideas_c8 CHECK (CASE WHEN status = 'pending_review' THEN published_on IS NULL
                                      WHEN status IN ('open', 'shortlisted', 'selected', 'in_development', 'released') THEN published_on IS NOT NULL
                                      ELSE true END),
  CONSTRAINT hdi_ideas_c9 CHECK (selected_cycle IS NULL OR extract(day FROM selected_cycle) = 1),
  CONSTRAINT hdi_ideas_c10 CHECK ((status <> 'released' OR (released_in IS NOT NULL AND released_on IS NOT NULL))
                                  AND (released_in IS NULL OR char_length(released_in) BETWEEN 1 AND 40))
);

CREATE INDEX hdi_ideas_i1 ON hdi_ideas (org_id, author_id);
CREATE INDEX hdi_ideas_i2 ON hdi_ideas (author_id);
CREATE INDEX hdi_ideas_i3 ON hdi_ideas (merged_into_id);
CREATE INDEX hdi_ideas_i4 ON hdi_ideas (moderated_by);
-- Вкладки доски (решение 22): популярные по выбранному способу подсчёта, новые по дате публикации, фильтр модуля.
CREATE INDEX hdi_ideas_i5 ON hdi_ideas (status, vote_count DESC, created_on);
CREATE INDEX hdi_ideas_i6 ON hdi_ideas (status, org_count DESC, created_on);
CREATE INDEX hdi_ideas_i7 ON hdi_ideas (status, published_on DESC);
CREATE INDEX hdi_ideas_i8 ON hdi_ideas (module_id, status);

COMMENT ON TABLE hdi_ideas IS 'Идеи клиентов по улучшению Smartup (ТЗ 7.7). Опубликованные видят клиенты всех организаций, на модерации только автор (решение 2)';
COMMENT ON COLUMN hdi_ideas.org_id IS 'Организация автора на момент подачи. Клиентам не показывается, пока автор не включит show_org';
COMMENT ON COLUMN hdi_ideas.idea_id IS 'Идентификатор идеи';
COMMENT ON COLUMN hdi_ideas.author_id IS 'Автор (клиент). Берётся из актора, не из запроса';
COMMENT ON COLUMN hdi_ideas.module_id IS 'Модуль Smartup из справочника. Пусто: автор не выбрал';
COMMENT ON COLUMN hdi_ideas.merged_into_id IS 'Идея, с которой объединена эта (статус merged). Цепочек нет: цель не бывает объединённой (решение 6)';
COMMENT ON COLUMN hdi_ideas.moderated_by IS 'Сотрудник, который опубликовал, отклонил или объединил идею с модерации. Ставит база';
COMMENT ON COLUMN hdi_ideas.number IS 'Номер для адреса и показа I-<номер>. Задаёт база, не меняется';
COMMENT ON COLUMN hdi_ideas.author_name IS 'Имя автора снимком при подаче (решение 7): представление профилей не отдаёт клиенту людей чужих организаций';
COMMENT ON COLUMN hdi_ideas.author_org_name IS 'Название организации автора снимком, только при show_org. Иначе пусто: в ответах и индексе названия нет';
COMMENT ON COLUMN hdi_ideas.show_org IS 'Автор разрешил показывать название своей организации (FR-IDEA-06). Меняет автор в любой момент';
COMMENT ON COLUMN hdi_ideas.original_locale IS 'Язык оригинала: ru, uz, en. Оригинал лежит строкой hdi_idea_translations';
COMMENT ON COLUMN hdi_ideas.vote_count IS 'Число голосов. Меняет только триггер t_hdi_votes_count';
COMMENT ON COLUMN hdi_ideas.org_count IS 'Число организаций, из которых есть хотя бы один голос. Меняет только триггер t_hdi_votes_count';
COMMENT ON COLUMN hdi_ideas.comment_count IS 'Число опубликованных комментариев. Меняет только триггер t_hdi_comments_count';
COMMENT ON COLUMN hdi_ideas.decline_reason IS 'Причина отклонения на языке модератора, до 1000 знаков. Показывается автору. Есть только у отклонённой';
COMMENT ON COLUMN hdi_ideas.findings_checked IS 'Модератор отметил "Проверено" при находках проверки личных и служебных данных (решение 9)';
COMMENT ON COLUMN hdi_ideas.selected_cycle IS 'Первое число месяца отбора, в котором идея выбрана "Идеей месяца"';
COMMENT ON COLUMN hdi_ideas.released_in IS 'Версия Smartup, в которой идея выпущена (статус released)';
COMMENT ON COLUMN hdi_ideas.released_on IS 'Дата выпуска';
COMMENT ON COLUMN hdi_ideas.published_on IS 'Когда идея опубликована модератором. Ставит база при переходе из модерации в голосование';
COMMENT ON COLUMN hdi_ideas.status IS 'pending_review, open (голосование), shortlisted, selected, in_development, released, declined, merged (FR-IDEA-08). Переходы держит триггер t_hdi_ideas_guard';
COMMENT ON COLUMN hdi_ideas.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_ideas.created_on IS 'Когда идея подана. Заполняет база. При равенстве голосов выше идея, поданная раньше (FR-IDEA-09)';
COMMENT ON COLUMN hdi_ideas.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_ideas.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
ALTER SEQUENCE hdi_ideas_sq OWNED BY hdi_ideas.number;

CREATE TRIGGER t_hdi_ideas_stamp
  BEFORE INSERT OR UPDATE ON hdi_ideas
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Переходы статуса (решение 19; тот же перечень IDEA_TRANSITIONS в src/modules/hdi/pref.ts, тест сверяет их). by:
-- moderator (product, admin и система) или system (только система: шорт-лист ставит и снимает отбор месяца).
CREATE FUNCTION app.hdi_idea_transition(from_status text, to_status text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$
  SELECT t.by FROM (VALUES
    ('pending_review', 'open', 'moderator'), ('pending_review', 'declined', 'moderator'), ('pending_review', 'merged', 'moderator'),
    ('open', 'declined', 'moderator'), ('open', 'merged', 'moderator'), ('open', 'shortlisted', 'system'),
    ('shortlisted', 'open', 'system'), ('shortlisted', 'selected', 'moderator'), ('shortlisted', 'declined', 'moderator'),
    ('selected', 'in_development', 'moderator'), ('selected', 'declined', 'moderator'),
    ('in_development', 'released', 'moderator'), ('in_development', 'declined', 'moderator')
  ) AS t(from_status, to_status, by)
  WHERE t.from_status = $1 AND t.to_status = $2
$$;
COMMENT ON FUNCTION app.hdi_idea_transition(text, text) IS 'Кто может перевести идею из статуса в статус: moderator, system или пусто (переход запрещён). План M7, решение 19';

-- Клиент создаёт только свою идею на модерации без полей модератора, с именем из своего профиля и названием своей
-- организации (только при show_org). Меняет он только модуль своей идеи на модерации и показ организации. Сотрудник
-- (только product, admin) меняет статус по таблице переходов, причину, модуль, отметку находок, отбор и выпуск.
-- Счётчики пишет только система (триггеры пересчёта). Номер, автор, организация и язык оригинала не меняются никем.
-- Без актора (none) в базу ходят только миграции и суперпользователь тестов: роль hub_app без актора не видит строк.
CREATE FUNCTION app.hdi_ideas_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  actor CONSTANT text := app.actor_type();
  client_cols CONSTANT text[] := ARRAY['module_id', 'show_org', 'author_org_name', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  staff_cols CONSTANT text[] := ARRAY['module_id', 'merged_into_id', 'decline_reason', 'findings_checked', 'selected_cycle', 'released_in', 'released_on',
                                      'status', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  rule text;
BEGIN
  IF TG_OP = 'INSERT' THEN
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
COMMENT ON FUNCTION app.hdi_ideas_guard() IS 'Триггер: что клиент, модератор и система могут менять в идее; переходы статуса по app.hdi_idea_transition (план M7, решение 19)';

CREATE TRIGGER t_hdi_ideas_guard
  BEFORE INSERT OR UPDATE ON hdi_ideas
  FOR EACH ROW EXECUTE FUNCTION app.hdi_ideas_guard();

-- Голос или подписка пользователя на идею. Функция, а не подзапрос в политике: политики голосов и подписок не
-- ссылаются на идеи, а идеи ссылаются на них только через функцию, поэтому круга политик нет.
-- PL/pgSQL: таблицы голосов и подписок создаются ниже, тело функции разбирается при первом вызове.
CREATE FUNCTION app.hdi_follows(idea uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS
$$
BEGIN
  RETURN EXISTS (SELECT 1 FROM hdi_votes v WHERE v.idea_id = idea AND v.user_id = app.user_uuid())
      OR EXISTS (SELECT 1 FROM hdi_subscriptions s WHERE s.idea_id = idea AND s.user_id = app.user_uuid());
END
$$;

ALTER TABLE hdi_ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_ideas FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_ideas_internal_select ON hdi_ideas FOR SELECT TO hub_app USING (app.is_internal());
-- Решение 2: опубликованная (в том числе объединённая после публикации) видна всем клиентам; своя любая; отклонённая
-- после публикации ещё проголосовавшим и подписчикам. Границы организации нет по FR-IDEA-06 (набор изоляции: published-or-own).
CREATE POLICY hdi_ideas_client_select ON hdi_ideas FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client'
    AND (
      (status NOT IN ('pending_review', 'declined') AND published_on IS NOT NULL)
      OR author_id = app.user_uuid()
      OR (status = 'declined' AND published_on IS NOT NULL AND app.hdi_follows(idea_id))
    )
  );
CREATE POLICY hdi_ideas_client_insert ON hdi_ideas FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'client' AND org_id = app.org_id() AND author_id = app.user_uuid());
CREATE POLICY hdi_ideas_client_update ON hdi_ideas FOR UPDATE TO hub_app
  USING (app.actor_type() = 'client' AND org_id = app.org_id() AND author_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'client' AND org_id = app.org_id() AND author_id = app.user_uuid());
CREATE POLICY hdi_ideas_system_insert ON hdi_ideas FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdi_ideas_moderator_update ON hdi_ideas FOR UPDATE TO hub_app USING (app.ideas_can_moderate()) WITH CHECK (app.ideas_can_moderate());
COMMENT ON POLICY hdi_ideas_internal_select ON hdi_ideas IS 'Идеи читают все сотрудники и система';
COMMENT ON POLICY hdi_ideas_client_select ON hdi_ideas IS 'Клиент: опубликованные идеи всех организаций, свои любые, отклонённые после публикации, если голосовал или подписан (решение 2)';
COMMENT ON POLICY hdi_ideas_client_insert ON hdi_ideas IS 'Клиент подаёт идею от своего имени в свою организацию; что именно, проверяет t_hdi_ideas_guard';
COMMENT ON POLICY hdi_ideas_client_update ON hdi_ideas IS 'Автор меняет свою идею из своей организации; какие поля, проверяет t_hdi_ideas_guard';
COMMENT ON POLICY hdi_ideas_system_insert ON hdi_ideas IS 'Система (команды и тесты) может завести идею';
COMMENT ON POLICY hdi_ideas_moderator_update ON hdi_ideas IS 'Модерацию, статусы и отбор ведут product, admin и система; счётчики пишет только система';

GRANT SELECT, INSERT, UPDATE ON hdi_ideas TO hub_app;
GRANT USAGE ON SEQUENCE hdi_ideas_sq TO hub_app;

-- ---------------------------------------------------------------------------
-- hdi_idea_translations: оригинал и переводы заголовка и описания
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_idea_translations (
  translation_id uuid        NOT NULL DEFAULT uuidv7(),
  idea_id        uuid        NOT NULL,
  locale         text        NOT NULL,
  title          text        NOT NULL,
  body           text        NOT NULL,
  is_machine     boolean     NOT NULL DEFAULT false,
  status         text        NOT NULL DEFAULT 'original',
  source_hash    text        NOT NULL,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdi_idea_translations_pk PRIMARY KEY (translation_id),
  CONSTRAINT hdi_idea_translations_f1 FOREIGN KEY (idea_id) REFERENCES hdi_ideas (idea_id),
  -- Индекс u1 покрывает внешний ключ идеи.
  CONSTRAINT hdi_idea_translations_u1 UNIQUE (idea_id, locale),
  CONSTRAINT hdi_idea_translations_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdi_idea_translations_c2 CHECK (char_length(title) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 10000),
  CONSTRAINT hdi_idea_translations_c3 CHECK (status IN ('original', 'machine', 'reviewed', 'outdated', 'rejected')),
  -- Оригинал и проверенный модератором перевод не машинные, перевод модели машинный.
  CONSTRAINT hdi_idea_translations_c4 CHECK (CASE status WHEN 'original' THEN NOT is_machine WHEN 'reviewed' THEN NOT is_machine WHEN 'machine' THEN is_machine ELSE true END),
  CONSTRAINT hdi_idea_translations_c5 CHECK (source_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE hdi_idea_translations IS 'Заголовок и описание идеи по языкам: оригинал автора и переводы (FR-IDEA-13, решения 1 и 11). Видимость как у идеи';
COMMENT ON COLUMN hdi_idea_translations.translation_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdi_idea_translations.idea_id IS 'Идея';
COMMENT ON COLUMN hdi_idea_translations.locale IS 'Язык: ru, uz, en';
COMMENT ON COLUMN hdi_idea_translations.title IS 'Заголовок, только текст (до 120 знаков у автора)';
COMMENT ON COLUMN hdi_idea_translations.body IS 'Описание, только текст (до 5000 знаков у автора). Выводится текстом, ссылки не нажимаются (решение 13)';
COMMENT ON COLUMN hdi_idea_translations.is_machine IS 'Текст перевела модель и модератор его не правил: клиент видит пометку "Машинный перевод"';
COMMENT ON COLUMN hdi_idea_translations.status IS 'original (оригинал автора), machine (перевод модели прошёл сверку), reviewed (перевод поправил модератор), outdated (оригинал изменился), rejected (перевод не прошёл сверку). Последние два клиент не видит';
COMMENT ON COLUMN hdi_idea_translations.source_hash IS 'SHA-256 заголовка и описания оригинала, с которого сделан перевод (у оригинала свой)';
COMMENT ON COLUMN hdi_idea_translations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_idea_translations.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdi_idea_translations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_idea_translations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdi_idea_translations_stamp
  BEFORE INSERT OR UPDATE ON hdi_idea_translations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Клиент пишет только оригинал своей идеи на модерации (какой идеи, проверяет политика) и меняет в нём только текст.
-- Язык строки и идея не меняются никем.
CREATE FUNCTION app.hdi_idea_translations_guard() RETURNS trigger LANGUAGE plpgsql AS
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
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdi_idea_translations_guard() IS 'Триггер: клиент пишет только текст оригинала, идея и язык строки не меняются';

CREATE TRIGGER t_hdi_idea_translations_guard
  BEFORE INSERT OR UPDATE ON hdi_idea_translations
  FOR EACH ROW EXECUTE FUNCTION app.hdi_idea_translations_guard();

-- Правка оригинала (модератором до публикации) делает переводы устаревшими: клиент видит оригинал, пока задание
-- ideas.translate не переведёт заново (решение 11).
CREATE FUNCTION app.hdi_idea_translations_outdated() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  UPDATE hdi_idea_translations SET status = 'outdated' WHERE idea_id = NEW.idea_id AND status IN ('machine', 'reviewed');
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_idea_translations_outdated() IS 'Триггер: правка заголовка или описания оригинала помечает переводы устаревшими (план M7, решение 11)';

CREATE TRIGGER t_hdi_idea_translations_outdated
  AFTER UPDATE OF title, body ON hdi_idea_translations
  FOR EACH ROW WHEN (OLD.status = 'original' AND (OLD.title IS DISTINCT FROM NEW.title OR OLD.body IS DISTINCT FROM NEW.body))
  EXECUTE FUNCTION app.hdi_idea_translations_outdated();

ALTER TABLE hdi_idea_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_idea_translations FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_idea_translations_internal_select ON hdi_idea_translations FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdi_idea_translations_client_select ON hdi_idea_translations FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND status NOT IN ('outdated', 'rejected') AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_idea_translations.idea_id));
CREATE POLICY hdi_idea_translations_client_insert ON hdi_idea_translations FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client'
    AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_idea_translations.idea_id AND i.author_id = app.user_uuid()
                AND i.status = 'pending_review' AND i.original_locale = hdi_idea_translations.locale)
  );
CREATE POLICY hdi_idea_translations_client_update ON hdi_idea_translations FOR UPDATE TO hub_app
  USING (
    app.actor_type() = 'client' AND status = 'original'
    AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_idea_translations.idea_id AND i.author_id = app.user_uuid() AND i.status = 'pending_review')
  )
  WITH CHECK (
    app.actor_type() = 'client' AND status = 'original'
    AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_idea_translations.idea_id AND i.author_id = app.user_uuid() AND i.status = 'pending_review')
  );
CREATE POLICY hdi_idea_translations_moderator_insert ON hdi_idea_translations FOR INSERT TO hub_app WITH CHECK (app.ideas_can_moderate());
CREATE POLICY hdi_idea_translations_moderator_update ON hdi_idea_translations FOR UPDATE TO hub_app USING (app.ideas_can_moderate()) WITH CHECK (app.ideas_can_moderate());
COMMENT ON POLICY hdi_idea_translations_internal_select ON hdi_idea_translations IS 'Оригинал и все переводы читают сотрудники и система';
COMMENT ON POLICY hdi_idea_translations_client_select ON hdi_idea_translations IS 'Клиент видит тексты идей, которые ему видны, кроме устаревших и не прошедших сверку переводов (решение 11)';
COMMENT ON POLICY hdi_idea_translations_client_insert ON hdi_idea_translations IS 'Клиент пишет оригинал своей идеи на модерации на её языке';
COMMENT ON POLICY hdi_idea_translations_client_update ON hdi_idea_translations IS 'Автор правит оригинал своей идеи, пока она на модерации (решение 5)';
COMMENT ON POLICY hdi_idea_translations_moderator_insert ON hdi_idea_translations IS 'Переводы пишет задание ideas.translate (система), модератор может добавить перевод';
COMMENT ON POLICY hdi_idea_translations_moderator_update ON hdi_idea_translations IS 'Модератор правит оригинал до публикации и переводы (статус reviewed)';

GRANT SELECT, INSERT, UPDATE ON hdi_idea_translations TO hub_app;

-- ---------------------------------------------------------------------------
-- hdi_votes: голоса
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_votes (
  org_id      uuid        NOT NULL,
  idea_id     uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  -- Один пользователь - один голос (FR-IDEA-04): ключ таблицы, а не проверка кода.
  CONSTRAINT hdi_votes_pk PRIMARY KEY (idea_id, user_id),
  CONSTRAINT hdi_votes_f1 FOREIGN KEY (idea_id) REFERENCES hdi_ideas (idea_id),
  -- Голосует участник организации: сотрудник Smartup голосовать не может даже прямым запросом (FR-IDEA-05, решение 3).
  CONSTRAINT hdi_votes_f2 FOREIGN KEY (org_id, user_id) REFERENCES hdu_memberships (org_id, user_id),
  CONSTRAINT hdi_votes_f3 FOREIGN KEY (user_id) REFERENCES auth."user" ("id")
);

CREATE INDEX hdi_votes_i1 ON hdi_votes (user_id);
CREATE INDEX hdi_votes_i2 ON hdi_votes (org_id, user_id);

COMMENT ON TABLE hdi_votes IS 'Голоса за идеи (FR-IDEA-04, 05). Клиент видит только свой голос (ТЗ 15.2); разбивку по организациям видят только product и admin';
COMMENT ON COLUMN hdi_votes.org_id IS 'Организация голосующего на момент голоса: для разбивки и числа организаций. Клиенту не видна';
COMMENT ON COLUMN hdi_votes.idea_id IS 'Идея';
COMMENT ON COLUMN hdi_votes.user_id IS 'Голосующий клиент';
COMMENT ON COLUMN hdi_votes.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_votes.created_on IS 'Когда отдан голос. Заполняет база';
COMMENT ON COLUMN hdi_votes.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_votes.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdi_votes_stamp
  BEFORE INSERT OR UPDATE ON hdi_votes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Голос принимается и отзывается клиентом только в статусах open и shortlisted (решение 4; автор ещё и у своей идеи на
-- модерации: его голос ставится при подаче), под блокировкой строки идеи; перенос голосов при объединении (модератор, система) допускается в любую опубликованную цель. Затем полный
-- пересчёт vote_count и org_count от имени системы. Один запуск на оператор: перенос тысячи голосов пересчитывает
-- идею один раз.
CREATE FUNCTION app.hdi_votes_count() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  actor CONSTANT text := app.actor_type();
  me CONSTANT uuid := app.user_uuid();
  ids uuid[];
  own boolean := false;
  prev text[];
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
  prev := app.hdi_as_system();
  PERFORM 1 FROM hdi_ideas WHERE idea_id = ANY (ids) ORDER BY idea_id FOR NO KEY UPDATE;
  -- Автор голосует за свою идею ещё на модерации: голос ставится сам при подаче (решение 4).
  IF actor = 'client' AND EXISTS (SELECT 1 FROM unnest(ids) AS x(id) WHERE NOT EXISTS (
       SELECT 1 FROM hdi_ideas i WHERE i.idea_id = x.id AND (i.status IN ('open', 'shortlisted') OR (i.status = 'pending_review' AND i.author_id = me)))) THEN
    RAISE EXCEPTION 'Голос: голосовать и отзывать голос можно только у идеи в голосовании, нельзя' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND actor <> 'client' AND EXISTS (SELECT 1 FROM unnest(ids) AS x(id) WHERE NOT EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = x.id AND i.status NOT IN ('pending_review', 'declined', 'merged'))) THEN
    RAISE EXCEPTION 'Голос: голос переносится только в опубликованную идею, нельзя' USING ERRCODE = '42501';
  END IF;
  -- Блокировка NO KEY UPDATE: вставка голоса уже держит KEY SHARE на строке идеи (внешний ключ), FOR UPDATE с ней
  -- конфликтует и дал бы взаимную блокировку параллельных голосов. Отдельная команда после блокировки: в READ
  -- COMMITTED она видит голоса транзакций, закончившихся до блокировки.
  UPDATE hdi_ideas i
     SET vote_count = (SELECT count(*) FROM hdi_votes v WHERE v.idea_id = i.idea_id),
         org_count = (SELECT count(DISTINCT v.org_id) FROM hdi_votes v WHERE v.idea_id = i.idea_id)
   WHERE i.idea_id = ANY (ids);
  PERFORM app.hdi_restore_actor(prev);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_votes_count() IS 'Триггер: голос только клиента и только в голосовании (решения 3, 4), полный пересчёт vote_count и org_count под блокировкой идеи';

CREATE TRIGGER t_hdi_votes_count
  AFTER INSERT ON hdi_votes REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.hdi_votes_count();
CREATE TRIGGER t_hdi_votes_uncount
  AFTER DELETE ON hdi_votes REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.hdi_votes_count();

ALTER TABLE hdi_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_votes FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_votes_internal_select ON hdi_votes FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdi_votes_client_select ON hdi_votes FOR SELECT TO hub_app USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdi_votes_client_insert ON hdi_votes FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid() AND org_id = app.org_id());
CREATE POLICY hdi_votes_client_delete ON hdi_votes FOR DELETE TO hub_app USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdi_votes_moderator_insert ON hdi_votes FOR INSERT TO hub_app WITH CHECK (app.ideas_can_moderate());
CREATE POLICY hdi_votes_moderator_delete ON hdi_votes FOR DELETE TO hub_app USING (app.ideas_can_moderate());
COMMENT ON POLICY hdi_votes_internal_select ON hdi_votes IS 'Голоса читают сотрудники (разбивку показывают только product и admin, решение 24) и система';
COMMENT ON POLICY hdi_votes_client_select ON hdi_votes IS 'Клиент видит только свой голос (ТЗ 15.2)';
COMMENT ON POLICY hdi_votes_client_insert ON hdi_votes IS 'Клиент голосует от своего имени из своей организации; статус идеи проверяет t_hdi_votes_count';
COMMENT ON POLICY hdi_votes_client_delete ON hdi_votes IS 'Клиент отзывает свой голос; статус идеи проверяет t_hdi_votes_count';
COMMENT ON POLICY hdi_votes_moderator_insert ON hdi_votes IS 'Перенос голосов при объединении (решение 6): product, admin, система. Голосовать сам сотрудник не может (hdi_votes_f2)';
COMMENT ON POLICY hdi_votes_moderator_delete ON hdi_votes IS 'Удаление голосов объединяемой идеи после переноса (решение 6)';

GRANT SELECT, INSERT, DELETE ON hdi_votes TO hub_app;

-- ---------------------------------------------------------------------------
-- hdi_comments: комментарии и ответы Smartup
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_comments (
  org_id      uuid,
  comment_id  uuid        NOT NULL DEFAULT uuidv7(),
  idea_id     uuid        NOT NULL,
  author_id   uuid        NOT NULL,
  hidden_by   uuid,
  author_name text        NOT NULL,
  body        text        NOT NULL,
  is_official boolean     NOT NULL DEFAULT false,
  hide_reason text,
  status      text        NOT NULL DEFAULT 'published',
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdi_comments_pk PRIMARY KEY (comment_id),
  CONSTRAINT hdi_comments_f1 FOREIGN KEY (idea_id) REFERENCES hdi_ideas (idea_id),
  CONSTRAINT hdi_comments_f2 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdi_comments_f3 FOREIGN KEY (author_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdi_comments_f4 FOREIGN KEY (hidden_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hdi_comments_c1 CHECK (status IN ('published', 'pending', 'hidden')),
  CONSTRAINT hdi_comments_c2 CHECK (char_length(body) BETWEEN 1 AND 2000 AND char_length(author_name) BETWEEN 1 AND 200),
  -- Ответ Smartup пишет сотрудник (без организации), комментарий клиента всегда с организацией.
  CONSTRAINT hdi_comments_c3 CHECK (is_official = (org_id IS NULL)),
  CONSTRAINT hdi_comments_c4 CHECK ((status = 'hidden') = (hide_reason IS NOT NULL) AND (hide_reason IS NULL OR char_length(hide_reason) BETWEEN 1 AND 1000))
);

CREATE INDEX hdi_comments_i1 ON hdi_comments (idea_id, created_on);
CREATE INDEX hdi_comments_i2 ON hdi_comments (org_id);
CREATE INDEX hdi_comments_i3 ON hdi_comments (author_id);
CREATE INDEX hdi_comments_i4 ON hdi_comments (hidden_by);
-- Вкладка "Комментарии на проверке" рабочего места.
CREATE INDEX hdi_comments_i5 ON hdi_comments (created_on) WHERE status = 'pending';

COMMENT ON TABLE hdi_comments IS 'Комментарии к идеям (FR-IDEA-07, решение 8): клиент публикует сразу, с находками ждёт модератора; ответ Smartup со значком';
COMMENT ON COLUMN hdi_comments.org_id IS 'Организация автора-клиента. Клиентам не показывается никогда (решение 7). У ответа Smartup пусто';
COMMENT ON COLUMN hdi_comments.comment_id IS 'Идентификатор комментария';
COMMENT ON COLUMN hdi_comments.idea_id IS 'Идея';
COMMENT ON COLUMN hdi_comments.author_id IS 'Автор: клиент или сотрудник';
COMMENT ON COLUMN hdi_comments.hidden_by IS 'Модератор, который скрыл комментарий';
COMMENT ON COLUMN hdi_comments.author_name IS 'Имя автора снимком (решение 7)';
COMMENT ON COLUMN hdi_comments.body IS 'Текст до 2000 знаков, только текст, не переводится (решение 8)';
COMMENT ON COLUMN hdi_comments.is_official IS 'Ответ сотрудника Smartup: показывается со значком (FR-IDEA-07)';
COMMENT ON COLUMN hdi_comments.hide_reason IS 'Причина скрытия, видна автору';
COMMENT ON COLUMN hdi_comments.status IS 'published, pending (найдены данные или ссылка, ждёт модератора, виден только автору), hidden (скрыт модератором)';
COMMENT ON COLUMN hdi_comments.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_comments.created_on IS 'Когда написан комментарий. Заполняет база. Правка только 15 минут после него';
COMMENT ON COLUMN hdi_comments.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_comments.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdi_comments_stamp
  BEFORE INSERT OR UPDATE ON hdi_comments
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Клиент пишет обычный комментарий (не ответ Smartup) от своего имени из профиля; меняет только текст своего
-- нескрытого комментария в первые 15 минут (статус между published и pending ставит код по находкам). Сотрудник
-- пишет ответ Smartup; скрывает и публикует комментарии только модератор. Идея и автор не меняются никем.
CREATE FUNCTION app.hdi_comments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  actor CONSTANT text := app.actor_type();
  author_cols CONSTANT text[] := ARRAY['body', 'status', 'created_by', 'created_on', 'modified_by', 'modified_on'];
  moderator_cols CONSTANT text[] := ARRAY['status', 'hide_reason', 'hidden_by', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF actor IN ('client', 'staff') THEN
      IF NEW.hidden_by IS NOT NULL OR NEW.hide_reason IS NOT NULL OR NEW.status = 'hidden' OR NEW.is_official <> (actor = 'staff')
         OR (actor = 'staff' AND NEW.status <> 'published') THEN
        RAISE EXCEPTION 'Комментарий: клиент пишет комментарий, сотрудник ответ Smartup, остальное нельзя' USING ERRCODE = '42501';
      END IF;
      IF NEW.author_name IS DISTINCT FROM (SELECT p.name FROM hdu_user_profiles p WHERE p.user_id = NEW.author_id) THEN
        RAISE EXCEPTION 'Комментарий: имя автора берётся из его профиля, другое нельзя' USING ERRCODE = '42501';
      END IF;
    ELSIF actor NOT IN ('system', 'none') THEN
      RAISE EXCEPTION 'Комментарий: писать нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.idea_id IS DISTINCT FROM OLD.idea_id OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.is_official IS DISTINCT FROM OLD.is_official OR NEW.author_name IS DISTINCT FROM OLD.author_name THEN
    RAISE EXCEPTION 'Комментарий: идея, автор и вид не меняются, нельзя' USING ERRCODE = '42501';
  END IF;
  IF actor IN ('system', 'none') THEN
    RETURN NEW;
  END IF;
  IF actor = 'staff' AND app.ideas_can_moderate() AND (to_jsonb(NEW) - moderator_cols) = (to_jsonb(OLD) - moderator_cols) THEN
    IF NEW.status = 'hidden' AND OLD.status <> 'hidden' THEN
      NEW.hidden_by := app.user_uuid();
    ELSIF NEW.status <> 'hidden' THEN
      NEW.hidden_by := NULL;
      NEW.hide_reason := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- Свой комментарий на проверке автор сам не публикует: это делает модератор.
  IF OLD.author_id = app.user_uuid() AND OLD.status <> 'hidden' AND NEW.status IN ('published', 'pending') AND (actor = 'client' OR NEW.status = 'published')
     AND NOT (OLD.status = 'pending' AND NEW.status = 'published')
     AND (to_jsonb(NEW) - author_cols) = (to_jsonb(OLD) - author_cols) AND OLD.created_on > now() - interval '15 minutes' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Комментарий: менять этот комментарий нельзя (чужой, скрытый или прошло 15 минут)' USING ERRCODE = '42501';
END
$$;
COMMENT ON FUNCTION app.hdi_comments_guard() IS 'Триггер: кто что пишет и меняет в комментариях идей (план M7, решение 8)';

CREATE TRIGGER t_hdi_comments_guard
  BEFORE INSERT OR UPDATE ON hdi_comments
  FOR EACH ROW EXECUTE FUNCTION app.hdi_comments_guard();

-- Счётчик опубликованных комментариев: полный пересчёт от имени системы (чужие комментарии на проверке клиенту не
-- видны), один раз на оператор.
CREATE FUNCTION app.hdi_comments_count() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  ids uuid[];
  prev text[];
BEGIN
  SELECT array_agg(DISTINCT idea_id ORDER BY idea_id) INTO ids FROM new_rows;
  IF ids IS NULL THEN
    RETURN NULL;
  END IF;
  prev := app.hdi_as_system();
  PERFORM 1 FROM hdi_ideas WHERE idea_id = ANY (ids) ORDER BY idea_id FOR NO KEY UPDATE;
  UPDATE hdi_ideas i SET comment_count = (SELECT count(*) FROM hdi_comments c WHERE c.idea_id = i.idea_id AND c.status = 'published')
   WHERE i.idea_id = ANY (ids) AND i.comment_count IS DISTINCT FROM (SELECT count(*) FROM hdi_comments c WHERE c.idea_id = i.idea_id AND c.status = 'published');
  PERFORM app.hdi_restore_actor(prev);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.hdi_comments_count() IS 'Триггер: полный пересчёт comment_count (только опубликованные) под блокировкой идеи';

CREATE TRIGGER t_hdi_comments_count
  AFTER INSERT ON hdi_comments REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.hdi_comments_count();
CREATE TRIGGER t_hdi_comments_recount
  AFTER UPDATE ON hdi_comments REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.hdi_comments_count();

ALTER TABLE hdi_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_comments FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_comments_internal_select ON hdi_comments FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdi_comments_client_select ON hdi_comments FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client'
    AND (author_id = app.user_uuid() OR (status = 'published' AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_comments.idea_id)))
  );
-- Комментировать можно опубликованную идею; свою идею на модерации может комментировать только автор (её видит только он).
CREATE POLICY hdi_comments_client_insert ON hdi_comments FOR INSERT TO hub_app
  WITH CHECK (
    app.actor_type() = 'client' AND author_id = app.user_uuid() AND org_id = app.org_id()
    AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_comments.idea_id AND i.status NOT IN ('declined', 'merged'))
  );
CREATE POLICY hdi_comments_client_update ON hdi_comments FOR UPDATE TO hub_app
  USING (app.actor_type() = 'client' AND author_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'client' AND author_id = app.user_uuid());
CREATE POLICY hdi_comments_staff_insert ON hdi_comments FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND author_id = app.user_uuid() AND org_id IS NULL);
CREATE POLICY hdi_comments_staff_update ON hdi_comments FOR UPDATE TO hub_app USING (app.is_internal()) WITH CHECK (app.is_internal());
COMMENT ON POLICY hdi_comments_internal_select ON hdi_comments IS 'Все комментарии, включая скрытые и на проверке, читают сотрудники и система';
COMMENT ON POLICY hdi_comments_client_select ON hdi_comments IS 'Клиент: опубликованные комментарии видимых идей и свои любые (чужие на проверке не видны)';
COMMENT ON POLICY hdi_comments_client_insert ON hdi_comments IS 'Клиент комментирует от своего имени видимую ему идею, кроме отклонённой и объединённой';
COMMENT ON POLICY hdi_comments_client_update ON hdi_comments IS 'Автор правит свой комментарий; что и когда, проверяет t_hdi_comments_guard';
COMMENT ON POLICY hdi_comments_staff_insert ON hdi_comments IS 'Любой сотрудник пишет ответ Smartup от своего имени';
COMMENT ON POLICY hdi_comments_staff_update ON hdi_comments IS 'Скрыть и опубликовать может только модератор, свой ответ поправить автор: проверяет t_hdi_comments_guard';

GRANT SELECT, INSERT, UPDATE ON hdi_comments TO hub_app;

-- ---------------------------------------------------------------------------
-- hdi_subscriptions: подписки на идею
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_subscriptions (
  idea_id     uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdi_subscriptions_pk PRIMARY KEY (idea_id, user_id),
  CONSTRAINT hdi_subscriptions_f1 FOREIGN KEY (idea_id) REFERENCES hdi_ideas (idea_id),
  CONSTRAINT hdi_subscriptions_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id")
);

CREATE INDEX hdi_subscriptions_i1 ON hdi_subscriptions (user_id);

COMMENT ON TABLE hdi_subscriptions IS 'Подписки на идею (кнопка "Следить", FR-IDEA-11). Автор подписан сам, голос подписку не создаёт (решение 15)';
COMMENT ON COLUMN hdi_subscriptions.idea_id IS 'Идея';
COMMENT ON COLUMN hdi_subscriptions.user_id IS 'Подписчик';
COMMENT ON COLUMN hdi_subscriptions.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_subscriptions.created_on IS 'Когда создана подписка. Заполняет база';
COMMENT ON COLUMN hdi_subscriptions.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_subscriptions.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdi_subscriptions_stamp
  BEFORE INSERT OR UPDATE ON hdi_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Подписаться можно на свою идею или на опубликованную, кроме отклонённой: подписка открывает отклонённую идею
-- (решение 2), поэтому на отклонённую новой подписки нет. Функция, а не подзапрос: см. app.hdi_follows.
CREATE FUNCTION app.hdi_can_follow(idea uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = idea AND i.status NOT IN ('declined', 'merged')) $$;
COMMENT ON FUNCTION app.hdi_can_follow(uuid) IS 'Истина, если идея видна актору и не отклонена и не объединена: на неё можно подписаться';
COMMENT ON FUNCTION app.hdi_follows(uuid) IS 'Истина, если пользователь актора голосовал за идею или подписан на неё (видимость отклонённой, решение 2)';

ALTER TABLE hdi_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_subscriptions_internal_select ON hdi_subscriptions FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdi_subscriptions_client_select ON hdi_subscriptions FOR SELECT TO hub_app USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdi_subscriptions_client_insert ON hdi_subscriptions FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid() AND app.hdi_can_follow(idea_id));
CREATE POLICY hdi_subscriptions_client_delete ON hdi_subscriptions FOR DELETE TO hub_app USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdi_subscriptions_moderator_insert ON hdi_subscriptions FOR INSERT TO hub_app WITH CHECK (app.ideas_can_moderate());
CREATE POLICY hdi_subscriptions_moderator_delete ON hdi_subscriptions FOR DELETE TO hub_app USING (app.ideas_can_moderate());
COMMENT ON POLICY hdi_subscriptions_internal_select ON hdi_subscriptions IS 'Подписки читают сотрудники и система (рассылка уведомлений)';
COMMENT ON POLICY hdi_subscriptions_client_select ON hdi_subscriptions IS 'Клиент видит только свои подписки';
COMMENT ON POLICY hdi_subscriptions_client_insert ON hdi_subscriptions IS 'Клиент подписывается сам на видимую ему идею, кроме отклонённой и объединённой';
COMMENT ON POLICY hdi_subscriptions_client_delete ON hdi_subscriptions IS 'Клиент снимает свою подписку';
COMMENT ON POLICY hdi_subscriptions_moderator_insert ON hdi_subscriptions IS 'Перенос подписок при объединении (решение 6)';
COMMENT ON POLICY hdi_subscriptions_moderator_delete ON hdi_subscriptions IS 'Удаление подписок объединяемой идеи после переноса (решение 6)';

GRANT SELECT, INSERT, DELETE ON hdi_subscriptions TO hub_app;

-- ---------------------------------------------------------------------------
-- hdi_cycles: отбор месяца
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_cycles (
  cycle_id         uuid        NOT NULL DEFAULT uuidv7(),
  leader_idea_id   uuid,
  selected_idea_id uuid,
  decided_by       uuid,
  cycle            date        NOT NULL,
  shortlist        jsonb       NOT NULL DEFAULT '[]',
  vote_mode        text        NOT NULL,
  explanation_ru   text,
  explanation_uz   text,
  explanation_en   text,
  decided_on       timestamptz,
  status           text        NOT NULL DEFAULT 'open',
  created_by       text,
  created_on       timestamptz NOT NULL DEFAULT now(),
  modified_by      text,
  modified_on      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdi_cycles_pk PRIMARY KEY (cycle_id),
  CONSTRAINT hdi_cycles_f1 FOREIGN KEY (leader_idea_id) REFERENCES hdi_ideas (idea_id),
  CONSTRAINT hdi_cycles_f2 FOREIGN KEY (selected_idea_id) REFERENCES hdi_ideas (idea_id),
  CONSTRAINT hdi_cycles_f3 FOREIGN KEY (decided_by) REFERENCES auth."user" ("id"),
  -- Один отбор на месяц: повторный и параллельный запуск задания безвредны (решение 16).
  CONSTRAINT hdi_cycles_u1 UNIQUE (cycle),
  CONSTRAINT hdi_cycles_c1 CHECK (status IN ('open', 'decided', 'lapsed')),
  CONSTRAINT hdi_cycles_c2 CHECK (extract(day FROM cycle) = 1),
  CONSTRAINT hdi_cycles_c3 CHECK (vote_mode IN ('per_user', 'per_org')),
  CONSTRAINT hdi_cycles_c4 CHECK (jsonb_typeof(shortlist) = 'array' AND jsonb_array_length(shortlist) <= 5),
  CONSTRAINT hdi_cycles_c5 CHECK ((status = 'decided') = (selected_idea_id IS NOT NULL AND decided_on IS NOT NULL)),
  CONSTRAINT hdi_cycles_c6 CHECK ((explanation_ru IS NULL OR char_length(explanation_ru) BETWEEN 1 AND 2000)
                                  AND (explanation_uz IS NULL OR char_length(explanation_uz) BETWEEN 1 AND 2000)
                                  AND (explanation_en IS NULL OR char_length(explanation_en) BETWEEN 1 AND 2000)),
  -- Не лидер выбирается только с публичным объяснением, русское обязательно (FR-IDEA-10, решение 17).
  CONSTRAINT hdi_cycles_c7 CHECK (selected_idea_id IS NULL OR selected_idea_id = leader_idea_id OR explanation_ru IS NOT NULL)
);

CREATE INDEX hdi_cycles_i1 ON hdi_cycles (leader_idea_id);
CREATE INDEX hdi_cycles_i2 ON hdi_cycles (selected_idea_id);
CREATE INDEX hdi_cycles_i3 ON hdi_cycles (decided_by);

COMMENT ON TABLE hdi_cycles IS 'Отбор "Идеи месяца" (FR-IDEA-09, 10, 16): снимок пятёрки 1-го числа и выбор Smartup. Клиент видит только завершённые';
COMMENT ON COLUMN hdi_cycles.cycle_id IS 'Идентификатор отбора';
COMMENT ON COLUMN hdi_cycles.leader_idea_id IS 'Лидер снимка: первое место. Пусто у пустого отбора';
COMMENT ON COLUMN hdi_cycles.selected_idea_id IS 'Выбранная идея месяца. Пусто до выбора и у отбора без выбора (lapsed)';
COMMENT ON COLUMN hdi_cycles.decided_by IS 'Сотрудник, сделавший выбор. Клиенту не показывается';
COMMENT ON COLUMN hdi_cycles.cycle IS 'Первое число месяца отбора';
COMMENT ON COLUMN hdi_cycles.shortlist IS 'Снимок пятёрки: [{ideaId, number, voteCount, orgCount, place}]. Голоса после снимка его не меняют';
COMMENT ON COLUMN hdi_cycles.vote_mode IS 'Способ подсчёта на момент снимка: per_user или per_org (решение 3)';
COMMENT ON COLUMN hdi_cycles.explanation_ru IS 'Публичное объяснение выбора на русском. Обязательно, если выбран не лидер. Пишет сотрудник';
COMMENT ON COLUMN hdi_cycles.explanation_uz IS 'Объяснение на узбекском, по желанию';
COMMENT ON COLUMN hdi_cycles.explanation_en IS 'Объяснение на английском, по желанию';
COMMENT ON COLUMN hdi_cycles.decided_on IS 'Когда сделан выбор. Ставит база';
COMMENT ON COLUMN hdi_cycles.status IS 'open (ждёт выбора), decided (выбор сделан), lapsed (закрыт без выбора к следующему отбору, решение 17)';
COMMENT ON COLUMN hdi_cycles.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_cycles.created_on IS 'Когда сделан снимок. Заполняет база';
COMMENT ON COLUMN hdi_cycles.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_cycles.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdi_cycles_stamp
  BEFORE INSERT OR UPDATE ON hdi_cycles
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Сотрудник (product, admin) только выбирает: open -> decided, идея из снимка, объяснения. Снимок, месяц, способ
-- подсчёта и лидер не меняются; завершённый отбор не меняется (изменить выбор нельзя, решение 17).
CREATE FUNCTION app.hdi_cycles_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  staff_cols CONSTANT text[] := ARRAY['selected_idea_id', 'decided_by', 'explanation_ru', 'explanation_uz', 'explanation_en', 'decided_on', 'status',
                                      'created_by', 'created_on', 'modified_by', 'modified_on'];
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
COMMENT ON FUNCTION app.hdi_cycles_guard() IS 'Триггер: сотрудник только выбирает идею из снимка, завершённый отбор не меняется (план M7, решения 16, 17)';

CREATE TRIGGER t_hdi_cycles_guard
  BEFORE UPDATE ON hdi_cycles
  FOR EACH ROW EXECUTE FUNCTION app.hdi_cycles_guard();

ALTER TABLE hdi_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_cycles FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_cycles_internal_select ON hdi_cycles FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdi_cycles_client_select ON hdi_cycles FOR SELECT TO hub_app USING (app.actor_type() = 'client' AND status IN ('decided', 'lapsed'));
CREATE POLICY hdi_cycles_system_insert ON hdi_cycles FOR INSERT TO hub_app WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdi_cycles_moderator_update ON hdi_cycles FOR UPDATE TO hub_app USING (app.ideas_can_moderate()) WITH CHECK (app.ideas_can_moderate());
COMMENT ON POLICY hdi_cycles_internal_select ON hdi_cycles IS 'Отборы читают сотрудники и система';
COMMENT ON POLICY hdi_cycles_client_select ON hdi_cycles IS 'Клиент видит только завершённые отборы: архив выборов (FR-IDEA-16). Кто выбрал, страница не показывает';
COMMENT ON POLICY hdi_cycles_system_insert ON hdi_cycles IS 'Снимок делает задание ideas.cycle (система)';
COMMENT ON POLICY hdi_cycles_moderator_update ON hdi_cycles IS 'Выбор делают product и admin, закрытие без выбора система';

GRANT SELECT, INSERT, UPDATE ON hdi_cycles TO hub_app;

-- ---------------------------------------------------------------------------
-- hdi_attachments: изображения идеи
-- ---------------------------------------------------------------------------
CREATE TABLE hdi_attachments (
  org_id        uuid        NOT NULL,
  attachment_id uuid        NOT NULL DEFAULT uuidv7(),
  idea_id       uuid,
  uploader_id   uuid        NOT NULL,
  storage_key   text        NOT NULL,
  file_name     text        NOT NULL,
  mime          text        NOT NULL,
  size          bigint      NOT NULL,
  sha256        text,
  scan_status   text        NOT NULL DEFAULT 'pending',
  created_by    text,
  created_on    timestamptz NOT NULL DEFAULT now(),
  modified_by   text,
  modified_on   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdi_attachments_pk PRIMARY KEY (attachment_id),
  CONSTRAINT hdi_attachments_u1 UNIQUE (storage_key),
  CONSTRAINT hdi_attachments_f1 FOREIGN KEY (idea_id, org_id) REFERENCES hdi_ideas (idea_id, org_id),
  CONSTRAINT hdi_attachments_f2 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hdi_attachments_f3 FOREIGN KEY (uploader_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdi_attachments_c1 CHECK (scan_status IN ('pending', 'clean', 'infected', 'rejected')),
  -- Только изображения до 5 МБ (решение 10).
  CONSTRAINT hdi_attachments_c2 CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp') AND size > 0 AND size <= 5242880),
  CONSTRAINT hdi_attachments_c3 CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT hdi_attachments_c4 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX hdi_attachments_i1 ON hdi_attachments (idea_id, org_id);
CREATE INDEX hdi_attachments_i2 ON hdi_attachments (org_id);
CREATE INDEX hdi_attachments_i3 ON hdi_attachments (uploader_id);
CREATE INDEX hdi_attachments_i4 ON hdi_attachments (created_on) WHERE scan_status = 'pending';

COMMENT ON TABLE hdi_attachments IS 'Изображения идеи: PNG, JPEG, WebP до 5 МБ, не больше трёх (решение 10). Клиенты других организаций видят только чистые у опубликованной идеи';
COMMENT ON COLUMN hdi_attachments.org_id IS 'Организация загрузившего (совпадает с идеей по внешнему ключу)';
COMMENT ON COLUMN hdi_attachments.attachment_id IS 'Идентификатор вложения';
COMMENT ON COLUMN hdi_attachments.idea_id IS 'Идея. Пусто, пока загрузка не прикреплена отправкой формы';
COMMENT ON COLUMN hdi_attachments.uploader_id IS 'Кто загрузил (автор идеи)';
COMMENT ON COLUMN hdi_attachments.storage_key IS 'Ключ в хранилище: quarantine/ideas/<id> до проверки, files/ideas/<org>/<id> после. Задаёт портал';
COMMENT ON COLUMN hdi_attachments.file_name IS 'Имя файла от пользователя. Как путь не используется';
COMMENT ON COLUMN hdi_attachments.mime IS 'Заявленный тип: image/png, image/jpeg, image/webp. Проверка сверяет его с содержимым';
COMMENT ON COLUMN hdi_attachments.size IS 'Размер в байтах, до 5 МБ';
COMMENT ON COLUMN hdi_attachments.sha256 IS 'Хеш содержимого после проверки';
COMMENT ON COLUMN hdi_attachments.scan_status IS 'Проверка: pending, clean, infected, rejected (тип не совпал, размер не тот)';
COMMENT ON COLUMN hdi_attachments.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdi_attachments.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdi_attachments.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdi_attachments.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdi_attachments_stamp
  BEFORE INSERT OR UPDATE ON hdi_attachments
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

-- Клиент только прикрепляет свою загрузку к своей идее (какой, проверяет политика); проверку и ключ ставит система.
CREATE FUNCTION app.hdi_attachments_client_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  allowed CONSTANT text[] := ARRAY['idea_id', 'created_by', 'created_on', 'modified_by', 'modified_on'];
BEGIN
  IF app.actor_type() = 'client' AND ((to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) OR OLD.idea_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Вложение идеи: клиент только прикрепляет свою загрузку, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdi_attachments_client_guard() IS 'Триггер: клиент только прикрепляет свою загрузку к своей идее';

CREATE TRIGGER t_hdi_attachments_client_guard
  BEFORE UPDATE ON hdi_attachments
  FOR EACH ROW EXECUTE FUNCTION app.hdi_attachments_client_guard();

ALTER TABLE hdi_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdi_attachments FORCE ROW LEVEL SECURITY;

CREATE POLICY hdi_attachments_internal_select ON hdi_attachments FOR SELECT TO hub_app USING (app.is_internal());
-- Свои загрузки в любом состоянии; чужие только чистые и только у видимой опубликованной идеи (решение 10).
CREATE POLICY hdi_attachments_client_select ON hdi_attachments FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client'
    AND (
      uploader_id = app.user_uuid()
      OR (scan_status = 'clean' AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_attachments.idea_id AND i.published_on IS NOT NULL))
    )
  );
CREATE POLICY hdi_attachments_client_insert ON hdi_attachments FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid() AND idea_id IS NULL AND scan_status = 'pending');
CREATE POLICY hdi_attachments_client_update ON hdi_attachments FOR UPDATE TO hub_app
  USING (app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid())
  WITH CHECK (
    app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid()
    AND EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_attachments.idea_id AND i.author_id = app.user_uuid() AND i.status = 'pending_review')
  );
CREATE POLICY hdi_attachments_client_delete ON hdi_attachments FOR DELETE TO hub_app
  USING (
    app.actor_type() = 'client' AND org_id = app.org_id() AND uploader_id = app.user_uuid()
    AND (idea_id IS NULL OR EXISTS (SELECT 1 FROM hdi_ideas i WHERE i.idea_id = hdi_attachments.idea_id AND i.status = 'pending_review'))
  );
CREATE POLICY hdi_attachments_system_update ON hdi_attachments FOR UPDATE TO hub_app USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hdi_attachments_moderator_delete ON hdi_attachments FOR DELETE TO hub_app USING (app.ideas_can_moderate());
COMMENT ON POLICY hdi_attachments_internal_select ON hdi_attachments IS 'Вложения читают сотрудники (модератор просматривает снимки, решение 10) и система';
COMMENT ON POLICY hdi_attachments_client_select ON hdi_attachments IS 'Клиент: свои загрузки любые, чужие только чистые у опубликованной идеи';
COMMENT ON POLICY hdi_attachments_client_insert ON hdi_attachments IS 'Клиент заводит загрузку в карантине от своего имени';
COMMENT ON POLICY hdi_attachments_client_update ON hdi_attachments IS 'Клиент прикрепляет свою загрузку к своей идее на модерации';
COMMENT ON POLICY hdi_attachments_client_delete ON hdi_attachments IS 'Клиент убирает свою загрузку, пока идея на модерации';
COMMENT ON POLICY hdi_attachments_system_update ON hdi_attachments IS 'Итог проверки и ключ хранилища ставит задание ideas.scan';
COMMENT ON POLICY hdi_attachments_moderator_delete ON hdi_attachments IS 'Модератор удаляет снимок с данными организации; система удаляет брошенные загрузки';

GRANT SELECT, INSERT, UPDATE, DELETE ON hdi_attachments TO hub_app;

-- ---------------------------------------------------------------------------
-- Индекс похожих идей (решение 23) и цель вызова модели (решение 11)
-- ---------------------------------------------------------------------------
-- Строки идей пишет задание ideas.index (система, политика hdk_search_documents_system_insert). Отклонение и
-- объединение снимают их в транзакции модератора: роль product не публикует решения, поэтому нужна своя политика,
-- только для строк вида idea.
CREATE POLICY hdk_search_documents_idea_moderator_delete ON hdk_search_documents FOR DELETE TO hub_app USING (kind = 'idea' AND app.ideas_can_moderate());
COMMENT ON POLICY hdk_search_documents_idea_moderator_delete ON hdk_search_documents IS 'Строки идей снимает модератор идей в транзакции отклонения и объединения (план M7, решение 23)';

ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c1;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c1 CHECK (purpose IN ('solution_draft', 'translation', 'idea_translation'));
COMMENT ON COLUMN hda_runs.purpose IS 'Цель вызова: solution_draft (черновик решения из обращения), translation (перевод решения), idea_translation (перевод заголовка и описания идеи, веха M7)';
COMMENT ON COLUMN hda_runs.ref_id IS 'Объект вызова: статья hdk_articles (черновик или перевод) или идея hdi_ideas (перевод). Без внешнего ключа: журнал переживает объект';
