import 'server-only';

// Модуль hdu, слой api: точки входа модуля для страниц, серверных действий и обработчиков
// (docs/naming.md, раздел 5). Каждая функция проверяет актора, права и данные и вызывает слой core.
// Страницы и интерфейс импортируют модуль только отсюда: это проверяет линтер.

export { currentStaff, requireFreshStaffActor, requireStaffActor, signOut } from './api/actor';
export { handleAuthRequest } from './api/auth-route';
export { nextRequest } from './api/next-request';
export type { RequestInfo, SessionData } from './api/request';
export type { StaffContext } from './api/session';
export {
  acceptStaffInvitation,
  describeStaffInvitation,
  signInStaff,
  type StaffSignInResult,
  verifyStaffCode,
} from './api/staff';
export { inviteStaff, resetStaff } from './api/staff-admin';
export { HduError, type HduErrorCode, isHduError } from './error';
export { safeReturnPath } from './util';
