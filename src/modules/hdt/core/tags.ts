import 'server-only';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { findOrCreateTagTx, type Tag, tagsByIdTx } from '@/modules/hdr/api';
import { HdtError } from '../error';
import { MAX_TICKET_TAGS } from '../pref';
import { ticketTags } from '../schema';
import { assertCanWrite, lockAgentTicket, recordChange } from './agent-actions';

// Модуль hdt, слой core: теги на обращении (FR-AUTO-13; план M8, задача 1). Ставит и снимает сотрудник, который
// ведёт обращения. Каждое изменение одной транзакцией: строка связи, внутреннее событие истории (клиенту не видно)
// и запись журнала аудита. Название тега лежит в событии: история читается и после удаления тега.

/** Поставить тег по названию; тега с таким названием нет: создаётся. Уже стоит: ничего не меняется. */
export async function addTagTx(actor: StaffActor, number: number, name: string): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    const tag = await findOrCreateTagTx(tx, name);
    if (!(await canAddTagTx(tx, ticket.ticketId, tag.tagId))) return;
    const added = await tx
      .insert(ticketTags)
      .values({ orgId: ticket.orgId, ticketId: ticket.ticketId, tagId: tag.tagId, addedBy: actor.userId })
      .onConflictDoNothing()
      .returning({ ticketTagId: ticketTags.ticketTagId });
    if (added.length === 0) return;
    await recordChange(tx, actor, ticket, { kind: 'tag', payload: { action: 'added', tagId: tag.tagId, name: tag.name }, audit: 'ticket.tag_added' });
  });
}

/**
 * Можно ли поставить тег на обращение, строка которого заблокирована: тег уже стоит (false, менять нечего) или тегов
 * уже MAX_TICKET_TAGS (ошибка too_many_tags). Тот же предел держит триггер t_hdt_ticket_tags_guard.
 */
export async function canAddTagTx(tx: Tx, ticketId: string, tagId: string): Promise<boolean> {
  const rows = await tx.select({ tagId: ticketTags.tagId }).from(ticketTags).where(eq(ticketTags.ticketId, ticketId));
  if (rows.some((row) => row.tagId === tagId)) return false;
  if (rows.length >= MAX_TICKET_TAGS) throw new HdtError('too_many_tags');
  return true;
}

/** Снять тег с обращения. Тега на обращении нет: not_found. */
export async function removeTagTx(actor: StaffActor, number: number, tagId: string): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    const removed = await tx
      .delete(ticketTags)
      .where(and(eq(ticketTags.ticketId, ticket.ticketId), eq(ticketTags.tagId, tagId)))
      .returning({ ticketTagId: ticketTags.ticketTagId });
    if (removed.length === 0) throw new HdtError('not_found');
    const name = (await tagsByIdTx(tx, [tagId])).get(tagId)?.name ?? '';
    await recordChange(tx, actor, ticket, { kind: 'tag', payload: { action: 'removed', tagId, name }, audit: 'ticket.tag_removed' });
  });
}

/** Теги обращений в порядке постановки: для страницы обращения и строк очереди сотрудника. */
export async function ticketTagsTx(tx: Tx, ticketIds: readonly string[]): Promise<Map<string, Tag[]>> {
  const result = new Map<string, Tag[]>();
  if (ticketIds.length === 0) return result;
  const rows = await tx
    .select({ ticketId: ticketTags.ticketId, tagId: ticketTags.tagId })
    .from(ticketTags)
    .where(inArray(ticketTags.ticketId, [...ticketIds]))
    .orderBy(asc(ticketTags.createdOn), asc(ticketTags.ticketTagId));
  const tags = await tagsByIdTx(tx, rows.map((row) => row.tagId));
  for (const row of rows) {
    const tag = tags.get(row.tagId);
    if (tag) result.set(row.ticketId, [...(result.get(row.ticketId) ?? []), tag]);
  }
  return result;
}

/** На скольких обращениях стоит каждый тег: для экрана настроек. */
export async function tagUsageTx(actor: StaffActor): Promise<Map<string, number>> {
  const rows = await withActor(actor, (tx) => tx.select({ tagId: ticketTags.tagId, n: sql<number>`count(*)::int` }).from(ticketTags).groupBy(ticketTags.tagId));
  return new Map(rows.map((row) => [row.tagId, row.n]));
}
