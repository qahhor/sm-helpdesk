-- Ночная очистка строк идентичности с хешами ссылок и кодов (решение 13 плана M2, подтверждено владельцем
-- 21.11.2026; дополнение к решению 0023). Роль hub_auth получает право удалить строку только от актора system
-- и только когда срок строки вышел больше суток назад. Политика ограничивающая (AS RESTRICTIVE): прежние политики
-- system FOR ALL сами по себе удаления не дают, а клиент и сотрудник не удаляют ничего.

GRANT DELETE ON hdu_email_tokens, hdu_link_codes, hdu_login_codes TO hub_auth;

CREATE POLICY hdu_email_tokens_cleanup ON hdu_email_tokens AS RESTRICTIVE FOR DELETE TO hub_auth
  USING (app.actor_type() = 'system' AND expires_on < now() - interval '1 day');
CREATE POLICY hdu_link_codes_cleanup ON hdu_link_codes AS RESTRICTIVE FOR DELETE TO hub_auth
  USING (app.actor_type() = 'system' AND expires_on < now() - interval '1 day');
CREATE POLICY hdu_login_codes_cleanup ON hdu_login_codes AS RESTRICTIVE FOR DELETE TO hub_auth
  USING (app.actor_type() = 'system' AND expires_on < now() - interval '1 day');

COMMENT ON POLICY hdu_email_tokens_cleanup ON hdu_email_tokens IS 'Удаление только системой и только строк, срок которых вышел больше суток назад';
COMMENT ON POLICY hdu_link_codes_cleanup ON hdu_link_codes IS 'Удаление только системой и только строк, срок которых вышел больше суток назад';
COMMENT ON POLICY hdu_login_codes_cleanup ON hdu_login_codes IS 'Удаление только системой и только строк, срок которых вышел больше суток назад';
