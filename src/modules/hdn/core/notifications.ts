import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type ClientActor, type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { contacts, writeAudit } from '@/modules/hdc/api';
import { HdnError } from '../error';
import { type NotificationKind, notificationPrefs, notifications, type PrefKind } from '../schema';
import { getTelegramBot } from '../telegram';

// Модуль hdn, слой core: уведомления в портале (FR-NT-03, решение 5 вехи M4) и каналы уведомлений (FR-NT-04,
// FR-NT-14; решения 3 и 4 вехи M4b).

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
  n: { userId: string; kind: NotificationKind; payload: Record<string, string | number> } & ({ ticketId: string; orgId: string } | { ticketId?: undefined; orgId?: undefined }),
): Promise<void> {
  // Организацию обращения передаёт вызывающий: таблица обращений принадлежит другому модулю, и читать её отсюда
  // нельзя (аудит 23.11.2026, находка A2). Подделать организацию нельзя: политика вставки сверяет её с обращением.
  await tx
    .insert(notifications)
    .values({ notificationId: randomUUID(), userId: n.userId, kind: n.kind, ticketId: n.ticketId ?? null, orgId: n.ticketId ? n.orgId : null, payload: n.payload });
}

/** Отправлено ли уже напоминание о праздниках этого года: его ставит ежемесячная проверка календаря (FR-SLA-12). */
export async function holidaysReminderSentTx(tx: Tx, year: number): Promise<boolean> {
  const rows = await tx
    .select({ id: notifications.notificationId })
    .from(notifications)
    .where(and(eq(notifications.kind, 'holidays_reminder'), sql`${notifications.payload} ->> 'year' = ${String(year)}`))
    .limit(1);
  return rows.length > 0;
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

/**
 * Страница уведомлений. before: идентификатор последней показанной строки (следующая страница начинается сразу за
 * ней, строки с одинаковым временем не теряются; M4, мелкое 10) или время, как в прежних ссылках.
 */
export async function listNotificationsTx(actor: PersonActor, before: Date | { afterId: string } | null): Promise<NotificationRow[]> {
  const cursor =
    before === null
      ? undefined
      : before instanceof Date
        ? lt(notifications.createdOn, before)
        : sql`(${notifications.createdOn}, ${notifications.notificationId}) < (select c.created_on, c.notification_id from hdn_notifications c where c.notification_id = ${before.afterId}::uuid and c.user_id = ${actor.userId}::uuid)`;
  const rows = await withActor(actor, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, actor.userId), cursor))
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

export type Channels = { email: boolean; telegram: boolean };

const channel = z.object({ email: z.boolean(), telegram: z.boolean() }).strict();
// Клиент: о своих обращениях и об обращениях коллег, почта и Telegram (решение 3 вехи M4b). Портал всегда.
const clientPrefs = z.object({ own: channel, watched: channel }).strict();
const staffPrefs = z.object({ staffMention: z.boolean(), staffBreach: z.boolean() }).strict();
export type ClientPrefs = z.infer<typeof clientPrefs>;
export type StaffPrefs = z.infer<typeof staffPrefs>;

async function prefChannels(tx: Tx, userId: string, kind: PrefKind): Promise<Channels> {
  const row = (
    await tx
      .select({ email: notificationPrefs.emailEnabled, telegram: notificationPrefs.telegramEnabled })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.kind, kind)))
      .limit(1)
  )[0];
  return row ?? { email: true, telegram: true };
}

/** Действует ли Telegram у пользователя: бот портала включён, привязка есть и бот не заблокирован. */
async function telegramActive(userId: string): Promise<boolean> {
  return getTelegramBot().enabled && (await contacts().telegramLinked(userId));
}

/**
 * Куда уведомлять клиента о событии обращения (решения 3 и 4 вехи M4b). Telegram только при действующей
 * привязке. О своих обращениях хотя бы один внешний канал: если Telegram не действует, письмо идёт, даже когда
 * почта выключена в настройке (отвязал Telegram или заблокировал бота).
 */
export async function channelsFor(tx: Tx, userId: string, scope: 'own' | 'watched'): Promise<Channels> {
  const pref = await prefChannels(tx, userId, scope === 'own' ? 'own_tickets' : 'watched_tickets');
  const telegram = pref.telegram && (await telegramActive(userId));
  return { email: pref.email || (scope === 'own' && !telegram), telegram };
}

/**
 * Каналы сразу нескольких получателей события (аудит 23.11.2026, находка A4): настройки одним запросом, действие
 * Telegram одним запросом. Правила те же, что у channelsFor. own: пользователь, для которого обращение своё.
 */
export async function channelsForMany(tx: Tx, userIds: string[], own: string | null): Promise<Map<string, Channels>> {
  const result = new Map<string, Channels>();
  if (userIds.length === 0) return result;
  const rows = await tx
    .select({ userId: notificationPrefs.userId, kind: notificationPrefs.kind, email: notificationPrefs.emailEnabled, telegram: notificationPrefs.telegramEnabled })
    .from(notificationPrefs)
    .where(and(inArray(notificationPrefs.userId, userIds), inArray(notificationPrefs.kind, ['own_tickets', 'watched_tickets'])));
  const linked = getTelegramBot().enabled ? await contacts().telegramLinkedMany(userIds) : new Set<string>();
  for (const userId of userIds) {
    const scope = userId === own ? 'own' : 'watched';
    const pref = rows.find((row) => row.userId === userId && row.kind === (scope === 'own' ? 'own_tickets' : 'watched_tickets')) ?? { email: true, telegram: true };
    const telegram = pref.telegram && linked.has(userId);
    result.set(userId, { email: pref.email || (scope === 'own' && !telegram), telegram });
  }
  return result;
}

const STAFF_KIND = { staffMention: 'staff_mention', staffBreach: 'staff_breach' } as const;

async function readPrefsIn(tx: Tx, actor: PersonActor): Promise<ClientPrefs | StaffPrefs> {
  if (actor.type === 'client') {
    return { own: await prefChannels(tx, actor.userId, 'own_tickets'), watched: await prefChannels(tx, actor.userId, 'watched_tickets') };
  }
  return { staffMention: (await prefChannels(tx, actor.userId, 'staff_mention')).email, staffBreach: (await prefChannels(tx, actor.userId, 'staff_breach')).email };
}

async function upsertPref(tx: Tx, userId: string, kind: PrefKind, value: Channels | boolean): Promise<void> {
  const set = typeof value === 'boolean' ? { emailEnabled: value } : { emailEnabled: value.email, telegramEnabled: value.telegram };
  await tx
    .insert(notificationPrefs)
    .values({ userId, kind, ...set })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.kind], set });
}

/**
 * Сохранить свои настройки. Клиент выключает почту о своих обращениях, только если Telegram включён и действует
 * (решение 3 вехи M4b). Изменение пишется в журнал аудита без идентификатора Telegram.
 */
export async function savePrefsTx(actor: PersonActor, input: unknown): Promise<void> {
  const parsed = actor.type === 'client' ? clientPrefs.safeParse(input) : staffPrefs.safeParse(input);
  if (!parsed.success) throw new HdnError('invalid_input');
  const values = parsed.data;
  if ('own' in values && !values.own.email && !(values.own.telegram && (await telegramActive(actor.userId)))) throw new HdnError('invalid_input');
  await withActor(actor, async (tx) => {
    const before = await readPrefsIn(tx, actor);
    if (JSON.stringify(before) === JSON.stringify(values)) return;
    if ('own' in values) {
      await upsertPref(tx, actor.userId, 'own_tickets', values.own);
      await upsertPref(tx, actor.userId, 'watched_tickets', values.watched);
    } else {
      for (const key of ['staffMention', 'staffBreach'] as const) await upsertPref(tx, actor.userId, STAFF_KIND[key], values[key]);
    }
    await writeAudit(tx, { action: 'notify.channels_changed', objectType: 'user', objectId: actor.userId, diff: values });
  });
}

export async function readPrefsTx(actor: PersonActor): Promise<ClientPrefs | StaffPrefs> {
  return withActor(actor, (tx) => readPrefsIn(tx, actor));
}

/** Письма об идеях (план M7, задача 8, FR-NT-04): у клиентов и сотрудников, отключаются всегда. Нет строки: включены. */
export async function readIdeaMailPrefTx(actor: PersonActor): Promise<{ email: boolean }> {
  return withActor(actor, async (tx) => ({ email: (await prefChannels(tx, actor.userId, 'ideas')).email }));
}

export async function saveIdeaMailPrefTx(actor: PersonActor, input: unknown): Promise<void> {
  const parsed = z.object({ email: z.boolean() }).strict().safeParse(input);
  if (!parsed.success) throw new HdnError('invalid_input');
  await withActor(actor, async (tx) => {
    if ((await prefChannels(tx, actor.userId, 'ideas')).email === parsed.data.email) return;
    await upsertPref(tx, actor.userId, 'ideas', parsed.data.email);
    await writeAudit(tx, { action: 'notify.channels_changed', objectType: 'user', objectId: actor.userId, diff: { ideas: parsed.data.email } });
  });
}
