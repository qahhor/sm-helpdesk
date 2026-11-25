import 'server-only';
import { and, asc, eq, gte, inArray, isNull, lt, ne, type SQL, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import type { TicketSource, TicketStatus } from '../pref';
import { type TicketContext, ticketMessages, tickets } from '../schema';

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
  /** Исполнитель: его имя вырезается из текста для модели (0057, I3s). */
  assigneeId: string | null;
  /** Канал обращения: у письма описание хранится с цитатой, для модели она отрезается (0057, I1s). */
  source: TicketSource;
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
        assigneeId: tickets.assigneeId,
        source: tickets.source,
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

export type TicketSearchKey = { title: string; errorSignature: string | null; moduleId: string | null; locale: string };

/** Ключ поиска связанных решений: без описания и переписки, они в поиск не нужны. */
export async function ticketSearchKeyOf(actor: StaffActor, ticketId: string): Promise<TicketSearchKey | null> {
  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ title: tickets.title, errorSignature: tickets.errorSignature, moduleId: tickets.moduleId, locale: tickets.locale })
      .from(tickets)
      .where(eq(tickets.ticketId, ticketId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Сигнатура ошибки обращения (план M5, задача 8, решение 7) в транзакции системы модуля знаний. Сигнатуру считает
 * сервер после создания обращения: клиент её не задаёт (триггер t_hdt_tickets_client_guard).
 */
export async function setErrorSignatureTx(tx: Tx, ticketId: string, signature: string): Promise<void> {
  await tx.update(tickets).set({ errorSignature: signature }).where(eq(tickets.ticketId, ticketId));
}

export type TicketMissingSignature = {
  ticketId: string;
  orgId: string;
  authorId: string;
  description: string;
  moduleId: string | null;
  context: TicketContext | null;
  senderUnconfirmed: boolean;
};

/**
 * Обращения окна [from, to) без сигнатуры, в описании или контексте которых есть похожая на ошибку строка (код ORA,
 * PLS, TNS или подпись "ошибка:"): сигнатура могла не записаться, если процесс упал между записью обращения и
 * сигнатуры (0057, M7m). Точную проверку делает модуль знаний. Читает система.
 */
export async function ticketsMissingSignatureOf(actor: SystemActor, input: { from: Date; to: Date; excludeOrgId: string; limit: number }): Promise<TicketMissingSignature[]> {
  return withActor(actor, (tx) =>
    tx
      .select({
        ticketId: tickets.ticketId,
        orgId: tickets.orgId,
        authorId: tickets.authorId,
        description: tickets.description,
        moduleId: tickets.moduleId,
        context: tickets.context,
        senderUnconfirmed: tickets.senderUnconfirmed,
      })
      .from(tickets)
      .where(
        and(
          isNull(tickets.errorSignature),
          ne(tickets.orgId, input.excludeOrgId),
          gte(tickets.createdOn, input.from),
          lt(tickets.createdOn, input.to),
          sql`(${tickets.description} ~* '(ORA|PLS|TNS)-[0-9]{4,5}' or ${tickets.description} ~* '(текст ошибки|ошибка|error|xato|хато)\s*:'
               or ${tickets.context} ->> 'errorCode' is not null or ${tickets.context} ->> 'errorText' is not null)`,
        ),
      )
      .orderBy(asc(tickets.createdOn))
      .limit(input.limit),
  );
}
