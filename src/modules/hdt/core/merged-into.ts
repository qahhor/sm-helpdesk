import 'server-only';
import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { tickets } from '../schema';

// Куда ведёт объединённое обращение. Основное само могло позже стать дублем: тогда человек должен попасть
// к конечному основному, а не к закрытому (итоговая проверка M3, мелкое 6). Строка дубля при этом не меняется:
// правило базы "объединённое обращение закрыто навсегда" остаётся как есть, цепочка проходится при чтении.

const MAX_HOPS = 20;

/**
 * Номер конечного основного обращения. Запрос идёт в транзакции вызывающего, под его политиками: если какое-то
 * звено цепочки ему не видно, номера нет (решение 4 плана M3). Обычный случай без цепочки: один запрос.
 */
export async function finalMainNumberTx(tx: Tx, mergedIntoId: string | null): Promise<number | null> {
  let id = mergedIntoId;
  for (let hop = 0; id && hop < MAX_HOPS; hop++) {
    const [row] = await tx.select({ number: tickets.number, mergedIntoId: tickets.mergedIntoId }).from(tickets).where(eq(tickets.ticketId, id)).limit(1);
    if (!row) return null;
    if (!row.mergedIntoId) return row.number;
    id = row.mergedIntoId;
  }
  return null;
}
