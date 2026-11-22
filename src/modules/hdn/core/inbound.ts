import 'server-only';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { parseMailbox, type ReceivedEvent } from '../provider';
import { blockedSenders, emailInbound, emailThreads, type InboundClass } from '../schema';

// Модуль hdn, слой core: входящие письма (10.5 "email_inbound", решение 10 вехи M4), цепочки писем (решение 20)
// и список отклонённых как спам (решение 14). Вебхук записывает сведения о письме, разбор идёт фоновой задачей.

export type InboundRow = typeof emailInbound.$inferSelect;

const addressesOf = (values: string[]) =>
  values
    .map((value) => parseMailbox(value)?.address)
    .filter((value): value is string => Boolean(value))
    .slice(0, 50);

/** Запись письма из вебхука. Повтор того же письма (provider_id) ничего не меняет: created ложь. */
export async function recordInbound(actor: SystemActor, event: ReceivedEvent): Promise<{ inboundId: string; created: boolean }> {
  const from = parseMailbox(event.from);
  return withActor(actor, async (tx) => {
    const inserted = await tx
      .insert(emailInbound)
      .values({
        providerId: event.emailId,
        rawRef: event.emailId,
        fromAddress: (from?.address ?? event.from.toLowerCase()).slice(0, 320),
        fromName: from?.name?.slice(0, 200) ?? null,
        toAddresses: addressesOf(event.to),
        ccAddresses: addressesOf(event.cc),
        subject: event.subject.slice(0, 2000),
        messageId: event.messageId?.slice(0, 998) ?? null,
        receivedOn: event.receivedAt,
      })
      .onConflictDoNothing({ target: emailInbound.providerId })
      .returning({ inboundId: emailInbound.inboundId });
    if (inserted[0]) return { inboundId: inserted[0].inboundId, created: true };
    const existing = await tx.select({ inboundId: emailInbound.inboundId }).from(emailInbound).where(eq(emailInbound.providerId, event.emailId)).limit(1);
    if (!existing[0]) throw new Error('входящее письмо: строка не найдена');
    return { inboundId: existing[0].inboundId, created: false };
  });
}

/** Письмо с блокировкой строки: два разбора одного письма идут друг за другом, второй видит отметку разбора. */
export async function lockInboundTx(tx: Tx, inboundId: string): Promise<InboundRow | null> {
  const rows = await tx.select().from(emailInbound).where(eq(emailInbound.inboundId, inboundId)).limit(1).for('update');
  return rows[0] ?? null;
}

/**
 * То же письмо (Message-ID), уже разобранное под другой строкой: письмо пришло на два адреса поддержки, и сервис
 * прислал два события. Блокировка по Message-ID до конца транзакции: два таких разбора идут друг за другом.
 */
export async function processedTwinTx(tx: Tx, row: InboundRow): Promise<{ classification: InboundClass; ticketId: string | null } | null> {
  if (!row.messageId) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbound-message:${row.messageId}`}))`);
  const rows = await tx
    .select({ classification: emailInbound.classification, ticketId: emailInbound.ticketId })
    .from(emailInbound)
    .where(and(eq(emailInbound.messageId, row.messageId), ne(emailInbound.inboundId, row.inboundId), isNotNull(emailInbound.processedOn)))
    .limit(1);
  const twin = rows[0];
  return twin ? { classification: twin.classification ?? 'ignored', ticketId: twin.ticketId } : null;
}

export async function loadInbound(actor: SystemActor, inboundId: string): Promise<InboundRow | null> {
  const rows = await withActor(actor, (tx) => tx.select().from(emailInbound).where(eq(emailInbound.inboundId, inboundId)).limit(1));
  return rows[0] ?? null;
}

/** Итог разбора письма. Без ticketId обращение не меняется. */
export async function markInboundTx(
  tx: Tx,
  inboundId: string,
  patch: { classification: InboundClass; ticketId?: string; headers?: [string, string][]; dmarcAligned?: boolean },
): Promise<void> {
  await tx
    .update(emailInbound)
    .set({
      classification: patch.classification,
      processedOn: sql`now()`,
      ...(patch.ticketId ? { ticketId: patch.ticketId } : {}),
      ...(patch.headers ? { headers: patch.headers.slice(0, 200) } : {}),
      ...(patch.dmarcAligned !== undefined ? { authResult: { dmarcAligned: patch.dmarcAligned } } : {}),
    })
    .where(eq(emailInbound.inboundId, inboundId));
}

export async function markInbound(
  actor: SystemActor,
  inboundId: string,
  patch: { classification: InboundClass; ticketId?: string; headers?: [string, string][]; dmarcAligned?: boolean },
): Promise<void> {
  await withActor(actor, (tx) => markInboundTx(tx, inboundId, patch));
}

/** Message-ID письма обращения: ответ со ссылкой на него относится к обращению (FR-EM-02). Повтор не дублирует. */
export async function recordThreadTx(tx: Tx, row: { ticketId: string; messageId: string; inReplyTo?: string | null; direction: 'in' | 'out' }): Promise<void> {
  await tx
    .insert(emailThreads)
    .values({ ticketId: row.ticketId, messageId: row.messageId.slice(0, 998), inReplyTo: row.inReplyTo?.slice(0, 998) ?? null, direction: row.direction })
    .onConflictDoNothing({ target: emailThreads.messageId });
}

/** Обращение по Message-ID из In-Reply-To и References. Нет совпадений: null. */
export async function findThreadTicket(tx: Tx, ids: string[]): Promise<string | null> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length >= 3 && id.length <= 998))].slice(0, 100);
  if (wanted.length === 0) return null;
  const rows = await tx.select({ ticketId: emailThreads.ticketId }).from(emailThreads).where(inArray(emailThreads.messageId, wanted)).limit(1);
  return rows[0]?.ticketId ?? null;
}

/** Адрес в списке отклонённых как спам (решение 14). */
export async function isBlocked(tx: Tx, address: string): Promise<boolean> {
  const rows = await tx.select({ address: blockedSenders.address }).from(blockedSenders).where(eq(blockedSenders.address, address.toLowerCase())).limit(1);
  return rows.length > 0;
}
