import 'server-only';

// Модуль hdn, слой api: бот и чат дежурных (решение 8 вехи M4). Экран настроек появится в задаче 12.

export { BOT_TOKEN, ONCALL_BOT_SETTING, ONCALL_CHAT, ONCALL_CHAT_SETTING, oncallTelegram, saveOncallBotToken, setOncallBotFactoryForTests, staffBotSender } from '../core/oncall';
export { ONCALL_EMAILS_SETTING } from '../core/mail-settings';
