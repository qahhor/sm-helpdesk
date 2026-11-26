import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { consumeRateLimit } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { replyConfig } from '@/modules/hdn/api/inbound';
import { replyRole } from '@/modules/hdu/api/recipients';
import { type AiLinkChoice, parseAiCallbackData, parseAiLinkToken } from '../ai-link';
import { isHdtError } from '../error';
import { ticketMessages, tickets } from '../schema';
import { aiFeedback } from './ai-feedback';

// Модуль hdt, слой api: ответ на сообщение Теза из письма и из Telegram (план M5b, задача 6; FR-NT-11, FR-EM-12;
// пункт 7 проверки на AI-инъекции). Ссылка из письма только открывает страницу подтверждения: действие выполняет
// нажатие кнопки на ней, почтовый сканер ничего не меняет. Подпись связывает получателя, обращение (через сообщение)
// и выбор, ссылка действует 7 суток, второе нажатие видит, что ответ уже учтён. Нажатие идёт в ту же функцию
// aiFeedback, что кнопки портала, от имени клиента-получателя: своей логики у канала нет.

const SYSTEM: SystemActor = { type: 'system', job: 'ai.link' };

export type AiLinkResult = { ok: true; number: number; choice: AiLinkChoice } | { ok: false; code: 'link_invalid' | 'expired' | 'already_done' | 'rate_limited' };

const secrets = (): string[] => {
  const cfg = replyConfig();
  return cfg ? [cfg.secret, ...(cfg.previousSecret ? [cfg.previousSecret] : [])] : [];
};

/** Обращение сообщения и актор получателя: действующее членство, автор или коллега при видимости "организация". */
async function recipientOf(messageId: string, userId: string): Promise<{ actor: ClientActor; number: number } | null> {
  const [row] = await withActor(SYSTEM, (tx) =>
    tx
      .select({ number: tickets.number, orgId: tickets.orgId, authorId: tickets.authorId, visibility: tickets.visibility, authorType: ticketMessages.authorType })
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.ticketId, ticketMessages.ticketId))
      .where(eq(ticketMessages.messageId, messageId))
      .limit(1),
  );
  if (!row || row.authorType !== 'ai') return null;
  const role = await replyRole(userId, row.orgId);
  if (!role || (row.authorId !== userId && row.visibility !== 'org' && role !== 'client_admin')) return null;
  return { actor: { type: 'client', userId, orgId: row.orgId, orgRole: role }, number: row.number };
}

async function apply(messageId: string, userId: string, choice: AiLinkChoice): Promise<AiLinkResult> {
  if (!(await consumeRateLimit(`ai-link:${messageId}`, RATE_RULES.csatLinkPerTicket)).allowed) return { ok: false, code: 'rate_limited' };
  const target = await recipientOf(messageId, userId);
  if (!target) return { ok: false, code: 'link_invalid' };
  try {
    await aiFeedback({ actor: target.actor }, { number: target.number, messageId, choice });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    if (error.code === 'transition_refused' || error.code === 'invalid_input') return { ok: false, code: 'already_done' };
    return { ok: false, code: 'link_invalid' };
  }
  return { ok: true, number: target.number, choice };
}

const tokenInput = z.string().min(1).max(200);

/** Страница подтверждения: номер обращения и выбор из ссылки. Базу не меняет. */
export async function aiLinkInfo(token: unknown): Promise<{ ok: true; number: number; choice: AiLinkChoice } | { ok: false; code: 'link_invalid' | 'expired' }> {
  const t = tokenInput.safeParse(token);
  if (!t.success) return { ok: false, code: 'link_invalid' };
  const parsed = parseAiLinkToken(t.data, secrets(), new Date());
  if (!parsed.ok) return parsed;
  const target = await recipientOf(parsed.messageId, parsed.userId);
  return target ? { ok: true, number: target.number, choice: parsed.choice } : { ok: false, code: 'link_invalid' };
}

/** Нажатие на странице подтверждения из письма. */
export async function aiFeedbackByLink(input: unknown): Promise<AiLinkResult> {
  const t = z.strictObject({ token: tokenInput }).safeParse(input);
  if (!t.success) return { ok: false, code: 'link_invalid' };
  const parsed = parseAiLinkToken(t.data.token, secrets(), new Date());
  if (!parsed.ok) return parsed;
  return apply(parsed.messageId, parsed.userId, parsed.choice);
}

/** Кнопка Telegram: пользователя называет привязка бота, данные кнопки подписаны его идентификатором. */
export async function aiFeedbackByTelegram(userId: string, data: string): Promise<AiLinkResult> {
  const parsed = parseAiCallbackData(data, userId, secrets());
  if (!parsed) return { ok: false, code: 'link_invalid' };
  return apply(parsed.messageId, userId, parsed.choice);
}
