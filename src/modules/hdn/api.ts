import 'server-only';

// Модуль hdn (уведомления), слой api: то, что могут вызывать другие модули.
// В M1 это письма. Telegram и настоящая почта появятся в M4 и M4b.

export { CONFIRM_EMAIL_MINUTES, confirmEmailMail, INVITATION_DAYS, invitationMail, LOGIN_LINK_MINUTES, loginLinkMail } from './mail-text';
export { type Mailer, type MailKind, type MailMessage, MemoryMailer, queueMail, setMailerForTests } from './mailer';
