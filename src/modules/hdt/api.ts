import 'server-only';
import type { ClientContext } from '@/modules/hdu/api';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { isActiveModule } from '@/modules/hdr/api';
import { createTicketTx } from './core/tickets';
import { HdtError } from './error';
import { createTicketInput, parseInput } from './input';
import { MAX_FILES_PER_MESSAGE } from './pref';
import { titleFromDescription } from './util';

// Модуль hdt (обращения), слой api: точки входа для страниц, обработчиков и других модулей.
// Каждая функция принимает проверенный контекст клиента и разбирает вход схемой (ТЗ 9.4, правило 7).

export { HDT_ERROR_CODES, type HdtErrorCode, HdtError, isHdtError } from './error';
export { formatNumber, parseNumber } from './util';

/**
 * Новое обращение клиента (FR-TK-01..05). Организация и автор из контекста, поля организации во входе
 * отбрасываются. Не больше 10 обращений в час на пользователя (раздел 14.5).
 */
export async function createTicket(ctx: ClientContext, input: unknown): Promise<{ number: number }> {
  const data = parseInput(createTicketInput, input);
  if (new Set(data.attachmentIds).size > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  const limit = await consumeRateLimit(rateKey('ticket-create:user', ctx.actor.userId), RATE_RULES.ticketCreatePerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const { number } = await createTicketTx(ctx.actor, {
    ...data,
    title: data.title ?? titleFromDescription(data.description),
    attachmentIds: [...new Set(data.attachmentIds)],
  });
  return { number };
}
