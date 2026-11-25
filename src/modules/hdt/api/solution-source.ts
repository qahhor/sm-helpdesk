import 'server-only';
import * as z from 'zod';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { type SolutionSource, solutionSourceOf } from '../core/solution-source';
import { HdtError } from '../error';

// Модуль hdt, слой api: публичная переписка обращения для решения (план M5, задачи 5 и 7; FR-SOL-02, 03, ТЗ 14.3).
// Узкий файл: его тянет и фоновый процесс (задача черновика kb.draft), страниц и Next.js в нём нет. Внутренние
// заметки, сообщения системы и вложения сюда не попадают никогда; клиенту функция не дана.

export type { SolutionSource, SolutionSourceMessage } from '../core/solution-source';

const ref = z.union([z.strictObject({ ticketId: z.uuid() }), z.strictObject({ number: z.int().positive().max(999_999_999_999) })]);

export async function ticketSolutionSource(actor: StaffActor | SystemActor, input: unknown): Promise<SolutionSource | null> {
  if (actor.type !== 'staff' && actor.type !== 'system') throw new HdtError('forbidden');
  const parsed = ref.safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  return solutionSourceOf(actor, parsed.data);
}
