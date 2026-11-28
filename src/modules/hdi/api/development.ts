import 'server-only';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { type StaffContext, writeAudit } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { devTaskOfIdeaTx, isHdwError, linkIdeaTx, resolveIdeaTaskLink } from '@/modules/hdw/api/idea-links';
import { originalTextTx } from '../core/moderate';
import { notifyIdeaStatusTx } from '../core/notices';
import { HdiError, type HdiErrorCode } from '../error';
import { ideaNumber, parseInput } from '../input';
import { IDEA_MODERATOR_ROLES, ideaRef, RELEASE_VERSION_MAX } from '../pref';
import { ideas } from '../schema';
import { noProtoKeys } from '@/lib/no-proto';

// Модуль hdi, слой api: статусы после выбора (ТЗ FR-IDEA-12, FR-DEV-06; план M7, задача 9, решение 18).
// "Передать в разработку" (selected -> in_development): задача тем же адаптером hdw, что и обращения (ручной режим или
// API таск-менеджера), привязка идеи, статус, журнал и уведомления одной транзакцией. "Выпущена" (in_development ->
// released): версия и дата от сотрудника, письмо проголосовавшим уходит всегда (решение 14). Только product и admin;
// база отклоняет остальных и сама (политики 0079 и 0082, триггер t_hdi_ideas_guard).

function requireModerator(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(IDEA_MODERATOR_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdiError('forbidden');
}

/** Коды адаптера hdw, которые страница идеи показывает своим текстом; остальные становятся invalid_input. */
const HDW_CODES: readonly HdiErrorCode[] = ['invalid_input', 'invalid_url', 'already_linked', 'task_closed', 'task_not_found', 'tracker_unavailable', 'forbidden', 'not_found'];

async function viaHdw<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isHdwError(error)) throw error;
    throw new HdiError((HDW_CODES as readonly string[]).includes(error.code) ? (error.code as HdiErrorCode) : 'invalid_input');
  }
}

async function lockIdeaTx(tx: Tx, number: number) {
  const [idea] = await tx.select().from(ideas).where(eq(ideas.number, number)).limit(1).for('update');
  if (!idea) throw new HdiError('not_found');
  return idea;
}

/**
 * Передать выбранную идею в разработку. Поля задачи как у обращения: ручной режим externalId, url, title; режим API
 * необязательный externalId существующей задачи. Отказы: forbidden, invalid_input, not_found, bad_transition (идея не
 * "Выбрана"), already_linked, invalid_url, task_closed, task_not_found, tracker_unavailable.
 */
export async function sendIdeaToDevelopment(ctx: StaffContext, input: unknown): Promise<{ devTaskId: string; created: boolean }> {
  requireModerator(ctx);
  const { number, ...task } = parseInput(noProtoKeys(z.looseObject({ number: ideaNumber })), input);
  const source = await withActor(ctx.actor, async (tx) => {
    const [idea] = await tx.select().from(ideas).where(eq(ideas.number, number)).limit(1);
    if (!idea) throw new HdiError('not_found');
    if (idea.status !== 'selected') throw new HdiError('bad_transition');
    if (await devTaskOfIdeaTx(tx, idea.ideaId)) throw new HdiError('already_linked');
    const original = await originalTextTx(tx, idea.ideaId);
    if (!original) throw new HdiError('not_found');
    return { number, title: original.title, body: original.body };
  });
  const { link, remoteCreated } = await viaHdw(() => resolveIdeaTaskLink(ctx, task, source));
  try {
    const result = await withActor(ctx.actor, async (tx) => {
      const idea = await lockIdeaTx(tx, number);
      if (idea.status !== 'selected') throw new HdiError('bad_transition');
      const { task: linked, created } = await viaHdw(() => linkIdeaTx(tx, idea.ideaId, link));
      await tx.update(ideas).set({ status: 'in_development' }).where(and(eq(ideas.ideaId, idea.ideaId), eq(ideas.status, 'selected')));
      // В журнале номер задачи без адреса: в адресе бывают ключи доступа.
      await writeAudit(tx, {
        action: 'devtask.linked',
        objectType: 'idea',
        objectId: idea.ideaId,
        diff: { devTaskId: linked.devTaskId, tracker: linked.tracker, ref: linked.externalId, created },
      });
      await writeAudit(tx, { action: 'idea.status_changed', objectType: 'idea', objectId: idea.ideaId, orgId: idea.orgId, diff: { number: ideaRef(number), from: 'selected', to: 'in_development' } });
      await notifyIdeaStatusTx(tx, { ideaId: idea.ideaId, number, authorId: idea.authorId, status: 'in_development' });
      return { devTaskId: linked.devTaskId, created };
    });
    await wakeOutbox();
    return result;
  } catch (error) {
    // Задача в таск-менеджере создана, а привязка не прошла: номер в журнале событий, без текста идеи.
    if (remoteCreated) logEvent('error', 'devtask.orphan', { ref: link.externalId, ideaNumber: number });
    throw error;
  }
}

const releaseInput = z.strictObject({
  number: ideaNumber,
  version: z.string().trim().min(1).max(RELEASE_VERSION_MAX),
  releasedOn: z.iso.date(),
});

/** "Выпущена" с версией и датой (решение 18). Отказы: forbidden, invalid_input, not_found, bad_transition. */
export async function releaseIdea(ctx: StaffContext, input: unknown): Promise<void> {
  requireModerator(ctx);
  const data = parseInput(releaseInput, input);
  await withActor(ctx.actor, async (tx) => {
    const idea = await lockIdeaTx(tx, data.number);
    if (idea.status !== 'in_development') throw new HdiError('bad_transition');
    await tx.update(ideas).set({ status: 'released', releasedIn: data.version, releasedOn: data.releasedOn }).where(and(eq(ideas.ideaId, idea.ideaId), eq(ideas.status, 'in_development')));
    await writeAudit(tx, {
      action: 'idea.status_changed',
      objectType: 'idea',
      objectId: idea.ideaId,
      orgId: idea.orgId,
      diff: { number: ideaRef(data.number), from: 'in_development', to: 'released', version: data.version, releasedOn: data.releasedOn },
    });
    await notifyIdeaStatusTx(tx, { ideaId: idea.ideaId, number: data.number, authorId: idea.authorId, status: 'released' });
  });
  await wakeOutbox();
}
