import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { dispatchAgentEvents, handleAgentEvent, runSpikeDetection, setAgentEventsForTests } from '@/modules/hda/api/agent-jobs';
import { StubAgentEventSender } from '@/modules/hda/testing';
import { processEvents } from '@/modules/hdc/api';
import { transferToL2 } from '@/modules/hdt/api/lines';
import { rootWithoutTriggers, seedAgentToken } from './helpers/agent';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// События для AI-сотрудника (веха M8b, задача 9; FR-AGT-08, 10, 12; план M8b, решения 26, 27). Разбор событий
// предметной области ставит строку очереди hda_agent_events в точке сохранения: сбой приёмника и обработчика не
// откатывает событие. Отправка подписывает тело тем же форматом, что вебхуки M8. Без AGENT_WEBHOOK_URL ничего не ставится.

const SYSTEM = { type: 'system', job: 'test.agent-events' } as const;
const SECRET = 'agent-secret-'.repeat(4);
let f: Fixture;
let sender: StubAgentEventSender;

beforeEach(async () => {
  setLogSinkForTests(() => undefined);
  f = await seedTwoOrgs();
  sender = new StubAgentEventSender();
  setAgentEventsForTests({ url: 'https://hermes.example/events', secret: SECRET, sender });
});
afterEach(() => {
  setAgentEventsForTests(null);
  setLogSinkForTests(null);
});

const drain = () => processEvents(SYSTEM, (tx, event) => handleAgentEvent(tx, event));
const queue = async () => (await pools.root.query(`select kind, ticket_id, body, status, attempts, run_token_id from hda_agent_events order by created_on`)).rows;
const domainEvent = (ticketId: string, orgId: string, kind: string, payload: Record<string, unknown>) =>
  pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind, payload) values ($1, $2, $3, $4)`, [orgId, ticketId, kind, JSON.stringify(payload)]);

test('передача от помощника, передача на вторую линию, нарушение SLA и всплеск ставят по одному событию без текста', async () => {
  const t = f.tickets.aOrg;
  await domainEvent(t.ticketId, f.orgA.orgId, 'ai_handoff', { reason: 'not_helped', priority: 'p2' });
  await domainEvent(t.ticketId, f.orgA.orgId, 'sla_breached', { deadline: 'first_response' });
  await transferToL2(staffCtx(f.l1), { number: t.number, reason: 'suspected_bug', checked: 'Проверено', needed: 'Нужно', checklist: [] });
  expect((await pools.root.query(`select kind from hdc_domain_events where kind = 'line_transferred'`)).rowCount).toBe(1);
  await drain();
  const server = (await pools.root.query(`select server_id from hdu_servers limit 1`)).rows[0].server_id;
  const orgC = (await pools.root.query(`insert into hdu_organizations (server_id, external_company_id, name) values ($1, '503', 'Initech') returning org_id`, [server])).rows[0].org_id;
  for (const org of [f.orgA.orgId, f.orgB.orgId, orgC])
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, error_signature) values ($1, $2, 'bug', 'major', 'p3', 'org', 'Ошибка', 'E-17', 'ru', 'portal', repeat('f', 32))`,
      [org, f.aUser.userId],
    );
  // Конец окна на секунду позже вставок: created_on в микросекундах, а Date в миллисекундах. Вставка и new Date() в одной
  // миллисекунде давали created_on позже конца окна, и последнее обращение выпадало из подсчёта.
  expect(await runSpikeDetection(SYSTEM, new Date(Date.now() + 1000))).toEqual({ detected: 1 });
  const rows = await queue();
  expect(rows.map((r) => r.kind).sort()).toEqual(['ai_handoff', 'line_transferred', 'signature_spike', 'sla_breached']);
  expect(rows.every((r) => r.status === 'queued')).toBe(true);
  const handoff = rows.find((r) => r.kind === 'ai_handoff')!;
  expect(handoff.body).toMatchObject({ kind: 'ai_handoff', reason: 'not_helped', ticket: { number: t.number, org: { id: f.orgA.orgId } } });
  expect(rows.find((r) => r.kind === 'line_transferred')!.body).toMatchObject({ reason: 'suspected_bug' });
  const text = JSON.stringify(rows);
  for (const secret of [t.title, 'ACME', 'Globex', 'Initech', 'Алишер', 'Проверено']) expect(text, secret).not.toContain(secret);
});

test('обращение организации с выключенной AI-обработкой события не даёт; без AGENT_WEBHOOK_URL не ставится ничего и разбор не падает', async () => {
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  await domainEvent(f.tickets.bOrg.ticketId, f.orgB.orgId, 'ai_handoff', { reason: 'not_helped' });
  expect(await drain()).toMatchObject({ failed: 0 });
  expect(await queue()).toEqual([]);
  setAgentEventsForTests(null);
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'ai_handoff', { reason: 'not_helped' });
  expect(await drain()).toMatchObject({ failed: 0 });
  expect(await queue()).toEqual([]);
  expect((await pools.root.query(`select count(*)::int as n from hdc_domain_events where processed_on is null`)).rows[0].n).toBe(0);
});

test('сбой приёмника не откатывает событие предметной области; пять неудачных попыток дают failed, удачная sent', async () => {
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'sla_breached', { deadline: 'resolution' });
  await drain();
  expect((await pools.root.query(`select processed_on from hdc_domain_events`)).rows[0].processed_on).not.toBeNull();
  sender.fail = true;
  for (let i = 0; i < 5; i += 1) {
    await rootWithoutTriggers(`update hda_agent_events set next_attempt_on = now() - interval '1 second'`);
    await dispatchAgentEvents(SYSTEM);
  }
  expect(await queue()).toEqual([expect.objectContaining({ status: 'failed', attempts: 5 })]);
  sender.fail = false;
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'sla_breached', { deadline: 'first_response' });
  await drain();
  expect(await dispatchAgentEvents(SYSTEM)).toMatchObject({ sent: 1 });
  expect((await queue()).map((r) => r.status)).toEqual(['failed', 'sent']);
  // Подпись тем же форматом, что вебхуки M8.
  const last = sender.sent.at(-1)!;
  expect(last.headers['X-Hub-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  expect(JSON.parse(last.body)).toMatchObject({ kind: 'sla_breached', deadline: 'first_response' });
});

test('передача несёт токен запуска, если отмечен токен "для событий"; в строке очереди значения нет; повтор отзывает прежний', async () => {
  const parent = await seedAgentToken({ isEventParent: true });
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'ai_handoff', { reason: 'not_helped' });
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'sla_breached', { deadline: 'resolution' });
  await drain();
  await dispatchAgentEvents(SYSTEM);
  const handoff = sender.sent.map((s) => JSON.parse(s.body)).find((b) => b.kind === 'ai_handoff');
  const breach = sender.sent.map((s) => JSON.parse(s.body)).find((b) => b.kind === 'sla_breached');
  expect(handoff.run_token).toMatchObject({ value: expect.stringMatching(/^hub_at_/), tools: ['get_ticket', 'add_internal_note'], expires_on: expect.any(String) });
  expect(breach.run_token).toBeUndefined();
  const value = handoff.run_token.value as string;
  const stored = JSON.stringify([(await pools.root.query(`select * from hda_agent_events`)).rows, (await pools.root.query(`select * from hda_agent_tokens`)).rows]);
  expect(stored).not.toContain(value);
  const [row] = (await pools.root.query(`select run_token_id from hda_agent_events where kind = 'ai_handoff'`)).rows;
  const token = (await pools.root.query(`select parent_token_id, ticket_id, revoked_at from hda_agent_tokens where token_id = $1`, [row.run_token_id])).rows[0];
  expect(token).toMatchObject({ parent_token_id: parent.tokenId, ticket_id: f.tickets.aOrg.ticketId, revoked_at: null });
  // Запись журнала о выпуске называет событие и учётную запись AI-сотрудника (независимая проверка M9, M7).
  const [event] = (await pools.root.query(`select event_id from hda_agent_events where kind = 'ai_handoff'`)).rows;
  const [issued] = (await pools.root.query(`select diff from hdc_audit_log where action = 'agent.run_token_issued' and object_id = $1`, [row.run_token_id])).rows;
  expect(issued.diff).toMatchObject({ parentId: parent.tokenId, eventId: event.event_id, staffUserId: parent.userId });
  // Новое событие по тому же обращению выпускает новый токен и отзывает прежний.
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'ai_handoff', { reason: 'customer_request' });
  await drain();
  await dispatchAgentEvents(SYSTEM);
  expect((await pools.root.query(`select revoked_at from hda_agent_tokens where token_id = $1`, [row.run_token_id])).rows[0].revoked_at).not.toBeNull();
});

test('неудачная отправка с токеном запуска отзывает выпущенный токен; клиент не читает очередь событий', async () => {
  await seedAgentToken({ isEventParent: true });
  await domainEvent(f.tickets.aOrg.ticketId, f.orgA.orgId, 'ai_handoff', { reason: 'not_helped' });
  await drain();
  sender.fail = true;
  await dispatchAgentEvents(SYSTEM);
  const runs = (await pools.root.query(`select revoked_at from hda_agent_tokens where parent_token_id is not null`)).rows;
  expect(runs).toHaveLength(1);
  expect(runs[0].revoked_at).not.toBeNull();
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hda_agent_events`))).rowCount).toBe(0);
});
