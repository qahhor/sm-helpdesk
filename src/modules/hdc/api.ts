import 'server-only';
import { pingDatabases, type ReadyOptions } from '@/db/ready';

// Модуль hdc, слой api: точки входа модуля для страниц и обработчиков (docs/naming.md, раздел 5).

export { healthResponse, readyResponse } from './util';
// Журнал аудита для экрана администратора (FR-ADM-07).
export { AUDIT_PAGE_SIZE, AUDIT_RETENTION_YEARS, type AuditRow, cleanupAudit, listAudit } from './audit';
export { HdcError, isHdcError } from './error';
// Для других модулей: запись аудита в транзакции их действия, счётчики частоты, адрес посетителя,
// ответы обработчиков. Внутренние файлы модуля другим модулям не видны (правило линтера, проверка main, Q6).
export { type AuditEntry, writeAudit } from './audit';
export { cleanupRateLimits, consumeRateLimit, resetRateLimit } from './rate-limit';
export { clientIp, clientIpHeader, ipBucket, ipRateKey, isOwnNavigation, isSameOriginJson, problemResponse, rateKey, readLimited } from './util';
// Приём отчётов о нарушениях CSP (проверка main, S9).
export { handleCspReport } from './csp-report';
// Хранилище вложений и фоновые задачи (раздел 11.11, решение 0027).
export { contentDisposition, getStorage, handleLocalStorage, type Storage, UPLOAD_LINK_TTL_SEC } from './storage';
// Фоновые задачи: постановка для портала, настройки и очередь pg-boss для фонового процесса (решение 0028).
export { bossOptions, createPgBossQueue, enqueue, JOB_NAMES, type JobName, setJobQueue } from './jobs';
export { type AntivirusScanner, getScanner } from './antivirus';
export { type DetectedType, SNIFF_BYTES, sniffFileType } from './filetype';
// Настройки портала (hdc_settings).
export { readSetting, writeSettingTx } from './settings';
export { AUDIT_ACTIONS, type AuditAction } from './pref';
// Сигналы дежурным о состоянии портала (ТЗ 13.8).
export { type ArchiveState, archiveFailing, archiveState, claimOpsAlert, failedJobsSince, failedStaffSignIns, noteStaffSignInFailure, OPS_ALERT_EVERY_MS } from './ops-alerts';
// Политика обработки данных из файлов content/legal/ (раздел 14.6 ТЗ).
export { getPolicy, getPolicyVersion, type Policy, type PolicyBlock } from './legal';
// Общие понятия для модулей ниже hdu (аудит 23.11.2026, находка A1): справочник контактов и контекст сотрудника.
export { type ContactDirectory, contacts, type MailContact, registerContactDirectory, type TelegramContact } from './contacts';
export { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './staff-session';

/**
 * Отвечает ли база за отведённое время по обоим подключениям: приложения (hub_app)
 * и аутентификации (hub_auth). Ошибку не бросает.
 */
export function isDatabaseReady(opts: ReadyOptions = {}): Promise<boolean> {
  return pingDatabases(opts);
}
