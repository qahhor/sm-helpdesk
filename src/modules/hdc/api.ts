import 'server-only';
import { pingDb } from '@/db/client';

// Модуль hdc, слой api: точки входа модуля для страниц и обработчиков (docs/naming.md, раздел 5).

/** Отвечает ли база приложения за отведённое время. Ошибку не бросает. */
export function isDatabaseReady(timeoutMs = 2000): Promise<boolean> {
  return pingDb(timeoutMs);
}
