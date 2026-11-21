-- Отозванное приглашение не возвращается (итоговая проверка M1, мелкое 5). Прежний триггер разрешал
-- пользователю менять отметку об отзыве в любую сторону: администратор клиента мог снять её с
-- приглашения, которое отозвал другой администратор или сотрудник.

CREATE OR REPLACE FUNCTION app.hdu_invitations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app.actor_type() IN ('client', 'staff')
     AND ((NEW.org_id, NEW.email, NEW.role, NEW.name, NEW.is_lead, NEW.token_hash, NEW.invited_by, NEW.expires_on, NEW.accepted_on)
           IS DISTINCT FROM
           (OLD.org_id, OLD.email, OLD.role, OLD.name, OLD.is_lead, OLD.token_hash, OLD.invited_by, OLD.expires_on, OLD.accepted_on)
          OR (OLD.revoked_on IS NOT NULL AND NEW.revoked_on IS DISTINCT FROM OLD.revoked_on)) THEN
    RAISE EXCEPTION 'Приглашение: менять можно только отметку об отзыве, и только поставить её, остальное нельзя' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdu_invitations_guard() IS 'Триггер: пользователь может только отозвать приглашение, отзыв не снимается';
