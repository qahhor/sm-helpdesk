import 'server-only';

// Модуль hdu, слой api: точки входа модуля для страниц, серверных действий и обработчиков
// (docs/naming.md, раздел 5). Каждая функция проверяет актора, права и данные и вызывает слой core.
// Страницы и интерфейс импортируют модуль только отсюда: это проверяет линтер.

export {
  currentStaff,
  mySessions,
  requireClientActor,
  requireFreshStaffActor,
  requireSignedInClient,
  requireStaffActor,
  revokeMySessionOfRequest,
  rememberMyLocale,
  revokeOtherSessionsOfRequest,
  signedInKind,
  signOut,
  switchOrganizationOfRequest,
} from './api/actor';
export {
  type ClientContext,
  getOrganization,
  listMyOrganizations,
  type MyOrganization,
  type OrgRow,
  searchOrganizations,
} from './api/orgs';
export type { OrgScope } from './api/scope';
export type { SessionView } from './api/sessions';
export { handleAuthRequest } from './api/auth-route';
export { completeWelcome, confirmEmail, requestEmailConfirmation } from './api/email';
export {
  acceptInvitation,
  describeInvitation,
  type InvitationView,
  inviteMember,
  listInvitations,
  revokeInvitation,
} from './api/invitations';
export { completeLoginLink, requestLoginLink } from './api/login-link';
export {
  completeTelegramLogin,
  getBotLink,
  getTelegramLink,
  handleTelegramUpdate,
  rememberLocale,
  startTelegramLink,
  startTelegramLinkOfRequest,
  telegramEnabled,
  unlinkTelegram,
} from './api/telegram';
export { changeMemberRole, listMembers, listMembersForStaff, type MemberView, setMemberState } from './api/members';
export { nextRequest } from './api/next-request';
export type { RequestInfo, SessionData } from './api/request';
export type { StaffContext } from './api/session';
// Сотрудники в разделе "Настройки" (FR-ADM-03).
export { HUMAN_STAFF_ROLES, type HumanStaffRole } from './pref';
export {
  changeStaffRole,
  inviteStaffByMail,
  listStaff,
  listStaffInvitations,
  resetStaffByMail,
  setStaffState,
  type StaffInvitationRow,
  type StaffRow,
} from './api/staff-manage';
// Реестр серверов Smartup в разделе "Настройки" (FR-ADM-01).
export {
  addServer,
  checkServer,
  disableServer,
  enableServer,
  getServer,
  listServers,
  serverCallbackUrl,
  updateServer,
  type ServerCheck,
  type ServerDetails,
  type ServerIssue,
  type ServerView,
} from './api/servers';
export { describeLoginServer, forgetServer, type LoginServerState, rememberServer, startSmartupSignIn } from './api/sso';
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
