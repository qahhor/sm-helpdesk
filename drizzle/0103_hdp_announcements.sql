-- Веха M5c, задача 6: объявления (ТЗ 7.18, FR-ANN-01, 02, 04, FR-ADM-12; план M5c, решение 24).
--
-- Объявление пишут care и admin (app.hdp_can_announce): вид, период показа не длиннее 90 суток, аудитория (все, сервер
-- Smartup, модуль), текст на языке автора и принятые переводы. Клиент читает только начавшиеся объявления своей
-- аудитории: действующие и закончившиеся за 90 суток (архив). Аудитория "сервер" только клиентам организаций этого
-- сервера; "модуль" видят все клиенты, а где показывать (главная, форма, виджет), решает код (решение 24). Текст
-- клиенту только от сотрудника или принятым переводом. Закрытие баннера хранится в базе: панель виджета живёт в
-- iframe с отдельным хранилищем.

CREATE FUNCTION app.hdp_can_announce() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.actor_type() = 'system' OR (app.actor_type() = 'staff' AND app.staff_role() IN ('care', 'admin')) $$;
COMMENT ON FUNCTION app.hdp_can_announce() IS 'Истина для системы и сотрудника, который ведёт объявления: care, admin (FR-ANN-01)';

-- Сервер организации клиента для политики аудитории "сервер". Клиент видит свою организацию политикой hdu_organizations.
CREATE FUNCTION app.client_server_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT o.server_id FROM hdu_organizations o WHERE o.org_id = app.org_id() $$;
COMMENT ON FUNCTION app.client_server_id() IS 'Сервер Smartup организации клиента из актора. У служебной организации и не клиента пусто';

-- ---------------------------------------------------------------------------
-- hdp_announcements: объявления
-- ---------------------------------------------------------------------------
CREATE TABLE hdp_announcements (
  announcement_id uuid        NOT NULL DEFAULT uuidv7(),
  server_id       uuid,
  module_id       uuid,
  author_id       uuid        NOT NULL,
  kind            text        NOT NULL,
  audience        text        NOT NULL DEFAULT 'all',
  source_locale   text        NOT NULL,
  starts_on       timestamptz NOT NULL,
  ends_on         timestamptz NOT NULL,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_announcements_pk PRIMARY KEY (announcement_id),
  CONSTRAINT hdp_announcements_f1 FOREIGN KEY (server_id) REFERENCES hdu_servers (server_id),
  CONSTRAINT hdp_announcements_f2 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdp_announcements_f3 FOREIGN KEY (author_id) REFERENCES auth."user" ("id"),
  CONSTRAINT hdp_announcements_c1 CHECK (kind IN ('maintenance', 'outage', 'news')),
  CONSTRAINT hdp_announcements_c2 CHECK (audience IN ('all', 'server', 'module')),
  CONSTRAINT hdp_announcements_c3 CHECK ((audience = 'server') = (server_id IS NOT NULL) AND (audience = 'module') = (module_id IS NOT NULL)),
  CONSTRAINT hdp_announcements_c4 CHECK (source_locale IN ('ru', 'uz', 'en')),
  -- Конец позже начала; досрочное окончание ставит конец на момент окончания, поэтому граница 90 суток только сверху.
  CONSTRAINT hdp_announcements_c5 CHECK (ends_on > starts_on AND ends_on <= starts_on + interval '90 days')
);

CREATE INDEX hdp_announcements_i1 ON hdp_announcements (server_id);
CREATE INDEX hdp_announcements_i2 ON hdp_announcements (module_id);
CREATE INDEX hdp_announcements_i3 ON hdp_announcements (author_id);
-- Действующие и архив за 90 суток: по концу показа.
CREATE INDEX hdp_announcements_i4 ON hdp_announcements (ends_on DESC);

COMMENT ON TABLE hdp_announcements IS 'Объявления о плановых работах, сбоях и новостях (ТЗ 7.18). Клиент видит начавшиеся объявления своей аудитории: действующие и архив за 90 суток';
COMMENT ON COLUMN hdp_announcements.announcement_id IS 'Идентификатор объявления';
COMMENT ON COLUMN hdp_announcements.server_id IS 'Сервер Smartup у аудитории "сервер": объявление видят только клиенты организаций этого сервера';
COMMENT ON COLUMN hdp_announcements.module_id IS 'Модуль у аудитории "модуль": на форме и в виджете только при этом модуле (решение 24)';
COMMENT ON COLUMN hdp_announcements.author_id IS 'Сотрудник Customer Care или администратор, который создал объявление';
COMMENT ON COLUMN hdp_announcements.kind IS 'Вид: maintenance (плановые работы), outage (сбой, его учитывает помощник, FR-ANN-03), news (новость)';
COMMENT ON COLUMN hdp_announcements.audience IS 'Аудитория: all, server, module';
COMMENT ON COLUMN hdp_announcements.source_locale IS 'Язык, на котором написал сотрудник: с него переводятся остальные';
COMMENT ON COLUMN hdp_announcements.starts_on IS 'Начало показа';
COMMENT ON COLUMN hdp_announcements.ends_on IS 'Конец показа: не позже 90 суток от начала. Досрочное окончание ставит сюда момент окончания';
COMMENT ON COLUMN hdp_announcements.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_announcements.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_announcements.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_announcements.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_announcements_stamp
  BEFORE INSERT OR UPDATE ON hdp_announcements
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdp_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_announcements_internal_select ON hdp_announcements FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdp_announcements_client_select ON hdp_announcements FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND starts_on <= now() AND ends_on > now() - interval '90 days'
         AND (audience <> 'server' OR server_id = app.client_server_id()));
CREATE POLICY hdp_announcements_writer_insert ON hdp_announcements FOR INSERT TO hub_app WITH CHECK (app.hdp_can_announce());
CREATE POLICY hdp_announcements_writer_update ON hdp_announcements FOR UPDATE TO hub_app USING (app.hdp_can_announce()) WITH CHECK (app.hdp_can_announce());
COMMENT ON POLICY hdp_announcements_internal_select ON hdp_announcements IS 'Объявления читают сотрудники и система';
COMMENT ON POLICY hdp_announcements_client_select ON hdp_announcements IS 'Клиент видит начавшиеся объявления своей аудитории: действующие и закончившиеся за 90 суток (архив, FR-ANN-04)';
COMMENT ON POLICY hdp_announcements_writer_insert ON hdp_announcements IS 'Объявления создают care и admin (FR-ANN-01)';
COMMENT ON POLICY hdp_announcements_writer_update ON hdp_announcements IS 'Объявления правят и заканчивают досрочно care и admin';
GRANT SELECT, INSERT, UPDATE ON hdp_announcements TO hub_app;

-- ---------------------------------------------------------------------------
-- hdp_announcement_translations: заголовок и текст по языкам
-- ---------------------------------------------------------------------------
CREATE TABLE hdp_announcement_translations (
  translation_id  uuid        NOT NULL DEFAULT uuidv7(),
  announcement_id uuid        NOT NULL,
  accepted_by     uuid,
  locale          text        NOT NULL,
  title           text        NOT NULL,
  body            text        NOT NULL DEFAULT '',
  is_machine      boolean     NOT NULL DEFAULT false,
  accepted_on     timestamptz,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_announcement_translations_pk PRIMARY KEY (translation_id),
  CONSTRAINT hdp_announcement_translations_f1 FOREIGN KEY (announcement_id) REFERENCES hdp_announcements (announcement_id),
  CONSTRAINT hdp_announcement_translations_f2 FOREIGN KEY (accepted_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hdp_announcement_translations_u1 UNIQUE (announcement_id, locale),
  CONSTRAINT hdp_announcement_translations_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hdp_announcement_translations_c2 CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT hdp_announcement_translations_c3 CHECK (char_length(body) <= 3000),
  CONSTRAINT hdp_announcement_translations_c4 CHECK ((accepted_by IS NULL) = (accepted_on IS NULL)),
  CONSTRAINT hdp_announcement_translations_c5 CHECK (is_machine OR accepted_by IS NULL)
);

CREATE INDEX hdp_announcement_translations_i1 ON hdp_announcement_translations (accepted_by);

COMMENT ON TABLE hdp_announcement_translations IS 'Заголовок и текст объявления по языкам портала (FR-ANN-01). Клиент видит только текст сотрудника и принятые переводы видимых ему объявлений';
COMMENT ON COLUMN hdp_announcement_translations.translation_id IS 'Идентификатор строки';
COMMENT ON COLUMN hdp_announcement_translations.announcement_id IS 'Объявление';
COMMENT ON COLUMN hdp_announcement_translations.accepted_by IS 'Сотрудник, который принял машинный перевод. Пусто: перевод не принят и клиенту не виден';
COMMENT ON COLUMN hdp_announcement_translations.locale IS 'Язык: ru, uz, en';
COMMENT ON COLUMN hdp_announcement_translations.title IS 'Заголовок баннера';
COMMENT ON COLUMN hdp_announcement_translations.body IS 'Текст объявления. Проходит проверку текста перед сохранением (решение 6)';
COMMENT ON COLUMN hdp_announcement_translations.is_machine IS 'Текст подготовила модель (задание announcements.translate). Клиенту виден только после принятия сотрудником';
COMMENT ON COLUMN hdp_announcement_translations.accepted_on IS 'Когда сотрудник принял машинный перевод';
COMMENT ON COLUMN hdp_announcement_translations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_announcement_translations.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdp_announcement_translations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_announcement_translations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_announcement_translations_stamp
  BEFORE INSERT OR UPDATE ON hdp_announcement_translations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdp_announcement_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_announcement_translations FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_announcement_translations_internal_select ON hdp_announcement_translations FOR SELECT TO hub_app USING (app.is_internal());
-- Подзапрос идёт под той же политикой клиента: перевод видим, только если видимо само объявление.
CREATE POLICY hdp_announcement_translations_client_select ON hdp_announcement_translations FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND (NOT is_machine OR accepted_by IS NOT NULL)
         AND EXISTS (SELECT 1 FROM hdp_announcements a WHERE a.announcement_id = hdp_announcement_translations.announcement_id));
CREATE POLICY hdp_announcement_translations_writer_insert ON hdp_announcement_translations FOR INSERT TO hub_app WITH CHECK (app.hdp_can_announce());
CREATE POLICY hdp_announcement_translations_writer_update ON hdp_announcement_translations FOR UPDATE TO hub_app USING (app.hdp_can_announce()) WITH CHECK (app.hdp_can_announce());
COMMENT ON POLICY hdp_announcement_translations_internal_select ON hdp_announcement_translations IS 'Тексты объявлений читают сотрудники и система';
COMMENT ON POLICY hdp_announcement_translations_client_select ON hdp_announcement_translations IS 'Клиент видит текст сотрудника и принятый перевод объявления, которое видит сам';
COMMENT ON POLICY hdp_announcement_translations_writer_insert ON hdp_announcement_translations IS 'Тексты пишут care, admin и система (машинный перевод)';
COMMENT ON POLICY hdp_announcement_translations_writer_update ON hdp_announcement_translations IS 'Тексты правят и принимают care, admin и система';
GRANT SELECT, INSERT, UPDATE ON hdp_announcement_translations TO hub_app;

-- ---------------------------------------------------------------------------
-- hdp_announcement_dismissals: закрытые баннеры (FR-ANN-04)
-- ---------------------------------------------------------------------------
CREATE TABLE hdp_announcement_dismissals (
  user_id         uuid        NOT NULL,
  announcement_id uuid        NOT NULL,
  created_by      text,
  created_on      timestamptz NOT NULL DEFAULT now(),
  modified_by     text,
  modified_on     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdp_announcement_dismissals_pk PRIMARY KEY (user_id, announcement_id),
  CONSTRAINT hdp_announcement_dismissals_f1 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT hdp_announcement_dismissals_f2 FOREIGN KEY (announcement_id) REFERENCES hdp_announcements (announcement_id)
);

CREATE INDEX hdp_announcement_dismissals_i1 ON hdp_announcement_dismissals (announcement_id);

COMMENT ON TABLE hdp_announcement_dismissals IS 'Кто закрыл баннер объявления: закрытый баннер не показывается этому пользователю ни в портале, ни в виджете (FR-ANN-04)';
COMMENT ON COLUMN hdp_announcement_dismissals.user_id IS 'Пользователь, который закрыл баннер';
COMMENT ON COLUMN hdp_announcement_dismissals.announcement_id IS 'Объявление';
COMMENT ON COLUMN hdp_announcement_dismissals.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdp_announcement_dismissals.created_on IS 'Когда баннер закрыт. Заполняет база';
COMMENT ON COLUMN hdp_announcement_dismissals.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdp_announcement_dismissals.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdp_announcement_dismissals_stamp
  BEFORE INSERT OR UPDATE ON hdp_announcement_dismissals
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdp_announcement_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdp_announcement_dismissals FORCE ROW LEVEL SECURITY;
CREATE POLICY hdp_announcement_dismissals_client_select ON hdp_announcement_dismissals FOR SELECT TO hub_app
  USING (app.actor_type() = 'client' AND user_id = app.user_uuid());
CREATE POLICY hdp_announcement_dismissals_client_insert ON hdp_announcement_dismissals FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'client' AND user_id = app.user_uuid()
              AND EXISTS (SELECT 1 FROM hdp_announcements a WHERE a.announcement_id = hdp_announcement_dismissals.announcement_id));
CREATE POLICY hdp_announcement_dismissals_internal_select ON hdp_announcement_dismissals FOR SELECT TO hub_app USING (app.is_internal());
COMMENT ON POLICY hdp_announcement_dismissals_client_select ON hdp_announcement_dismissals IS 'Клиент видит только свои закрытия';
COMMENT ON POLICY hdp_announcement_dismissals_client_insert ON hdp_announcement_dismissals IS 'Клиент закрывает баннер только за себя и только видимого ему объявления';
COMMENT ON POLICY hdp_announcement_dismissals_internal_select ON hdp_announcement_dismissals IS 'Сотрудники и система читают закрытия (ночная очистка, разбор)';
GRANT SELECT, INSERT ON hdp_announcement_dismissals TO hub_app;

-- Перевод объявления моделью (решение 24).
ALTER TABLE hda_runs DROP CONSTRAINT hda_runs_c1;
ALTER TABLE hda_runs ADD CONSTRAINT hda_runs_c1 CHECK (purpose IN ('solution_draft', 'translation', 'idea_translation', 'first_line', 'triage', 'message_translation', 'thanks', 'problem_translation', 'announcement_translation'));
