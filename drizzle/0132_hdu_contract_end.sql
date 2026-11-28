-- Дата окончания договора организации (ТЗ 14.6, решение 78; волна 7, находка T2; решение 0162). От неё считается срок
-- хранения обращений: 3 года после окончания договора. Дату задаёт администратор портала в карточке организации (или
-- позже Smartup Billing от имени системы). Клиенту колонка не отдаётся: представления и запросы кабинета её не читают.

ALTER TABLE hdu_organizations ADD COLUMN contract_ends_on date;
ALTER TABLE hdu_organizations ADD CONSTRAINT hdu_organizations_c9 CHECK (contract_ends_on IS NULL OR contract_ends_on >= DATE '2000-01-01');

COMMENT ON COLUMN hdu_organizations.contract_ends_on IS 'Дата окончания договора с клиентом. Пусто: договор действует или дата не задана. От неё считается срок хранения обращений (3 года, ТЗ 14.6)';
COMMENT ON CONSTRAINT hdu_organizations_c9 ON hdu_organizations IS 'Дата окончания договора не раньше 2000 года';

-- Триггер сотрудника (миграция 0007): care и admin меняют категорию и признак AI; дату окончания договора из
-- сотрудников меняет только администратор. Прежние запреты сохранены дословно, добавлен один.
CREATE OR REPLACE FUNCTION app.hdu_organizations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() = 'staff'
     AND (NEW.org_id, NEW.server_id, NEW.external_company_id, NEW.name, NEW.inn, NEW.state, NEW.created_by, NEW.created_on)
         IS DISTINCT FROM
         (OLD.org_id, OLD.server_id, OLD.external_company_id, OLD.name, OLD.inn, OLD.state, OLD.created_by, OLD.created_on) THEN
    RAISE EXCEPTION 'Организация: сотрудник меняет только категорию и признак AI, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  IF app.actor_type() = 'staff' AND app.staff_role() <> 'admin' AND NEW.contract_ends_on IS DISTINCT FROM OLD.contract_ends_on THEN
    RAISE EXCEPTION 'Организация: дату окончания договора меняет только администратор, остальным нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_organizations_guard() IS 'Триггер: сотрудник меняет у организации только категорию и признак AI; дату окончания договора только администратор';
