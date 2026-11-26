import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { aiHandoff, postAiMessage } from '@/modules/hdt/api/ai';
import { createTicket, createTicketForClient, listQueue, queueCounts } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { deliver as deliverTo, inboundPerTest, type Letter } from './helpers/inbound';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Состояние помощника, передача сотруднику и сроки (план M5b, задача 3; FR-AI-09, 10, 14, 15, FR-SLA-04, 10, 11;
// решения 4, 5, 14, 15). Пункт 8 раздела "На что смотреть": ответ с решением останавливает срок первого ответа,
// передача начинает его заново, ожидание реакции на ответ помощника ставит срок решения на паузу.

const SYSTEM = { type: 'system', job: 'ai.first_line' } as const;
const SERVICE_ORG_ID = '00000000-0000-7000-8000-000000000001';
const ARTICLE = '01900000-0000-7000-8000-0000000000a1';
const box = inboundPerTest();
let f: Fixture;
let jobs: MemoryJobQueue;

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true'::jsonb)`);
});
afterEach(() => setJobQueueForTests(null));

const ticket = (ticketId: string) =>
  pools.root
    .query(
      `select status, queue, ai_state, ai_reply_count, ai_handoff_reason, ai_handoff_on, first_responded_on, first_response_due_on, resolution_due_on, sla_paused_on, created_on, priority
         from hdt_tickets where ticket_id = $1`,
      [ticketId],
    )
    .then((r) => r.rows[0]);
const idOf = (number: number) => pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number]).then((r) => r.rows[0].ticket_id as string);
const newQueue = async () => (await listQueue(staffCtx(f.l1), { queue: 'new' })).items.map((i) => i.number);

async function portalTicket(over: Record<string, unknown> = {}) {
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'При печати накладной выходит пустой лист', type: 'bug', impact: 'minor', locale: 'ru', ...over });
  return { number, ticketId: await idOf(number) };
}

test('обращение с портала: помощник включён, задания первой линии и сторожа поставлены, первые 90 секунд не в "Новых", потом в "Новых"', async () => {
  const { number, ticketId } = await portalTicket();
  expect(await ticket(ticketId)).toMatchObject({ ai_state: 'active', status: 'new' });
  expect(jobs.sent).toEqual(
    expect.arrayContaining([
      { name: 'ai.first_line', data: { ticketId }, opts: undefined },
      { name: 'ai.watchdog', data: { ticketId }, opts: { startAfterSeconds: 60 } },
    ]),
  );
  // Внутреннее событие истории о включении помощника.
  const events = (await pools.root.query(`select kind, is_internal, payload from hdt_ticket_events where ticket_id = $1 and kind = 'ai_state'`, [ticketId])).rows;
  expect(events).toEqual([{ kind: 'ai_state', is_internal: true, payload: { to: 'active' } }]);
  expect(await newQueue()).not.toContain(number);
  // Помощник молчит 91 секунду: обращение в "Новых" и в счётчике (решение 5, слой в).
  // Время создания ставит триггер: сдвиг в прошлое мимо него.
  await pools.root.query(`begin; set local session_replication_role = replica; update hdt_tickets set created_on = now() - interval '91 seconds' where ticket_id = '${ticketId}'; commit`);
  expect(await newQueue()).toContain(number);
  const counts = await queueCounts(staffCtx(f.l1));
  expect(counts.new).toBeGreaterThanOrEqual(1);
});

test('помощник не включается: AI-обработка организации выключена, помощник выключен администратором, обращение от сотрудника; такие сразу в "Новых"', async () => {
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  const off = await portalTicket();
  expect((await ticket(off.ticketId)).ai_state).toBe('none');
  expect(await newQueue()).toContain(off.number);
  expect(jobs.sent.filter((j) => j.name.startsWith('ai.'))).toEqual([]);

  await pools.root.query(`update hdu_organizations set is_ai_enabled = true where org_id = $1`, [f.orgA.orgId]);
  await pools.root.query(`update hdc_settings set value = 'false'::jsonb where code = 'ai.enabled'`);
  expect((await ticket((await portalTicket()).ticketId)).ai_state).toBe('none');

  await pools.root.query(`update hdc_settings set value = 'true'::jsonb where code = 'ai.enabled'`);
  const staff = await createTicketForClient(staffCtx(f.l1), { orgId: f.orgA.orgId, authorId: f.aUser.userId, description: 'Клиент позвонил: не открывается отчёт', type: 'question', impact: 'minor', visibility: 'org', locale: 'ru' });
  expect((await ticket(await idOf(staff.number))).ai_state).toBe('none');
  expect(await newQueue()).toContain(staff.number);
});

test('письмо: опознанный пользователь с DMARC получает помощника, неопознанное письмо и письмо без DMARC нет', async () => {
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true, "lastOrgId" = $2 where id = $1`, [f.aUser.userId, f.orgA.orgId]);
  const deliver = (letter: Letter) => deliverTo(box, letter);
  const state = async (inboundId: string) =>
    (await pools.root.query(`select t.ai_state, t.org_id from hdn_email_inbound i join hdt_tickets t on t.ticket_id = i.ticket_id where i.inbound_id = $1`, [inboundId])).rows[0];
  expect(await state((await deliver({ subject: 'Не печатается накладная', text: 'После обновления накладная не печатается' })).inboundId)).toMatchObject({ ai_state: 'active', org_id: f.orgA.orgId });
  expect(await state((await deliver({ subject: 'Вопрос', dmarc: 'fail' })).inboundId)).toMatchObject({ ai_state: 'none', org_id: SERVICE_ORG_ID });
  expect(await state((await deliver({ from: 'Bobur <bobur@unknown.uz>', subject: 'Хотим подключиться' })).inboundId)).toMatchObject({ ai_state: 'none' });
});

test('ответ решением (FR-SLA-04, FR-AI-10): "Ждём вашего ответа", срок первого ответа остановлен, срок решения на паузе; ответ сообщением с типом ai и ссылками', async () => {
  const { ticketId } = await portalTicket();
  await postAiMessage(SYSTEM, { ticketId, payload: { kind: 'answer', introId: 'likely_solution', articleId: ARTICLE, articleNumber: 1042, locale: 'ru' } });
  const t = await ticket(ticketId);
  expect(t).toMatchObject({ status: 'waiting_customer', ai_state: 'active', ai_reply_count: 1 });
  expect(t.first_responded_on).not.toBeNull();
  expect(t.sla_paused_on).not.toBeNull();
  const [message] = (await pools.root.query(`select author_type, author_id, is_internal, ai_payload from hdt_ticket_messages where ticket_id = $1`, [ticketId])).rows;
  expect(message).toMatchObject({ author_type: 'ai', author_id: null, is_internal: false, ai_payload: { kind: 'answer', articleId: ARTICLE } });
  // Помощник не меняет приоритет, исполнителя и организацию.
  expect(t.priority).toBe('p3');
  // Вопрос помощника срок первого ответа не останавливает.
  const other = await portalTicket();
  await postAiMessage(SYSTEM, { ticketId: other.ticketId, payload: { kind: 'clarify', introId: 'similar_case', options: [{ articleId: ARTICLE, articleNumber: 1042 }, { articleId: ARTICLE, articleNumber: 1043 }], locale: 'ru' } });
  expect(await ticket(other.ticketId)).toMatchObject({ status: 'waiting_customer', first_responded_on: null, ai_reply_count: 1 });
});

test('передача (решение 14) одной транзакцией: состояние, причина, линия, статус, сообщение со сроком, срок первого ответа от передачи, событие, журнал, история', async () => {
  const { ticketId } = await portalTicket();
  await postAiMessage(SYSTEM, { ticketId, payload: { kind: 'answer', introId: 'likely_solution', articleId: ARTICLE, articleNumber: 1042, locale: 'ru' } });
  const created = (await ticket(ticketId)).created_on as Date;
  // Передача через три часа после создания: срок первого ответа сотрудника считается от передачи.
  const now = new Date(created.getTime() + 3 * 3600_000);
  await aiHandoff(SYSTEM, { ticketId, reason: 'not_helped', questionIds: [], now });
  const t = await ticket(ticketId);
  expect(t).toMatchObject({ ai_state: 'handed_off', ai_handoff_reason: 'not_helped', queue: 'l1', status: 'in_progress', first_responded_on: null, sla_paused_on: null });
  expect(t.ai_handoff_on.getTime()).toBe(now.getTime());
  expect(t.first_response_due_on.getTime()).toBeGreaterThan(now.getTime());
  const messages = (await pools.root.query(`select ai_payload from hdt_ticket_messages where ticket_id = $1 order by created_on`, [ticketId])).rows;
  expect(messages.at(-1)!.ai_payload).toMatchObject({ kind: 'handoff', reason: 'not_helped', dueOn: t.first_response_due_on.toISOString() });
  expect((await pools.root.query(`select payload from hdc_domain_events where ticket_id = $1 and kind = 'ai_handoff'`, [ticketId])).rows).toEqual([{ payload: { reason: 'not_helped', priority: 'p3' } }]);
  expect((await pools.root.query(`select diff from hdc_audit_log where object_id = $1 and action = 'ticket.ai_handoff'`, [ticketId])).rows).toEqual([{ diff: { reason: 'not_helped' } }]);
  expect((await pools.root.query(`select is_internal, payload from hdt_ticket_events where ticket_id = $1 and kind = 'ai_handoff'`, [ticketId])).rows).toEqual([{ is_internal: true, payload: { reason: 'not_helped' } }]);
  // Повтор передачи ничего не меняет; после передачи помощник не пишет.
  await aiHandoff(SYSTEM, { ticketId, reason: 'ai_failure', questionIds: [], now: new Date() });
  expect((await ticket(ticketId)).ai_handoff_reason).toBe('not_helped');
  await expect(postAiMessage(SYSTEM, { ticketId, payload: { kind: 'answer', introId: 'likely_solution', articleId: ARTICLE, articleNumber: 1042, locale: 'ru' } })).rejects.toMatchObject({ code: 'transition_refused' });
  // Клиент события передачи не видит, сообщение передачи видит.
  const seen = await asActor(pools.app, f.aUser.actor, async (c) => ({
    events: (await c.query(`select kind from hdt_ticket_events where ticket_id = $1 and kind like 'ai_%'`, [ticketId])).rowCount,
    messages: (await c.query(`select 1 from hdt_ticket_messages where ticket_id = $1 and author_type = 'ai'`, [ticketId])).rowCount,
  }));
  expect(seen).toEqual({ events: 0, messages: 2 });
});

test('P1 в субботу 22:00 (FR-AI-07, UX-C-04): передача сразу, срок от понедельника 08:00, в сообщении начало рабочего времени', async () => {
  const { ticketId } = await portalTicket({ impact: 'blocker' });
  // Суббота 28.11.2026 22:00 по Ташкенту (UTC+5).
  const now = new Date('2026-11-28T17:00:00Z');
  await aiHandoff(SYSTEM, { ticketId, reason: 'p1', questionIds: ['version', 'steps'], now });
  const t = await ticket(ticketId);
  expect(t).toMatchObject({ ai_state: 'handed_off', ai_handoff_reason: 'p1', status: 'new' });
  const [message] = (await pools.root.query(`select ai_payload from hdt_ticket_messages where ticket_id = $1 and author_type = 'ai'`, [ticketId])).rows;
  // P1 по умолчанию круглосуточно: начала рабочего времени нет, срок через минуты политики P1.
  expect(message.ai_payload).toMatchObject({ kind: 'handoff', reason: 'p1', questionIds: ['version', 'steps'] });
  // Событие ticket_created записано: предустановленное правило "P1 дежурным" отправит сообщение дежурным.
  expect((await pools.root.query(`select count(*)::int as n from hdc_domain_events where ticket_id = $1 and kind = 'ticket_created'`, [ticketId])).rows[0].n).toBe(1);
});

test('P3 в субботу 22:00: в сообщении передачи начало рабочего времени понедельник 08:00 по Ташкенту', async () => {
  const { ticketId } = await portalTicket();
  await aiHandoff(SYSTEM, { ticketId, reason: 'customer_request', questionIds: [], now: new Date('2026-11-28T17:00:00Z') });
  const [message] = (await pools.root.query(`select ai_payload from hdt_ticket_messages where ticket_id = $1 and author_type = 'ai'`, [ticketId])).rows;
  expect(message.ai_payload.startOn).toBe('2026-11-30T03:00:00.000Z');
});

test('сбой AI, AI выключен, предел: шаблонное подтверждение без Теза (вид ack)', async () => {
  for (const reason of ['ai_failure', 'ai_disabled', 'ai_limit'] as const) {
    const { ticketId } = await portalTicket();
    await aiHandoff(SYSTEM, { ticketId, reason, questionIds: [], now: new Date() });
    const [message] = (await pools.root.query(`select ai_payload from hdt_ticket_messages where ticket_id = $1 and author_type = 'ai'`, [ticketId])).rows;
    expect(message.ai_payload).toMatchObject({ kind: 'ack', reason });
  }
});

test('вид Теза не подделать: сообщение ai пишет только система, без автора и не заметкой', async () => {
  const { ticketId } = await portalTicket();
  const payload = JSON.stringify({ kind: 'answer', introId: 'x', articleId: ARTICLE, articleNumber: 1, locale: 'ru' });
  await expect(
    asActor(pools.app, f.l1.actor, (c) => c.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, ai_payload) values ($1, $2, 'ai', 'Тез', $3)`, [f.orgA.orgId, ticketId, payload])),
  ).rejects.toThrow(/только система/);
  await expect(
    asActor(pools.app, f.aUser.actor, (c) =>
      c.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, ai_payload) values ($1, $2, $3, 'client', 'Тез · AI-ассистент: оплатите', $4)`, [f.orgA.orgId, ticketId, f.aUser.userId, payload]),
    ),
  ).rejects.toThrow();
  await expect(
    asActor(pools.app, SYSTEM, (c) => c.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_type, body) values ($1, $2, 'ai', 'Тез')`, [f.orgA.orgId, ticketId])),
  ).rejects.toThrow(/hdt_ticket_messages_c5/);
});

test('четвёртого ответа нет (FR-AI-09)', async () => {
  const { ticketId } = await portalTicket();
  await pools.root.query(`update hdt_tickets set ai_reply_count = 3 where ticket_id = $1`, [ticketId]);
  await expect(postAiMessage(SYSTEM, { ticketId, payload: { kind: 'answer', introId: 'likely_solution', articleId: ARTICLE, articleNumber: 1042, locale: 'ru' } })).rejects.toMatchObject({ code: 'transition_refused' });
});
