import 'server-only';
import { pingDatabases, type ReadyOptions } from '@/db/ready';

// Модуль hdc, слой api: точки входа модуля для страниц и обработчиков (docs/naming.md, раздел 5).

export { healthResponse, readyResponse } from './util';

/**
 * Отвечает ли база за отведённое время по обоим подключениям: приложения (hub_app)
 * и аутентификации (hub_auth). Ошибку не бросает.
 */
export function isDatabaseReady(opts: ReadyOptions = {}): Promise<boolean> {
  return pingDatabases(opts);
}
