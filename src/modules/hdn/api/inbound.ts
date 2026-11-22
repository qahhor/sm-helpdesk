import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { env } from '@/env';
import { enqueue } from '@/modules/hdc/api';
import { supportAddresses } from '../core/mail-settings';
import { dmarcAligned, inboundAuthservOf } from '../inbound/auth-results';
import { parseReplyAddress, type ReplyConfig, replyConfigOf } from '../inbound/reply-address';
import { getEmailProvider, type InboundAttachment, type InboundContent, parseMailbox } from '../provider';

// Модуль hdn, слой api: разбор входящего письма для модуля обращений (FR-EM-02, раздел 11.8, решения 11, 16, 20
// вехи M4). Узкий файл: его берёт фоновый процесс. hdn обращения не знает: решает, что делать с письмом, модуль hdt.

export { classifyAuto } from '../inbound/classify';
export { cleanSubject, emailToText, SUBJECT_MAX } from '../inbound/email-text';
export {
  blockSenderTx,
  findThreadTicket,
  type InboundRow,
  isBlocked,
  lockInboundTx,
  loadInbound,
  markInbound,
  markInboundTx,
  processedTwinTx,
  recordThreadTx,
} from '../core/inbound';
import { staleInboundIds } from '../core/inbound';
export type { InboundClass } from '../schema';
export type { InboundAttachment, InboundContent };
export { parseMailbox };

/** Домен и секрет адресов ответа. Нет: приём писем выключен. */
export function replyConfig(): ReplyConfig | null {
  return replyConfigOf(env);
}

/** Признак "адрес ответа": местная часть reply+ в домене приёма, подпись не проверяется. */
export function looksLikeReplyAddress(address: string, cfg: ReplyConfig): boolean {
  const [local = '', domain = ''] = address.toLowerCase().split('@');
  return local.startsWith('reply+') && domain === cfg.domain.toLowerCase();
}

/** Первый адрес ответа с верной подписью среди получателей письма. */
export function signedReplyOf(addresses: string[], cfg: ReplyConfig): { number: number; userId: string } | null {
  for (const address of addresses) {
    const parsed = parseReplyAddress(address, cfg);
    if (parsed) return parsed;
  }
  return null;
}

/** Адрес приёма портала: любой адрес домена приёма, кроме адресов ответа, или адрес поддержки из настроек (решение 23). */
export async function intakeAddresses(addresses: string[], cfg: ReplyConfig): Promise<string[]> {
  const support = new Set((await supportAddresses()).map((item) => item.address.toLowerCase()));
  return addresses.filter((address) => {
    const lower = address.toLowerCase();
    if (looksLikeReplyAddress(lower, cfg)) return false;
    return support.has(lower) || lower.split('@')[1] === cfg.domain.toLowerCase();
  });
}

/** Отправитель опознан по DMARC (решение 11): верхний заголовок сервиса приёма, совпадение домена. */
export function senderAligned(headers: [string, string][], fromAddress: string): boolean {
  return dmarcAligned(headers, fromAddress, inboundAuthservOf(env));
}

/**
 * Текст, заголовки и список вложений письма у почтового сервиса. Сбой списка вложений письмо не губит: оно разбирается
 * без файлов, сбой пишется в журнал процесса (итоговая проверка M4).
 */
export async function fetchInbound(emailId: string): Promise<{ content: InboundContent; attachments: InboundAttachment[] }> {
  const provider = await getEmailProvider();
  const content = await provider.fetchInbound(emailId);
  let attachments: InboundAttachment[] = [];
  try {
    attachments = await provider.listInboundAttachments(emailId);
  } catch (error) {
    console.error(`Список вложений письма не получен: ${error instanceof Error ? error.message : 'ошибка'}`);
  }
  return { content, attachments };
}

/** Неразобранные письма старше 10 минут снова в очередь разбора (шаг задачи раз в минуту). Возвращает их число. */
export async function requeueStaleInbound(actor: SystemActor, now: Date = new Date()): Promise<number> {
  if (actor.type !== 'system') throw new Error('Повторный разбор писем выполняет только система');
  const ids = await staleInboundIds(actor, now, 50);
  for (const inboundId of ids) await enqueue('email.inbound', { inboundId });
  return ids.length;
}

/** Файл вложения, не больше maxBytes. */
export async function downloadInbound(url: string, maxBytes: number): Promise<Uint8Array> {
  return (await getEmailProvider()).download(url, maxBytes);
}

/** Значения заголовков письма с этим именем, сверху вниз. */
export function headerValues(headers: [string, string][], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === wanted).map(([, value]) => value);
}

/** Идентификаторы писем из In-Reply-To и References. */
export function referencedIds(headers: [string, string][]): string[] {
  return [...headerValues(headers, 'in-reply-to'), ...headerValues(headers, 'references')].flatMap((value) => value.match(/<[^<>\s]{1,996}>/g) ?? []).slice(0, 100);
}
