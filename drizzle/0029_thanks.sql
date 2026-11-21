-- Благодарность на решённое обращение (FR-TK-14, решение 15 плана M3): сообщение клиента сохраняется, но обращение
-- не открывается заново. Отметка нужна для списка "Не открыли обращение" у сотрудников. Ставит сервис по простым
-- признакам; клиенту отметка не видна и ничего не меняет в его правах.

ALTER TABLE hdt_ticket_messages ADD COLUMN is_thanks boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN hdt_ticket_messages.is_thanks IS 'Благодарность клиента на решённое обращение: обращение не открылось заново (FR-TK-14)';

CREATE INDEX hdt_ticket_messages_i3 ON hdt_ticket_messages (created_on DESC) WHERE is_thanks;
