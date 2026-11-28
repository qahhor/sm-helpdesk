-- Очистка отметок ресурсов сервера (независимая проверка M9, находка M2; решение 0145). Снятый или переименованный
-- сервер оставлял строку в hdc_ops_host_marks навсегда, и ops.watch слал по ней host_mark_stale без конца. Ночная
-- очистка под системным актором удаляет отметки старше 7 суток. Политика hdc_ops_host_marks_system_all уже
-- ограничивает все действия системным актором; здесь добавляется только право DELETE роли hub_app.

GRANT DELETE ON hdc_ops_host_marks TO hub_app;
COMMENT ON POLICY hdc_ops_host_marks_system_all ON hdc_ops_host_marks IS 'Отметку ставит команда hub ops:host-mark, читает задача ops.watch, отметки старше 7 суток удаляет ночная очистка; все под системным актором';
