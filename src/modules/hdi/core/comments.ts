import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { alias } from 'drizzle-orm/pg-core';
import type { CommentStatus } from '../pref';
import { COMMENT_EDIT_MINUTES, COMMENT_PAGE } from '../pref';
import { ideaComments, ideas } from '../schema';

// Модуль hdi, слой core: комментарии к идеям и ответы Smartup (ТЗ FR-IDEA-07; план M7, задача 7, решение 8). Читается
// и пишется в транзакции актора: клиенту политика отдаёт опубликованные комментарии видимых идей и свои любые, кто что
// пишет и меняет, держит триггер t_hdi_comments_guard; счётчик опубликованных пересчитывает только триггер.

export type CommentRow = typeof ideaComments.$inferSelect;

export type CommentView = {
  commentId: string;
  authorName: string;
  body: string;
  isOfficial: boolean;
  status: CommentStatus;
  /** Причина скрытия: только автору своего комментария. */
  hideReason: string | null;
  mine: boolean;
  editable: boolean;
  createdOn: Date;
};

export async function insertCommentTx(
  tx: Tx,
  values: { ideaId: string; orgId: string | null; authorId: string; authorName: string; body: string; isOfficial: boolean; status: CommentStatus },
): Promise<string> {
  // Идентификатор задаёт приложение: так строка не перечитывается после вставки.
  const commentId = randomUUID();
  await tx.insert(ideaComments).values({ commentId, ...values });
  return commentId;
}

/** Видимый актору комментарий. */
export async function commentByIdTx(tx: Tx, commentId: string): Promise<CommentRow | null> {
  const [row] = await tx.select().from(ideaComments).where(eq(ideaComments.commentId, commentId)).limit(1);
  return row ?? null;
}

const isFresh = (createdOn: Date, now: Date) => now.getTime() - createdOn.getTime() < COMMENT_EDIT_MINUTES * 60_000;

/** Страница комментариев идеи: старые сверху, после комментария after (ключ: время и идентификатор). */
export async function commentsTx(tx: Tx, ideaId: string, after: string | null, userId: string, now: Date): Promise<{ items: CommentView[]; next: string | null }> {
  const cursor = alias(ideaComments, 'cursor_comment');
  const rows = await tx
    .select()
    .from(ideaComments)
    .where(
      and(
        eq(ideaComments.ideaId, ideaId),
        after
          ? sql`(${ideaComments.createdOn}, ${ideaComments.commentId}) > (${tx.select({ v: cursor.createdOn }).from(cursor).where(eq(cursor.commentId, after))}, ${after}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(ideaComments.createdOn), asc(ideaComments.commentId))
    .limit(COMMENT_PAGE + 1);
  const page = rows.slice(0, COMMENT_PAGE);
  return {
    items: page.map((row) => {
      const mine = row.authorId === userId;
      return {
        commentId: row.commentId,
        authorName: row.authorName,
        body: row.body,
        isOfficial: row.isOfficial,
        status: row.status,
        hideReason: mine ? row.hideReason : null,
        mine,
        editable: mine && row.status !== 'hidden' && isFresh(row.createdOn, now),
        createdOn: row.createdOn,
      };
    }),
    next: rows.length > COMMENT_PAGE ? (page[page.length - 1]?.commentId ?? null) : null,
  };
}

/** Правка своего комментария в первые 15 минут: текст и статус по находкам. Опоздал: false. */
export async function editCommentTx(tx: Tx, comment: CommentRow, body: string, status: CommentStatus, now: Date): Promise<boolean> {
  if (!isFresh(comment.createdOn, now)) return false;
  const updated = await tx
    .update(ideaComments)
    .set({ body, status })
    .where(and(eq(ideaComments.commentId, comment.commentId), gt(ideaComments.createdOn, new Date(now.getTime() - COMMENT_EDIT_MINUTES * 60_000))))
    .returning({ id: ideaComments.commentId });
  return updated.length > 0;
}

/** Скрытие с причиной или публикация удержанного (модератор): кто скрыл, ставит триггер. */
export async function setCommentStatusTx(tx: Tx, commentId: string, from: CommentStatus, to: CommentStatus, reason: string | null): Promise<boolean> {
  const updated = await tx
    .update(ideaComments)
    .set({ status: to, hideReason: to === 'hidden' ? reason : null })
    .where(and(eq(ideaComments.commentId, commentId), eq(ideaComments.status, from)))
    .returning({ id: ideaComments.commentId });
  return updated.length > 0;
}

export type PendingComment = { commentId: string; ideaNumber: number; authorName: string; body: string; createdOn: Date };

/** Комментарии на проверке, от старых к новым (вкладка рабочего места). */
export async function pendingCommentsTx(tx: Tx, limit: number): Promise<PendingComment[]> {
  return tx
    .select({ commentId: ideaComments.commentId, ideaNumber: ideas.number, authorName: ideaComments.authorName, body: ideaComments.body, createdOn: ideaComments.createdOn })
    .from(ideaComments)
    .innerJoin(ideas, eq(ideas.ideaId, ideaComments.ideaId))
    .where(eq(ideaComments.status, 'pending'))
    .orderBy(asc(ideaComments.createdOn))
    .limit(limit);
}

/** Номер идеи для журнала и перехода. */
export async function ideaNumberTx(tx: Tx, ideaId: string): Promise<number> {
  const [row] = await tx.select({ number: ideas.number }).from(ideas).where(eq(ideas.ideaId, ideaId)).limit(1);
  return row?.number ?? 0;
}
