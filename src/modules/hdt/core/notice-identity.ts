import 'server-only';
import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type Actor, withActor } from '@/db/with-actor';
import { type IdentitySnapshot, readIdentitySnapshot, withIdentitySnapshot } from '@/modules/hdu/api/identity-snapshot';
import { tickets, ticketWatchers } from '../schema';

// Модуль hdt, слой core: транзакция записи обращения, перед которой прочитаны сведения о получателях уведомления
// (проверка качества, Q2). Роли автора и подписчиков в организации, привязки Telegram и название организации лежат
// в таблицах идентичности под ролью hub_auth. Раньше уведомление спрашивало их изнутри транзакции записи: она держала
// соединение hub_app и блокировку обращения, пока ждала соединение второго пула. Теперь сведения читаются до неё.
//
// Подписчик, добавленный между чтением и транзакцией, в снимок не попал: за ним уведомление пойдёт в базу, как
// раньше. Это редкий случай, а не правило; тест tests/integration/nested-tx.test.ts следит, чтобы обычные пути
// вторую транзакцию не открывали.

type TicketRef = { ticketId: string } | { number: number };

/** Автор, подписчики и организация обращения глазами актора: короткое чтение без блокировок. */
async function ticketPeople(actor: Actor, ref: TicketRef): Promise<{ orgId: string; userIds: string[] } | null> {
  return withActor(actor, async (tx) => {
    const [ticket] = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, authorId: tickets.authorId })
      .from(tickets)
      .where('ticketId' in ref ? eq(tickets.ticketId, ref.ticketId) : eq(tickets.number, ref.number))
      .limit(1);
    if (!ticket) return null;
    const watchers = await tx.select({ userId: ticketWatchers.userId }).from(ticketWatchers).where(eq(ticketWatchers.ticketId, ticket.ticketId));
    return { orgId: ticket.orgId, userIds: [ticket.authorId, ...watchers.map((w) => w.userId)] };
  });
}

/** Снимок получателей обращения или null, если обращения для актора нет: транзакция сама ответит "не найдено". */
export async function ticketPeopleSnapshot(actor: Actor, ref: TicketRef): Promise<IdentitySnapshot | null> {
  const people = await ticketPeople(actor, ref);
  return people ? readIdentitySnapshot(people.orgId, people.userIds) : null;
}

/** Транзакция актора над существующим обращением: получатели уведомления прочитаны до неё. */
export async function withActorForTicket<T>(actor: Actor, ref: TicketRef, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withIdentitySnapshot([await ticketPeopleSnapshot(actor, ref)], () => withActor(actor, fn));
}

/** Транзакция актора, создающая обращение: получатель один, его автор. */
export async function withActorForAuthor<T>(actor: Actor, author: { orgId: string; userId: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withIdentitySnapshot([await readIdentitySnapshot(author.orgId, [author.userId])], () => withActor(actor, fn));
}

/** Операция над несколькими обращениями (задачи фонового процесса): снимки всех читаются до неё. */
export async function withTicketsPeople<T>(actor: Actor, ticketIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  const snapshots: (IdentitySnapshot | null)[] = [];
  for (const ticketId of ticketIds) snapshots.push(await ticketPeopleSnapshot(actor, { ticketId }));
  return withIdentitySnapshot(snapshots, fn);
}
