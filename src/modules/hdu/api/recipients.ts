import 'server-only';
import * as z from 'zod';
import { type MailRecipient, mailRecipientTx } from '../core/recipients';

// Модуль hdu, слой api: адрес для письма пользователю (решение 2 вехи M4). Узкий файл: его берёт фоновый
// процесс, в сборку которого не должны попадать страницы.

export type { MailRecipient };

export async function mailRecipient(userId: string): Promise<MailRecipient | null> {
  const id = z.uuid().safeParse(userId);
  return id.success ? mailRecipientTx(id.data) : null;
}
