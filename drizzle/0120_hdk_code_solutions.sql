-- Веха M8c, задача 6: решение из записи каталога ошибок (ТЗ 7.22 FR-CODE-07, 15; план M8c, решение 17).
--
-- hdk_articles.code_entry_id: запись знаний из кода, из которой сотрудник создал черновик решения. По ней проверка
-- перед публикацией (FR-SOL-04) ищет ещё объекты и пути записи, а показатель пользы считает решения из записей.
-- Политики статьи не меняются: колонку ставит сотрудник с правом черновика решения при создании черновика.

ALTER TABLE hdk_articles ADD COLUMN code_entry_id uuid;
ALTER TABLE hdk_articles ADD CONSTRAINT hdk_articles_f4 FOREIGN KEY (code_entry_id) REFERENCES hda_code_error_entries (entry_id) NOT VALID;
ALTER TABLE hdk_articles VALIDATE CONSTRAINT hdk_articles_f4;
CREATE INDEX hdk_articles_i4 ON hdk_articles (code_entry_id) WHERE code_entry_id IS NOT NULL;
COMMENT ON COLUMN hdk_articles.code_entry_id IS 'Запись каталога ошибок, из которой создан черновик решения (веха M8c, FR-CODE-07). Пусто у остальных решений';
COMMENT ON INDEX hdk_articles_i4 IS 'Внешний ключ: запись каталога ошибок; показатель решений из записей (FR-CODE-15)';
