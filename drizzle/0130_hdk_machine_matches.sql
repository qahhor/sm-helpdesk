-- Совпадения черновика модели с опубликованным решением считаются отдельно (волна 7, находка S-M8 проверки на
-- AI-инъекции; решение 0154; уточняет FR-CAND-03 и миграцию 0106). Раньше такое совпадение увеличивало
-- staff_useful_count ("пригодилось сотрудникам") без участия человека: текст обращения клиента через черновик модели
-- мог накрутить счётчик решения. Теперь staff_useful_count растёт только от действия сотрудника (объединение
-- кандидата с решением, FR-CAND-04), а совпадения без человека считает machine_match_count.

ALTER TABLE hdk_articles ADD COLUMN machine_match_count integer NOT NULL DEFAULT 0;
ALTER TABLE hdk_articles ADD CONSTRAINT hdk_articles_c9 CHECK (machine_match_count >= 0);

COMMENT ON COLUMN hdk_articles.machine_match_count IS 'Совпадения без человека: сколько раз черновик модели по закрытому обращению без решения оказался похож на это решение (FR-CAND-03, кандидат не создан). Сотрудник это число не подтверждал';
COMMENT ON CONSTRAINT hdk_articles_c9 ON hdk_articles IS 'Счётчик совпадений без человека не отрицательный';
COMMENT ON COLUMN hdk_articles.staff_useful_count IS 'Пригодилось сотрудникам: сколько источников кандидатов сотрудник объединил с этим решением (FR-CAND-04). Совпадения черновика модели без человека считает machine_match_count (миграция 0130)';
