-- Веха M5c, задача 10: решение из кандидата и отдельное подтверждение недоверенного текста (ТЗ FR-CAND-04, 06, 09,
-- FR-SOL-04, 05, угроза T33; план M5c, решения 29, 30). Номер миграции сдвинут на два от плана (0105).
--
-- 1. hdk_articles.is_untrusted: черновик решения сделан из кандидата, то есть из текста модели по переписке клиента.
--    У такого решения находки "телефон", "почта", "команда", "код" при публикации блокируют кнопку, пока сотрудник не
--    отметит каждую "Проверено".
-- 2. hdk_article_versions.untrusted_confirmed: отметки сотрудника в версии: отпечатки находок и отпечаток текста, с
--    которого они сделаны. Изменённый текст даёт другой отпечаток: отметки больше не действуют.

ALTER TABLE hdk_articles ADD COLUMN is_untrusted boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN hdk_articles.is_untrusted IS 'Решение сделано из кандидата (текст модели по переписке клиента, FR-CAND-09): находки телефона, почты, команд и кода публикуются только после отметки каждой';

ALTER TABLE hdk_article_versions ADD COLUMN untrusted_confirmed jsonb;
ALTER TABLE hdk_article_versions ADD CONSTRAINT hdk_article_versions_c6 CHECK (
  untrusted_confirmed IS NULL OR (jsonb_typeof(untrusted_confirmed) = 'object' AND jsonb_typeof(untrusted_confirmed -> 'fingerprints') = 'array' AND untrusted_confirmed ->> 'textHash' ~ '^[0-9a-f]{64}$')
);
COMMENT ON COLUMN hdk_article_versions.untrusted_confirmed IS 'Отметки "Проверено" находок недоверенного текста: {textHash, fingerprints}. Отпечаток текста другой (текст изменён): отметки не действуют';
COMMENT ON CONSTRAINT hdk_article_versions_c6 ON hdk_article_versions IS 'Отметки недоверенного текста: объект с массивом отпечатков находок и шестнадцатеричным отпечатком текста';
