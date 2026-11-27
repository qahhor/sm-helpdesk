import 'server-only';
import { and, asc, gt, inArray, sql } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { filterValues, foldText, localeField, type SearchDocument, type SearchIndexWriter, TEXT_LIMITS } from '@/modules/hdc/api';
import { ticketMessages, tickets } from '../schema';

// Модуль hdt, слой api: документы индекса поиска (план W6, решение 1; решение владельца 0070, пункт 3). Строит их
// фоновый процесс под системным актором (src/worker/search.ts).
//
// Обращение: организация, номер, тема и первые 1000 знаков описания на поле языка обращения, свёрнутая тема, время
// создания. Без автора, адресов, ИНН, названия организации, вложений, тегов и внутренних полей.
// Переписка (коллекция только для ключа сотрудника): тело сообщения и заметки на поле языка обращения, признак
// внутренней заметки. Идентификатор документа <обращение>_<сообщение>: из него берётся обращение.

const micros = (column: typeof tickets.modifiedOn | typeof ticketMessages.modifiedOn) => sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`;

export async function buildTicketDocs(system: SystemActor, ids: readonly string[]): Promise<Map<string, SearchDocument[]>> {
  const out = new Map<string, SearchDocument[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = await withActor(system, (tx) =>
    tx
      .select({
        ticketId: tickets.ticketId,
        orgId: tickets.orgId,
        authorId: tickets.authorId,
        visibility: tickets.visibility,
        number: tickets.number,
        title: tickets.title,
        description: sql<string>`left(${tickets.description}, ${TEXT_LIMITS.ticketDescription})`,
        locale: tickets.locale,
        createdOn: tickets.createdOn,
        version: micros(tickets.modifiedOn),
      })
      .from(tickets)
      .where(inArray(tickets.ticketId, [...ids])),
  );
  for (const row of rows)
    out.set(row.ticketId, [
      {
        id: row.ticketId,
        org_id: row.orgId,
        author_id: row.authorId,
        visibility: row.visibility,
        number: row.number,
        [localeField('title', row.locale)]: row.title,
        [localeField('description', row.locale)]: row.description,
        title_fold: foldText(row.title),
        created_on: row.createdOn.getTime(),
        version: Number(row.version),
      },
    ]);
  return out;
}

export async function pageTicketIds(system: SystemActor, after: string | null, limit: number): Promise<string[]> {
  const rows = await withActor(system, (tx) =>
    tx
      .select({ id: tickets.ticketId })
      .from(tickets)
      .where(after ? gt(tickets.ticketId, after) : undefined)
      .orderBy(asc(tickets.ticketId))
      .limit(limit),
  );
  return rows.map((r) => r.id);
}

/** Объект очереди переписки: <обращение>_<сообщение>. */
const split = (id: string) => {
  const [ticketId, messageId] = id.split('_') as [string, string | undefined];
  return { ticketId, messageId: messageId ?? '' };
};

export async function buildTicketTextDocs(system: SystemActor, ids: readonly string[]): Promise<Map<string, SearchDocument[]>> {
  const out = new Map<string, SearchDocument[]>(ids.map((id) => [id, []]));
  const messageIds = ids.map((id) => split(id).messageId).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (messageIds.length === 0) return out;
  const rows = await withActor(system, (tx) =>
    tx
      .select({
        messageId: ticketMessages.messageId,
        ticketId: ticketMessages.ticketId,
        orgId: ticketMessages.orgId,
        isInternal: ticketMessages.isInternal,
        agentNoteKind: ticketMessages.agentNoteKind,
        body: sql<string>`left(${ticketMessages.body}, ${TEXT_LIMITS.ticketText})`,
        locale: tickets.locale,
        version: micros(ticketMessages.modifiedOn),
      })
      .from(ticketMessages)
      .innerJoin(tickets, sql`${tickets.ticketId} = ${ticketMessages.ticketId}`)
      .where(inArray(ticketMessages.messageId, messageIds)),
  );
  for (const row of rows) {
    const id = `${row.ticketId}_${row.messageId}`;
    if (!out.has(id)) continue;
    // Заметка анализа по коду в поиск не идёт: поиск сотрудников не делит их по ролям знаний из кода (FR-CODE-11;
    // независимая проверка M8c, находка I2). Пустой список удаляет строку из индекса.
    if (row.agentNoteKind === 'code_analysis') continue;
    out.set(id, [{ id, ticket_id: row.ticketId, org_id: row.orgId, is_internal: row.isInternal, [localeField('body', row.locale)]: row.body, version: Number(row.version) }]);
  }
  return out;
}

export async function pageTicketTextIds(system: SystemActor, after: string | null, limit: number): Promise<string[]> {
  const afterMessage = after ? split(after).messageId : null;
  const rows = await withActor(system, (tx) =>
    tx
      .select({ id: ticketMessages.messageId, ticketId: ticketMessages.ticketId })
      .from(ticketMessages)
      .where(and(afterMessage ? gt(ticketMessages.messageId, afterMessage) : undefined))
      .orderBy(asc(ticketMessages.messageId))
      .limit(limit),
  );
  return rows.map((r) => `${r.ticketId}_${r.id}`);
}

/** Удалённое обращение уносит свою переписку. */
export async function removeTicketTexts(writer: SearchIndexWriter, ticketIds: readonly string[]): Promise<void> {
  if (ticketIds.length > 0) await writer.removeWhere('ticket_texts', `ticket_id:=${filterValues(ticketIds)}`);
}
