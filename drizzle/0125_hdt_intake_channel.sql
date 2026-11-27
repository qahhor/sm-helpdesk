-- Отметка "откуда пришло" у обращения, созданного сотрудником от имени клиента (план M9, задача 3, решение 12; ТЗ 16.7,
-- решение ТЗ 83). Колонка в конце таблицы обращений: telegram, phone, email_direct (письмо сотруднику, а не на адрес
-- поддержки), jira, other. У обращений портала, виджета и почты поле пусто: проверка базы. Обязательность при создании
-- проверяет схема точки входа: у обращений сотрудника, созданных до миграции, отметки нет. Клиенту колонка не
-- отдаётся: запросы клиента её не выбирают (STAFF_ONLY_TICKET_COLUMNS модуля hdt, как заметку руководителя 0064).

ALTER TABLE hdt_tickets ADD COLUMN intake_channel text;
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c21 CHECK (intake_channel IS NULL OR intake_channel IN ('telegram', 'phone', 'email_direct', 'jira', 'other'));
ALTER TABLE hdt_tickets ADD CONSTRAINT hdt_tickets_c22 CHECK (intake_channel IS NULL OR source = 'staff');
COMMENT ON COLUMN hdt_tickets.intake_channel IS 'Откуда пришло обращение мимо портала, если его завёл сотрудник: telegram, phone, email_direct, jira, other (ТЗ 16.7). Внутреннее: клиенту не отдаётся';
COMMENT ON CONSTRAINT hdt_tickets_c21 ON hdt_tickets IS 'Отметка "откуда пришло" из перечня';
COMMENT ON CONSTRAINT hdt_tickets_c22 ON hdt_tickets IS 'Отметка "откуда пришло" только у обращения, созданного сотрудником (source = staff)';
