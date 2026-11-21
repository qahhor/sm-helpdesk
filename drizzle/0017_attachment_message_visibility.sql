-- Вложение сообщения клиент видит, только если видит само сообщение (итоговая проверка M2, отложенное замечание 3).
-- Раньше видимость держалась на копии флага is_internal у файла: если при внутренней заметке сотрудника его
-- забыть поставить, клиент увидел бы файл заметки. Подзапрос к сообщениям идёт под их политикой RLS, а она
-- внутренние заметки клиенту не отдаёт. Ужесточение, права не расширяются.

DROP POLICY hdt_attachments_client_select ON hdt_attachments;
CREATE POLICY hdt_attachments_client_select ON hdt_attachments FOR SELECT TO hub_app
  USING (
    app.actor_type() = 'client' AND org_id = app.org_id() AND NOT is_internal
    AND (message_id IS NULL OR EXISTS (SELECT 1 FROM hdt_ticket_messages m WHERE m.message_id = hdt_attachments.message_id))
    AND (
      (uploader_id = app.user_uuid() AND (ticket_id IS NULL OR EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_attachments.ticket_id)))
      OR (ticket_id IS NOT NULL AND scan_status = 'clean' AND EXISTS (SELECT 1 FROM hdt_tickets t WHERE t.ticket_id = hdt_attachments.ticket_id))
    )
  );
COMMENT ON POLICY hdt_attachments_client_select ON hdt_attachments IS
  'Клиент видит свои загрузки и чистые файлы видимых обращений, но не файлы сообщений, которые ему не видны';
