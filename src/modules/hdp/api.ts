import 'server-only';

// Модуль hdp (известные проблемы, рассылки, объявления), слой api: то, что могут вызывать страницы и другие модули
// (docs/naming.md, раздел 5). Точки входа по темам лежат в каталоге api/.

export { ACTIVE_PROBLEM_STATUSES, isActiveProblem, PROBLEM_STATUSES, PROBLEM_WRITER_ROLES, type ProblemStatus, SETTABLE_PROBLEM_STATUSES } from './pref';
export { HDP_ERROR_CODES, HdpError, type HdpErrorCode, isHdpError } from './error';
export { parseProblemRef, problemRef } from './util';
export type { ProblemRow, PublicProblem } from './types';
