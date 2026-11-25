-- Полнотекстовый вектор поискового индекса (ТЗ 10.4, 11.6; план M5, задача 9). Конфигурация по языку документа:
-- russian для русского, english для английского, simple для узбекского (встроенного узбекского стеммера в PostgreSQL
-- нет). Заголовок весит больше текста (вес A против B). Узбекская латиница пишет o‘ и g‘ разными знаками апострофа:
-- перед разбором они убираются, и то же делает поиск с запросом (функция app.hdk_search_text), иначе "o‘zgartirish"
-- и "o'zgartirish" дали бы разные слова. Колонку tsv приложение не пишет: её всегда пересчитывает триггер.
-- Индексы GIN, триграммный и HNSW создаёт следующая миграция вне транзакции (0075).
--
-- Строк в индексе до этой миграции нет: задание kb.index до задачи 9 ничего не записывало, поэтому пересчёт
-- старых строк не нужен (пропущенное находит ночная сверка kb.reconcile).

CREATE FUNCTION app.hdk_text_config(locale text) RETURNS regconfig LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE locale WHEN 'ru' THEN 'pg_catalog.russian'::regconfig WHEN 'en' THEN 'pg_catalog.english'::regconfig ELSE 'pg_catalog.simple'::regconfig END $$;
COMMENT ON FUNCTION app.hdk_text_config(text) IS 'Конфигурация полнотекстового поиска для языка документа: russian, english, simple для узбекского (ТЗ 10.4)';

CREATE FUNCTION app.hdk_search_text(locale text, value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN locale = 'uz' THEN translate(coalesce(value, ''), E'‘’ʻʼ`''', '') ELSE coalesce(value, '') END $$;
COMMENT ON FUNCTION app.hdk_search_text(text, text) IS 'Текст для разбора: в узбекском убираются знаки апострофа (o‘, g‘), одинаково у документа и запроса';

CREATE FUNCTION app.hdk_search_documents_tsv() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  cfg regconfig := app.hdk_text_config(NEW.locale);
BEGIN
  NEW.tsv := setweight(to_tsvector(cfg, app.hdk_search_text(NEW.locale, NEW.title)), 'A')
          || setweight(to_tsvector(cfg, app.hdk_search_text(NEW.locale, NEW.body_text)), 'B');
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.hdk_search_documents_tsv() IS 'Пересчитывает tsv строки индекса из заголовка и текста по языку документа (ТЗ 10.4)';

-- tsv в списке колонок: значение, записанное приложением напрямую, триггер всё равно заменит пересчитанным.
CREATE TRIGGER t_hdk_search_documents_tsv
  BEFORE INSERT OR UPDATE OF title, body_text, locale, tsv ON hdk_search_documents
  FOR EACH ROW EXECUTE FUNCTION app.hdk_search_documents_tsv();
