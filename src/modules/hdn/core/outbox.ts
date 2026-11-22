import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import type { Locale } from '@/i18n/locales';
import { enqueue } from '@/modules/hdc/api';
import { mailRecipient } from '@/modules/hdu/api/recipients';
import { replyAddress, replyConfigOf } from '../inbound/reply-address';
import { type MailData, type MailPayload, type MailTemplate, renderMail } from '../mail/render';
import { type DeliveryEvent, type EmailProvider, getEmailProvider } from '../provider';
import { MailError } from '../resend';
import { outbox } from '../schema';
import { recordThreadTx } from './inbound';
import { oncallEmails, shownSupportAddress } from './mail-settings';

// Модуль hdn, слой core: очередь исходящих (FR-NT-09, решения 1-3 вехи M4).
// Строка ставится в транзакции действия (enqueueTx). Отправка в три шага: короткая транзакция захватывает пачку
// строк (FOR UPDATE SKIP LOCKED, попытка +1, срок захвата 5 минут), письмо уходит вне транзакции с ключом
// идемпотентности строки, итог пишется отдельной транзакцией. Процесс упал после отправки: строка вернётся после
// срока захвата, а сервис не отправит повтор с тем же ключом.

/** Паузы перед повторами после сбоя, минут. После шестой неудачи строка получает failed. */
export const OUTBOX_RETRY_MINUTES = [1, 5, 15, 60, 240] as const;
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_RETRY_MINUTES.length + 1;
const LEASE_MS = 5 * 60_000;
const BATCH = 50;
const MINUTE = 60_000;
/** Письма клиенту об обращении: на них отвечают, ответ попадает в обращение. */
const CLIENT_REPLY_TEMPLATES = new Set(['ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'unidentified_ack']);

export type OutboxItem = {
  channel: 'email' | 'telegram';
  recipient: { kind: 'user'; userId: string } | { kind: 'oncall' };
  template: MailTemplate;
  /** Данные шаблона. Ссылка, начинающаяся с "/", получает адрес портала и язык получателя при отправке. */
  payload: MailPayload;
  ticketId?: string;
  messageId?: string;
  /** Язык обращения: письмо уходит на языке получателя, а если он не выбран, на этом. */
  locale?: Locale;
  /** Путь настроек уведомлений для отключаемого письма ("/settings" или "/agent/account"). */
  settingsPath?: string;
};

/** Сообщение в служебный чат дежурных (решение 8). null: чат не настроен, сообщение пропускается. */
export type OncallSender = { send(text: string): Promise<void> };

export async function enqueueTx(tx: Tx, item: OutboxItem): Promise<string> {
  if (item.payload.template !== item.template) throw new Error('очередь: шаблон не совпадает с данными');
  // Идентификатор задаёт приложение: под клиентом строка очереди не читается, RETURNING ей недоступен.
  const outboxId = randomUUID();
  await tx.insert(outbox).values({
    outboxId,
    channel: item.channel,
    recipientKind: item.recipient.kind,
    recipientUserId: item.recipient.kind === 'user' ? item.recipient.userId : null,
    template: item.template,
    locale: item.locale ?? null,
    settingsPath: item.settingsPath ?? null,
    payload: item.payload as unknown as Record<string, unknown>,
    ticketId: item.ticketId ?? null,
    messageId: item.messageId ?? null,
  });
  return outboxId;
}

/** Будит отправку после фиксации. Сбой постановки не бросает: строку подберёт задача раз в минуту. */
export async function wakeOutbox(): Promise<void> {
  await enqueue('outbox.dispatch', {});
}

type Row = typeof outbox.$inferSelect;
/** messageId: наш Message-ID первого письма строки, для цепочки ответов (решение 20). */
type Outcome = { kind: 'sent'; externalId: string; recipient: string; messageId?: string } | { kind: 'skipped' } | { kind: 'error'; error: string };

/** Код ошибки без адреса, темы и текста письма (проверка main, Q16). */
function errorCode(error: unknown): string {
  if (error instanceof MailError) return error.status === null ? 'нет ответа' : `код ${error.status}`;
  return error instanceof Error ? error.name : 'ошибка';
}

/** Ссылки вида "/tickets/1042" получают адрес портала и язык получателя. */
function absolute(payload: Record<string, unknown>, hubUrl: string, locale: Locale): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) out[key] = key === 'url' && typeof value === 'string' && value.startsWith('/') ? `${hubUrl}/${locale}${value}` : value;
  return out;
}

async function deliver(row: Row, provider: EmailProvider, oncall: OncallSender | null): Promise<Outcome> {
  const env = getEnv();
  if (row.channel === 'telegram') {
    if (!oncall) return { kind: 'skipped' };
    const { oncallTelegramText } = await import('./oncall-text');
    await oncall.send(oncallTelegramText(row.payload, env.HUB_URL));
    return { kind: 'sent', externalId: `telegram-${row.outboxId}`, recipient: 'oncall' };
  }
  let targets: { address: string; locale: Locale }[];
  if (row.recipientKind === 'user' && row.recipientUserId) {
    const to = await mailRecipient(row.recipientUserId);
    targets = to ? [{ address: to.address, locale: to.locale ?? row.locale ?? 'ru' }] : [];
  } else targets = (await oncallEmails()).map((address) => ({ address, locale: row.locale ?? 'ru' }));
  if (targets.length === 0) return { kind: 'skipped' };
  const supportAddress = await shownSupportAddress();
  const reply = replyConfigOf(env);
  const domain = reply?.domain ?? env.HUB_DOMAIN;
  // Ответ на письмо об обращении попадает в обращение: адрес подписан для пары обращение и получатель (FR-NT-06).
  const number = typeof row.payload.number === 'number' ? row.payload.number : null;
  const replyTo =
    reply && number && row.ticketId && row.recipientKind === 'user' && row.recipientUserId && CLIENT_REPLY_TEMPLATES.has(row.template)
      ? replyAddress(number, row.recipientUserId, reply)
      : undefined;
  let externalId = '';
  for (const [index, target] of targets.entries()) {
    const data = {
      ...absolute(row.payload, env.HUB_URL, target.locale),
      hubUrl: env.HUB_URL,
      supportAddress,
      settingsUrl: row.settingsPath ? `${env.HUB_URL}/${target.locale}${row.settingsPath}` : null,
    } as unknown as MailData;
    const mail = await renderMail(row.template as MailTemplate, target.locale, data);
    const key = index === 0 ? row.outboxId : `${row.outboxId}-${index}`;
    const result = await provider.send(
      {
        to: target.address,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(replyTo ? { replyTo } : {}),
        headers: {
          // Наши письма не ждут автоответов (решение 17), у письма свой Message-ID для цепочки (решение 20).
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'Message-ID': `<${key}@${domain}>`,
        },
      },
      key,
    );
    if (index === 0) externalId = result.providerId;
  }
  return { kind: 'sent', externalId, recipient: targets.map((t) => t.address).join(', ').slice(0, 320), messageId: `<${row.outboxId}@${domain}>` };
}

export async function dispatchOutbox(
  actor: SystemActor,
  now: Date,
  provider?: EmailProvider,
  oncall?: OncallSender | null,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const claimed = await withActor(actor, async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(and(eq(outbox.status, 'queued'), lte(outbox.nextAttemptOn, now)))
      .orderBy(asc(outbox.nextAttemptOn))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    await tx
      .update(outbox)
      .set({ attempts: sql`${outbox.attempts} + 1`, nextAttemptOn: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(outbox.outboxId, rows.map((r) => r.outboxId)));
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (claimed.length === 0) return result;
  const email = provider ?? (await getEmailProvider());
  // Бот и чат дежурных берутся из настроек в момент отправки (решение 8), только если в пачке есть такие строки.
  const telegram = oncall !== undefined ? oncall : claimed.some((r) => r.channel === 'telegram') ? await (await import('./oncall')).oncallSender() : null;
  for (const row of claimed) {
    let outcome: Outcome;
    try {
      outcome = await deliver(row, email, telegram);
    } catch (error) {
      outcome = { kind: 'error', error: errorCode(error) };
    }
    await withActor(actor, async (tx) => {
      if (outcome.kind === 'sent') {
        result.sent++;
        await tx
          .update(outbox)
          .set({ status: 'sent', externalId: outcome.externalId, recipient: outcome.recipient, sentOn: now, lastError: null })
          .where(eq(outbox.outboxId, row.outboxId));
        // Ответ на наше письмо без адреса ответа найдёт обращение по In-Reply-To (решение 20, итоговая проверка M4).
        if (row.ticketId && outcome.messageId) await recordThreadTx(tx, { ticketId: row.ticketId, messageId: outcome.messageId, direction: 'out' });
      } else if (outcome.kind === 'skipped') {
        result.skipped++;
        await tx.update(outbox).set({ status: 'skipped' }).where(eq(outbox.outboxId, row.outboxId));
      } else if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
        result.failed++;
        await tx.update(outbox).set({ status: 'failed', lastError: outcome.error }).where(eq(outbox.outboxId, row.outboxId));
      } else {
        const pause = OUTBOX_RETRY_MINUTES[row.attempts - 1] ?? OUTBOX_RETRY_MINUTES[OUTBOX_RETRY_MINUTES.length - 1];
        await tx
          .update(outbox)
          .set({ lastError: outcome.error, nextAttemptOn: new Date(now.getTime() + pause * MINUTE) })
          .where(eq(outbox.outboxId, row.outboxId));
      }
    });
  }
  return result;
}

/** События доставки (решение 21): статус строки по идентификатору письма у сервиса. */
export async function recordDelivery(actor: SystemActor, event: DeliveryEvent): Promise<void> {
  await withActor(actor, async (tx) => {
    const byId = eq(outbox.externalId, event.emailId);
    switch (event.status) {
      case 'sent':
        return;
      case 'delivered':
        await tx.update(outbox).set({ status: 'delivered' }).where(and(byId, inArray(outbox.status, ['queued', 'sent'])));
        return;
      case 'delayed':
        await tx.update(outbox).set({ lastError: 'delayed' }).where(and(byId, eq(outbox.status, 'sent')));
        return;
      default:
        await tx
          .update(outbox)
          .set({ status: 'failed', lastError: `${event.status}${event.reason ? `: ${event.reason}` : ''}`.slice(0, 500) })
          .where(byId);
    }
  });
}


/**
 * Сообщения сотрудника, письмо о которых не доставлено (решение 21 вехи M4): отметка "Письмо не доставлено" в рабочем
 * месте. Читает сотрудник под своим актором: строки очереди клиенту не видны.
 */
export async function undeliveredMessages(actor: StaffActor, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await withActor(actor, (tx) =>
    tx
      .selectDistinct({ messageId: outbox.messageId })
      .from(outbox)
      .where(and(inArray(outbox.messageId, messageIds.slice(0, 500)), eq(outbox.status, 'failed'), eq(outbox.channel, 'email'))),
  );
  return new Set(rows.map((r) => r.messageId).filter((id): id is string => id !== null));
}
