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
export { cleanupRateLimits, consumeRateLimit, peekRateLimit, resetRateLimit } from './rate-limit';
export { clientIp, clientIpHeader, ipBucket, ipRateKey, isOwnNavigation, isSameOriginJson, problemResponse, rateKey, readLimited } from './util';
// Приём отчётов о нарушениях CSP (проверка main, S9).
export { handleCspReport } from './csp-report';
// Хранилище вложений и фоновые задачи (раздел 11.11, решение 0027).
export { contentDisposition, getStorage, handleLocalStorage, type Storage, UPLOAD_LINK_TTL_SEC } from './storage';
// Фоновые задачи: постановка для портала, настройки и очередь pg-boss для фонового процесса (решение 0028).
export { bossOptions, createPgBossQueue, enqueue, JOB_NAMES, type JobName, type JobOptions, setJobQueue } from './jobs';
export { type AntivirusScanner, getScanner } from './antivirus';
export { type DetectedType, SNIFF_BYTES, sniffFileType } from './filetype';
export { type QuarantineResult, scanQuarantinedImage } from './scan';
// Настройки портала (hdc_settings).
export { readSetting, writeSettingTx } from './settings';
export { AUDIT_ACTIONS, type AuditAction } from './pref';
// События предметной области (FR-AUTO-02; план M8, задача 2): запись в транзакции действия, разбор фоновой задачей.
export {
  cleanupDomainEvents,
  type DomainEvent,
  droppedEventsSince,
  emitEventTx,
  EVENT_MAX_ATTEMPTS,
  EVENT_RETRY_SECONDS,
  type EventHandler,
  EVENTS_KEEP_DAYS,
  eventsState,
  type NewDomainEvent,
  processEvents,
  type ProcessOptions,
  wakeAutomation,
} from './events';
export { DOMAIN_EVENT_KINDS, type DomainEventKind } from './pref';
// Сигналы дежурным о состоянии портала (ТЗ 13.8).
export { type ArchiveState, archiveFailing, archiveState, claimOpsAlert, failedJobsSince, failedStaffSignIns, noteStaffSignInFailure, OPS_ALERT_EVERY_MS } from './ops-alerts';
// Наблюдение без внешних сервисов (план подготовки M9, задача 3): отметка фонового процесса и отметки резервных копий.
export {
  BACKUP_KINDS,
  BACKUP_STALE_HOURS,
  type BackupKind,
  beatWorker,
  latestBackups,
  type LatestBackups,
  markBackup,
  staleBackupKinds,
  type StaleBackupKind,
  WORKER_STALE_SEC,
  workerReadyResponse,
} from './ops-status';
// Политика обработки данных из файлов content/legal/ (раздел 14.6 ТЗ).
export { getPolicy, getPolicyVersion, type Policy, type PolicyBlock } from './legal';
// Общие понятия для модулей ниже hdu (аудит 23.11.2026, находка A1): справочник контактов и контекст сотрудника.
export { type ContactDirectory, contacts, type MailContact, registerContactDirectory, type TelegramContact } from './contacts';
export { recordTicketSignature, registerTicketSignatureRecorder, type TicketSignatureInput, type TicketSignatureRecorder } from './ticket-signatures';
// Известная проблема по сигнатуре нового обращения (веха M5c): обращения в hdt, проблемы в hdp.
export { type KnownProblemLinker, linkKnownProblem, registerKnownProblemLinker } from './known-problems';
export { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './staff-session';
// Кнопки под ответом Теза в Telegram (веха M5b): бот в hdu, реализация в hdt.
export { registerTezFeedback, tezFeedback, type TezFeedbackHandler, type TezFeedbackResult } from './tez-feedback';

/**
 * Отвечает ли база за отведённое время по обоим подключениям: приложения (hub_app)
 * и аутентификации (hub_auth). Ошибку не бросает.
 */
export function isDatabaseReady(opts: ReadyOptions = {}): Promise<boolean> {
  return pingDatabases(opts);
}
// Поиск на Typesense (план W6; ТЗ 11.11 SearchReader и SearchIndexWriter): ключ с областью из актора, откат на
// PostgreSQL, свёртка написаний. Другие модули берут поиск только отсюда.
export {
  aliasOf,
  COLLECTION_SCHEMAS,
  createStubSearch,
  type CurationItem,
  filterValues,
  FOLD_WEIGHT,
  foldText,
  mergeRanked,
  type RankedList,
  SEARCH_TIMEOUT_MS,
  STOPWORD_SETS,
  getSearchReader,
  getSearchWriter,
  HIDDEN_IDEA_STATUSES,
  localeField,
  localizedFields,
  noteIsolationDrop,
  processStub,
  SEARCH_COLLECTIONS,
  type SearchCollection,
  searchAs,
  searchCounters,
  type SearchDocument,
  type SearchFallback,
  type SearchHitId,
  type SearchIds,
  type SearchIndexWriter,
  type SearchPurpose,
  type SearchReader,
  type SearchSpec,
  SearchWriteError,
  setSearchForTests,
  setSearchKeysForTests,
  type StemPair,
  type StubSearch,
  type SynonymItem,
  TEXT_LIMITS,
} from './search';
export { issueSearchKeys } from './search/admin';
export {
  cleanupDroppedOutbox,
  DRIFT_ALERT_SHARE,
  KIND_OF,
  pendingEntities,
  reconcileCollection,
  type ReconcileReport,
  prepareSearchIndex,
  applyAllConfig,
  registerSearchSources,
  reindexCollection,
  runSearchSync,
  type SearchSource,
  searchQueueState,
  type SourceKind,
  type SyncResult,
} from './search/sync';
export {
  curationSchema,
  type CurationRules,
  SEARCH_SETTING_CODES,
  SEARCH_SETTINGS_LIMITS,
  stemPairsSchema,
  type StemPairs,
  synonymSetsSchema,
  type SynonymSets,
} from './search/config';
