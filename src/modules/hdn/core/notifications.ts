import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type ClientActor, type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { type NotificationKind, notificationPrefs, notifications, type PrefKind } from '../schema';

// Модуль hdn, слой core: уведомления в портале (FR-NT-03, решение 5 вехи M4) и настройки писем (FR-NT-04).

export type PersonActor = ClientActor | StaffActor;

/** Прочитанные уведомления живут 90 дней, затем их удаляет ночная очистка (решение 5). */
export const READ_NOTIFICATION_DAYS = 90;
const PAGE = 50;
const DAY_MS = 86_400_000;

export type NotificationRow = {
  notificationId: string;
  kind: NotificationKind;
  ticketNumber: number | null;
  payload: Record<string, string | number>;
  readOn: Date | null;
  createdOn: Date;
};

/**
 * Ставит уведомление в транзакции действия. Идентификатор задаёт приложение: клиент, который уведомляет
 * исполнителя, строку не читает. Организация берётся из обращения.
 */
export async function notifyTx(
  tx: Tx,
  n: { userId: string; kind: NotificationKind; ticketId?: string; payload: Record<string, string | number> },
): Promise<void> {
  let orgId: string | null = null;
  if (n.ticketId) {
    const found = await tx.execute<{ org_id: string }>(sql`select org_id from hdt_tickets where ticket_id = ${n.ticketId}`);
    orgId = found.rows[0]?.org_id ?? null;
    if (!orgId) throw new Error('уведомление: обращение не найдено');
  }
  await tx.insert(notifications).values({ notificationId: randomUUID(), userId: n.userId, kind: n.kind, ticketId: n.ticketId ?? null, orgId, payload: n.payload });
}

export async function unreadCountTx(actor: PersonActor): Promise<number> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readOn))),
  );
  return rows[0]?.n ?? 0;
}

export async function listNotificationsTx(actor: PersonActor, before: Date | null): Promise<NotificationRow[]> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, actor.userId), before ? lt(notifications.createdOn, before) : undefined))
      .orderBy(desc(notifications.createdOn), desc(notifications.notificationId))
      .limit(PAGE),
  );
  return rows.map((r) => ({
    notificationId: r.notificationId,
    kind: r.kind,
    ticketNumber: typeof r.payload.number === 'number' ? r.payload.number : null,
    payload: r.payload,
    readOn: r.readOn,
    createdOn: r.createdOn,
  }));
}

export async function markReadTx(actor: PersonActor, ids: string[] | 'all'): Promise<void> {
  await withActor(actor, (tx) =>
    tx
      .update(notifications)
      .set({ readOn: sql`now()` })
      .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readOn), ids === 'all' ? undefined : inArray(notifications.notificationId, ids))),
  );
}

/** Открыть уведомление: отметка прочтения и данные для перехода. Чужое или несуществующее: null. */
export async function openNotificationTx(actor: PersonActor, id: string): Promise<NotificationRow | null> {
  return withActor(actor, async (tx) => {
    const row = (await tx.select().from(notifications).where(and(eq(notifications.notificationId, id), eq(notifications.userId, actor.userId))).limit(1))[0];
    if (!row) return null;
    if (!row.readOn) await tx.update(notifications).set({ readOn: sql`now()` }).where(eq(notifications.notificationId, id));
    return { notificationId: row.notificationId, kind: row.kind, ticketNumber: typeof row.payload.number === 'number' ? row.payload.number : null, payload: row.payload, readOn: row.readOn, createdOn: row.createdOn };
  });
}

/** Ночная очистка: прочитанные старше 90 дней. */
export async function cleanupNotificationsTx(actor: SystemActor, now: Date): Promise<number> {
  const before = new Date(now.getTime() - READ_NOTIFICATION_DAYS * DAY_MS);
  const rows = await withActor(actor, (tx) =>
    tx
      .delete(notifications)
      .where(and(isNotNull(notifications.readOn), lt(notifications.readOn, before)))
      .returning({ id: notifications.notificationId }),
  );
  return rows.length;
}

/** Разрешено ли письмо этого вида. Нет строки настройки: разрешено (FR-NT-04). */
export async function emailAllowed(tx: Tx, userId: string, pref: PrefKind): Promise<boolean> {
  const row = (
    await tx
      .select({ enabled: notificationPrefs.emailEnabled })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.kind, pref)))
      .limit(1)
  )[0];
  return row?.enabled ?? true;
}

// Письма о своих обращениях выключить нельзя (FR-NT-04): в схеме такого поля нет, лишнее поле отклоняется.
const clientPrefs = z.object({ watchedTickets: z.boolean() }).strict();
const staffPrefs = z.object({ staffMention: z.boolean(), staffBreach: z.boolean() }).strict();
export type ClientPrefs = z.infer<typeof clientPrefs>;
export type StaffPrefs = z.infer<typeof staffPrefs>;

const KIND_OF = { watchedTickets: 'watched_tickets', staffMention: 'staff_mention', staffBreach: 'staff_breach' } as const;

export async function savePrefsTx(actor: PersonActor, input: unknown): Promise<void> {
  const values = actor.type === 'client' ? clientPrefs.parse(input) : staffPrefs.parse(input);
  await withActor(actor, async (tx) => {
    for (const [key, enabled] of Object.entries(values) as [keyof typeof KIND_OF, boolean][]) {
      await tx
        .insert(notificationPrefs)
        .values({ userId: actor.userId, kind: KIND_OF[key], emailEnabled: enabled })
        .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.kind], set: { emailEnabled: enabled } });
    }
  });
}

export async function readPrefsTx(actor: PersonActor): Promise<ClientPrefs | StaffPrefs> {
  const rows = await withActor(actor, (tx) =>
    tx.select({ kind: notificationPrefs.kind, enabled: notificationPrefs.emailEnabled }).from(notificationPrefs).where(eq(notificationPrefs.userId, actor.userId)),
  );
  const of = (kind: PrefKind) => rows.find((r) => r.kind === kind)?.enabled ?? true;
  return actor.type === 'client' ? { watchedTickets: of('watched_tickets') } : { staffMention: of('staff_mention'), staffBreach: of('staff_breach') };
}
