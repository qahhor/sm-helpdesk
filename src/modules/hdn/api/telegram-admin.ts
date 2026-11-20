import 'server-only';
import { getTelegramBot } from '../telegram';

// Обслуживание бота из команды консоли hub (решение 0018): вебхук и сведения о боте.
// Отдельный файл: команда консоли не должна тянуть тексты писем и библиотеку переводов.

/** Ставит вебхук бота на адрес портала с секретом из настроек. Возвращает адрес вебхука. */
export async function setTelegramWebhook(cfg: { hubUrl: string; secret: string }): Promise<{ url: string }> {
  const bot = getTelegramBot();
  if (!bot.enabled) throw new Error('Бот выключен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET');
  const url = `${cfg.hubUrl}/api/webhooks/telegram`;
  await bot.setWebhook(url, cfg.secret);
  return { url };
}

/** Включён ли бот и как его найти в Telegram. */
export async function telegramInfo(): Promise<{ enabled: false } | { enabled: true; username: string }> {
  const bot = getTelegramBot();
  if (!bot.enabled) return { enabled: false };
  return { enabled: true, username: (await bot.getMe()).username };
}
