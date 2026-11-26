import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { type IdeaMailEvent, notifyManyTx } from '@/modules/hdn/api/idea-notices';
import type { IdeaStatus } from '../pref';
import { ideas, ideaSubscriptions, ideaTranslations, ideaVotes } from '../schema';

// Модуль hdi, слой core: кому и что сообщить о событии идеи (ТЗ FR-IDEA-11; план M7, задача 8, решения 14, 15).
// Получателей читает транзакция действия: модератор и система видят голоса и подписки всех. Уведомления ставит модуль
// hdn (колокольчик и очередь писем, одно письмо в сутки по идее, кроме "Выпущена"). В уведомлении номер, статус и
// заголовки идеи на языках портала (письмо выбирает язык получателя); текста комментариев и причин там нет.

/** Автор, проголосовавшие и подписчики идеи без повторов (решение 15). */
export async function followersTx(tx: Tx, ideaId: string, authorId: string, opts: { voters: boolean }): Promise<string[]> {
  const subs = await tx.select({ userId: ideaSubscriptions.userId }).from(ideaSubscriptions).where(eq(ideaSubscriptions.ideaId, ideaId));
  const votes = opts.voters ? await tx.select({ userId: ideaVotes.userId }).from(ideaVotes).where(eq(ideaVotes.ideaId, ideaId)) : [];
  return [...new Set([authorId, ...subs.map((r) => r.userId), ...votes.map((r) => r.userId)])];
}

/**
 * Заголовки идеи для уведомлений по языкам и оригинал. Только оригинал и проверенный модератором перевод: в письме
 * пометки "Машинный перевод" нет, поэтому машинный перевод туда не идёт, получатель видит оригинал (итоговая проверка
 * M7, пункт M4).
 */
export async function titlesTx(tx: Tx, ideaId: string): Promise<{ title: string; titles: Partial<Record<Locale, string>> }> {
  const rows = await tx
    .select({ locale: ideaTranslations.locale, title: ideaTranslations.title, status: ideaTranslations.status })
    .from(ideaTranslations)
    .where(and(eq(ideaTranslations.ideaId, ideaId), inArray(ideaTranslations.status, ['original', 'reviewed'])));
  const titles: Partial<Record<Locale, string>> = {};
  for (const row of rows) titles[row.locale] = row.title;
  return { title: rows.find((r) => r.status === 'original')?.title ?? '', titles };
}

type Event = { ideaId: string; number: number; event: IdeaMailEvent; kind: 'idea_published' | 'idea_declined' | 'idea_status' | 'idea_merged' | 'idea_comment_hidden' | 'idea_official_reply' };

async function send(tx: Tx, e: Event, userIds: readonly string[], extra: { status?: IdeaStatus; into?: number; always?: boolean }): Promise<void> {
  const { title, titles } = await titlesTx(tx, e.ideaId);
  await notifyManyTx(tx, {
    kind: e.kind,
    ideaId: e.ideaId,
    userIds,
    payload: { idea: e.number, ...(extra.status ? { status: extra.status } : {}), ...(extra.into ? { into: extra.into } : {}) },
    mail: {
      payload: { template: 'idea_status', event: e.event, ideaId: e.ideaId, number: e.number, title, titles, url: `/ideas/${e.number}`, ...(extra.into ? { into: extra.into } : {}) },
      settingsPath: '/settings',
      always: extra.always ?? false,
      dayKey: e.ideaId,
    },
  });
}

/** Публикация: только автору (решение 15). */
export async function notifyPublishedTx(tx: Tx, idea: { ideaId: string; number: number; authorId: string }): Promise<void> {
  await send(tx, { ideaId: idea.ideaId, number: idea.number, event: 'published', kind: 'idea_published' }, [idea.authorId], { status: 'open' });
}

/** Отклонение: с модерации только автору, после публикации ещё проголосовавшим и подписчикам. */
export async function notifyDeclinedTx(tx: Tx, idea: { ideaId: string; number: number; authorId: string; wasPublished: boolean }): Promise<void> {
  const users = idea.wasPublished ? await followersTx(tx, idea.ideaId, idea.authorId, { voters: true }) : [idea.authorId];
  await send(tx, { ideaId: idea.ideaId, number: idea.number, event: 'declined', kind: 'idea_declined' }, users, { status: 'declined' });
}

/** Объединение: автору, проголосовавшим и подписчикам источника; получатели читаются до переноса голосов. */
export async function mergeRecipientsTx(tx: Tx, ideaId: string, authorId: string): Promise<string[]> {
  return followersTx(tx, ideaId, authorId, { voters: true });
}

export async function notifyMergedTx(tx: Tx, idea: { ideaId: string; number: number }, into: number, users: readonly string[]): Promise<void> {
  await send(tx, { ideaId: idea.ideaId, number: idea.number, event: 'merged', kind: 'idea_merged' }, users, { status: 'merged', into });
}

/**
 * Смена статуса после отбора (решение 15): shortlisted, selected, in_development, released. Автору, проголосовавшим и
 * подписчикам; "Выпущена" письмом всегда (решение 14). Возврат из шорт-листа в голосование не уведомляет.
 */
export async function notifyIdeaStatusTx(tx: Tx, idea: { ideaId: string; number: number; authorId: string; status: 'shortlisted' | 'selected' | 'in_development' | 'released' }): Promise<void> {
  const users = await followersTx(tx, idea.ideaId, idea.authorId, { voters: true });
  await send(tx, { ideaId: idea.ideaId, number: idea.number, event: idea.status, kind: 'idea_status' }, users, { status: idea.status, always: idea.status === 'released' });
}

/** Ответ Smartup: автору и подписчикам, не проголосовавшим (решение 15). */
export async function notifyOfficialReplyTx(tx: Tx, ideaId: string): Promise<void> {
  const [idea] = await tx.select({ number: ideas.number, authorId: ideas.authorId }).from(ideas).where(eq(ideas.ideaId, ideaId)).limit(1);
  if (!idea) return;
  const users = await followersTx(tx, ideaId, idea.authorId, { voters: false });
  await send(tx, { ideaId, number: idea.number, event: 'official_reply', kind: 'idea_official_reply' }, users, {});
}

/** Скрытие комментария: его автору (решение 15). */
export async function notifyCommentHiddenTx(tx: Tx, ideaId: string, number: number, authorId: string): Promise<void> {
  await send(tx, { ideaId, number, event: 'comment_hidden', kind: 'idea_comment_hidden' }, [authorId], {});
}
