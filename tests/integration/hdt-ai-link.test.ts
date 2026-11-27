import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { setReplyConfigForTests } from '@/modules/hdn/inbound/reply-address';
import { aiHandoff, postAiMessage } from '@/modules/hdt/api/ai';
import { aiFeedbackByLink, aiFeedbackByTelegram, aiLinkInfo } from '@/modules/hdt/api/ai-link';
import { createTicket } from '@/modules/hdt/api';
import { aiCallbackData, aiLinkToken } from '@/modules/hdt/ai-link';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { REPLY } from './helpers/inbound';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Ответ Теза в письме и в Telegram (план M5b, задача 6; FR-NT-11, FR-EM-12; пункт 7 проверки на AI-инъекции).
// Ссылка из письма только открывает страницу подтверждения, действие выполняет нажатие; ссылка одноразовая, привязана
// к получателю, обращению и сообщению, действует 7 суток; чужая подпись, истёкший срок и чужое обращение
// отклоняются; есть предел частоты. Кнопки Telegram вызывают ту же функцию, что кнопки портала.

const SYSTEM = { type: 'system', job: 'ai.first_line' } as const;
const ARTICLE = '01900000-0000-7000-8000-0000000000e1';
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  setReplyConfigForTests(REPLY);
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
  await pools.root.query(`delete from hdc_rate_limits`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true'::jsonb)`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setReplyConfigForTests(undefined);
});

async function answered() {
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'При печати накладной выходит пустой лист', type: 'bug', impact: 'minor', locale: 'ru' });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  const messageId = await postAiMessage(SYSTEM, {
    ticketId,
    payload: { kind: 'answer', introId: 'likely_solution', articleId: ARTICLE, articleNumber: 1042, locale: 'ru' },
    mail: { solutionTitle: 'Пустой лист при печати', lines: ['Откройте Настройки > Печать', 'Выберите шаблон А4'] },
  });
  return { number, ticketId, messageId };
}
const state = (ticketId: string) => pools.root.query(`select status, ai_state, ai_handoff_reason from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const tokenOf = (url: string) => decodeURIComponent(new URL(url, 'https://hub.example.test').searchParams.get('t') ?? '');

test('письмо и Telegram об ответе Теза: только автору, решение из ссылки, ссылки и кнопки с подписью', async () => {
  const { ticketId } = await answered();
  const rows = (await pools.root.query(`select channel, template, recipient_user_id, payload from hdn_outbox where ticket_id = $1 and template = 'tez_answer'`, [ticketId])).rows;
  expect(rows.map((r) => [r.channel, r.recipient_user_id])).toEqual([['email', f.aUser.userId]]);
  const payload = rows[0].payload;
  expect(payload).toMatchObject({ solutionTitle: 'Пустой лист при печати', lines: ['Откройте Настройки > Печать', 'Выберите шаблон А4'], introId: 'likely_solution', solutionUrl: '/help/a/1042' });
  expect(payload.helpedUrl).toMatch(/^\/ai-answer\?t=/);
  expect(payload.staffData).toMatch(/^tz:s:/);
});

test('ссылка из письма: открытие ничего не меняет, нажатие решает, второе нажатие "Уже учтено"', async () => {
  const { ticketId, number } = await answered();
  const [row] = (await pools.root.query(`select payload from hdn_outbox where ticket_id = $1 and template = 'tez_answer'`, [ticketId])).rows;
  const token = tokenOf(row.payload.helpedUrl);
  expect(await aiLinkInfo(token)).toEqual({ ok: true, number, choice: 'helped' });
  expect(await aiLinkInfo(token)).toEqual({ ok: true, number, choice: 'helped' });
  expect((await state(ticketId)).status).toBe('waiting_customer');
  expect(await aiFeedbackByLink({ token })).toEqual({ ok: true, number, choice: 'helped' });
  expect(await state(ticketId)).toMatchObject({ status: 'resolved', ai_state: 'resolved_by_ai' });
  expect(await aiFeedbackByLink({ token })).toEqual({ ok: false, code: 'already_done' });
});

test('ссылка: чужая подпись, чужой получатель, истёкший срок и порча отклоняются; предел частоты', async () => {
  const { ticketId, messageId } = await answered();
  const forged = aiLinkToken({ messageId, userId: f.aUser.userId, choice: 'helped', now: new Date() }, 'other-secret-0123456789abcdef0123456789');
  expect(await aiFeedbackByLink({ token: forged })).toEqual({ ok: false, code: 'link_invalid' });
  // Подпись верная, но получатель из другой организации: обращение ему не видно.
  const stranger = aiLinkToken({ messageId, userId: f.bUser.userId, choice: 'helped', now: new Date() }, REPLY.secret);
  expect(await aiFeedbackByLink({ token: stranger })).toEqual({ ok: false, code: 'link_invalid' });
  const old = aiLinkToken({ messageId, userId: f.aUser.userId, choice: 'helped', now: new Date(Date.now() - 8 * 86_400_000) }, REPLY.secret);
  expect(await aiFeedbackByLink({ token: old })).toEqual({ ok: false, code: 'expired' });
  expect(await aiLinkInfo(old)).toEqual({ ok: false, code: 'expired' });
  expect(await aiFeedbackByLink({ token: 'мусор' })).toEqual({ ok: false, code: 'link_invalid' });
  expect((await state(ticketId)).status).toBe('waiting_customer');
  const fine = aiLinkToken({ messageId, userId: f.aUser.userId, choice: 'need_staff', now: new Date() }, REPLY.secret);
  for (let i = 0; i < 10; i++) await aiFeedbackByLink({ token: stranger });
  expect(await aiFeedbackByLink({ token: fine })).toEqual({ ok: false, code: 'rate_limited' });
});

test('кнопка Telegram: та же функция, привязка к пользователю бота', async () => {
  const { ticketId, number, messageId } = await answered();
  const data = aiCallbackData({ messageId, userId: f.aUser.userId, choice: 'need_staff' }, REPLY.secret);
  expect(await aiFeedbackByTelegram(f.bUser.userId, data)).toEqual({ ok: false, code: 'link_invalid' });
  expect(await aiFeedbackByTelegram(f.aUser.userId, data)).toEqual({ ok: true, number, choice: 'need_staff' });
  expect(await state(ticketId)).toMatchObject({ ai_state: 'handed_off', ai_handoff_reason: 'customer_request' });
  expect(await aiFeedbackByTelegram(f.aUser.userId, data)).toEqual({ ok: false, code: 'already_done' });
});

test('подтверждение без Теза при ai_disabled и ai_limit: письмо tez_ack автору; при сбое AI письма нет', async () => {
  for (const reason of ['ai_disabled', 'ai_limit', 'ai_failure'] as const) {
    const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Не открывается отчёт', type: 'bug', impact: 'minor', locale: 'ru' });
    const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
    await aiHandoff(SYSTEM, { ticketId, reason, questionIds: [] });
    const acks = (await pools.root.query(`select recipient_user_id, payload from hdn_outbox where ticket_id = $1 and template = 'tez_ack'`, [ticketId])).rows;
    if (reason === 'ai_failure') expect(acks).toHaveLength(0);
    else expect(acks).toEqual([{ recipient_user_id: f.aUser.userId, payload: expect.objectContaining({ template: 'tez_ack', timeZone: 'Asia/Tashkent' }) }]);
  }
});
