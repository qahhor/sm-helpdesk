-- Справочник модулей продукта (модуль hdr) и настройки портала (модуль hdc).
-- ТЗ: разделы 10.5 и 10.3. Имена: docs/naming.md.

-- ---------------------------------------------------------------------------
-- hdr_product_modules
-- ---------------------------------------------------------------------------
CREATE TABLE hdr_product_modules (
  module_id   uuid        NOT NULL DEFAULT uuidv7(),
  parent_id   uuid,
  name        jsonb       NOT NULL,
  screens     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  state       text        NOT NULL DEFAULT 'active',
  code        text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdr_product_modules_pk PRIMARY KEY (module_id),
  CONSTRAINT hdr_product_modules_u1 UNIQUE (code),
  CONSTRAINT hdr_product_modules_f1 FOREIGN KEY (parent_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdr_product_modules_c1 CHECK (jsonb_typeof(name) = 'object' AND name ? 'ru'),
  CONSTRAINT hdr_product_modules_c2 CHECK (jsonb_typeof(screens) = 'array'),
  CONSTRAINT hdr_product_modules_c3 CHECK (state IN ('active', 'passive')),
  CONSTRAINT hdr_product_modules_c4 CHECK (code <> '' AND code = btrim(code)),
  CONSTRAINT hdr_product_modules_c5 CHECK (parent_id <> module_id)
);

CREATE INDEX hdr_product_modules_i1 ON hdr_product_modules (parent_id);

COMMENT ON TABLE hdr_product_modules IS 'Модули продукта Smartup: по ним клиент выбирает тему обращения, а поддержка распределяет работу';
COMMENT ON COLUMN hdr_product_modules.module_id IS 'Идентификатор модуля';
COMMENT ON COLUMN hdr_product_modules.parent_id IS 'Родительский модуль, если модуль вложен';
COMMENT ON COLUMN hdr_product_modules.name IS 'Название по языкам, объект вида {"ru": "...", "uz": "...", "en": "..."}. Русское обязательно';
COMMENT ON COLUMN hdr_product_modules.screens IS 'Экраны модуля: массив объектов с кодом и названием';
COMMENT ON COLUMN hdr_product_modules.state IS 'Состояние: active (доступен для выбора) или passive (скрыт)';
COMMENT ON COLUMN hdr_product_modules.code IS 'Код модуля, как в Smartup';
COMMENT ON COLUMN hdr_product_modules.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdr_product_modules.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdr_product_modules.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdr_product_modules.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdr_product_modules_stamp
  BEFORE INSERT OR UPDATE ON hdr_product_modules
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdr_product_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdr_product_modules FORCE ROW LEVEL SECURITY;

-- Справочник читает любой актор: клиент, сотрудник, фоновая задача, AI-сотрудник.
CREATE POLICY hdr_product_modules_actor_select ON hdr_product_modules FOR SELECT TO hub_app
  USING (app.actor_type() <> 'none');

-- Меняет справочник только администратор.
CREATE POLICY hdr_product_modules_admin_all ON hdr_product_modules FOR ALL TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON hdr_product_modules TO hub_app;

-- ---------------------------------------------------------------------------
-- hdc_settings
-- ---------------------------------------------------------------------------
CREATE TABLE hdc_settings (
  setting_id  uuid        NOT NULL DEFAULT uuidv7(),
  value       jsonb       NOT NULL,
  code        text        NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdc_settings_pk PRIMARY KEY (setting_id),
  CONSTRAINT hdc_settings_u1 UNIQUE (code),
  CONSTRAINT hdc_settings_c1 CHECK (code <> '' AND code = btrim(code))
);

COMMENT ON TABLE hdc_settings IS 'Настройки портала, которые администратор меняет без выкладки. Секреты здесь не хранятся';
COMMENT ON COLUMN hdc_settings.setting_id IS 'Идентификатор настройки';
COMMENT ON COLUMN hdc_settings.value IS 'Значение настройки';
COMMENT ON COLUMN hdc_settings.code IS 'Код настройки, например ai.enabled';
COMMENT ON COLUMN hdc_settings.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdc_settings.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdc_settings.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdc_settings.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdc_settings_stamp
  BEFORE INSERT OR UPDATE ON hdc_settings
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdc_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdc_settings FORCE ROW LEVEL SECURITY;

-- Настройки читают фоновые задачи и администратор. Клиент и линии поддержки их не видят.
CREATE POLICY hdc_settings_system_select ON hdc_settings FOR SELECT TO hub_app
  USING (app.actor_type() = 'system');

-- Читает и меняет настройки только администратор.
CREATE POLICY hdc_settings_admin_all ON hdc_settings FOR ALL TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON hdc_settings TO hub_app;
