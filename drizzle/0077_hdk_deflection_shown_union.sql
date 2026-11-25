-- Повторная проверка M5 (docs/decisions/0057, I6c). Строка исходов подсказки копит все решения, показанные за сессию
-- формы, а не только последний показ: иначе "Помогло" по решению, показанному раньше, не засчитывалось сессии, а
-- повторный показ того же решения считался в shown_count ещё раз. Подсказка показывает не больше трёх решений за раз
-- (FR-SOL-08), за сессию их набирается больше; предел строки 50 (приложение держит его же, SHOWN_PER_SESSION_MAX).

ALTER TABLE hdk_deflection_events DROP CONSTRAINT hdk_deflection_events_c5;
ALTER TABLE hdk_deflection_events ADD CONSTRAINT hdk_deflection_events_c5 CHECK (cardinality(shown_article_ids) <= 50);

COMMENT ON COLUMN hdk_deflection_events.shown_article_ids IS 'Решения, показанные за сессию формы (по три за показ, FR-SOL-08), не больше 50';
