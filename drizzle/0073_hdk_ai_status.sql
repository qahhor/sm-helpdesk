-- Состояние задачи модели для языка решения (план M5, задачи 6 и 7, решения 3, 9, 15; ТЗ UX-W-06, UX-W-09).
-- Claude вызывает только фоновый процесс (решение 3): кнопки "Перевести с AI" и "Создать решение" ставят задачу,
-- страница показывает "готовится" и обновляется сама. Чтобы страница знала, что задача поставлена, удалась или нет,
-- строка языка статьи (у черновика из обращения это строка языка оригинала) хранит состояние последней задачи модели.
-- Текста модели здесь нет: он ложится черновиком в hdk_article_versions с пометкой is_machine.

ALTER TABLE hdk_article_translations ADD COLUMN ai_status text;
ALTER TABLE hdk_article_translations ADD CONSTRAINT hdk_article_translations_c4
  CHECK (ai_status IS NULL OR ai_status IN ('pending', 'ready', 'not_confident', 'failed', 'limited', 'unavailable', 'disabled', 'skipped'));

COMMENT ON COLUMN hdk_article_translations.ai_status IS 'Последняя задача модели для этого языка: pending (поставлена), ready (текст модели в черновике), not_confident (черновик есть, модель не уверена), failed (сбой, задача повторяется), limited (суточный предел), unavailable (нет ключа), disabled (AI-обработка организации выключена или обращение не закрыто), skipped (сотрудник начал писать раньше). Пусто: модель не вызывалась';
