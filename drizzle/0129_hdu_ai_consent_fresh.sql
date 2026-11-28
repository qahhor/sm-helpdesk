-- Согласие на AI-обработку ставится заново при каждом включении (независимая проверка M9, находка M5; решение 0147).
-- Прежняя функция триггера (миграция 0124) пропускала включение, если после выключения осталась старая отметка:
-- одного признака is_ai_enabled = true хватало. Теперь включение выключенной организации требует, чтобы дата или
-- основание согласия изменились в этом же UPDATE. Код (hdu, core/orgs.ts, setOrgAiProcessingTx) перед включением
-- снимает прежнюю отметку и ставит новую, так что повтор того же письма тоже проходит. Политики RLS не меняются.

CREATE OR REPLACE FUNCTION app.hdu_organizations_ai_consent_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.is_ai_enabled AND NOT OLD.is_ai_enabled AND (
    NEW.ai_consent_on IS NULL OR NEW.ai_consent_ref IS NULL
    OR (NEW.ai_consent_on IS NOT DISTINCT FROM OLD.ai_consent_on AND NEW.ai_consent_ref IS NOT DISTINCT FROM OLD.ai_consent_ref)
  ) THEN
    RAISE EXCEPTION 'Организация: AI-обработку включают только с новой отметкой согласия (дата и основание) в том же изменении' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_organizations_ai_consent_guard() IS
  'Триггер: AI-обработку выключенной организации включают только с отметкой согласия, поставленной в том же UPDATE (план M9, решение 10; решение 0147)';
