import 'server-only';
import type { Tx } from '@/db/client';
import type { AgentActor } from '@/db/with-actor';
import { ticketMessages } from '../schema';

// Модуль hdt, слой api: запись AI-сотрудника в обращение (веха M8b, задача 6; FR-AGT-04, 05, 07; план M8b, решение 19).
// Внутренняя заметка или черновик записки второй линии строкой сообщения с author_type = agent от учётной записи
// agent_bot. Больше ничего: ни статуса, ни сроков SLA, ни "клиент ждёт с", ни исполнителя, ни уведомлений, ни событий
// правил. Это делает код сотрудника, а здесь его нет. Политика hdt_ticket_messages_agent_insert пускает строку только
// в обращение, видное агенту; триггер базы считает заметки токена запуска.

export type AgentNoteKind = 'note' | 'handoff_memo' | 'code_analysis';

/** Запись агента в транзакции его инструмента. Без returning: читать сообщения актору agent не дано. */
export async function addAgentNoteTx(tx: Tx, actor: AgentActor, input: { ticketId: string; orgId: string; kind: AgentNoteKind; body: string; messageId?: string }): Promise<void> {
  await tx.insert(ticketMessages).values({
    ...(input.messageId ? { messageId: input.messageId } : {}),
    orgId: input.orgId,
    ticketId: input.ticketId,
    authorId: actor.userId,
    authorType: 'agent',
    body: input.body,
    isInternal: true,
    source: 'staff',
    agentNoteKind: input.kind,
  });
}
