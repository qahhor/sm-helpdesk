import 'server-only';
import * as z from 'zod';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { consumeRateLimit, rateKey, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { cleanUserText, RATE_RULES } from '@/modules/hdc/pref';
import { findInText } from '@/modules/hdk/api/text-checks';
import type { ClientContext } from '@/modules/hdu/api';
import { commentByIdTx, commentsTx, ideaNumberTx, type CommentView, editCommentTx, insertCommentTx, type PendingComment, pendingCommentsTx, setCommentStatusTx } from '../core/comments';
import { ideaByNumberTx } from '../core/ideas';
import { notifyCommentHiddenTx, notifyOfficialReplyTx } from '../core/notices';
import { HdiError } from '../error';
import { ideaNumber, parseInput } from '../input';
import { COMMENT_MAX, type CommentStatus, DECLINE_REASON_MAX, IDEA_MODERATOR_ROLES, ideaRef } from '../pref';
import { hasLink } from '../util';

// Модуль hdi, слой api: комментарии к идеям и ответы Smartup (ТЗ FR-IDEA-07; план M7, задача 7, решения 8, 13, 20).
// Комментарий клиента публикуется сразу; с телефоном, почтой, ИНН, ПИНФЛ, адресом сервера (проверка текста модуля hdk)
// или ссылкой ждёт модератора и виден только автору. Ответ сотрудника публикуется сразу со значком Smartup. Скрыть с
// причиной и опубликовать удержанный может только product и admin, с записью в журнал без текста. 20 комментариев в
// час на пользователя. Комментарии не переводятся и правятся автором только первые 15 минут.

export type { CommentView, PendingComment };

const text = (max: number) =>
  z
    .string()
    .transform((value) => cleanUserText(value).trim())
    .pipe(z.string().min(1).max(max));

/** Удерживается ли комментарий до модератора (решение 8). */
export function needsReview(body: string): boolean {
  return findInText(body).some((hit) => ['phone', 'email', 'inn', 'pinfl', 'server'].includes(hit.kind)) || hasLink(body);
}

async function limited(userId: string): Promise<void> {
  const limit = await consumeRateLimit(rateKey('idea-comment:user', userId), RATE_RULES.ideaCommentPerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
}

const addInput = z.strictObject({ number: ideaNumber, body: text(COMMENT_MAX) });

/** Комментарий клиента к видимой идее. Отклонённая и объединённая: comments_closed; невидимая: not_found. */
export async function addComment(ctx: Pick<ClientContext, 'actor' | 'user'>, input: unknown): Promise<{ commentId: string; status: CommentStatus }> {
  const data = parseInput(addInput, input);
  await limited(ctx.actor.userId);
  const status: CommentStatus = needsReview(data.body) ? 'pending' : 'published';
  const commentId = await withActor(ctx.actor, async (tx) => {
    const idea = await ideaByNumberTx(tx, data.number);
    if (!idea) throw new HdiError('not_found');
    if (idea.status === 'declined' || idea.status === 'merged') throw new HdiError('comments_closed');
    const id = await insertCommentTx(tx, { ideaId: idea.ideaId, orgId: ctx.actor.orgId, authorId: ctx.actor.userId, authorName: ctx.user.name, body: data.body, isOfficial: false, status });
    if (status === 'pending') await writeAudit(tx, { action: 'idea.comment_held', objectType: 'idea_comment', objectId: id, orgId: ctx.actor.orgId, diff: { idea: ideaRef(idea.number) } });
    return id;
  });
  return { commentId, status };
}

/** Ответ Smartup: любой сотрудник, публикуется сразу со значком (FR-IDEA-07). */
export async function addStaffReply(ctx: StaffContext, input: unknown): Promise<{ commentId: string }> {
  const data = parseInput(addInput, input);
  await limited(ctx.actor.userId);
  const commentId = await withActor(ctx.actor, async (tx) => {
    const idea = await ideaByNumberTx(tx, data.number);
    if (!idea) throw new HdiError('not_found');
    if (idea.status === 'declined' || idea.status === 'merged' || idea.status === 'pending_review') throw new HdiError('comments_closed');
    const id = await insertCommentTx(tx, { ideaId: idea.ideaId, orgId: null, authorId: ctx.actor.userId, authorName: ctx.user.name, body: data.body, isOfficial: true, status: 'published' });
    // Автору и подписчикам, не проголосовавшим (решение 15), той же транзакцией.
    await notifyOfficialReplyTx(tx, idea.ideaId);
    return id;
  });
  return { commentId };
}

const editInput = z.strictObject({ commentId: z.uuid(), body: text(COMMENT_MAX) });

/** Правка своего комментария в первые 15 минут: с находками он снова ждёт модератора, удержанный сам не публикуется. */
export async function editComment(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<{ status: CommentStatus }> {
  const data = parseInput(editInput, input);
  await limited(ctx.actor.userId);
  return withActor(ctx.actor, async (tx) => {
    const comment = await commentByIdTx(tx, data.commentId);
    if (!comment || comment.authorId !== ctx.actor.userId) throw new HdiError('not_found');
    if (comment.status === 'hidden') throw new HdiError('not_editable');
    const status: CommentStatus = needsReview(data.body) || comment.status === 'pending' ? 'pending' : 'published';
    if (!(await editCommentTx(tx, comment, data.body, status, new Date()))) throw new HdiError('not_editable');
    if (status === 'pending' && comment.status !== 'pending')
      await writeAudit(tx, { action: 'idea.comment_held', objectType: 'idea_comment', objectId: comment.commentId, orgId: ctx.actor.orgId, diff: { edited: true } });
    return { status };
  });
}

const moderateInput = z.discriminatedUnion('action', [
  z.strictObject({ commentId: z.uuid(), action: z.literal('publish') }),
  z.strictObject({ commentId: z.uuid(), action: z.literal('hide'), reason: text(DECLINE_REASON_MAX) }),
]);

const requireModerator = (ctx: StaffContext) => {
  if (ctx.actor.type !== 'staff' || !(IDEA_MODERATOR_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdiError('forbidden');
};

/** Публикация удержанного или скрытие любого комментария с причиной (решение 8): только product и admin. */
export async function moderateComment(ctx: StaffContext, input: unknown): Promise<{ ideaNumber: number }> {
  requireModerator(ctx);
  const data = parseInput(moderateInput, input);
  return withActor(ctx.actor, async (tx) => {
    const comment = await commentByIdTx(tx, data.commentId);
    if (!comment) throw new HdiError('not_found');
    const to: CommentStatus = data.action === 'hide' ? 'hidden' : 'published';
    const allowed = data.action === 'hide' ? comment.status !== 'hidden' : comment.status === 'pending';
    if (!allowed || !(await setCommentStatusTx(tx, comment.commentId, comment.status, to, data.action === 'hide' ? data.reason : null))) throw new HdiError('bad_transition');
    const number = await ideaNumberTx(tx, comment.ideaId);
    await writeAudit(tx, {
      action: to === 'hidden' ? 'idea.comment_hidden' : 'idea.comment_published',
      objectType: 'idea_comment',
      objectId: comment.commentId,
      orgId: comment.orgId ?? undefined,
      diff: { idea: ideaRef(number), from: comment.status, to },
    });
    if (to === 'hidden' && !comment.isOfficial) await notifyCommentHiddenTx(tx, comment.ideaId, number, comment.authorId);
    return { ideaNumber: number };
  });
}

const listInput = z.strictObject({ number: ideaNumber, after: z.uuid().or(z.literal('')).optional() });

/** Комментарии идеи для клиента или сотрудника; невидимая идея: пусто. */
export async function listComments(actor: ClientActor | StaffActor, input: unknown): Promise<{ items: CommentView[]; next: string | null }> {
  const data = parseInput(listInput, input);
  return withActor(actor, async (tx) => {
    const idea = await ideaByNumberTx(tx, data.number);
    if (!idea) return { items: [], next: null };
    return commentsTx(tx, idea.ideaId, data.after || null, actor.userId, new Date());
  });
}

/** Вкладка "Комментарии на проверке": любой сотрудник видит, публикует и скрывает модератор. */
export async function pendingComments(ctx: StaffContext): Promise<PendingComment[]> {
  return withActor(ctx.actor, (tx) => pendingCommentsTx(tx, 100));
}
