-- Прошлый визит сотрудника в обращение (UX-A-15, решение 11 плана M3): по нему отмечается новое с прошлого раза.
-- Строка своя у каждого сотрудника, в том числе у роли product: отметка просмотра обращение не меняет.

CREATE TABLE hdt_ticket_reads (
  ticket_id   uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  seen_on     timestamptz NOT NULL,
  created_by  text,
  created_on  timestamptz NOT NULL DEFAULT now(),
  modified_by text,
  modified_on timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hdt_ticket_reads_pk PRIMARY KEY (ticket_id, user_id),
  CONSTRAINT hdt_ticket_reads_f1 FOREIGN KEY (ticket_id) REFERENCES hdt_tickets (ticket_id),
  CONSTRAINT hdt_ticket_reads_f2 FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX hdt_ticket_reads_i1 ON hdt_ticket_reads (user_id);

COMMENT ON TABLE hdt_ticket_reads IS 'Последний просмотр обращения сотрудником: по нему отмечается новое с прошлого визита';
COMMENT ON COLUMN hdt_ticket_reads.ticket_id IS 'Обращение';
COMMENT ON COLUMN hdt_ticket_reads.user_id IS 'Сотрудник';
COMMENT ON COLUMN hdt_ticket_reads.seen_on IS 'Когда сотрудник последний раз открывал обращение';
COMMENT ON COLUMN hdt_ticket_reads.created_by IS 'Кто создал строку. Заполняет база';
COMMENT ON COLUMN hdt_ticket_reads.created_on IS 'Когда создана строка. Заполняет база';
COMMENT ON COLUMN hdt_ticket_reads.modified_by IS 'Кто изменил строку последним. Заполняет база';
COMMENT ON COLUMN hdt_ticket_reads.modified_on IS 'Когда строка изменена последний раз. Заполняет база';

CREATE TRIGGER t_hdt_ticket_reads_stamp
  BEFORE INSERT OR UPDATE ON hdt_ticket_reads
  FOR EACH ROW EXECUTE FUNCTION app.stamp_row();

ALTER TABLE hdt_ticket_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hdt_ticket_reads FORCE ROW LEVEL SECURITY;

CREATE POLICY hdt_ticket_reads_staff_own ON hdt_ticket_reads FOR ALL TO hub_app
  USING (app.actor_type() = 'staff' AND user_id = app.user_uuid())
  WITH CHECK (app.actor_type() = 'staff' AND user_id = app.user_uuid());

GRANT SELECT, INSERT, UPDATE ON hdt_ticket_reads TO hub_app;
