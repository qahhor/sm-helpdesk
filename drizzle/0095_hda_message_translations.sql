-- Перевод сообщения клиента для сотрудника (ТЗ FR-AG-11, 14.3, поправка 101; план M5b, задача 9, решение 24).
--
-- hda_message_translations: машинный перевод одного публичного сообщения клиента на язык интерфейса сотрудника по
-- кнопке "Перевести". Только для сотрудников: в переписку не попадает, клиент не видит ни одной строки. Запрос
-- ("готовится") ставит сотрудник от своего имени, текст перевода и итог пишет фоновый процесс, он же удаляет строки
-- старше 24 часов. Одна строка на сообщение и язык.

CREATE TABLE hda_message_translations (
  translation_id uuid        NOT NULL DEFAULT uuidv7(),
  org_id         uuid        NOT NULL,
  ticket_id      uuid        NOT NULL,
  message_id     uuid        NOT NULL,
  locale         text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending',
  text           text,
  requested_by   uuid        NOT NULL,
  created_by     text,
  created_on     timestamptz NOT NULL DEFAULT now(),
  modified_by    text,
  modified_on    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hda_message_translations_pk PRIMARY KEY (translation_id),
  CONSTRAINT hda_message_translations_f1 FOREIGN KEY (org_id) REFERENCES hdu_organizations (org_id),
  CONSTRAINT hda_message_translations_f2 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hda_message_translations_f3 FOREIGN KEY (message_id) REFERENCES hdt_ticket_messages (message_id),
  CONSTRAINT hda_message_translations_f4 FOREIGN KEY (requested_by) REFERENCES auth."user" ("id"),
  CONSTRAINT hda_message_translations_c1 CHECK (locale IN ('ru', 'uz', 'en')),
  CONSTRAINT hda_message_translations_c2 CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT hda_message_translations_c3 CHECK ((status = 'ready') = (text IS NOT NULL)),
  CONSTRAINT hda_message_translations_c4 CHECK (text IS NULL OR char_length(text) <= 20000)
);

CREATE UNIQUE INDEX hda_message_translations_u1 ON hda_message_translations (message_id, locale);
CREATE INDEX hda_message_translations_i1 ON hda_message_translations (org_id);
CREATE INDEX hda_message_translations_i2 ON hda_message_translations (ticket_id);
CREATE INDEX hda_message_translations_i3 ON hda_message_translations (requested_by);
CREATE INDEX hda_message_translations_i4 ON hda_message_translations (created_on);
COMMENT ON INDEX hda_message_translations_u1 IS 'Один перевод сообщения на язык; внешний ключ сообщения';
COMMENT ON INDEX hda_message_translations_i1 IS 'Внешний ключ: организация';
COMMENT ON INDEX hda_message_translations_i2 IS 'Переводы обращения для страницы сотрудника; внешний ключ обращения';
COMMENT ON INDEX hda_message_translations_i3 IS 'Внешний ключ: кто попросил перевод';
COMMENT ON INDEX hda_message_translations_i4 IS 'Удаление строк старше 24 часов';

COMMENT ON TABLE hda_message_translations IS 'Машинный перевод сообщения клиента для сотрудника (FR-AG-11). Не переписка: клиент не видит, строки живут 24 часа';
COMMENT ON COLUMN hda_message_translations.translation_id IS 'Идентификатор перевода';
COMMENT ON COLUMN hda_message_translations.org_id IS 'Организация обращения';
COMMENT ON COLUMN hda_message_translations.ticket_id IS 'Обращение';
COMMENT ON COLUMN hda_message_translations.message_id IS 'Переведённое сообщение клиента';
COMMENT ON COLUMN hda_message_translations.locale IS 'Язык перевода: язык интерфейса сотрудника';
COMMENT ON COLUMN hda_message_translations.status IS 'pending (готовится), ready (перевод готов), failed (перевод не получился)';
COMMENT ON COLUMN hda_message_translations.text IS 'Текст машинного перевода. Только для сотрудника, рядом с оригиналом, с пометкой "машинный перевод"';
COMMENT ON COLUMN hda_message_translations.requested_by IS 'Сотрудник, нажавший "Перевести"';
COMMENT ON COLUMN hda_message_translations.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hda_message_translations.created_on IS 'Когда попросили перевод. Через 24 часа строка удаляется';
COMMENT ON COLUMN hda_message_translations.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hda_message_translations.modified_on IS 'Когда строка изменена последний раз. Заполняет база';
COMMENT ON CONSTRAINT hda_message_translations_c3 ON hda_message_translations IS 'Текст есть ровно у готового перевода';

CREATE TRIGGER t_hda_message_translations_stamp
  BEFORE INSERT OR UPDATE ON hda_message_translations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hda_message_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hda_message_translations FORCE ROW LEVEL SECURITY;
CREATE POLICY hda_message_translations_internal_select ON hda_message_translations FOR SELECT TO hub_app USING (app.is_internal());
CREATE POLICY hda_message_translations_staff_insert ON hda_message_translations FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() IN ('agent_l1', 'agent_l2', 'care', 'admin')
              AND requested_by::text = app.user_id() AND status = 'pending' AND text IS NULL);
CREATE POLICY hda_message_translations_system_update ON hda_message_translations FOR UPDATE TO hub_app
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
CREATE POLICY hda_message_translations_system_delete ON hda_message_translations FOR DELETE TO hub_app USING (app.actor_type() = 'system');
COMMENT ON POLICY hda_message_translations_internal_select ON hda_message_translations IS 'Переводы читают сотрудники и система. Клиент не читает';
COMMENT ON POLICY hda_message_translations_staff_insert ON hda_message_translations IS 'Запрос перевода ставит сотрудник, который ведёт обращения, от своего имени и без текста';
COMMENT ON POLICY hda_message_translations_system_update ON hda_message_translations IS 'Текст перевода и итог пишет фоновый процесс';
COMMENT ON POLICY hda_message_translations_system_delete ON hda_message_translations IS 'Строки старше 24 часов удаляет фоновый процесс';
GRANT SELECT, INSERT, UPDATE, DELETE ON hda_message_translations TO hub_app;
