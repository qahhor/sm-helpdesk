-- Срок хранения журнала аудита: 3 года (вопрос 16, решение владельца 24.11.2026; ТЗ 14.6; решение 0041).
-- До этой миграции журнал не удалял никто: права DELETE у роли приложения не было. Теперь удаляет только ночная
-- очистка под системным актором и только записи старше 3 лет: политика не пускает более свежую запись ни одному
-- актору, даже системе. Изменять записи по-прежнему нельзя никому.
GRANT DELETE ON hdc_audit_log TO hub_app;
-- Чтобы удалить строку, база должна её видеть. Система видит только записи старше срока хранения: свежий журнал
-- по-прежнему читает один администратор портала.
CREATE POLICY hdc_audit_log_system_select_expired ON hdc_audit_log FOR SELECT TO hub_app
  USING (app.actor_type() = 'system' AND created_on < now() - interval '3 years');
COMMENT ON POLICY hdc_audit_log_system_select_expired ON hdc_audit_log IS 'Ночная очистка видит только записи старше 3 лет, которые удаляет';
CREATE POLICY hdc_audit_log_system_delete ON hdc_audit_log FOR DELETE TO hub_app
  USING (app.actor_type() = 'system' AND created_on < now() - interval '3 years');
COMMENT ON POLICY hdc_audit_log_system_delete ON hdc_audit_log IS 'Ночная очистка удаляет записи журнала старше 3 лет; моложе не удаляет никто';
