import * as z from 'zod';

// Событие Telegram Bot API, которое принимает вебхук бота (задача 16). Только то, что нужно порталу:
// личное сообщение с текстом и нажатие кнопки. Лишние поля отбрасываются, длины ограничены.

const user = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string().max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(16).optional(),
});

const chat = z.object({ id: z.number().int(), type: z.string().max(32) });

export const telegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      message_id: z.number().int(),
      from: user.optional(),
      chat,
      text: z.string().max(4096).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(64),
      from: user,
      data: z.string().max(64).optional(),
      message: z.object({ message_id: z.number().int(), chat }).optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdate>;
export type TelegramUser = z.infer<typeof user>;
