// Модуль hdk, слой api: проверки текста для других модулей (план M7, решения 8, 9, 11). Те же правила, что у решений
// (FR-SOL-04): идеи и комментарии ищут в тексте телефоны, email, ИНН, ПИНФЛ, адреса серверов и внутренние имена,
// машинный перевод идеи сверяется с оригиналом. Чистые функции без базы: копий правил в других модулях нет.

export { FINDING_KINDS, type FindingKind, findInText, isAllowedDomain } from '../checks';
export { compareClientTextInvariants, comparePlainInvariants, type InvariantIssue, type InvariantKind } from '../translation';
