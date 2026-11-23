import { beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import {
  cleanupNotifications,
  emailAllowed,
  listNotifications,
  markRead,
  notifyTx,
  readPrefs,
  savePrefs,
  unreadCount,
} from '@/modules/hdn/api/notifications';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Уведомления в портале (FR-NT-03, решение 5 вехи M4) и настройки писем (FR-NT-04).

const WATCHED_OFF = { own: { email: true, telegram: true }, watched: { email: false, telegram: true } };
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const notifyAUser = (kind: 'ticket_reply' | 'ticket_status' = 'ticket_reply') =>
  withActor(f.l1.actor, (tx) => notifyTx(tx, { userId: f.aUser.userId, kind, ticketId: f.tickets.aOrg.ticketId, orgId: f.orgA.orgId, payload: { number: f.tickets.aOrg.number, title: f.tickets.aOrg.title } }));

test('уведомление видит и отмечает только адресат', async () => {
  await notifyAUser();
  const mine = await listNotifications(f.aUser.actor, {});
  const fixtureCount = mine.length - 1;
  expect(mine[0]).toMatchObject({ kind: 'ticket_reply', ticketNumber: f.tickets.aOrg.number, readOn: null });
  // Коллега из той же организации и сотрудник чужих уведомлений не видят.
  expect((await listNotifications(f.aAdmin.actor, {})).some((n) => n.notificationId === mine[0]!.notificationId)).toBe(false);
  expect((await listNotifications(f.l1.actor, {})).some((n) => n.notificationId === mine[0]!.notificationId)).toBe(false);
  // Чужая отметка прочтения ничего не меняет.
  await markRead(f.aAdmin.actor, [mine[0]!.notificationId]);
  expect((await listNotifications(f.aUser.actor, {}))[0]!.readOn).toBeNull();
  await markRead(f.aUser.actor, [mine[0]!.notificationId]);
  expect((await listNotifications(f.aUser.actor, {}))[0]!.readOn).not.toBeNull();
  expect(fixtureCount).toBeGreaterThanOrEqual(0);
  // Напрямую в базу: клиент видит только свои строки.
  const others = await asActor(pools.app, f.aAdmin.actor, (c) => c.query(`select count(*)::int as n from hdn_notifications where user_id = $1`, [f.aUser.userId]));
  expect(others.rows[0].n).toBe(0);
});

test('счётчик непрочитанных и "Прочитать все"', async () => {
  const before = await unreadCount(f.aUser.actor);
  await notifyAUser();
  await notifyAUser('ticket_status');
  expect(await unreadCount(f.aUser.actor)).toBe(before + 2);
  await markRead(f.aUser.actor, 'all');
  expect(await unreadCount(f.aUser.actor)).toBe(0);
  // Чужие уведомления "Прочитать все" не трогает.
  await withActor(f.l1.actor, (tx) => notifyTx(tx, { userId: f.bUser.userId, kind: 'ticket_reply', ticketId: f.tickets.bOrg.ticketId, orgId: f.orgB.orgId, payload: { number: f.tickets.bOrg.number } }));
  const bBefore = await unreadCount(f.bUser.actor);
  await markRead(f.aUser.actor, 'all');
  expect(await unreadCount(f.bUser.actor)).toBe(bBefore);
});

test('клиент не ставит уведомление по чужому обращению', async () => {
  await expect(
    withActor(f.aUser.actor, (tx) => notifyTx(tx, { userId: f.bUser.userId, kind: 'ticket_reply', ticketId: f.tickets.bOrg.ticketId, orgId: f.orgB.orgId, payload: { number: 1 } })),
  ).rejects.toThrow();
  await expect(withActor(f.aUser.actor, (tx) => notifyTx(tx, { userId: f.bUser.userId, kind: 'holidays_reminder', payload: { year: 2027 } }))).rejects.toThrow();
});

test('настройки клиента и сотрудника: каждому свой вид, без привязки Telegram почту о своих обращениях не выключить', async () => {
  await expect(savePrefs(f.aUser.actor, { own: { email: false, telegram: true }, watched: { email: true, telegram: true } })).rejects.toThrow();
  await expect(savePrefs(f.aUser.actor, { watchedTickets: 'нет' })).rejects.toThrow();
  // Клиенту недоступны настройки сотрудника и наоборот.
  await expect(savePrefs(f.aUser.actor, { staffMention: false })).rejects.toThrow();
  await expect(savePrefs(f.l1.actor, { watchedTickets: false })).rejects.toThrow();
  await savePrefs(f.aUser.actor, WATCHED_OFF);
  expect(await readPrefs(f.aUser.actor)).toEqual(WATCHED_OFF);
  await savePrefs(f.l1.actor, { staffMention: false, staffBreach: true });
  expect(await readPrefs(f.l1.actor)).toEqual({ staffMention: false, staffBreach: true });
});

test('нет строки настройки: письмо разрешено', async () => {
  expect(await withActor(f.l1.actor, (tx) => emailAllowed(tx, f.aUser.userId, 'watched_tickets'))).toBe(true);
  await savePrefs(f.aUser.actor, WATCHED_OFF);
  expect(await withActor(f.l1.actor, (tx) => emailAllowed(tx, f.aUser.userId, 'watched_tickets'))).toBe(false);
  expect(await withActor({ type: 'system', job: 'test' }, (tx) => emailAllowed(tx, f.aUser.userId, 'watched_tickets'))).toBe(false);
  // Настройки клиента не видны другому клиенту напрямую в базе.
  const seen = await asActor(pools.app, f.aAdmin.actor, (c) => c.query(`select count(*)::int as n from hdn_notification_prefs where user_id = $1`, [f.aUser.userId]));
  expect(seen.rows[0].n).toBe(0);
});

test('ночная очистка удаляет прочитанные старше 90 дней', async () => {
  await notifyAUser();
  await notifyAUser('ticket_status');
  const [newer, older] = await listNotifications(f.aUser.actor, {});
  await markRead(f.aUser.actor, 'all');
  await pools.root.query(`update hdn_notifications set read_on = now() - interval '91 days' where notification_id = $1`, [older!.notificationId]);
  // Непрочитанное старое остаётся.
  await withActor(f.l1.actor, (tx) => notifyTx(tx, { userId: f.aUser.userId, kind: 'ticket_reply', ticketId: f.tickets.aOrg.ticketId, orgId: f.orgA.orgId, payload: { number: 7 } }));
  await pools.root.query(`update hdn_notifications set created_on = now() - interval '200 days' where read_on is null and user_id = $1`, [f.aUser.userId]);
  const removed = await cleanupNotifications({ type: 'system', job: 'maintenance.cleanup' }, new Date());
  expect(removed).toBeGreaterThanOrEqual(1);
  const left = (await listNotifications(f.aUser.actor, {})).map((n) => n.notificationId);
  expect(left).toContain(newer!.notificationId);
  expect(left).not.toContain(older!.notificationId);
  expect(await unreadCount(f.aUser.actor)).toBe(1);
});

test('листание уведомлений не теряет строки с одинаковым временем (M4, мелкое 10)', async () => {
  const root = await pools.root.connect();
  try {
    await root.query('begin');
    await root.query(`set local session_replication_role = replica`);
    // 120 уведомлений с одним и тем же временем: граница страницы проходит внутри них.
    await root.query(
      `insert into hdn_notifications (notification_id, user_id, kind, ticket_id, org_id, payload, created_on)
       select uuidv7(), $1, 'ticket_reply', $2, $3, jsonb_build_object('number', g), date_trunc('second', now()) from generate_series(1, 120) g`,
      [f.aUser.userId, f.tickets.aOrg.ticketId, f.orgA.orgId],
    );
    await root.query('commit');
  } finally {
    root.release();
  }
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const rows = await listNotifications(f.aUser.actor, before ? { before } : {});
    if (rows.length === 0) break;
    for (const row of rows) seen.add(row.notificationId);
    before = rows.at(-1)?.notificationId;
  }
  // Ни одна строка пользователя не потеряна и не показана дважды (у него могут быть и уведомления из заготовки).
  const total = (await pools.root.query(`select count(*)::int as n from hdn_notifications where user_id = $1`, [f.aUser.userId])).rows[0].n as number;
  expect(total).toBeGreaterThanOrEqual(120);
  expect(seen.size).toBe(total);
  // Прежняя ссылка с временем в адресе по-прежнему открывается.
  expect(Array.isArray(await listNotifications(f.aUser.actor, { before: new Date().toISOString() }))).toBe(true);
  await expect(listNotifications(f.aUser.actor, { before: 'не курсор' })).rejects.toThrow();
});
