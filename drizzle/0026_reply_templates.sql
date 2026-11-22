-- Шаблоны ответов (FR-AG-06, 10.5; план M3, задача 10): заготовка на каждом языке портала, вызывается кодом после "/".
-- Читают сотрудники, ведёт администратор, клиент не видит ни одного (10.5: "К: нет"; строка 10.5 о справочниках
-- без ограничений по строкам относится к остальным справочникам, решение 0031).

CREATE TABLE hdr_reply_templates (
  template_id uuid        NOT NULL DEFAULT uuidv7(),
  shortcut    text        NOT NULL,
  title       text        NOT NULL,
  body        jsonb       NOT NULL,
  module_id   uuid,
  is_enabled  boolean     NOT NULL DEFAULT true,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdr_reply_templates_pk PRIMARY KEY (template_id),
  CONSTRAINT hdr_reply_templates_u1 UNIQUE (shortcut),
  CONSTRAINT hdr_reply_templates_f1 FOREIGN KEY (module_id) REFERENCES hdr_product_modules (module_id),
  CONSTRAINT hdr_reply_templates_c1 CHECK (shortcut ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT hdr_reply_templates_c2 CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT hdr_reply_templates_c3 CHECK (
    jsonb_typeof(body) = 'object' AND jsonb_typeof(body -> 'ru') = 'string' AND char_length(body ->> 'ru') BETWEEN 1 AND 10000
    AND (body - 'ru' - 'uz' - 'en') = '{}'::jsonb
  )
);

COMMENT ON TABLE hdr_reply_templates IS 'Шаблон ответа: заготовка на языках портала, вызывается коротким кодом после "/"';
COMMENT ON COLUMN hdr_reply_templates.template_id IS 'Идентификатор шаблона';
COMMENT ON COLUMN hdr_reply_templates.shortcut IS 'Код после "/": латинские буквы, цифры и дефис, уникален';
COMMENT ON COLUMN hdr_reply_templates.title IS 'Название шаблона для сотрудников';
COMMENT ON COLUMN hdr_reply_templates.body IS 'Текст по языкам: ru обязателен, uz и en по желанию';
COMMENT ON COLUMN hdr_reply_templates.module_id IS 'Модуль продукта. Пусто: шаблон для любых обращений';
COMMENT ON COLUMN hdr_reply_templates.is_enabled IS 'Показывать ли шаблон в списке "/"';
COMMENT ON COLUMN hdr_reply_templates.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdr_reply_templates.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdr_reply_templates.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdr_reply_templates.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdr_reply_templates_stamp
  BEFORE INSERT OR UPDATE ON hdr_reply_templates
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdr_reply_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdr_reply_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY hdr_reply_templates_internal_select ON hdr_reply_templates FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hdr_reply_templates_admin_write ON hdr_reply_templates FOR ALL TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
COMMENT ON POLICY hdr_reply_templates_internal_select ON hdr_reply_templates IS 'Шаблоны читают сотрудники и система';
COMMENT ON POLICY hdr_reply_templates_admin_write ON hdr_reply_templates IS 'Шаблоны ведёт администратор портала';

GRANT SELECT, INSERT, UPDATE ON hdr_reply_templates TO hub_app;
