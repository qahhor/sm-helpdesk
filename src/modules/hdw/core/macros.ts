import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdwError } from '../error';
import { type MacroAction, type MacroDefinition, storedMacro } from '../macro-schema';
import { MAX_MACROS } from '../pref';
import { macros } from '../schema';

// Модуль hdw, слой core: макросы в базе (FR-AG-15, FR-ADM-10; план M8, задача 6). Читают сотрудники, создаёт, меняет
// и удаляет администратор: права держат политики RLS, код проверяет роль раньше, чтобы ответить кодом. Каждое
// изменение пишет запись журнала аудита в той же транзакции.

export type MacroRecord = {
  macroId: string;
  name: string;
  actions: MacroAction[];
  /** Действия в базе прошли схему. Негодный макрос (схема изменилась) не запускается и ждёт правки. */
  isValid: boolean;
  isEnabled: boolean;
  orderNo: number;
  modifiedOn: Date;
};

const columns = { macroId: macros.macroId, name: macros.name, actions: macros.actions, isEnabled: macros.isEnabled, orderNo: macros.orderNo, modifiedOn: macros.modifiedOn };
const inOrder = [asc(macros.orderNo), asc(macros.macroId)];

function toRecord(row: { actions: unknown } & Omit<MacroRecord, 'actions' | 'isValid'>): MacroRecord {
  const parsed = storedMacro.safeParse({ actions: row.actions });
  return parsed.success ? { ...row, actions: parsed.data.actions, isValid: true } : { ...row, actions: [], isValid: false };
}

function requireAdmin(actor: StaffActor): void {
  if (actor.staffRole !== 'admin') throw new HdwError('forbidden');
}

/** Все макросы по порядку. */
export async function listMacrosTx(actor: StaffActor): Promise<MacroRecord[]> {
  const rows = await withActor(actor, (tx) => tx.select(columns).from(macros).orderBy(...inOrder));
  return rows.map(toRecord);
}

export async function readMacroTx(actor: StaffActor, macroId: string): Promise<MacroRecord | null> {
  const [row] = await withActor(actor, (tx) => tx.select(columns).from(macros).where(eq(macros.macroId, macroId)).limit(1));
  return row ? toRecord(row) : null;
}

/** Что записать в журнал о макросе: без текста заметок, только виды действий. */
const summary = (macro: MacroDefinition) => ({ name: macro.name, actions: macro.actions.map((item) => item.action), isEnabled: macro.isEnabled });

/** Новый макрос (последним по порядку) или правка существующего. Нет макроса: not_found. */
export async function saveMacroTx(actor: StaffActor, macro: MacroDefinition): Promise<{ macroId: string }> {
  requireAdmin(actor);
  return withActor(actor, async (tx) => {
    const values = { name: macro.name, actions: macro.actions, isEnabled: macro.isEnabled };
    if (macro.macroId) {
      const [saved] = await tx.update(macros).set(values).where(eq(macros.macroId, macro.macroId)).returning({ macroId: macros.macroId });
      if (!saved) throw new HdwError('not_found');
      await writeAudit(tx, { action: 'macro.updated', objectType: 'macro', objectId: saved.macroId, diff: summary(macro) });
      return saved;
    }
    // Порядок новых макросов считается под блокировкой: два администратора не получат один номер.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdw.macros_order'))`);
    const [last] = await tx.select({ orderNo: sql<number>`coalesce(max(${macros.orderNo}), 0)::int`, total: sql<number>`count(*)::int` }).from(macros);
    if ((last?.total ?? 0) >= MAX_MACROS) throw new HdwError('too_many');
    const [created] = await tx
      .insert(macros)
      .values({ ...values, orderNo: (last?.orderNo ?? 0) + 1 })
      .returning({ macroId: macros.macroId });
    if (!created) throw new Error('hdw: макрос не сохранён');
    await writeAudit(tx, { action: 'macro.created', objectType: 'macro', objectId: created.macroId, diff: summary(macro) });
    return created;
  });
}

/** Сдвинуть макрос на одно место вверх или вниз. Порядок всех макросов перенумеровывается подряд. Край списка: ничего. */
export async function moveMacroTx(actor: StaffActor, macroId: string, direction: 'up' | 'down'): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdw.macros_order'))`);
    const list = await tx.select({ macroId: macros.macroId, name: macros.name, orderNo: macros.orderNo }).from(macros).orderBy(...inOrder).for('update');
    const index = list.findIndex((row) => row.macroId === macroId);
    const moved = list[index];
    if (!moved) throw new HdwError('not_found');
    const target = direction === 'up' ? index - 1 : index + 1;
    const other = list[target];
    if (!other) return;
    list[index] = other;
    list[target] = moved;
    for (const [position, row] of list.entries())
      if (row.orderNo !== position + 1) await tx.update(macros).set({ orderNo: position + 1 }).where(eq(macros.macroId, row.macroId));
    await writeAudit(tx, { action: 'macro.moved', objectType: 'macro', objectId: macroId, diff: { name: moved.name, direction, position: target + 1 } });
  });
}

/** Удалить макрос. Нет макроса: not_found. */
export async function deleteMacroTx(actor: StaffActor, macroId: string): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    const [deleted] = await tx.delete(macros).where(eq(macros.macroId, macroId)).returning({ name: macros.name });
    if (!deleted) throw new HdwError('not_found');
    await writeAudit(tx, { action: 'macro.deleted', objectType: 'macro', objectId: macroId, diff: { name: deleted.name } });
  });
}

/** Включённый и годный макрос для запуска. Нет такого, выключен или негоден: null. */
export async function runnableMacroTx(actor: StaffActor, macroId: string): Promise<MacroRecord | null> {
  const [row] = await withActor(actor, (tx) => tx.select(columns).from(macros).where(and(eq(macros.macroId, macroId), eq(macros.isEnabled, true))).limit(1));
  const macro = row ? toRecord(row) : null;
  return macro?.isValid ? macro : null;
}
