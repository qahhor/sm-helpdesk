-- Повтор того же письма (план M4, задача 9): письмо на два адреса поддержки приходит двумя событиями с разными
-- provider_id и одним Message-ID. Разбор ищет уже разобранную строку с тем же Message-ID: индекс для этого поиска.

CREATE INDEX hdn_email_inbound_i2 ON hdn_email_inbound (message_id) WHERE message_id IS NOT NULL;
