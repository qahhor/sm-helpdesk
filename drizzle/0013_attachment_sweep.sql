-- Обход загрузок фоновым процессом (решение 0028, решение 8 плана M2): неприкреплённая загрузка старше суток
-- удаляется вместе с файлом. Удалять строки вложений может только система и только такие строки:
-- политика ограничивающая (AS RESTRICTIVE), поэтому общая политика сотрудников FOR ALL удаления им не даёт.

GRANT DELETE ON hdt_attachments TO hub_app;

CREATE POLICY hdt_attachments_delete_sweep ON hdt_attachments AS RESTRICTIVE FOR DELETE TO hub_app
  USING (app.actor_type() = 'system' AND ticket_id IS NULL AND created_on < now() - interval '1 day');

COMMENT ON POLICY hdt_attachments_delete_sweep ON hdt_attachments IS
  'Удаление только системой и только неприкреплённых загрузок старше суток (обход attachment.sweep)';
