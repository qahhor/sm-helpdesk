import { afterEach, beforeEach, expect, test } from 'vitest';
import type { JobData, JobName, JobQueue } from '@/modules/hdc/jobs';
import { registerKnownProblemLinker } from '@/modules/hdc/api';
import { setJobQueueForTests } from '@/modules/hdc/testing';
import { createProblem, saveProblemTranslation, setProblemStatus, addProblemSignature } from '@/modules/hdp/api/problems';
import { bulkLinkProblem, knownProblemLinker, linkTicketToProblem, unlinkTicket } from '@/modules/hdp/api/links';
import { bindTicket, createTicket, createTicketForClient, createWidgetTicket } from '@/modules/hdt/api';
import { deleteRule, saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { drainAutomation } from './helpers/automation';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { deliver, inboundPerTest } from './helpers/inbound';
import { memoryMailerPerTest } from './helpers/mail';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Привязка обращений к известной проблеме (ТЗ FR-KP-04, 13, FR-AG-20, UX-A-10, FR-AUTO-03, 04; план M5c, задача 3,
// решения 8-12): вручную, массово, по сигнатуре в момент создания во всех каналах, правилом. Одно обращение, одна
// проблема; привязка не трогает сроков и статуса; каждая привязка с событием истории и журналом аудита.

const ERROR_TEXT = 'При проведении выходит:\nORA-20001: Накладная №4512 от 12.03.2026 не проведена';
let f: Fixture;
let l2: ReturnType<typeof staffCtx>;
const box = inboundPerTest();
memoryMailerPerTest();

/** Очередь задач, которая при постановке первой линии помощника запоминает, привязано ли уже обращение. */
class SpyQueue implements JobQueue {
  readonly sent: { name: JobName; data: JobData }[] = [];
  readonly linkedAtAssistant = new Map<string, string | null>();
  async send(name: JobName, data: JobData): Promise<void> {
    this.sent.push({ name, data });
    if (name === 'ai.first_line' && typeof data.ticketId === 'string')
      this.linkedAtAssistant.set(data.ticketId, (await pools.root.query(`select known_problem_id from hdt_tickets where ticket_id = $1`, [data.ticketId])).rows[0].known_problem_id);
  }
}
let jobs: SpyQueue;

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  jobs = new SpyQueue();
  setJobQueueForTests(jobs);
  await pools.root.query(`delete from hdc_rate_limits`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true') on conflict (code) do update set value = excluded.value`);
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true, "lastOrgId" = $2 where id = $1`, [f.aUser.userId, f.orgA.orgId]);
});
afterEach(() => {
  setJobQueueForTests(null);
  registerKnownProblemLinker(knownProblemLinker);
});

/** Сигнатура текста ошибки так, как её считает сервер: создаём обращение и читаем. */
async function signatureOfError(): Promise<string> {
  const { ticketId } = await createTicket(await clientCtx(f.bUser), { description: ERROR_TEXT, type: 'bug', impact: 'minor', locale: 'ru' });
  return (await pools.root.query(`select error_signature from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0].error_signature as string;
}

async function activeProblem(signature: string): Promise<{ number: number; problemId: string }> {
  const { number } = await createProblem(l2, { internalTitle: 'Накладные не проводятся' });
  await addProblemSignature(l2, { number, signature });
  return { number, problemId: (await pools.root.query(`select problem_id from hdp_problems where number = $1`, [number])).rows[0].problem_id };
}

const ticket = (ticketId: string) => pools.root.query(`select * from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const ticketByNumber = (number: number) => pools.root.query(`select * from hdt_tickets where number = $1`, [number]).then((r) => r.rows[0]);
const problem = (number: number) => pools.root.query(`select * from hdp_problems where number = $1`, [number]).then((r) => r.rows[0]);
const events = (ticketId: string) => pools.root.query(`select payload, is_internal, actor_type from hdt_ticket_events where ticket_id = $1 and kind = 'known_problem' order by event_id`, [ticketId]).then((r) => r.rows);

test('новое обращение с портала, из виджета, от сотрудника и письмом опознанного клиента привязывается по сигнатуре до помощника', async () => {
  const sig = await signatureOfError();
  const p = await activeProblem(sig);

  const portal = await createTicket(await clientCtx(f.aUser), { description: ERROR_TEXT, type: 'bug', impact: 'minor', locale: 'ru' });
  const widget = await createWidgetTicket(await clientCtx(f.aAdmin), { description: 'Не проводится', type: 'bug', impact: 'minor', visibility: 'org', locale: 'ru', context: { errorCode: 'ORA-20001', errorText: 'Накладная №77 от 01.01.2026 не проведена' } }, { platform: 'web' });
  const staff = await createTicketForClient(staffCtx(f.l1), { orgId: f.orgA.orgId, authorId: f.aUser.userId, description: ERROR_TEXT, type: 'bug', impact: 'minor', visibility: 'org', locale: 'ru' });
  const mailed = await deliver(box, { from: 'a-user@example.uz', subject: 'Ошибка', text: ERROR_TEXT });
  const emailTicket = (await pools.root.query(`select ticket_id from hdn_email_inbound where inbound_id = $1`, [mailed.inboundId])).rows[0].ticket_id as string;

  for (const ticketId of [portal.ticketId, widget.ticketId, (await ticketByNumber(staff.number)).ticket_id, emailTicket]) {
    expect((await ticket(ticketId)).known_problem_id, ticketId).toBe(p.problemId);
    expect(await events(ticketId)).toEqual([{ payload: { action: 'linked', problemNumber: p.number, via: 'signature' }, is_internal: true, actor_type: 'system' }]);
  }
  // Помощник получил задание уже после привязки (шаг 4 порядка 7.13 будет у него в задаче 7).
  expect(jobs.linkedAtAssistant.get(portal.ticketId)).toBe(p.problemId);
  expect(jobs.linkedAtAssistant.get(widget.ticketId)).toBe(p.problemId);
  expect((await problem(p.number))).toMatchObject({ ticket_count: 4, org_count: 1 });
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'ticket.problem_linked'`)).rows[0].n).toBe(4);
});

test('письмо "Неопознанных" не привязывается, после привязки к организации привязывается', async () => {
  const sig = await signatureOfError();
  const p = await activeProblem(sig);
  const mailed = await deliver(box, { from: 'Бобур <bobur@unknown.uz>', subject: 'Ошибка', text: ERROR_TEXT });
  const row = (await pools.root.query(`select t.ticket_id, t.number from hdn_email_inbound i join hdt_tickets t on t.ticket_id = i.ticket_id where i.inbound_id = $1`, [mailed.inboundId])).rows[0];
  expect((await ticket(row.ticket_id)).known_problem_id).toBeNull();
  await bindTicket(staffCtx(f.l1), { number: Number(row.number), orgId: f.orgA.orgId });
  expect((await ticket(row.ticket_id)).known_problem_id).toBe(p.problemId);
});

test('исправленная и закрытая проблема не притягивают обращение; связывание с другой проблемой отклоняется', async () => {
  const sig = await signatureOfError();
  const p = await activeProblem(sig);
  await setProblemStatus(l2, { number: p.number, status: 'fixed' });
  const after = await createTicket(await clientCtx(f.aUser), { description: ERROR_TEXT, type: 'bug', impact: 'minor', locale: 'ru' });
  expect((await ticket(after.ticketId)).known_problem_id).toBeNull();
  // Вручную к исправленной привязать можно; к другой, пока привязано, нельзя.
  await linkTicketToProblem(staffCtx(f.l1), { ticketNumber: Number((await ticket(after.ticketId)).number), problemNumber: p.number });
  const other = await createProblem(l2, { internalTitle: 'Другая' });
  await expect(linkTicketToProblem(l2, { ticketNumber: Number((await ticket(after.ticketId)).number), problemNumber: other.number })).rejects.toMatchObject({ code: 'already_linked' });
  // Повторная привязка к той же проблеме ничего не меняет.
  await linkTicketToProblem(l2, { ticketNumber: Number((await ticket(after.ticketId)).number), problemNumber: p.number });
  expect(await events(after.ticketId)).toHaveLength(1);
});

test('сбой привязчика не отменяет создание обращения и не пишет текста в журнал работы', async () => {
  const sig = await signatureOfError();
  await activeProblem(sig);
  registerKnownProblemLinker({
    async linkBySignature() {
      throw new Error(`секрет клиента ${ERROR_TEXT}`);
    },
    async linkAffected() {
      return null;
    },
  });
  const logged: string[] = [];
  const original = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  try {
    const created = await createTicket(await clientCtx(f.aUser), { description: ERROR_TEXT, type: 'bug', impact: 'minor', locale: 'ru' });
    expect((await ticket(created.ticketId)).known_problem_id).toBeNull();
    expect((await ticket(created.ticketId)).error_signature).toBe(sig);
  } finally {
    console.error = original;
    console.log = originalLog;
  }
  expect(logged.join('\n')).not.toContain('ORA-20001');
  expect(logged.join('\n')).not.toContain('секрет клиента');
});

test('привязка и отвязка вручную: событие истории, журнал аудита, пересчёт счётчиков; сроки и статус не меняются', async () => {
  const { number } = await createProblem(l2, { internalTitle: 'Отчёт' });
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set first_response_due_on = now() + interval '1 hour', resolution_due_on = now() + interval '8 hours' where ticket_id = $1`, [t.ticketId]);
  const before = await ticket(t.ticketId);
  await linkTicketToProblem(staffCtx(f.l1), { ticketNumber: t.number, problemNumber: number });
  await linkTicketToProblem(staffCtx(f.l1), { ticketNumber: f.tickets.bOrg.number, problemNumber: number });
  const linked = await ticket(t.ticketId);
  expect(linked).toMatchObject({ status: before.status, queue: before.queue, assignee_id: before.assignee_id, sla_paused_on: null });
  expect(linked.first_response_due_on).toEqual(before.first_response_due_on);
  expect(linked.resolution_due_on).toEqual(before.resolution_due_on);
  expect(await problem(number)).toMatchObject({ ticket_count: 2, org_count: 2 });
  expect((await problem(number)).last_seen_on).not.toBeNull();
  await unlinkTicket(staffCtx(f.l1), { ticketNumber: t.number });
  expect((await ticket(t.ticketId)).known_problem_id).toBeNull();
  expect(await problem(number)).toMatchObject({ ticket_count: 1, org_count: 1 });
  expect((await events(t.ticketId)).map((e) => e.payload)).toEqual([
    { action: 'linked', problemNumber: number, via: 'manual' },
    { action: 'unlinked', problemNumber: number, via: 'manual' },
  ]);
  expect((await pools.root.query(`select action, diff from hdc_audit_log where object_id = $1 and action like 'ticket.problem_%' order by created_on, audit_id`, [t.ticketId])).rows).toEqual([
    { action: 'ticket.problem_linked', diff: { problemNumber: number, via: 'manual' } },
    { action: 'ticket.problem_unlinked', diff: { problemNumber: number } },
  ]);
  // product только читает; закрытое обращение не привязывается.
  const product = staffCtx(await staffWithRole('product'));
  await expect(linkTicketToProblem(product, { ticketNumber: t.number, problemNumber: number })).rejects.toMatchObject({ code: 'forbidden' });
  await pools.root.query(`update hdt_tickets set status = 'closed', closed_on = now() where ticket_id = $1`, [t.ticketId]);
  await expect(linkTicketToProblem(l2, { ticketNumber: t.number, problemNumber: number })).rejects.toMatchObject({ code: 'ticket_closed' });
});

test('массовая привязка: 101 обращение отклоняется целиком, до 100 итог по каждому', async () => {
  const { number } = await createProblem(l2, { internalTitle: 'Массовая' });
  const many = Array.from({ length: 101 }, (_, i) => i + 1);
  await expect(bulkLinkProblem(staffCtx(f.l1), { numbers: many, problemNumber: number })).rejects.toMatchObject({ code: 'too_many' });
  // Предел проверяет схема входа до удаления повторов: 101 одинаковый номер тоже отказ, ничего не привязано.
  await expect(bulkLinkProblem(staffCtx(f.l1), { numbers: Array.from({ length: 101 }, () => f.tickets.aOrg.number), problemNumber: number })).rejects.toMatchObject({ code: 'too_many' });
  expect((await ticket(f.tickets.aOrg.ticketId)).known_problem_id).toBeNull();
  const other = await createProblem(l2, { internalTitle: 'Другая' });
  await linkTicketToProblem(l2, { ticketNumber: f.tickets.bOrg.number, problemNumber: other.number });
  const result = await bulkLinkProblem(staffCtx(f.l1), { numbers: [f.tickets.aOrg.number, f.tickets.aMine.number, f.tickets.bOrg.number, 999_999], problemNumber: number });
  expect(result).toEqual({
    done: [f.tickets.aOrg.number, f.tickets.aMine.number],
    refused: [
      { number: f.tickets.bOrg.number, code: 'already_linked' },
      { number: 999_999, code: 'not_found' },
    ],
  });
  expect(await problem(number)).toMatchObject({ ticket_count: 2 });
});

test('правило "сигнатура есть и проблема не привязана: привязать к KP-n" выполняется общей функцией привязки', async () => {
  const sig = await signatureOfError();
  const { number } = await createProblem(l2, { internalTitle: 'Для правила' });
  const admin = staffCtx(f.adminStaff);
  // Ссылка на несуществующую проблему не сохраняется.
  await expect(
    saveRule(admin, { name: 'Нет проблемы', event: 'ticket_created', conditions: { match: 'all', items: [] }, actions: [{ action: 'link_known_problem', problemNumber: 999_999 }], isStop: false }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  const { ruleId } = await saveRule(admin, {
    name: 'Ошибка в обращении',
    event: 'ticket_created',
    conditions: {
      match: 'all',
      items: [
        { field: 'signature', op: 'is', value: 'present' },
        { field: 'known_problem', op: 'is', value: 'unlinked' },
      ],
    },
    actions: [{ action: 'link_known_problem', problemNumber: number }],
    isStop: false,
  });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const withError = await createTicket(await clientCtx(f.aUser), { description: ERROR_TEXT, type: 'bug', impact: 'minor', locale: 'ru' });
  const plain = await createTicket(await clientCtx(f.aUser), { description: 'Просто вопрос о складе', type: 'question', impact: 'minor', locale: 'ru' });
  await drainAutomation();
  const problemId = (await problem(number)).problem_id;
  expect((await ticket(withError.ticketId)).error_signature).toBe(sig);
  expect((await ticket(withError.ticketId)).known_problem_id).toBe(problemId);
  expect((await ticket(plain.ticketId)).known_problem_id).toBeNull();
  expect((await events(withError.ticketId)).map((e) => e.payload.via)).toEqual(['rule']);
  // Срабатывание в журнале срабатываний и журнале аудита (FR-AUTO-09).
  expect((await pools.root.query(`select result, actions_done from hdw_rule_runs where rule_id = $1 and ticket_id = $2`, [ruleId, withError.ticketId])).rows).toEqual([
    { result: 'applied', actions_done: [{ action: 'link_known_problem', ok: true, to: `KP-${number}` }] },
  ]);
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'rule.applied' and object_id = $1`, [withError.ticketId])).rowCount).toBe(1);
  // Закрытая проблема: правило не привязывает, отказ с кодом.
  await saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'X', publicBody: 'Y' }).catch(() => undefined);
  await pools.root.query(`update hdp_problems set status = 'fixed' where number = $1`, [number]);
  const later = await createTicket(await clientCtx(f.aUser), { description: 'Без ошибки, но с проблемой', type: 'bug', impact: 'minor', locale: 'ru' });
  await pools.root.query(`update hdt_tickets set error_signature = $2 where ticket_id = $1`, [later.ticketId, sig]);
  await drainAutomation();
  expect((await ticket(later.ticketId)).known_problem_id).toBeNull();
  await deleteRule(admin, { ruleId });
});
