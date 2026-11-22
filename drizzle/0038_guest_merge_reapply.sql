-- Повторный переход гостя (итоговая проверка M4, замечание I6). Письмо без DMARC после перехода снова приходит от
-- гостя; когда владелец адреса ещё раз доказывает адрес, та же пара гость и пользователь должна применяться заново.
-- Система (hub_auth) сбрасывает отметку применения у уже записанной пары: задача раз в минуту перенесёт остаток.

GRANT UPDATE (applied_on) ON hdu_guest_merges TO hub_auth;
CREATE POLICY hdu_guest_merges_auth_update ON hdu_guest_merges FOR UPDATE TO hub_auth
  USING (app.actor_type() = 'system') WITH CHECK (app.actor_type() = 'system');
COMMENT ON POLICY hdu_guest_merges_auth_update ON hdu_guest_merges IS 'Повторное доказательство адреса сбрасывает отметку применения: остаток обращений гостя переходит заново';
