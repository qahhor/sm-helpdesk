-- Сроки SLA и рабочий календарь (модуль hdr, ТЗ: разделы 7.4, 10.5, FR-SLA-01, FR-SLA-12; план M3, задача 2).
-- Значения по умолчанию из раздела 7.4 заданы в коде (src/modules/hdr/pref.ts): строка таблицы появляется, когда
-- администратор меняет значение, и действует вместо значения по умолчанию (решение 0032). Читает любой актор
-- (10.5: "Чтение: все"), вставляет и меняет только администратор, удалять не может никто.

CREATE TABLE hdr_business_calendars (
  calendar_id uuid        NOT NULL DEFAULT uuidv7(),
  code        text        NOT NULL,
  timezone    text        NOT NULL,
  week_hours  jsonb       NOT NULL,
  holidays    date[]      NOT NULL DEFAULT '{}',
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdr_business_calendars_pk PRIMARY KEY (calendar_id),
  CONSTRAINT hdr_business_calendars_u1 UNIQUE (code),
  CONSTRAINT hdr_business_calendars_c1 CHECK (jsonb_typeof(week_hours) = 'object'),
  CONSTRAINT hdr_business_calendars_c2 CHECK (timezone <> '' AND timezone = btrim(timezone)),
  CONSTRAINT hdr_business_calendars_c3 CHECK (cardinality(holidays) <= 1000)
);

COMMENT ON TABLE hdr_business_calendars IS 'Рабочий календарь поддержки: часовой пояс, график недели, праздничные дни (FR-SLA-01, FR-SLA-12)';
COMMENT ON COLUMN hdr_business_calendars.calendar_id IS 'Идентификатор календаря';
COMMENT ON COLUMN hdr_business_calendars.code IS 'Код календаря. Календарь по умолчанию: default';
COMMENT ON COLUMN hdr_business_calendars.timezone IS 'Часовой пояс IANA, например Asia/Tashkent';
COMMENT ON COLUMN hdr_business_calendars.week_hours IS 'График недели: объект "0".."6" (0 воскресенье) со значением ["HH:MM","HH:MM"] или null для выходного';
COMMENT ON COLUMN hdr_business_calendars.holidays IS 'Праздничные дни, нерабочие целиком';
COMMENT ON COLUMN hdr_business_calendars.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdr_business_calendars.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdr_business_calendars.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdr_business_calendars.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdr_business_calendars_stamp
  BEFORE INSERT OR UPDATE ON hdr_business_calendars
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

CREATE TABLE hdr_sla_policies (
  priority               text        NOT NULL,
  first_response_minutes integer     NOT NULL,
  resolution_minutes     integer,
  resolution_days        integer,
  clock                  text        NOT NULL DEFAULT 'business',
  calendar_id            uuid        NOT NULL,
  created_by             text,
  created_on             timestamptz NOT NULL DEFAULT now(),
  modified_by            text,
  modified_on            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdr_sla_policies_pk PRIMARY KEY (priority),
  CONSTRAINT hdr_sla_policies_f1 FOREIGN KEY (calendar_id) REFERENCES hdr_business_calendars (calendar_id),
  CONSTRAINT hdr_sla_policies_c1 CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  CONSTRAINT hdr_sla_policies_c2 CHECK (first_response_minutes > 0),
  CONSTRAINT hdr_sla_policies_c3 CHECK ((resolution_minutes IS NULL) <> (resolution_days IS NULL)),
  CONSTRAINT hdr_sla_policies_c4 CHECK (resolution_minutes IS NULL OR resolution_minutes > 0),
  CONSTRAINT hdr_sla_policies_c5 CHECK (resolution_days IS NULL OR resolution_days > 0),
  CONSTRAINT hdr_sla_policies_c6 CHECK (clock IN ('business', '24x7'))
);

COMMENT ON TABLE hdr_sla_policies IS 'Сроки SLA по приоритету (раздел 7.4): первый ответ и решение, режим отсчёта';
COMMENT ON COLUMN hdr_sla_policies.priority IS 'Приоритет: p1, p2, p3, p4';
COMMENT ON COLUMN hdr_sla_policies.first_response_minutes IS 'Срок первого ответа в рабочих минутах';
COMMENT ON COLUMN hdr_sla_policies.resolution_minutes IS 'Срок решения в рабочих минутах (P1, P2). Задан либо он, либо resolution_days';
COMMENT ON COLUMN hdr_sla_policies.resolution_days IS 'Срок решения в рабочих днях (P3, P4)';
COMMENT ON COLUMN hdr_sla_policies.clock IS 'Режим отсчёта: business (рабочее время) или 24x7 (круглосуточно)';
COMMENT ON COLUMN hdr_sla_policies.calendar_id IS 'Рабочий календарь для режима business';
COMMENT ON COLUMN hdr_sla_policies.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdr_sla_policies.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdr_sla_policies.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdr_sla_policies.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdr_sla_policies_stamp
  BEFORE INSERT OR UPDATE ON hdr_sla_policies
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdr_business_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdr_business_calendars FORCE ROW LEVEL SECURITY;
ALTER TABLE hdr_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdr_sla_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY hdr_business_calendars_actor_select ON hdr_business_calendars FOR SELECT TO hub_app
  USING (app.actor_type() <> 'none');
CREATE POLICY hdr_business_calendars_admin_insert ON hdr_business_calendars FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdr_business_calendars_admin_update ON hdr_business_calendars FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdr_sla_policies_actor_select ON hdr_sla_policies FOR SELECT TO hub_app
  USING (app.actor_type() <> 'none');
CREATE POLICY hdr_sla_policies_admin_insert ON hdr_sla_policies FOR INSERT TO hub_app
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');
CREATE POLICY hdr_sla_policies_admin_update ON hdr_sla_policies FOR UPDATE TO hub_app
  USING (app.actor_type() = 'staff' AND app.staff_role() = 'admin')
  WITH CHECK (app.actor_type() = 'staff' AND app.staff_role() = 'admin');

GRANT SELECT, INSERT, UPDATE ON hdr_business_calendars, hdr_sla_policies TO hub_app;
