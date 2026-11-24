import 'server-only';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdrError } from '../error';
import { TAG_DEFAULT_COLOR, type TagColor } from '../pref';
import { tags } from '../schema';

// Модуль hdr, слой core: справочник тегов обращений (FR-AUTO-13; план M8, задача 1, решение 8). Читают сотрудники,
// создаёт тот, кто ведёт обращения (на лету при постановке тега), меняет и удаляет администратор: права держит
// политика RLS, код проверяет роль раньше, чтобы ответить кодом. Связь тега с обращением ведёт модуль hdt.

export type Tag = { tagId: string; name: string; color: TagColor };

const columns = { tagId: tags.tagId, name: tags.name, color: tags.color };
/** Сравнение названий без учёта регистра делает база: тем же выражением, что уникальный индекс hdr_tags_u1. */
const sameName = (name: string) => sql`lower(${tags.name}) = lower(${name})`;

/** Все теги по названию. */
export async function listTagsTx(actor: StaffActor | SystemActor): Promise<Tag[]> {
  return withActor(actor, (tx) => tx.select(columns).from(tags).orderBy(asc(sql`lower(${tags.name})`), asc(tags.tagId)));
}

/** Теги по идентификаторам в транзакции вызывающего: модуль обращений подписывает ими свои строки. */
export async function tagsByIdTx(tx: Tx, tagIds: readonly string[]): Promise<Map<string, Tag>> {
  if (tagIds.length === 0) return new Map();
  const rows = await tx.select(columns).from(tags).where(inArray(tags.tagId, [...new Set(tagIds)]));
  return new Map(rows.map((row) => [row.tagId, row]));
}

/**
 * Тег по названию без учёта регистра; нет такого: создаётся с цветом по умолчанию и записью журнала. Работает в
 * транзакции действия над обращением: откатилось действие, не осталось и тега. Название уже проверено схемой.
 */
export async function findOrCreateTagTx(tx: Tx, name: string): Promise<Tag & { created: boolean }> {
  // Два сотрудника создают один тег одновременно: второй ждёт на уникальном индексе и получает строку первого.
  const [created] = await tx.insert(tags).values({ name, color: TAG_DEFAULT_COLOR }).onConflictDoNothing().returning(columns);
  if (created) {
    await writeAudit(tx, { action: 'tag.created', objectType: 'tag', objectId: created.tagId, diff: { name } });
    return { ...created, created: true };
  }
  const [found] = await tx.select(columns).from(tags).where(sameName(name)).limit(1);
  if (!found) throw new Error('hdr: тег не создан и не найден');
  return { ...found, created: false };
}

/** Переименовать и перекрасить. Название занято другим тегом: tag_taken. Нет тега: not_found. */
export async function updateTagTx(actor: StaffActor, input: { tagId: string; name: string; color: TagColor }): Promise<void> {
  if (actor.staffRole !== 'admin') throw new HdrError('forbidden');
  await withActor(actor, async (tx) => {
    const [before] = await tx.select(columns).from(tags).where(eq(tags.tagId, input.tagId)).limit(1).for('update');
    if (!before) throw new HdrError('not_found');
    const [taken] = await tx.select({ tagId: tags.tagId }).from(tags).where(sameName(input.name)).limit(1);
    if (taken && taken.tagId !== input.tagId) throw new HdrError('tag_taken');
    if (before.name === input.name && before.color === input.color) return;
    await tx.update(tags).set({ name: input.name, color: input.color }).where(eq(tags.tagId, input.tagId));
    await writeAudit(tx, {
      action: 'tag.updated',
      objectType: 'tag',
      objectId: input.tagId,
      diff: { name: { from: before.name, to: input.name }, color: { from: before.color, to: input.color } },
    });
  });
}

/** Удалить тег: со всех обращений его снимает внешний ключ hdt_ticket_tags_f2. Нет тега: not_found. */
export async function deleteTagTx(actor: StaffActor, tagId: string): Promise<void> {
  if (actor.staffRole !== 'admin') throw new HdrError('forbidden');
  await withActor(actor, async (tx) => {
    const [deleted] = await tx.delete(tags).where(eq(tags.tagId, tagId)).returning(columns);
    if (!deleted) throw new HdrError('not_found');
    await writeAudit(tx, { action: 'tag.deleted', objectType: 'tag', objectId: tagId, diff: { name: deleted.name } });
  });
}
