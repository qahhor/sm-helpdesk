import { DEV_TASK_URL_MAX } from './pref';

// Модуль hdw: проверка адреса задачи разработки (FR-DEV-02; план M8, задача 7). Чистый файл без базы и сети.
// Адрес портал не открывает: он только показывается сотруднику внешней ссылкой. Поэтому узел не проверяется на
// "внешний" (таск-менеджер бывает во внутренней сети), проверяется схема: иначе ссылкой стал бы javascript: или data:.

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Адрес задачи для показа ссылкой: https без учётной записи, не длиннее 500 знаков. http принимается только для
 * localhost и 127.0.0.1 и только когда сам портал работает на localhost (localPortal), как у адресов вебхуков.
 * Иная схема, неразборчивый или слишком длинный адрес: null. Возвращает адрес в записи разборщика URL.
 */
export function devTaskUrlOrNull(raw: string, localPortal: boolean): string | null {
  if (raw.length > DEV_TASK_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localPortal && LOCAL_HOSTS.has(url.hostname))) return null;
  const text = url.toString();
  return text.length <= DEV_TASK_URL_MAX && !/\s/.test(text) ? text : null;
}
