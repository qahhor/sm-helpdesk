// Модуль hda, слой api: константы для страниц (план M5b, задача 1). Страницы берут модуль только через api.

export { AI_FLAG_REASONS, AI_MODELS, AI_PURPOSES, AI_REVIEW_RESULTS, CANDIDATE_REJECT_REASONS, CANDIDATE_STATUSES, REPORT_KINDS, TRIAGE_FIELDS, type AiModel, type AiPurpose, type CandidateRejectReason, type CandidateStatus, type TriageField } from '../pref';
export { RESTRICTED_TOPICS, type RestrictedTopic } from '../topics';
// Знания из кода (веха M8c): статусы, род записи и кто видит знания (FR-CODE-11).
export { CODE_CHECK_ROLES, CODE_ENTRY_STATUSES, CODE_KINDS, CODE_READER_ROLES, type CodeEntryStatus, type CodeKind } from '../pref';
export { CODE_TEMPLATE_LOCALES } from '../code/report';
