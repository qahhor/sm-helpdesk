import 'server-only';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import type { ClientActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { wakeAutomation } from '@/modules/hdc/api';
import { aiFeedbackEventTx, aiResolveTx, lastAiMessageTx } from '../core/ai';
import { clientTicketByNumber } from '../core/tickets';
import { HdtError } from '../error';
import { AI_REPLY_LIMIT } from '../pref';
import { tickets } from '../schema';
import { assistantSolution } from '@/modules/hdk/api/assistant';
import { aiHandoff, postAiMessage } from './ai';

// Модуль hdt, слой api: кнопки клиента под сообщением Теза (план M5b, задача 5; FR-AI-08, 09, 10, FR-TK-18). Портал,
// страница подтверждения из письма и кнопки Telegram вызывают эту одну функцию: своей логики у канала нет.
//
// Проверки: сессия даёт актора клиента, вход разбирает Zod, обращение читается под политикой клиента (чужое и
// невидимое: not_found), сообщение обязано быть последним сообщением помощника этого обращения, помощник ведёт
// обращение и ждёт реакции клиента. Изменение делает система по правилам кода с записью в историю и журнал аудита.

const SYSTEM: SystemActor = { type: 'system', job: 'ai.feedback' };

export const AI_FEEDBACK_CHOICES = ['helped', 'not_helped', 'need_staff', 'pick'] as const;
export type AiFeedbackChoice = (typeof AI_FEEDBACK_CHOICES)[number];
export type AiFeedbackResult = 'helped' | 'not_helped' | 'need_staff' | 'picked';

const input = z.strictObject({
  number: z.coerce.number().int().positive(),
  messageId: z.uuid(),
  choice: z.enum(AI_FEEDBACK_CHOICES),
  articleId: z.uuid().optional(),
});

export async function aiFeedback(ctx: { actor: ClientActor }, raw: unknown): Promise<AiFeedbackResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new HdtError('invalid_input');
  const data = parsed.data;
  const actor = ctx.actor;
  const found = await withActor(actor, async (tx) => {
    const [t] = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, status: tickets.status, aiState: tickets.aiState, aiReplyCount: tickets.aiReplyCount })
      .from(tickets)
      .where(and(clientTicketByNumber(actor, data.number), eq(tickets.orgId, actor.orgId)))
      .limit(1);
    if (!t) return null;
    return { ticket: t, last: await lastAiMessageTx(tx, t.ticketId) };
  });
  if (!found) throw new HdtError('not_found');
  const { ticket, last } = found;
  if (!last || last.messageId !== data.messageId || ticket.aiState !== 'active' || ticket.status !== 'waiting_customer') throw new HdtError('transition_refused');
  const kind = last.payload.kind;
  if (kind !== 'answer' && kind !== 'clarify') throw new HdtError('transition_refused');
  if ((data.choice === 'helped' && kind !== 'answer') || (data.choice === 'pick' && kind !== 'clarify')) throw new HdtError('invalid_input');
  const option = data.choice === 'pick' && last.payload.kind === 'clarify' ? last.payload.options.find((o) => o.articleId === data.articleId) : undefined;
  if (data.choice === 'pick' && !option) throw new HdtError('invalid_input');

  await withActor(SYSTEM, (tx) => aiFeedbackEventTx(tx, { ticketId: ticket.ticketId, orgId: ticket.orgId, userId: actor.userId, choice: data.choice }));
  const now = new Date();
  if (data.choice === 'helped' && last.payload.kind === 'answer') {
    const articleId = last.payload.articleId;
    await withActor(SYSTEM, (tx) => aiResolveTx(tx, { ticketId: ticket.ticketId, articleId, userId: actor.userId, now }));
    await wakeAutomation();
    return 'helped';
  }
  if (data.choice === 'pick' && option && last.payload.kind === 'clarify') {
    // Выбор клиента ставит выбранное решение ответом без нового вызова модели (решение 9).
    if (ticket.aiReplyCount >= AI_REPLY_LIMIT) {
      await aiHandoff(SYSTEM, { ticketId: ticket.ticketId, reason: 'reply_limit', questionIds: [], now });
      return 'need_staff';
    }
    const locale = last.payload.locale as 'ru' | 'uz' | 'en';
    // Заголовок и шаги для письма: из hdk_published от имени клиента (решение, ставшее внутренним, не найдётся).
    const solution = await assistantSolution(actor, { number: option.articleNumber, locale });
    await postAiMessage(SYSTEM, {
      ticketId: ticket.ticketId,
      payload: { kind: 'answer', introId: 'likely_solution', articleId: option.articleId, articleNumber: option.articleNumber, locale },
      now,
      expectReplyCount: ticket.aiReplyCount,
      ...(solution ? { mail: { solutionTitle: solution.title, lines: solution.text.split('\n') } } : {}),
    });
    return 'picked';
  }
  await aiHandoff(SYSTEM, { ticketId: ticket.ticketId, reason: data.choice === 'not_helped' ? 'not_helped' : 'customer_request', questionIds: [], now });
  return data.choice === 'not_helped' ? 'not_helped' : 'need_staff';
}
