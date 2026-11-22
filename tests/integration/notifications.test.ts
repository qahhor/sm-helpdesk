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

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const notifyAUser = (kind: 'ticket_reply' | 'ticket_status' = 'ticket_reply') =>
  withActor(f.l1.actor, (tx) => notifyTx(tx, { userId: f.aUser.userId, kind, ticketId: f.tickets.aOrg.ticketId, payload: { number: f.tickets.aOrg.number, title: f.tickets.aOrg.title } }));

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
  await withActor(f.l1.actor, (tx) => notifyTx(tx, { userId: f.bUser.userId, kind: 'ticket_reply', ticketId: f.tickets.bOrg.ticketId, payload: { number: f.tickets.bOrg.number } }));
  const bBefore = await unreadCount(f.bUser.actor);
  await markRead(f.aUser.actor, 'all');
  expect(await unreadCount(f.bUser.actor)).toBe(bBefore);
});

test('клиент не ставит уведомление по чужому обращению', async () => {
  await expect(
    withActor(f.aUser.actor, (tx) => notifyTx(tx, { userId: f.bUser.userId, kind: 'ticket_reply', ticketId: f.tickets.bOrg.ticketId, payload: { number: 1 } })),
  ).rejects.toThrow();
  await expect(withActor(f.aUser.actor, (tx) => notifyTx(tx, { userId: f.bUser.userId, kind: 'holidays_reminder', payload: { year: 2027 } }))).rejects.toThrow();
});

test('письма о своих обращениях выключить нельзя: попытка отклоняется схемой', async () => {
  await expect(savePrefs(f.aUser.actor, { ownTickets: false, watchedTickets: true })).rejects.toThrow();
  await expect(savePrefs(f.aUser.actor, { watchedTickets: 'нет' })).rejects.toThrow();
  // Клиенту недоступны настройки сотрудника и наоборот.
  await expect(savePrefs(f.aUser.actor, { staffMention: false })).rejects.toThrow();
  await expect(savePrefs(f.l1.actor, { watchedTickets: false })).rejects.toThrow();
  await savePrefs(f.aUser.actor, { watchedTickets: false });
  expect(await readPrefs(f.aUser.actor)).toEqual({ watchedTickets: false });
  await savePrefs(f.l1.actor, { staffMention: false, staffBreach: true });
  expect(await readPrefs(f.l1.actor)).toEqual({ staffMention: false, staffBreach: true });
});

test('нет строки настройки: письмо разрешено', async () => {
  expect(await withActor(f.l1.actor, (tx) => emailAllowed(tx, f.aUser.userId, 'watched_tickets'))).toBe(true);
  await savePrefs(f.aUser.actor, { watchedTickets: false });
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
  await withActor(f.l1.actor, (tx) => notifyTx(tx, { userId: f.aUser.userId, kind: 'ticket_reply', ticketId: f.tickets.aOrg.ticketId, payload: { number: 7 } }));
  await pools.root.query(`update hdn_notifications set created_on = now() - interval '200 days' where read_on is null and user_id = $1`, [f.aUser.userId]);
  const removed = await cleanupNotifications({ type: 'system', job: 'maintenance.cleanup' }, new Date());
  expect(removed).toBeGreaterThanOrEqual(1);
  const left = (await listNotifications(f.aUser.actor, {})).map((n) => n.notificationId);
  expect(left).toContain(newer!.notificationId);
  expect(left).not.toContain(older!.notificationId);
  expect(await unreadCount(f.aUser.actor)).toBe(1);
});
