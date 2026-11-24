import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { readSetting, writeAudit } from '@/modules/hdc/api';
import { getSecretBox } from '@/security/secret-box';
import { channelSecrets } from '../schema';
import { createTelegramBot } from '../telegram';
import type { OncallSender } from './outbox';

// Модуль hdn, слой core: сообщения дежурным о P1 в служебный чат Telegram (FR-SLA-07, решение 8 вехи M4).
// Всё задаёт администратор в портале: номер чата, какой бот отправляет (основной бот портала из TELEGRAM_BOT_TOKEN,
// сейчас @SmartupSupportBot, или отдельный бот), токен отдельного бота хранится зашифрованным, как секреты серверов
// Smartup. Чат не задан или токена нет: сообщение пропускается, письмо дежурным уходит как обычно.

export const ONCALL_CHAT_SETTING = 'notify.oncall_chat_id';
export const ONCALL_BOT_SETTING = 'notify.oncall_bot';
const SECRET_CODE = 'oncall_telegram_bot';
const SECRET_CONTEXT = 'oncall-telegram';
const SYSTEM = { type: 'system', job: 'outbox.dispatch' } as const;

/** Номер чата Telegram: группа или канал (-100...), личный чат (число) или @имя канала. */
export const ONCALL_CHAT = z.string().trim().regex(/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/);
/** Токен бота от @BotFather: число, двоеточие, буквы и цифры. */
export const BOT_TOKEN = z.string().trim().regex(/^\d{3,20}:[A-Za-z0-9_-]{10,200}$/);

/** Бот и чат дежурных в момент отправки. null: чат не задан или у выбранного бота нет токена. */
export async function oncallTelegram(): Promise<{ token: string; chatId: string } | null> {
  // Слой базы разбирает строку JSON ещё раз: номер чата из одних цифр приходит числом.
  const raw = await readSetting(ONCALL_CHAT_SETTING);
  const chat = ONCALL_CHAT.safeParse(typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw);
  if (!chat.success) return null;
  const bot = (await readSetting(ONCALL_BOT_SETTING)) === 'own' ? 'own' : 'main';
  if (bot === 'main') {
    const token = getEnv().TELEGRAM_BOT_TOKEN;
    return token ? { token, chatId: chat.data } : null;
  }
  const row = await withActor(SYSTEM, (tx) => tx.select({ sealed: channelSecrets.sealed }).from(channelSecrets).where(eq(channelSecrets.code, SECRET_CODE)).limit(1));
  if (!row[0]) return null;
  try {
    return { token: getSecretBox().open(row[0].sealed, SECRET_CONTEXT), chatId: chat.data };
  } catch {
    // Ключ сменили или строку повредили: токен задаётся заново на экране настроек (как секреты серверов, решение 0015).
    console.error('Бот дежурных: токен не расшифровывается, задайте его заново в настройках');
    return null;
  }
}

/**
 * Сохранить токен отдельного бота. Задаёт только администратор портала: проверка здесь, запись от имени системы
 * (политика базы: секрет читает и пишет только система). Токен в журнал не попадает.
 */
export async function saveOncallBotToken(staff: StaffActor, token: string): Promise<void> {
  if (staff.type !== 'staff' || staff.staffRole !== 'admin') throw new Error('бот дежурных: токен задаёт только администратор');
  const sealed = getSecretBox().seal(BOT_TOKEN.parse(token), SECRET_CONTEXT);
  await withActor({ type: 'system', job: 'settings.oncall-bot' }, async (tx) => {
    await tx
      .insert(channelSecrets)
      .values({ code: SECRET_CODE, sealed })
      .onConflictDoUpdate({ target: channelSecrets.code, set: { sealed } });
    // Запись журнала в той же транзакции, что и секрет: смена токена без записи невозможна (итоговая проверка M4,
    // мелкое 12). Секрет пишет система, поэтому сотрудник назван в описании изменения.
    await writeAudit(tx, { action: 'settings.oncall_bot_replaced', objectType: 'setting', objectId: 'notify.oncall_bot', diff: { by: staff.userId } });
  });
}

/** Место хранения секрета канала по его коду. Новый секрет канала добавляется сюда. */
const SECRET_CONTEXTS: Record<string, string> = { [SECRET_CODE]: SECRET_CONTEXT };

/**
 * Замена ключа шифрования (находка S6 аудита 23.11.2026): секреты каналов перешифровываются текущим ключом.
 * Секрет, который не открывается ни одним ключом, не трогается, его код возвращается в failed.
 */
export async function resealChannelSecrets(actor: SystemActor): Promise<{ resealed: number; failed: string[] }> {
  const box = getSecretBox();
  return withActor(actor, async (tx) => {
    const rows = await tx.select({ code: channelSecrets.code, sealed: channelSecrets.sealed }).from(channelSecrets);
    let resealed = 0;
    const failed: string[] = [];
    for (const row of rows) {
      const context = SECRET_CONTEXTS[row.code];
      // Под try только шифрование: ошибка базы не должна выглядеть как "секрет не открывается" (итоговая проверка W1, F9).
      let next: string | null;
      try {
        if (!context) throw new Error('неизвестный секрет канала');
        next = box.needsReseal(row.sealed, context) ? box.reseal(row.sealed, context) : null;
      } catch {
        failed.push(row.code);
        continue;
      }
      if (next === null) continue;
      await tx.update(channelSecrets).set({ sealed: next }).where(eq(channelSecrets.code, row.code));
      resealed += 1;
    }
    if (resealed > 0 || failed.length > 0)
      await writeAudit(tx, { action: 'secrets.resealed', objectType: 'channel_secret', diff: { resealed, failed: failed.length } });
    return { resealed, failed };
  });
}

/** Сохранён ли токен отдельного бота (экран настроек показывает "токен сохранён", а не сам токен). */
export async function oncallTokenSaved(): Promise<boolean> {
  const rows = await withActor(SYSTEM, (tx) => tx.select({ code: channelSecrets.code }).from(channelSecrets).where(eq(channelSecrets.code, SECRET_CODE)).limit(1));
  return rows.length > 0;
}

/** Бот дежурных: отправляет текст в чат. */
export type OncallBot = { send(chatId: string, text: string): Promise<void> };
let factoryOverride: ((token: string) => OncallBot) | null = null;

/** Тесты подменяют бота дежурных (null возвращает настоящего). */
export function setOncallBotFactoryForTests(factory: ((token: string) => OncallBot) | null): void {
  factoryOverride = factory;
}

function realBot(token: string): OncallBot {
  const bot = createTelegramBot({ token, apiUrl: getEnv().TELEGRAM_API_URL });
  return { send: (chatId, text) => bot.sendMessage(chatId, text) };
}

/** Отправитель сообщений в чат дежурных по настройкам в момент отправки. */
export async function oncallSender(): Promise<OncallSender | null> {
  const config = await oncallTelegram();
  if (!config) return null;
  const bot = (factoryOverride ?? realBot)(config.token);
  return { send: (text: string) => bot.send(config.chatId, text) };
}
