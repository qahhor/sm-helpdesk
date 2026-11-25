import 'server-only';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import type { TicketStatus } from '../pref';
import { ticketMessages, tickets } from '../schema';

// Модуль hdt, слой core: обращение как источник решения (ТЗ FR-SOL-02, 03, 11.10, 14.3; план M5, задачи 5 и 7).
// Только публичная переписка: тема, описание и сообщения клиента и сотрудников без внутренних заметок, без
// сообщений системы, автоматических ответов правил и без вложений (их здесь нет вовсе). Читают сотрудник
// (создание решения, экран черновика) и система (задача черновика); клиенту функция не дана.

export type SolutionSourceMessage = { authorType: 'client' | 'staff'; authorId: string | null; body: string };

export type SolutionSource = {
  ticketId: string;
  orgId: string;
  number: number;
  status: TicketStatus;
  title: string;
  description: string;
  locale: string;
  moduleId: string | null;
  errorSignature: string | null;
  authorId: string;
  messages: SolutionSourceMessage[];
};

export async function solutionSourceOf(actor: StaffActor | SystemActor, where: { ticketId: string } | { number: number }): Promise<SolutionSource | null> {
  const filter: SQL = 'ticketId' in where ? eq(tickets.ticketId, where.ticketId) : eq(tickets.number, where.number);
  return withActor(actor, async (tx) => {
    const [ticket] = await tx
      .select({
        ticketId: tickets.ticketId,
        orgId: tickets.orgId,
        number: tickets.number,
        status: tickets.status,
        title: tickets.title,
        description: tickets.description,
        locale: tickets.locale,
        moduleId: tickets.moduleId,
        errorSignature: tickets.errorSignature,
        authorId: tickets.authorId,
      })
      .from(tickets)
      .where(filter)
      .limit(1);
    if (!ticket) return null;
    const rows = await tx
      .select({ authorType: ticketMessages.authorType, authorId: ticketMessages.authorId, body: ticketMessages.body })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticket.ticketId),
          eq(ticketMessages.isInternal, false),
          eq(ticketMessages.isAuto, false),
          inArray(ticketMessages.authorType, ['client', 'staff']),
        ),
      )
      .orderBy(asc(ticketMessages.createdOn), asc(ticketMessages.messageId));
    return { ...ticket, messages: rows as SolutionSourceMessage[] };
  });
}
