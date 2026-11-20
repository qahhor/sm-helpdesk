import { afterEach, beforeEach } from 'vitest';
import { MemoryTelegramBot, setTelegramBotForTests, type TelegramUpdate } from '@/modules/hdn/api';
import { startTelegramLink } from '@/modules/hdu/api/telegram';
import { clientCtx } from './auth';
import { pools } from './db';

// Telegram в интеграционных тестах: бот в памяти, события собираются помощником.

/** Подключает бота в памяти к каждому тесту файла. */
export function memoryBotPerTest(): { readonly bot: MemoryTelegramBot } {
  const box = { bot: new MemoryTelegramBot() };
  beforeEach(() => {
    box.bot = new MemoryTelegramBot();
    setTelegramBotForTests(box.bot);
  });
  afterEach(() => setTelegramBotForTests(null));
  return box;
}

let serial = 1000;

/** Событие Telegram: сообщение или нажатие кнопки в личном диалоге. */
export function tgUpdate(opts: {
  from: number;
  text?: string;
  callback?: string;
  chatType?: string;
  isBot?: boolean;
  languageCode?: string;
  updateId?: number;
}): TelegramUpdate {
  const from = { id: opts.from, is_bot: opts.isBot ?? false, first_name: `Человек ${opts.from}`, username: `user${opts.from}`, language_code: opts.languageCode };
  const chat = { id: opts.from, type: opts.chatType ?? 'private' };
  const update_id = opts.updateId ?? ++serial;
  if (opts.callback !== undefined)
    return { update_id, callback_query: { id: `q${update_id}`, from, data: opts.callback, message: { message_id: 1, chat } } } as TelegramUpdate;
  return { update_id, message: { message_id: update_id, from, chat, text: opts.text ?? '' } } as TelegramUpdate;
}

/** Код привязки из ссылки, которую портал дал пользователю. */
export async function linkCodeFor(member: { userId: string }): Promise<string> {
  const result = await startTelegramLink(await clientCtx(member));
  if (!('url' in result)) throw new Error(`Ссылка привязки не выдана: ${result.error}`);
  return new URL(result.url).searchParams.get('start') ?? '';
}

/** Готовая привязка строкой в базе. */
export async function linkTelegramFixture(member: { userId: string }, externalId: number): Promise<void> {
  await pools.root.query(
    `insert into hdu_contact_identities (user_id, kind, external_id, display_name, verified, verified_on)
     values ($1, 'telegram', $2, $3, 'linked', now())`,
    [member.userId, String(externalId), `@user${externalId}`],
  );
}
