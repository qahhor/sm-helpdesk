import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { enqueue, wakeAutomation } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { assistantEligible, triageEligible } from '@/modules/hda/api/eligibility';
import { activateAiTx, type FirstLineTicket, firstLineTicketTx, handoffTx, postAiMessageTx, silentAssistantTx } from '../core/ai';
import { HdtError } from '../error';
import { AI_HANDOFF_REASONS, type AiHandoffReason, type AiPayload } from '../pref';
import { tickets } from '../schema';

// Модуль hdt, слой api: помощник первой линии в обращении (план M5b, задача 3). Узкий файл для фонового процесса и
// модуля hda: включение при создании, ответ и вопрос помощника, передача сотруднику. Только актор system: решения
// принимает код модуля hda, клиент и сотрудник эти функции не вызывают.

export { AI_HANDOFF_REASONS, AI_REPLY_LIMIT, AI_SILENCE_SEC, type AiHandoffReason, type AiPayload, type AiState } from '../pref';

const SYSTEM: SystemActor = { type: 'system', job: 'ai.start' };

function assertSystem(actor: SystemActor): void {
  if (actor.type !== 'system') throw new HdtError('forbidden');
}

/**
 * Включение помощника после фиксации создания обращения (решение 4). Источник решает вызывающий: портал, виджет и
 * письмо опознанного пользователя с DMARC; обращение от сотрудника и неопознанное письмо помощника не получают.
 * Включён: задание первой линии и сторожевая проверка через 60 секунд (решение 5). Сбой включения обращение не
 * отменяет: оно остаётся у сотрудников, как без помощника.
 */
export async function startAssistant(input: { ticketId: string; orgId: string }): Promise<boolean> {
  try {
    if (!(await assistantEligible(SYSTEM, { orgId: input.orgId }))) {
      await startTriage(input);
      return false;
    }
    if (!(await withActor(SYSTEM, (tx) => activateAiTx(tx, input.ticketId)))) return false;
  } catch (error) {
    console.error(`Помощник не включён в обращении ${input.ticketId}: ${error instanceof Error ? error.message : 'ошибка'}`);
    return false;
  }
  await enqueue('ai.first_line', { ticketId: input.ticketId });
  await enqueue('ai.watchdog', { ticketId: input.ticketId }, { startAfterSeconds: 60 });
  return true;
}

/**
 * Разбор без ответа (план M5b, задача 7, решение 6): помощник не отвечает (выключен администратором или обращение создал
 * сотрудник), а AI-обработка организации и предложения разбора включены. Сбой постановки обращение не задерживает.
 */
export async function startTriage(input: { ticketId: string; orgId: string }): Promise<boolean> {
  try {
    if (!(await triageEligible(SYSTEM, { orgId: input.orgId }))) return false;
    await enqueue('ai.triage', { ticketId: input.ticketId });
    return true;
  } catch (error) {
    console.error(`Разбор не поставлен для обращения ${input.ticketId}: ${error instanceof Error ? error.message : 'ошибка'}`);
    return false;
  }
}

const uuid = z.uuid();
const answerPayload = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), introId: z.string().regex(/^[a-z_]{1,40}$/), articleId: z.uuid(), articleNumber: z.number().int().positive(), locale: z.enum(['ru', 'uz', 'en']) }),
  z.strictObject({
    kind: z.literal('clarify'),
    introId: z.string().regex(/^[a-z_]{1,40}$/),
    options: z.array(z.strictObject({ articleId: z.uuid(), articleNumber: z.number().int().positive() })).length(2),
    locale: z.enum(['ru', 'uz', 'en']),
  }),
]);

/** Ответ решением или вопрос помощника (решения 9, 15). Возвращает идентификатор сообщения. */
export async function postAiMessage(
  actor: SystemActor,
  input: { ticketId: string; payload: Extract<AiPayload, { kind: 'answer' | 'clarify' }>; now?: Date; expectReplyCount?: number; mail?: { solutionTitle: string; lines: string[] } },
): Promise<string> {
  assertSystem(actor);
  const ticketId = uuid.parse(input.ticketId);
  const payload = answerPayload.parse(input.payload) as Extract<AiPayload, { kind: 'answer' | 'clarify' }>;
  const messageId = await withActor(actor, (tx) =>
    postAiMessageTx(tx, {
      ticketId,
      payload,
      now: input.now ?? new Date(),
      ...(input.expectReplyCount !== undefined ? { expectReplyCount: input.expectReplyCount } : {}),
      ...(input.mail ? { mail: { solutionTitle: input.mail.solutionTitle.slice(0, 200), lines: input.mail.lines.slice(0, 30).map((l) => l.slice(0, 500)) } } : {}),
    }),
  );
  // Письмо и сообщение в Telegram об ответе Теза уже в очереди.
  await wakeOutbox();
  await wakeAutomation();
  return messageId;
}

const handoffInput = z.strictObject({
  ticketId: z.uuid(),
  reason: z.enum(AI_HANDOFF_REASONS),
  questionIds: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(3),
  now: z.date().optional(),
  locale: z.enum(['ru', 'uz', 'en']).optional(),
});

/**
 * Передача сотруднику (решение 14). Повтор и передача уже переданного ничего не меняют: false. Язык сообщения о
 * передаче: язык обращения, если вызывающий не назвал другой (язык, определённый кодом, решение 16).
 */
export async function aiHandoff(actor: SystemActor, input: { ticketId: string; reason: AiHandoffReason; questionIds: readonly string[]; now?: Date; locale?: string }): Promise<boolean> {
  assertSystem(actor);
  const data = handoffInput.parse({ ...input, questionIds: [...input.questionIds] });
  const done = await withActor(actor, async (tx) => {
    const [row] = await tx.select({ locale: tickets.locale }).from(tickets).where(eq(tickets.ticketId, data.ticketId)).limit(1);
    if (!row) throw new HdtError('not_found');
    return handoffTx(tx, { ticketId: data.ticketId, reason: data.reason, questionIds: data.questionIds, now: data.now ?? new Date(), locale: data.locale ?? row.locale });
  });
  // Событие ai_handoff записано: правила разбираются сразу; письмо подтверждения в очереди.
  if (done) {
    await wakeAutomation();
    await wakeOutbox();
  }
  return done;
}

export type { FirstLineTicket } from '../core/ai';

/** Обращение для задачи первой линии (решения 7, 22): поля перечня 14.3 и состояние помощника. */
export async function firstLineTicket(actor: SystemActor, ticketId: string): Promise<FirstLineTicket | null> {
  assertSystem(actor);
  const id = uuid.parse(ticketId);
  return withActor(actor, (tx) => firstLineTicketTx(tx, id));
}

/** Обращения, где помощник молчит дольше 60 секунд (сторожевая проверка, решение 5). */
export async function silentAssistantTickets(actor: SystemActor, now: Date, limit = 100): Promise<string[]> {
  assertSystem(actor);
  return withActor(actor, (tx) => silentAssistantTx(tx, now, limit));
}

/** Клиент ответил в обращении с включённым помощником: помощник отвечает снова (FR-AI-09), сторож проверит через 60 секунд. */
export async function assistantOnClientReply(ticketId: string): Promise<void> {
  try {
    const active = await withActor(SYSTEM, async (tx) => (await tx.select({ aiState: tickets.aiState }).from(tickets).where(eq(tickets.ticketId, ticketId)).limit(1))[0]?.aiState === 'active');
    if (!active) return;
  } catch (error) {
    console.error(`Помощник не поставлен после ответа клиента ${ticketId}: ${error instanceof Error ? error.message : 'ошибка'}`);
    return;
  }
  await enqueue('ai.first_line', { ticketId });
  await enqueue('ai.watchdog', { ticketId }, { startAfterSeconds: 60 });
}
