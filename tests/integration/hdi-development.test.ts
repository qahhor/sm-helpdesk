import { afterEach, beforeEach, expect, test } from 'vitest';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { releaseIdea, sendIdeaToDevelopment } from '@/modules/hdi/api/development';
import { staffIdeaCard } from '@/modules/hdi/api/staff';
import { takeTicket } from '@/modules/hdt/api';
import { setDevTrackerForTests } from '@/modules/hdw/dev-tracker';
import { createMemoryDevTracker } from '@/modules/hdw/dev-tracker/memory';
import { readDevTaskForTicket, sendToDevelopment, setDevTaskStatus } from '@/modules/hdw/api/dev-tasks';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { addIdea, type IdeaRef } from './isolation/ideas-fixture';

// Выбранная идея в разработке и выпуск (ТЗ FR-IDEA-12, FR-DEV-06; план M7, задача 9, решение 18). Тот же адаптер hdw,
// что у обращений: ручной режим (номер, ссылка, название) или API таск-менеджера. Закрытие задачи статус идеи не
// меняет, а уведомляет product; "Выпущена" ставит сотрудник с версией и датой, письмо проголосовавшим уходит всегда.

let f: Fixture;
let product: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  setJobQueueForTests(new MemoryJobQueue());
  setAiClientForTests(new StubAiClient());
  f = await seedTwoOrgs();
  product = staffCtx(await staffWithRole('product'));
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
  setDevTrackerForTests(null);
});

const task = (ref = 'DEV-700') => ({ externalId: ref, url: `https://tracker.smartup.example/tasks/${ref}`, title: 'Печать накладных пачкой' });
const ideaRow = (ref: IdeaRef) => pools.root.query(`select status, released_in, released_on::text from hdi_ideas where idea_id = $1`, [ref.ideaId]).then((r) => r.rows[0]);
const links = () => pools.root.query(`select org_id, ticket_id, idea_id, dev_task_id from hdw_dev_task_links order by created_on, link_id`).then((r) => r.rows);
const vote = (ref: IdeaRef, orgId: string, userId: string) => pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, ref.ideaId, userId]);

async function selectedIdea(): Promise<IdeaRef> {
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted', { title: 'Печать накладных пачкой' });
  await vote(idea, f.orgA.orgId, f.aUser.userId);
  await pools.root.query(`update hdi_ideas set status = 'selected', selected_cycle = '2026-12-01' where idea_id = $1`, [idea.ideaId]);
  return idea;
}

test('решение 18: product передаёт выбранную идею в разработку вручную: задача, привязка без организации, "В разработке", журнал, уведомления', async () => {
  const idea = await selectedIdea();
  const result = await sendIdeaToDevelopment(product, { number: idea.number, ...task() });
  expect(result.created).toBe(true);
  expect(await ideaRow(idea)).toMatchObject({ status: 'in_development' });
  expect(await links()).toEqual([{ org_id: null, ticket_id: null, idea_id: idea.ideaId, dev_task_id: result.devTaskId }]);
  const audit = await pools.root.query(`select action, actor_id, object_type, diff from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [idea.ideaId]);
  expect(audit.rows).toMatchObject([
    { action: 'devtask.linked', actor_id: product.actor.userId, object_type: 'idea', diff: { devTaskId: result.devTaskId, tracker: 'manual', ref: 'DEV-700', created: true } },
    { action: 'idea.status_changed', actor_id: product.actor.userId, diff: { from: 'selected', to: 'in_development' } },
  ]);
  const notified = await pools.root.query(`select user_id from hdn_notifications where idea_id = $1 and payload ->> 'status' = 'in_development'`, [idea.ideaId]);
  expect(notified.rows.map((r) => r.user_id).sort()).toEqual([f.aUser.userId, f.bUser.userId].sort());
  const card = await staffIdeaCard(staffCtx(f.l1), { number: idea.number });
  expect(card?.devTask).toMatchObject({ externalId: 'DEV-700', url: 'https://tracker.smartup.example/tasks/DEV-700', status: 'todo' });
});

test('решение 18: идея не в "Выбрана", вторая передача, чужие роли и неверная ссылка отклоняются, ничего не меняя', async () => {
  const open = await addIdea(f.orgB.orgId, f.bUser, 'open');
  await expect(sendIdeaToDevelopment(product, { number: open.number, ...task() })).rejects.toMatchObject({ code: 'bad_transition' });
  const idea = await selectedIdea();
  for (const role of ['agent_l1', 'agent_l2', 'care'] as const)
    await expect(sendIdeaToDevelopment(staffCtx(await staffWithRole(role)), { number: idea.number, ...task() })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(sendIdeaToDevelopment(product, { number: idea.number, ...task(), url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'invalid_url' });
  expect(await links()).toEqual([]);
  expect((await pools.root.query(`select count(*)::int as n from hdw_dev_tasks`)).rows[0].n).toBe(0);
  await sendIdeaToDevelopment(staffCtx(await staffWithRole('admin')), { number: idea.number, ...task() });
  await expect(sendIdeaToDevelopment(product, { number: idea.number, ...task('DEV-701') })).rejects.toMatchObject({ code: 'bad_transition' });
  expect(await links()).toHaveLength(1);
});

test('FR-DEV-06: к одной задаче привязаны обращение и идея; закрытие напоминает исполнителю обращения и уведомляет product, статус идеи не меняется', async () => {
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  await takeTicket(l2, f.tickets.aOrg.number);
  await sendToDevelopment(l2, { ticketNumber: f.tickets.aOrg.number, ...task() });
  const idea = await selectedIdea();
  const { devTaskId, created } = await sendIdeaToDevelopment(product, { number: idea.number, ...task() });
  expect(created).toBe(false);
  expect((await links()).map((l) => [l.org_id, l.ticket_id, l.idea_id])).toEqual([
    [f.orgA.orgId, f.tickets.aOrg.ticketId, null],
    [null, null, idea.ideaId],
  ]);
  // Привязка обращения читается как прежде: другие "обращения той же задачи" без строки идеи.
  expect(await readDevTaskForTicket(l2, f.tickets.aOrg.number)).toMatchObject({ task: { devTaskId }, otherTickets: [] });

  await setDevTaskStatus(l2, { devTaskId, status: 'done', version: '5.12' });
  expect((await ideaRow(idea)).status).toBe('in_development');
  const bell = await pools.root.query(`select user_id, kind, payload from hdn_notifications where kind = 'idea_dev_task_closed'`);
  expect(bell.rows).toEqual([{ user_id: product.actor.userId, kind: 'idea_dev_task_closed', payload: { idea: idea.number, ref: 'DEV-700' } }]);
  const mail = await pools.root.query(`select recipient_user_id, payload from hdn_outbox where template = 'staff_idea_dev_task_closed'`);
  expect(mail.rows).toEqual([
    { recipient_user_id: product.actor.userId, payload: { template: 'staff_idea_dev_task_closed', ref: 'DEV-700', number: idea.number, title: 'Печать накладных пачкой', url: `/agent/ideas/${idea.number}` } },
  ]);
  expect((await pools.root.query(`select count(*)::int as n from hdn_notifications where kind = 'dev_task_closed' and ticket_id = $1`, [f.tickets.aOrg.ticketId])).rows[0].n).toBe(1);
  // Карточка идеи предлагает версию задачи.
  expect((await staffIdeaCard(product, { number: idea.number }))?.devTask).toMatchObject({ status: 'done', version: '5.12' });
});

test('решение 18: "Выпущена" с версией и датой из "В разработке"; письмо проголосовавшим уходит всегда, даже после письма сегодня', async () => {
  const idea = await selectedIdea();
  await sendIdeaToDevelopment(product, { number: idea.number, ...task() });
  await expect(releaseIdea(product, { number: idea.number, version: '', releasedOn: '2026-12-20' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(releaseIdea(product, { number: idea.number, version: '5.12', releasedOn: '20.12.2026' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(releaseIdea(staffCtx(f.l1), { number: idea.number, version: '5.12', releasedOn: '2026-12-20' })).rejects.toMatchObject({ code: 'forbidden' });
  await releaseIdea(product, { number: idea.number, version: '5.12', releasedOn: '2026-12-20' });
  expect(await ideaRow(idea)).toEqual({ status: 'released', released_in: '5.12', released_on: '2026-12-20' });
  const mails = await pools.root.query(`select recipient_user_id, payload ->> 'event' as event from hdn_outbox where payload ->> 'ideaId' = $1 order by created_on`, [idea.ideaId]);
  // Утром "В разработке", следом "Выпущена": второе письмо за сутки уходит, потому что это выпуск.
  expect(mails.rows.filter((m) => m.recipient_user_id === f.aUser.userId).map((m) => m.event)).toEqual(['in_development', 'released']);
  const audit = await pools.root.query(`select diff from hdc_audit_log where object_id = $1 and action = 'idea.status_changed' order by created_on, audit_id`, [idea.ideaId]);
  expect(audit.rows.at(-1)?.diff).toEqual({ number: `I-${idea.number}`, from: 'in_development', to: 'released', version: '5.12', releasedOn: '2026-12-20' });
  await expect(releaseIdea(product, { number: idea.number, version: '5.13', releasedOn: '2026-12-21' })).rejects.toMatchObject({ code: 'bad_transition' });
});

test('FR-IDEA-12: режим API создаёт задачу в таск-менеджере с текстом идеи и ссылкой на карточку, без автора и организации', async () => {
  const tracker = createMemoryDevTracker();
  setDevTrackerForTests({ settings: { mode: 'smartup', url: 'https://tracker.smartup.example', token: 't'.repeat(32), webhookSecret: 's'.repeat(32) }, tracker });
  const idea = await selectedIdea();
  const { created } = await sendIdeaToDevelopment(product, { number: idea.number });
  expect(created).toBe(true);
  expect(tracker.created).toHaveLength(1);
  expect(tracker.created[0]).toMatchObject({ title: 'Печать накладных пачкой', kind: 'feature' });
  expect(tracker.created[0]?.sourceUrl).toMatch(new RegExp(`/ru/agent/ideas/I-${idea.number}$`));
  expect(JSON.stringify(tracker.created[0])).not.toContain(f.orgB.name);
  expect(JSON.stringify(tracker.created[0])).not.toContain(f.bUser.name);
  expect((await ideaRow(idea)).status).toBe('in_development');
  tracker.failing = true;
  const other = await selectedIdea();
  await expect(sendIdeaToDevelopment(product, { number: other.number })).rejects.toMatchObject({ code: 'tracker_unavailable' });
  expect((await ideaRow(other)).status).toBe('selected');
});
