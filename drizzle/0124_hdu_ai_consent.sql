-- Согласие организации на AI-обработку (план M9, задача 2, решение 10; решения ТЗ 24 и 88, раздел 14.6). Две колонки в
-- конце таблицы организаций: дата согласия и основание (номер письма или договора, до 200 знаков). Включить
-- AI-обработку организации, у которой она была выключена, база даёт только вместе с отметкой: триггер ниже. Строки,
-- где обработка уже включена без отметки, миграция не трогает (на production их нет, решение 10), их прочие изменения
-- проходят. Выключение отметку не требует и её не стирает. Политики RLS не меняются: колонки читают сотрудники, клиенту
-- их не отдаёт код модуля hdu (как заметку руководителя миграции 0064; проверяет tests/integration/hdu-ai-consent.test.ts).

ALTER TABLE hdu_organizations ADD COLUMN ai_consent_on date;
ALTER TABLE hdu_organizations ADD COLUMN ai_consent_ref text;
ALTER TABLE hdu_organizations ADD CONSTRAINT hdu_organizations_c7 CHECK (ai_consent_ref IS NULL OR length(ai_consent_ref) BETWEEN 1 AND 200);
ALTER TABLE hdu_organizations ADD CONSTRAINT hdu_organizations_c8 CHECK ((ai_consent_on IS NULL) = (ai_consent_ref IS NULL));
COMMENT ON COLUMN hdu_organizations.ai_consent_on IS 'Дата письменного согласия организации на AI-обработку (решение ТЗ 88). Пусто: отметки нет';
COMMENT ON COLUMN hdu_organizations.ai_consent_ref IS 'Основание согласия на AI-обработку: номер письма или договора, до 200 знаков. Клиенту не отдаётся';
COMMENT ON CONSTRAINT hdu_organizations_c7 ON hdu_organizations IS 'Основание согласия на AI-обработку: от 1 до 200 знаков';
COMMENT ON CONSTRAINT hdu_organizations_c8 ON hdu_organizations IS 'Дата и основание согласия на AI-обработку заполняются вместе';

CREATE FUNCTION app.hdu_organizations_ai_consent_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.is_ai_enabled AND NOT OLD.is_ai_enabled AND (NEW.ai_consent_on IS NULL OR NEW.ai_consent_ref IS NULL) THEN
    RAISE EXCEPTION 'Организация: AI-обработку включают только с отметкой согласия (дата и основание)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_organizations_ai_consent_guard() IS
  'Триггер: AI-обработку выключенной организации включают только с отметкой согласия (план M9, решение 10)';

CREATE TRIGGER t_hdu_organizations_ai_consent
  BEFORE UPDATE ON hdu_organizations
  FOR EACH ROW EXECUTE FUNCTION app.hdu_organizations_ai_consent_guard();
