-- Вложение, удалённое по сроку хранения (ТЗ 14.6, решение 78: вложения хранятся 1 год после закрытия обращения;
-- волна 7, находка T2; решение 0162). Ночная задача retention.client_data удаляет файл из хранилища и оставляет строку
-- с отметкой expired: политики RLS и право удаления строк не меняются (удалять строки вложений по-прежнему может только
-- обход неприкреплённых загрузок, миграция 0013). Клиент строку с отметкой не видит: политика hdt_attachments_client_select
-- отдаёт ему только проверенные файлы (clean). Отметку ставит только система (триггер миграции 0018).

ALTER TABLE hdt_attachments DROP CONSTRAINT hdt_attachments_c1;
ALTER TABLE hdt_attachments ADD CONSTRAINT hdt_attachments_c1 CHECK (scan_status IN ('pending', 'clean', 'infected', 'rejected', 'expired'));

COMMENT ON COLUMN hdt_attachments.scan_status IS 'Проверка: pending, clean, infected, rejected (тип не совпал или запрещён), expired (файл удалён по сроку хранения, строка осталась)';
COMMENT ON CONSTRAINT hdt_attachments_c1 ON hdt_attachments IS 'Состояние файла из закрытого списка';
