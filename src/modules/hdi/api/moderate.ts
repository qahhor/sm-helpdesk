import 'server-only';
import { withActor } from '@/db/with-actor';
import { enqueue, type StaffContext } from '@/modules/hdc/api';
import { isActiveModule } from '@/modules/hdr/api';
import { declineTx, mergeTx, moderatorEditTx, publishTx, reviewTranslationTx } from '../core/moderate';
import { HdiError } from '../error';
import { declineInput, mergeInput, moderatorEditInput, parseInput, publishInput, translationEditInput } from '../input';
import { IDEA_MODERATOR_ROLES } from '../pref';

// Модуль hdi, слой api: модерация идей (ТЗ FR-IDEA-03, 13, S6 (2); план M7, задача 4, решения 5, 6, 9, 11, 23).
// Действует только product и admin: остальные роли получают forbidden ещё до базы, а база отклоняет их и сама
// (политики и триггер 0079). Задания перевода и индекса ставятся после фиксации транзакции, как у решений (M5):
// очередь pg-boss не участвует в транзакции портала, пропущенную постановку повторит следующая правка.
// Уведомления автору, проголосовавшим и подписчикам ставит та же транзакция модератора (задача 8, решения 14, 15).

function requireModerator(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(IDEA_MODERATOR_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdiError('forbidden');
}

/** Публикация с модерации (решения 5, 9): затем машинный перевод и индекс похожих. */
export async function publishIdea(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  requireModerator(ctx);
  const data = parseInput(publishInput, input);
  const idea = await withActor(ctx.actor, (tx) => publishTx(tx, data.number, data.findingsChecked));
  await enqueue('ideas.translate', { ideaId: idea.ideaId });
  await enqueue('ideas.index', { ideaId: idea.ideaId });
  return { number: idea.number };
}

/** Правка текста и модуля модератором до публикации (решение 5), например чтобы убрать телефон. */
export async function editIdeaAsModerator(ctx: StaffContext, input: unknown): Promise<void> {
  requireModerator(ctx);
  const data = parseInput(moderatorEditInput, input);
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdiError('invalid_input');
  await withActor(ctx.actor, (tx) => moderatorEditTx(tx, data.number, data));
}

/** Отклонение с обязательной причиной до 1000 знаков (решение 5). Строки индекса снимаются той же транзакцией. */
export async function declineIdea(ctx: StaffContext, input: unknown): Promise<void> {
  requireModerator(ctx);
  const data = parseInput(declineInput, input);
  await withActor(ctx.actor, (tx) => declineTx(tx, data.number, data.reason));
}

/** Объединение без задвоения голосов (решение 6). */
export async function mergeIdea(ctx: StaffContext, input: unknown): Promise<{ into: number; moved: number }> {
  requireModerator(ctx);
  const data = parseInput(mergeInput, input);
  if (data.number === data.into) throw new HdiError('bad_merge_target');
  const { target, moved } = await withActor(ctx.actor, (tx) => mergeTx(tx, data.number, data.into));
  return { into: target.number, moved };
}

/** Правка перевода модератором: статус reviewed, клиент видит текст без пометки машинного (решение 11). */
export async function reviewIdeaTranslation(ctx: StaffContext, input: unknown): Promise<void> {
  requireModerator(ctx);
  const data = parseInput(translationEditInput, input);
  const idea = await withActor(ctx.actor, (tx) => reviewTranslationTx(tx, data.number, data.locale, data));
  await enqueue('ideas.index', { ideaId: idea.ideaId });
}
