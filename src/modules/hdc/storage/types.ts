// Хранилище файлов (ТЗ, раздел 11.11; решение 0027): интерфейс, общий для R2, локальной заглушки и памяти тестов.
// Портал файлы не проксирует: браузер кладёт файл по подписанной ссылке и забирает по такой же.

export interface Storage {
  /** Ссылка PUT на UPLOAD_LINK_TTL_SEC секунд. Тип и размер подписаны: другой файл хранилище не примет. */
  presignUpload(key: string, mime: string, size: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** Ссылка GET на ttlSeconds секунд. Без inline файл скачивается (Content-Disposition: attachment). */
  presignDownload(key: string, filename: string, ttlSeconds: number, inline?: boolean): Promise<string>;
  /** Размер объекта или null, если объекта нет. */
  head(key: string): Promise<{ size: number } | null>;
  move(fromKey: string, toKey: string): Promise<void>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Удаление. Отсутствующий объект ошибкой не считается. */
  remove(key: string): Promise<void>;
}

/** Срок ссылки на загрузку (FR-TK-13). */
export const UPLOAD_LINK_TTL_SEC = 300;

/** Ключи quarantine/{attachment_id} и files/{org_id}/{attachment_id}: без точек и других знаков пути. */
const STORAGE_KEY = /^(?:quarantine|files)(?:\/[A-Za-z0-9_-]{1,64}){1,3}$/;

export function assertKey(key: string): string {
  if (!STORAGE_KEY.test(key)) throw new Error('хранилище: недопустимый ключ');
  return key;
}

/**
 * Заголовок Content-Disposition с именем файла: запасное имя из печатных знаков ASCII для старых браузеров
 * и точное имя в UTF-8 (RFC 6266, RFC 5987).
 */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
