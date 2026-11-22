import 'server-only';
import * as z from 'zod';
import { adminIdsTx, lineLeadsTx, type MailRecipient, mailRecipientTx, organizationNameTx } from '../core/recipients';

// Модуль hdu, слой api: адрес для письма пользователю (решение 2 вехи M4), руководители линии, администраторы
// и название организации для уведомлений (решения 7 и 8). Узкий файл: его берёт фоновый
// процесс, в сборку которого не должны попадать страницы.

export type { MailRecipient };

export async function mailRecipient(userId: string): Promise<MailRecipient | null> {
  const id = z.uuid().safeParse(userId);
  return id.success ? mailRecipientTx(id.data) : null;
}

export function lineLeads(line: 'l1' | 'l2'): Promise<string[]> {
  return lineLeadsTx(line);
}

export function adminIds(): Promise<string[]> {
  return adminIdsTx();
}

export async function organizationName(orgId: string): Promise<string | null> {
  const id = z.uuid().safeParse(orgId);
  return id.success ? organizationNameTx(id.data) : null;
}
