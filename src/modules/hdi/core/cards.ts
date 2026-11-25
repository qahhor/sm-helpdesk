import 'server-only';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import type { IdeaStatus } from '../pref';
import { ideas, ideaTranslations, ideaVotes } from '../schema';

// Модуль hdi, слой core: карточки идей для списков (похожие идеи, доска). Читается в транзакции актора: клиенту
// политика отдаёт только видимые идеи и видимые тексты (без устаревших и не прошедших сверку переводов). Заголовок на
// языке пользователя, если такой текст есть, иначе оригинал. Автора, организацию и разбивку голосов карточка не несёт.

export type IdeaCard = {
  ideaId: string;
  number: number;
  status: IdeaStatus;
  voteCount: number;
  orgCount: number;
  title: string;
  /** Язык показанного заголовка и признак машинного перевода (пометка "Машинный перевод", FR-IDEA-13). */
  locale: Locale;
  isMachine: boolean;
  voted: boolean;
};

/** Карточки идей в порядке ideaIds; невидимые актору и статусы из exclude пропускаются. */
export async function ideaCardsTx(tx: Tx, ideaIds: readonly string[], opts: { locale: Locale; userId: string | null; exclude?: readonly IdeaStatus[] }): Promise<IdeaCard[]> {
  if (ideaIds.length === 0) return [];
  const rows = await tx
    .select({ ideaId: ideas.ideaId, number: ideas.number, status: ideas.status, voteCount: ideas.voteCount, orgCount: ideas.orgCount, originalLocale: ideas.originalLocale })
    .from(ideas)
    .where(opts.exclude && opts.exclude.length > 0 ? and(inArray(ideas.ideaId, [...ideaIds]), notInArray(ideas.status, [...opts.exclude])) : inArray(ideas.ideaId, [...ideaIds]));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.ideaId);
  const texts = await tx
    .select({ ideaId: ideaTranslations.ideaId, locale: ideaTranslations.locale, title: ideaTranslations.title, isMachine: ideaTranslations.isMachine, status: ideaTranslations.status })
    .from(ideaTranslations)
    .where(and(inArray(ideaTranslations.ideaId, ids), notInArray(ideaTranslations.status, ['outdated', 'rejected'])));
  // Свой голос одним запросом на страницу (решение 22): клиенту политика отдаёт только его голоса.
  const voted = opts.userId
    ? new Set((await tx.select({ ideaId: ideaVotes.ideaId }).from(ideaVotes).where(and(inArray(ideaVotes.ideaId, ids), eq(ideaVotes.userId, opts.userId)))).map((r) => r.ideaId))
    : new Set<string>();
  const byId = new Map(rows.map((row) => [row.ideaId, row]));
  const out: IdeaCard[] = [];
  for (const id of ideaIds) {
    const row = byId.get(id);
    if (!row) continue;
    const own = texts.filter((t) => t.ideaId === id);
    const text = own.find((t) => t.locale === opts.locale) ?? own.find((t) => t.status === 'original') ?? own[0];
    if (!text) continue;
    out.push({ ideaId: id, number: row.number, status: row.status, voteCount: row.voteCount, orgCount: row.orgCount, title: text.title, locale: text.locale, isMachine: text.isMachine, voted: voted.has(id) });
  }
  return out;
}
