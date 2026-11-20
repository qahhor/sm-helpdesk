import 'server-only';

// Модуль hdn (уведомления), слой api: то, что могут вызывать другие модули.
// В M1 это письма и бот Telegram (решение 0018). Уведомления об обращениях появятся в M4 и M4b.

export { BOT_TEXT_KEYS, type BotTextKey, botText } from './bot-text';
export {
  CONFIRM_EMAIL_MINUTES,
  confirmEmailMail,
  INVITATION_DAYS,
  invitationMail,
  LOGIN_LINK_MINUTES,
  loginLinkMail,
  STAFF_LINK_HOURS,
  staffInvitationMail,
  staffResetMail,
  telegramLinkedMail,
} from './mail-text';
export { type Mailer, mailDelivers, type MailKind, type MailMessage, MemoryMailer, queueMail, setMailerForTests } from './mailer';
export {
  createTelegramBot,
  getTelegramBot,
  MemoryTelegramBot,
  type SendOptions,
  setTelegramBotForTests,
  type TelegramBot,
  TelegramError,
} from './telegram';
export { type TelegramUpdate, type TelegramUser, telegramUpdate } from './telegram-update';
export { handleTelegramWebhook } from './webhook';
