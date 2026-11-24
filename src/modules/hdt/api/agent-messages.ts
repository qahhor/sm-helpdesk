import 'server-only';
import { listStaffDirectory, namesOf, type StaffContext } from '@/modules/hdu/api';
import { assertCanWrite } from '../core/agent-actions';
import { type ChangeSummary, listPresenceTx, loadDraftTx, postStaffMessageTx, saveDraftTx, syncPresenceTx, touchPresenceTx } from '../core/agent-messages';
import { draftInput, numberInput, parseInput, presenceInput, staffMessageInput } from '../input';
import type { PresenceMode } from '../pref';
import { wakeAutomation } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';

// Ответ клиенту, заметка, черновик и присутствие на рабочем месте (план M3, задача 8). Сотрудник только из
// проверенной сессии, вход разбирается схемой, права и данные проверяют слой core и база.

export type { ChangeSummary } from '../core/agent-messages';
export type PresenceEntry = { userId: string; name: string; mode: PresenceMode };

/**
 * Ответ клиенту или внутренняя заметка (FR-AG-03). Обращение изменили другие после seenVersion: ничего не уходит,
 * возвращается сводка изменений, агент решает и отправляет снова с новой версией (FR-AG-12, UX-A-06).
 */
export async function postStaffMessage(ctx: StaffContext, input: unknown): Promise<{ ok: true } | { ok: false; changed: ChangeSummary; version: string }> {
  assertCanWrite(ctx.actor);
  const data = parseInput(staffMessageInput, input);
  const mentionable = data.internal ? await listStaffDirectory(ctx) : [];
  const result = await postStaffMessageTx(ctx.actor, { ...data, seenVersion: new Date(data.seenVersion) }, { myName: ctx.user.name, mentionable });
  if (result.ok) {
    await wakeOutbox();
    // Событие ответа сотрудника записано в транзакции действия: разбор правил будится после фиксации.
    if (!data.internal) await wakeAutomation();
  }
  return result.ok ? { ok: true } : { ok: false, changed: result.changed, version: result.version };
}

/** Сохранить черновик (FR-AG-21, UX-A-07): пустой текст удаляет черновик. */
export async function saveDraft(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(draftInput, input);
  await saveDraftTx(ctx.actor, data.number, data.body, data.internal);
}

export async function loadDraft(ctx: StaffContext, number: unknown): Promise<{ body: string; internal: boolean; savedOn: Date } | null> {
  return loadDraftTx(ctx.actor, parseInput(numberInput, number));
}

/** Отметка присутствия (решение 10): страница вызывает раз в 10 секунд. */
export async function touchPresence(ctx: StaffContext, input: unknown): Promise<void> {
  const data = parseInput(presenceInput, input);
  await touchPresenceTx(ctx.actor, data.number, data.mode);
}

/**
 * Отметка присутствия и список коллег за один запрос к базе (находка P12). Имена читаются, только когда на обращении
 * есть кто-то ещё.
 */
export async function syncPresence(ctx: StaffContext, input: unknown): Promise<PresenceEntry[]> {
  const data = parseInput(presenceInput, input);
  const rows = await syncPresenceTx(ctx.actor, data.number, data.mode);
  if (rows.length === 0) return [];
  const names = await namesOf(ctx.actor, rows.map((row) => row.userId));
  return rows.map((row) => ({ userId: row.userId, name: names.get(row.userId) ?? '', mode: row.mode }));
}

/** Кто ещё открыл обращение и кто печатает: другие сотрудники с действующей отметкой. */
export async function listPresence(ctx: StaffContext, number: unknown): Promise<PresenceEntry[]> {
  const rows = await listPresenceTx(ctx.actor, parseInput(numberInput, number));
  const names = await namesOf(ctx.actor, rows.map((row) => row.userId));
  return rows.map((row) => ({ userId: row.userId, name: names.get(row.userId) ?? '', mode: row.mode }));
}
