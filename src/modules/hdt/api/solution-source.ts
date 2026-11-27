import 'server-only';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { and, asc, count, gte, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { setErrorSignatureTx, type SolutionSource, solutionSourceOf, type TicketMissingSignature, type TicketSearchKey, ticketSearchKeyOf, ticketsMissingSignatureOf } from '../core/solution-source';
import { HdtError } from '../error';
import { tickets } from '../schema';

// Модуль hdt, слой api: публичная переписка обращения для решения (план M5, задачи 5 и 7; FR-SOL-02, 03, ТЗ 14.3).
// Узкий файл: его тянет и фоновый процесс (задача черновика kb.draft), страниц и Next.js в нём нет. Внутренние
// заметки, сообщения системы и вложения сюда не попадают никогда; клиенту функция не дана.

export type { SolutionSource, SolutionSourceMessage, TicketMissingSignature } from '../core/solution-source';

const ref = z.union([z.strictObject({ ticketId: z.uuid() }), z.strictObject({ number: z.int().positive().max(999_999_999_999) })]);

export async function ticketSolutionSource(actor: StaffActor | SystemActor, input: unknown): Promise<SolutionSource | null> {
  if (actor.type !== 'staff' && actor.type !== 'system') throw new HdtError('forbidden');
  const parsed = ref.safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  return solutionSourceOf(actor, parsed.data);
}

/**
 * Тема, сигнатура, модуль и язык обращения для блока "Связанные решения" (FR-AG-05; план M5, задача 10). Только
 * сотрудник: обращение читается под его ролью.
 */
export async function ticketSearchKey(actor: StaffActor, input: unknown): Promise<TicketSearchKey | null> {
  if (actor.type !== 'staff') throw new HdtError('forbidden');
  const parsed = z.strictObject({ ticketId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  return ticketSearchKeyOf(actor, parsed.data.ticketId);
}

const signatureInput = z.strictObject({ ticketId: z.uuid(), signature: z.string().regex(/^[0-9a-f]{32}$/) });

/**
 * Записывает сигнатуру ошибки в обращение (план M5, задача 8). Вызывает модуль знаний в своей транзакции от имени
 * системы; политика RLS не даёт клиенту менять обращение, триггер не пускает сигнатуру во вставку клиента.
 */
export async function setTicketErrorSignatureTx(tx: Tx, input: unknown): Promise<void> {
  const parsed = signatureInput.safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  await setErrorSignatureTx(tx, parsed.data.ticketId, parsed.data.signature);
}

const missingInput = z.strictObject({ from: z.date(), to: z.date(), excludeOrgId: z.uuid(), limit: z.int().positive().max(1000) });

/** Обращения окна без сигнатуры, но со строкой, похожей на ошибку: для починки сигнатур (0057, M7m). Только система. */
export async function ticketsMissingSignature(actor: SystemActor, input: unknown): Promise<TicketMissingSignature[]> {
  if (actor.type !== 'system') throw new HdtError('forbidden');
  const parsed = missingInput.safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  return ticketsMissingSignatureOf(actor, parsed.data);
}

const candidateInput = z.strictObject({ since: z.date(), resolutions: z.array(z.string().regex(/^[a-z_]{1,40}$/)).min(1).max(6), limit: z.int().positive().max(1000) });

/**
 * Решённые и закрытые обращения окна без решения из базы (план M5c, задача 9, решение 26): итог из списка, решены не
 * раньше since, solution_id пусто. Источники решений, журнал вызовов и выключенную AI-обработку проверяет модуль hda.
 * Только система.
 */
export async function resolvedWithoutSolution(actor: SystemActor, input: unknown): Promise<{ ticketId: string; orgId: string }[]> {
  if (actor.type !== 'system') throw new HdtError('forbidden');
  const parsed = candidateInput.safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  const { since, resolutions, limit } = parsed.data;
  return withActor(actor, (tx) =>
    tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId })
      .from(tickets)
      .where(and(inArray(tickets.status, ['resolved', 'closed']), inArray(tickets.resolutionType, resolutions), isNull(tickets.solutionId), isNull(tickets.mergedIntoId), gte(tickets.resolvedOn, since)))
      .orderBy(asc(tickets.resolvedOn))
      .limit(limit),
  );
}

/**
 * Показатель пользы знаний из кода (веха M8c, FR-CODE-15): сколько обращений клиентов с сигнатурой ошибки создано с
 * даты и у скольких из них сигнатура из переданного списка (сигнатуры записей каталога). Только числа.
 */
export async function signatureShareTx(tx: Tx, input: { since: Date; signatures: readonly string[]; excludeOrgId: string }): Promise<{ withSignature: number; matched: number }> {
  const base = and(isNotNull(tickets.errorSignature), gte(tickets.createdOn, input.since), isNull(tickets.mergedIntoId), ne(tickets.orgId, input.excludeOrgId));
  const [all] = await tx.select({ n: count() }).from(tickets).where(base);
  const matched = input.signatures.length > 0 ? ((await tx.select({ n: count() }).from(tickets).where(and(base, inArray(tickets.errorSignature, [...input.signatures]))))[0]?.n ?? 0) : 0;
  return { withSignature: all?.n ?? 0, matched };
}
