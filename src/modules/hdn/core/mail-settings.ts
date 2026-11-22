import 'server-only';
import * as z from 'zod';
import { readSetting } from '@/modules/hdc/api';

// Модуль hdn, слой core: настройки почты, которые администратор меняет в портале (решения 8, 23, 24 вехи M4).
// Значения лежат в hdc_settings, экран настроек появится в задаче 12. Нет значения: пусто.

/** Адреса поддержки (решение 23): один из них показывается клиентам в подвале портала и в письмах. */
export const SUPPORT_ADDRESSES_SETTING = 'mail.support_addresses';
/** Адреса дежурных для писем о P1 (FR-SLA-07, решение 8). */
export const ONCALL_EMAILS_SETTING = 'notify.oncall_emails';

const address = z.email().max(320);
const supportList = z.array(z.object({ address, shown: z.boolean() })).max(20);
const emailList = z.array(address).max(20);

export async function supportAddresses(): Promise<{ address: string; shown: boolean }[]> {
  const parsed = supportList.safeParse(await readSetting(SUPPORT_ADDRESSES_SETTING));
  return parsed.success ? parsed.data : [];
}

export async function shownSupportAddress(): Promise<string | null> {
  return (await supportAddresses()).find((item) => item.shown)?.address ?? null;
}

export async function oncallEmails(): Promise<string[]> {
  const parsed = emailList.safeParse(await readSetting(ONCALL_EMAILS_SETTING));
  return parsed.success ? parsed.data : [];
}
