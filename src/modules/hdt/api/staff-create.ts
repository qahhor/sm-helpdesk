import 'server-only';
import { isActiveModule } from '@/modules/hdr/api';
import { listMembersForStaff, type StaffContext } from '@/modules/hdu/api';
import { assertCanWrite } from '../core/agent-actions';
import { createTicketForClientTx } from '../core/tickets';
import { HdtError } from '../error';
import { parseInput, staffCreateInput } from '../input';
import { MAX_FILES_PER_MESSAGE } from '../pref';
import { titleFromDescription } from '../util';
import { wakeAutomation } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';

// Обращение от имени клиента (FR-AG-08; план M3, задача 12). Организация и участник выбраны сотрудником,
// поэтому сервис сверяет их с членством: автор только действующий участник выбранной организации.

export async function createTicketForClient(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  assertCanWrite(ctx.actor);
  const data = parseInput(staffCreateInput, input);
  if (new Set(data.attachmentIds).size > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  const members = await listMembersForStaff(ctx, data.orgId).catch(() => []);
  if (!members.some((member) => member.userId === data.authorId && member.state === 'active')) throw new HdtError('invalid_input');
  const { number } = await createTicketForClientTx(ctx.actor, {
    ...data,
    title: data.title ?? titleFromDescription(data.description),
    attachmentIds: [...new Set(data.attachmentIds)],
  });
  await wakeOutbox();
  await wakeAutomation();
  return { number };
}
