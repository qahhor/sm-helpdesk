-- Индексы проверок состояния портала (итоговая проверка волны 0, замечания I2 и M4; ТЗ 13.8).
-- Задача ops.watch раз в 5 минут и событие outbox.state раз в минуту считают сбои отправки и заражённые файлы
-- за последний час. Без индексов это полный просмотр очереди исходящих и таблицы вложений.

-- Сбой отправки самого портала: строка исчерпала повторы и не ушла.
CREATE INDEX hdn_outbox_i3 ON hdn_outbox (modified_on) WHERE status = 'failed' AND sent_on IS NULL;
-- Файлы с отметкой "заражён".
CREATE INDEX hdt_attachments_i6 ON hdt_attachments (modified_on) WHERE scan_status = 'infected';
