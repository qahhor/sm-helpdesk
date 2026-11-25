import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { EMBED_KEY_PARAM, embedAncestors } from '@/security/embed-frame';
import { EmbedSession } from '@/ui/widget/EmbedSession';
import { widgetLabels } from '../labels';

// Раскладка страниц виджета во фрейме Smartup Web (план M6, задачи 4-6; решения 1, 6 и 8). Сессию портала и куки
// не читает: прокси удаляет заголовок Cookie у этих страниц. Адреса встраивания сервера по ключу ?key= (те же, что
// стоят в frame-ancestors) уходят странице: только им она отвечает по postMessage. Токен виджета живёт в памяти
// поставщика EmbedSession; раскладка при переходах между страницами виджета не пересоздаётся, токен не теряется.

/** Ключ встраивания из адреса запроса: его передаёт прокси заголовком x-hub-path. */
function keyOf(path: string): string | null {
  try {
    return new URL(path, 'http://hub.invalid').searchParams.get(EMBED_KEY_PARAM);
  } catch {
    return null;
  }
}

export default async function EmbedLayout({ children }: LayoutProps<'/[locale]/embed'>) {
  const allowed = await embedAncestors(keyOf((await headers()).get('x-hub-path') ?? ''));
  return (
    <EmbedSession allowed={allowed} locale={await getLocale()} labels={await widgetLabels()}>
      {children}
    </EmbedSession>
  );
}
