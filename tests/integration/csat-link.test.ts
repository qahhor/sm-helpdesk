import { beforeEach, expect, test } from 'vitest';
import { setReplyConfigForTests } from '@/modules/hdn/inbound/reply-address';
import { getTicket, rateByLink, ticketsMinute } from '@/modules/hdt/api';
import { csatToken } from '@/modules/hdt/csat-link';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { inboundPerTest, REPLY } from './helpers/inbound';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Оценка одним нажатием из письма (FR-TK-11, UX-C-07; план W3, задача 1). Письмо о закрытии несёт автору ссылки
// с оценками. Ссылка без входа ставит оценку только этому обращению, только раз и только за автора.

const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
const box = inboundPerTest();
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
  setReplyConfigForTests(REPLY);
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true where id = $1`, [f.aUser.userId]);
});

const close = (ticketId: string) => pools.root.query(`update hdt_tickets set status = 'closed', closed_on = now(), resolved_on = now() where ticket_id = $1`, [ticketId]);
const row = (ticketId: string) => pools.root.query(`select csat_score, csat_reason, csat_comment from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const token = (number: number, userId: string) => csatToken(number, userId, REPLY.secret);

test('автозакрытие: письмо автору несёт ссылку оценки, письмо коллеге нет', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`, [f.orgA.orgId, t.ticketId, f.aAdmin.userId]);
  await pools.root.query(`update auth."user" set email = 'a-admin@example.uz', "emailVerified" = true where id = $1`, [f.aAdmin.userId]);
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now() - interval '30 days', resolution_type = 'solved' where ticket_id = $1`, [t.ticketId]);
  expect((await ticketsMinute(SYSTEM, new Date())).closed).toBeGreaterThanOrEqual(1);
  const mails = (await pools.root.query(`select recipient_user_id, payload from hdn_outbox where ticket_id = $1 and channel = 'email' and template = 'ticket_status'`, [t.ticketId])).rows;
  const own = mails.find((m) => m.recipient_user_id === f.aUser.userId);
  expect(own?.payload.rateUrl).toBe(`/rate?t=${token(t.number, f.aUser.userId)}`);
  for (const other of mails.filter((m) => m.recipient_user_id !== f.aUser.userId)) expect(other.payload.rateUrl).toBeUndefined();
  expect(mails.length).toBeGreaterThanOrEqual(2);
});

test('оценка по ссылке: ставится один раз, событие и запись в журнале, второй раз отказ', async () => {
  const t = f.tickets.aMine;
  await close(t.ticketId);
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 5 }, { ip: '203.0.113.9' })).toEqual({ ok: true, number: t.number });
  expect(await row(t.ticketId)).toEqual({ csat_score: 5, csat_reason: null, csat_comment: null });
  expect((await pools.root.query(`select actor_type, actor_id, payload from hdt_ticket_events where ticket_id = $1 and kind = 'rated'`, [t.ticketId])).rows).toEqual([
    { actor_type: 'client', actor_id: f.aUser.userId, payload: { score: 5 } },
  ]);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'ticket.rated_by_link' and object_id = $1`, [t.ticketId])).rows[0].n).toBe(1);
  expect((await getTicket(await clientCtx(f.aUser), t.number))?.csat?.score).toBe(5);
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 1, reason: 'slow' }, { ip: null })).toEqual({ ok: false, code: 'already_rated' });
  expect((await row(t.ticketId)).csat_score).toBe(5);
});

test('оценка 1-3 требует причину из списка; комментарий сохраняется', async () => {
  const t = f.tickets.aMine;
  await close(t.ticketId);
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 2 }, { ip: null })).toEqual({ ok: false, code: 'reason_required' });
  expect((await row(t.ticketId)).csat_score).toBeNull();
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 2, reason: 'not_solved', comment: 'Ошибка осталась' }, { ip: null })).toEqual({ ok: true, number: t.number });
  expect(await row(t.ticketId)).toEqual({ csat_score: 2, csat_reason: 'not_solved', csat_comment: 'Ошибка осталась' });
});

test('негодная ссылка, чужой пользователь, открытое обращение, отключённый участник: оценки нет', async () => {
  const t = f.tickets.aMine;
  // Обращение ещё не закрыто.
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'not_closed' });
  await close(t.ticketId);
  // Подпись другим ключом, испорченная ссылка, оценка вне 1-5.
  expect(await rateByLink({ token: csatToken(t.number, f.aUser.userId, 'another-secret-of-at-least-32-chars!'), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  expect(await rateByLink({ token: 'мусор', score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 9 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  // Верная подпись, но не автор: коллега и пользователь другой организации оценку не ставят.
  expect(await rateByLink({ token: token(t.number, f.aAdmin.userId), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  expect(await rateByLink({ token: token(t.number, f.bUser.userId), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  // Несуществующее обращение отвечает так же, как негодная ссылка.
  expect(await rateByLink({ token: token(999_999, f.aUser.userId), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  // Автора отключили в организации: ссылка больше не действует.
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aUser.userId]);
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  expect((await row(t.ticketId)).csat_score).toBeNull();
});

test('перебор по ссылке ограничен: 11-я попытка за час получает отказ по частоте', async () => {
  const t = f.tickets.aMine;
  for (let i = 0; i < 10; i++) expect((await rateByLink({ token: token(t.number, f.aUser.userId), score: 5 }, { ip: null })).ok).toBe(false);
  await close(t.ticketId);
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 5 }, { ip: null })).toEqual({ ok: false, code: 'rate_limited' });
});

// --- Итоговая проверка волны 3 ---

test('пересланное письмо о закрытии: ссылка оценки в текст обращения и заметки не попадает', async () => {
  const { deliver } = await import('./helpers/inbound');
  const t = f.tickets.aMine;
  const link = `https://hub.example.test/ru/rate?t=${token(t.number, f.aUser.userId)}`;
  const text = `Мне не помогли!\n\n---------- Пересланное письмо ----------\nОцените, как мы помогли:\n1: ${link}&score=1\n5: ${link}&score=5`;
  const { inboundId, result } = await deliver(box, { from: 'forwarder@unknown.uz', subject: 'Жалоба', text });
  expect(result).toBe('new');
  const body = (await pools.root.query(`select t.description from hdt_tickets t join hdn_email_inbound i on i.ticket_id = t.ticket_id where i.inbound_id = $1`, [inboundId])).rows[0].description as string;
  expect(body).toContain('Мне не помогли');
  expect(body).not.toContain(token(t.number, f.aUser.userId));
  expect(body).not.toMatch(/rate\?t=\d+\.[0-9a-f]{32}/);
});

test('комментарий из одних пробелов считается пустым, оценка ставится', async () => {
  const t = f.tickets.aMine;
  await close(t.ticketId);
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 2, reason: 'slow', comment: '  \r\n ' }, { ip: null })).toEqual({ ok: true, number: t.number });
  expect(await row(t.ticketId)).toEqual({ csat_score: 2, csat_reason: 'slow', csat_comment: null });
});

test('запросы с негодной подписью предел обращения не расходуют: настоящая ссылка после них работает', async () => {
  const t = f.tickets.aMine;
  await close(t.ticketId);
  const bad = csatToken(t.number, f.aUser.userId, 'another-secret-of-at-least-32-chars!');
  for (let i = 0; i < 11; i++) expect(await rateByLink({ token: bad, score: 5 }, { ip: null })).toEqual({ ok: false, code: 'link_invalid' });
  expect(await rateByLink({ token: token(t.number, f.aUser.userId), score: 5 }, { ip: null })).toEqual({ ok: true, number: t.number });
});

test('обращение уже оценено: письмо о повторном закрытии ссылок оценки не несёт', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now() - interval '30 days', resolution_type = 'solved', csat_score = 4 where ticket_id = $1`, [t.ticketId]);
  expect((await ticketsMinute(SYSTEM, new Date())).closed).toBeGreaterThanOrEqual(1);
  const mails = (await pools.root.query(`select payload from hdn_outbox where ticket_id = $1 and channel = 'email' and template = 'ticket_status' and recipient_user_id = $2`, [t.ticketId, f.aUser.userId])).rows;
  expect(mails).toHaveLength(1);
  expect(mails[0].payload.rateUrl).toBeUndefined();
});
