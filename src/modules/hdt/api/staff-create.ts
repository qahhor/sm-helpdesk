import 'server-only';
import { isActiveModule } from '@/modules/hdr/api';
import { memberForStaff, type StaffContext } from '@/modules/hdu/api';
import { assertCanWrite } from '../core/agent-actions';
import { createTicketForClientTx } from '../core/tickets';
import { HdtError } from '../error';
import { parseInput, staffCreateInput } from '../input';
import { MAX_FILES_PER_MESSAGE } from '../pref';
import { titleFromDescription } from '../util';
import { startTriage } from './ai';
import { recordTicketSignature, wakeAutomation } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';

// Обращение от имени клиента (FR-AG-08; план M3, задача 12). Организация и участник выбраны сотрудником,
// поэтому сервис сверяет их с членством: автор только действующий участник выбранной организации.

export async function createTicketForClient(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  assertCanWrite(ctx.actor);
  const data = parseInput(staffCreateInput, input);
  if (new Set(data.attachmentIds).size > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  // Автор: действующий участник выбранной организации. Одна строка по ключу, а не весь список (проверка качества, Q20).
  // Чужая ошибка не глотается (Q16): отказ в праве остаётся отказом, сбой базы остаётся сбоем.
  const author = await memberForStaff(ctx, data.orgId, data.authorId);
  if (author?.state !== 'active') throw new HdtError('invalid_input');
  const { number, ticketId } = await createTicketForClientTx(ctx.actor, {
    ...data,
    title: data.title ?? titleFromDescription(data.description),
    attachmentIds: [...new Set(data.attachmentIds)],
  });
  // Сигнатура ошибки из описания (план M5, задача 8), как у обращения клиента.
  await recordTicketSignature({ ticketId, orgId: data.orgId, authorId: data.authorId, description: data.description, context: null, moduleId: data.moduleId ?? null });
  // Помощник не отвечает на обращение от сотрудника, но разбор предлагается (план M5b, решение 6).
  await startTriage({ ticketId, orgId: data.orgId });
  await wakeOutbox();
  await wakeAutomation();
  return { number };
}
