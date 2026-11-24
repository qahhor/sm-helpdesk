import 'server-only';
import { type AnyColumn, and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { HdtError } from '../error';
import { ticketEvents, ticketMessages } from '../schema';

// Что изменилось в обращении после того, как сотрудник открыл страницу (FR-AG-12, UX-A-06). Одна проверка для
// ответа и для действий (статус, исполнитель, приоритет): действие со старой страницы не выполняется молча.

export type ChangeSummary = { newMessages: number; statusChanged: boolean; assigneeChanged: boolean };

// Время в браузере передаётся с точностью до миллисекунды, в базе до микросекунды: сравнение по миллисекундам.
const after = (column: AnyColumn, seen: Date) => gt(sql`date_trunc('milliseconds', ${column})`, seen);

/** Сообщения, смена статуса и исполнителя от других людей после seen. Свои действия изменением не считаются. */
export async function changesSinceTx(tx: Tx, ticketId: string, seen: Date, me: string): Promise<ChangeSummary> {
  const [messages] = await tx
    .select({ n: count() })
    .from(ticketMessages)
    .where(and(eq(ticketMessages.ticketId, ticketId), after(ticketMessages.createdOn, seen), sql`${ticketMessages.authorId} is distinct from ${me}::uuid`));
  const kinds = await tx
    .selectDistinct({ kind: ticketEvents.kind })
    .from(ticketEvents)
    .where(
      and(
        eq(ticketEvents.ticketId, ticketId),
        inArray(ticketEvents.kind, ['status', 'assignee']),
        after(ticketEvents.createdOn, seen),
        sql`${ticketEvents.actorId} is distinct from ${me}::uuid`,
      ),
    );
  return {
    newMessages: messages?.n ?? 0,
    statusChanged: kinds.some((k) => k.kind === 'status'),
    assigneeChanged: kinds.some((k) => k.kind === 'assignee'),
  };
}

export const hasChanges = (c: ChangeSummary) => c.newMessages > 0 || c.statusChanged || c.assigneeChanged;

/**
 * Действие со страницы, открытой в момент seen. Обращение с тех пор изменили другие: ошибка changed со сводкой,
 * действие не выполняется. seen не передан (массовое действие, палитра команд): проверки нет.
 */
export async function assertUnchangedTx(tx: Tx, ticketId: string, seen: Date | undefined, me: string): Promise<void> {
  if (!seen) return;
  const changed = await changesSinceTx(tx, ticketId, seen, me);
  if (hasChanges(changed)) throw new HdtError('changed', { changed });
}
