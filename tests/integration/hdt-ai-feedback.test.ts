import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { aiFeedback } from '@/modules/hdt/api/ai-feedback';
import { postAiMessage } from '@/modules/hdt/api/ai';
import { createTicket, getTicket } from '@/modules/hdt/api';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Кнопки клиента под ответом Теза (план M5b, задача 5; FR-AI-08, FR-AI-09, FR-AI-10, FR-TK-18). "Помогло" решает
// обращение и ставит resolved_by_ai, "Не помогло" и "Нужен сотрудник" передают его, выбор в вопросе показывает
// выбранное решение без нового вызова модели. Каждое нажатие проверяет право на обращение и сообщение, пишет историю
// и журнал аудита. Чужое, старое и не помощника сообщение не срабатывает.

const SYSTEM = { type: 'system', job: 'ai.first_line' } as const;
const A1 = '01900000-0000-7000-8000-0000000000b1';
const A2 = '01900000-0000-7000-8000-0000000000b2';
let f: Fixture;
let stub: StubAiClient;

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  stub = new StubAiClient();
  setAiClientForTests(stub);
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true'::jsonb)`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

async function answered(kind: 'answer' | 'clarify' = 'answer') {
  const ctx = await clientCtx(f.aUser);
  const { number } = await createTicket(ctx, { description: 'При печати накладной выходит пустой лист', type: 'bug', impact: 'minor', locale: 'ru' });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  const messageId = await postAiMessage(SYSTEM, {
    ticketId,
    payload:
      kind === 'answer'
        ? { kind: 'answer', introId: 'likely_solution', articleId: A1, articleNumber: 1042, locale: 'ru' }
        : { kind: 'clarify', introId: 'similar_case', options: [{ articleId: A1, articleNumber: 1042 }, { articleId: A2, articleNumber: 1043 }], locale: 'ru' },
  });
  return { ctx, number, ticketId, messageId };
}
const row = (ticketId: string) =>
  pools.root.query(`select status, ai_state, ai_handoff_reason, resolution_type, solution_id, resolved_on, ai_reply_count from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);

test('"Помогло": обращение решено помощником, решение записано, история и журнал аудита', async () => {
  const { ctx, number, ticketId, messageId } = await answered();
  expect(await aiFeedback(ctx, { number, messageId, choice: 'helped' })).toBe('helped');
  const t = await row(ticketId);
  expect(t).toMatchObject({ status: 'resolved', ai_state: 'resolved_by_ai', resolution_type: 'solved', solution_id: A1 });
  expect(t.resolved_on).not.toBeNull();
  expect((await pools.root.query(`select payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = 'ai_feedback'`, [ticketId])).rows).toEqual([{ payload: { choice: 'helped' }, is_internal: true }]);
  expect((await pools.root.query(`select diff from hdc_audit_log where object_id = $1 and action = 'ticket.ai_feedback'`, [ticketId])).rows).toEqual([{ diff: { choice: 'helped' } }]);
  // Второе нажатие: уже учтено.
  await expect(aiFeedback(ctx, { number, messageId, choice: 'helped' })).rejects.toMatchObject({ code: 'transition_refused' });
  // Клиент видит своё обращение решённым, состояние помощника на странице.
  expect((await getTicket(ctx, number))?.aiState).toBe('resolved_by_ai');
});

test('"Не помогло" и "Нужен сотрудник": передача с причиной, кнопки больше не работают', async () => {
  const a = await answered();
  expect(await aiFeedback(a.ctx, { number: a.number, messageId: a.messageId, choice: 'not_helped' })).toBe('not_helped');
  expect(await row(a.ticketId)).toMatchObject({ status: 'in_progress', ai_state: 'handed_off', ai_handoff_reason: 'not_helped' });
  await expect(aiFeedback(a.ctx, { number: a.number, messageId: a.messageId, choice: 'helped' })).rejects.toMatchObject({ code: 'transition_refused' });
  const b = await answered();
  expect(await aiFeedback(b.ctx, { number: b.number, messageId: b.messageId, choice: 'need_staff' })).toBe('need_staff');
  expect(await row(b.ticketId)).toMatchObject({ ai_state: 'handed_off', ai_handoff_reason: 'customer_request' });
});

test('выбор в вопросе: выбранное решение ответом без нового вызова модели; решение вне пары не принимается', async () => {
  const { ctx, number, ticketId, messageId } = await answered('clarify');
  await expect(aiFeedback(ctx, { number, messageId, choice: 'pick', articleId: '01900000-0000-7000-8000-0000000000ff' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(aiFeedback(ctx, { number, messageId, choice: 'helped' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await aiFeedback(ctx, { number, messageId, choice: 'pick', articleId: A2 })).toBe('picked');
  expect(stub.calls).toHaveLength(0);
  const payloads = (await pools.root.query(`select ai_payload from hdt_ticket_messages where ticket_id = $1 and author_type = 'ai' order by created_on`, [ticketId])).rows.map((r) => r.ai_payload);
  expect(payloads.at(-1)).toMatchObject({ kind: 'answer', articleId: A2, articleNumber: 1043 });
  expect((await row(ticketId)).ai_reply_count).toBe(2);
  // Старое сообщение (вопрос) после нового ответа не срабатывает.
  await expect(aiFeedback(ctx, { number, messageId, choice: 'pick', articleId: A1 })).rejects.toMatchObject({ code: 'transition_refused' });
});

test('чужая организация, коллега без доступа к личному, не помощника сообщение и неверный вход отклоняются', async () => {
  const { number, messageId } = await answered();
  await expect(aiFeedback(await clientCtx(f.bUser), { number, messageId, choice: 'helped' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(aiFeedback(await clientCtx(f.aUser), { number, messageId, choice: 'delete' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(aiFeedback(await clientCtx(f.aUser), { number, messageId: 'not-a-uuid', choice: 'helped' })).rejects.toMatchObject({ code: 'invalid_input' });
  const client = await pools.root.query(`select message_id from hdt_ticket_messages where author_type = 'client' limit 1`);
  if (client.rows[0]) await expect(aiFeedback(await clientCtx(f.aUser), { number, messageId: client.rows[0].message_id, choice: 'helped' })).rejects.toBeTruthy();
  const priv = f.tickets.aMine;
  await expect(aiFeedback(await clientCtx(f.aAdmin), { number: priv.number, messageId, choice: 'helped' })).rejects.toMatchObject({ code: 'transition_refused' });
});
