import 'server-only';
import { pingDatabases, type ReadyOptions } from '@/db/ready';

// Модуль hdc, слой api: точки входа модуля для страниц и обработчиков (docs/naming.md, раздел 5).

export { healthResponse, readyResponse } from './util';
// Журнал аудита для экрана администратора (FR-ADM-07).
export { AUDIT_PAGE_SIZE, type AuditRow, listAudit } from './audit';
export { HdcError, isHdcError } from './error';
// Для других модулей: запись аудита в транзакции их действия, счётчики частоты, адрес посетителя,
// ответы обработчиков. Внутренние файлы модуля другим модулям не видны (правило линтера, проверка main, Q6).
export { type AuditEntry, writeAudit } from './audit';
export { cleanupRateLimits, consumeRateLimit, resetRateLimit } from './rate-limit';
export { clientIp, clientIpHeader, ipBucket, ipRateKey, isSameOriginJson, problemResponse, rateKey, readLimited } from './util';
// Приём отчётов о нарушениях CSP (проверка main, S9).
export { handleCspReport } from './csp-report';
// Хранилище вложений и фоновые задачи (раздел 11.11, решение 0027).
export { contentDisposition, getStorage, handleLocalStorage, type Storage, UPLOAD_LINK_TTL_SEC } from './storage';
export { enqueue, type JobName } from './jobs';
export { type AntivirusScanner, getScanner } from './antivirus';
export { type DetectedType, SNIFF_BYTES, sniffFileType } from './filetype';
// Настройки портала (hdc_settings).
export { readSetting } from './settings';
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
