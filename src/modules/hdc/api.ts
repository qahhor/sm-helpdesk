import 'server-only';
import { pingDatabases, type ReadyOptions } from '@/db/ready';

// Модуль hdc, слой api: точки входа модуля для страниц и обработчиков (docs/naming.md, раздел 5).

export { healthResponse, readyResponse } from './util';
// Журнал аудита для экрана администратора (FR-ADM-07).
export { AUDIT_PAGE_SIZE, type AuditRow, listAudit } from './audit';
export { HdcError, isHdcError } from './error';
// Приём отчётов о нарушениях CSP (проверка main, S9).
export { handleCspReport } from './csp-report';
export { AUDIT_ACTIONS, type AuditAction } from './pref';
// Политика обработки данных из файлов content/legal/ (раздел 14.6 ТЗ).
export { getPolicy, getPolicyVersion, type Policy, type PolicyBlock } from './legal';

/**
 * Отвечает ли база за отведённое время по обоим подключениям: приложения (hub_app)
 * и аутентификации (hub_auth). Ошибку не бросает.
 */
export function isDatabaseReady(opts: ReadyOptions = {}): Promise<boolean> {
  return pingDatabases(opts);
}
