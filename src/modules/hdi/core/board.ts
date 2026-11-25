import 'server-only';
import { and, asc, desc, eq, inArray, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import type { Tx } from '@/db/client';
import { containsText } from '@/db/contains';
import type { Locale } from '@/i18n/locales';
import type { BoardTab, IdeaStatus, VoteMode } from '../pref';
import { BOARD_PAGE, BOARD_TAB_STATUSES, VOTING_STATUSES } from '../pref';
import { ideaAttachments, ideaCycles, ideas, ideaSubscriptions, ideaTranslations, ideaVotes } from '../schema';

// Модуль hdi, слой core: доска идей и страница идеи (ТЗ FR-IDEA-04, 06, 14, 8.3; план M7, задача 5, решения 2, 6, 7,
// 11, 22). Читается в транзакции актора: клиенту политика отдаёт только видимые идеи, видимые тексты (без устаревших и
// не прошедших сверку переводов), свои голоса и подписки. Организация автора идёт только снимком author_org_name,
// который есть лишь при включённом показе (решение 7); разбивки голосов здесь нет (решение 24).

export type BoardCard = {
  ideaId: string;
  number: number;
  status: IdeaStatus;
  /** Счётчик выбранного способа подсчёта (решение 3): голоса или организации. */
  score: number;
  voteCount: number;
  commentCount: number;
  moduleId: string | null;
  selectedCycle: string | null;
  releasedIn: string | null;
  title: string;
  locale: Locale;
  isMachine: boolean;
  voted: boolean;
};

type TextRow = { ideaId: string; locale: Locale; title: string; body: string; isMachine: boolean; status: string };

/** Видимые тексты идей: на языке пользователя, иначе оригинал (FR-IDEA-13). */
function pickText(texts: readonly TextRow[], ideaId: string, locale: Locale): TextRow | undefined {
  const own = texts.filter((t) => t.ideaId === ideaId);
  return own.find((t) => t.locale === locale) ?? own.find((t) => t.status === 'original');
}

const HIDDEN_TEXT = ['outdated', 'rejected'] as const;

async function cardsOf(tx: Tx, rows: (typeof ideas.$inferSelect)[], locale: Locale, userId: string | null, mode: VoteMode): Promise<BoardCard[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.ideaId);
  const texts = await tx
    .select({ ideaId: ideaTranslations.ideaId, locale: ideaTranslations.locale, title: ideaTranslations.title, body: sql<string>`''`, isMachine: ideaTranslations.isMachine, status: ideaTranslations.status })
    .from(ideaTranslations)
    .where(and(inArray(ideaTranslations.ideaId, ids), notInArray(ideaTranslations.status, [...HIDDEN_TEXT])));
  const voted = userId
    ? new Set((await tx.select({ ideaId: ideaVotes.ideaId }).from(ideaVotes).where(and(inArray(ideaVotes.ideaId, ids), eq(ideaVotes.userId, userId)))).map((r) => r.ideaId))
    : new Set<string>();
  const out: BoardCard[] = [];
  for (const row of rows) {
    const text = pickText(texts, row.ideaId, locale);
    if (!text) continue;
    out.push({
      ideaId: row.ideaId,
      number: row.number,
      status: row.status,
      score: mode === 'per_org' ? row.orgCount : row.voteCount,
      voteCount: row.voteCount,
      commentCount: row.commentCount,
      moduleId: row.moduleId,
      selectedCycle: row.selectedCycle,
      releasedIn: row.releasedIn,
      title: text.title,
      locale: text.locale,
      isMachine: text.isMachine,
      voted: voted.has(row.ideaId),
    });
  }
  return out;
}

/** Порядок вкладки и условие "после идеи с номером after" для постраничного вывода по ключу (решение 22). */
function orderOf(tx: Tx, tab: BoardTab, mode: VoteMode, after: number | null): { order: SQL[]; cursor: SQL | undefined } {
  // Значение колонки у идеи-курсора: подзапрос к той же таблице под другим именем, видимость даёт та же политика.
  const cursorIdea = alias(ideas, 'cursor_idea');
  const ref = (pick: (t: typeof cursorIdea) => PgColumn) => sql`(${tx.select({ value: pick(cursorIdea) }).from(cursorIdea).where(eq(cursorIdea.number, after ?? 0))})`;
  if (tab === 'popular') {
    const count = mode === 'per_org' ? ideas.orgCount : ideas.voteCount;
    const column = (t: typeof cursorIdea) => (mode === 'per_org' ? t.orgCount : t.voteCount);
    return {
      order: [desc(count), asc(ideas.createdOn), asc(ideas.number)],
      cursor: after === null ? undefined : sql`(${count} < ${ref(column)} or (${count} = ${ref(column)} and (${ideas.createdOn}, ${ideas.number}) > (${ref((t) => t.createdOn)}, ${after})))`,
    };
  }
  if (tab === 'released') {
    return {
      order: [desc(ideas.releasedOn), desc(ideas.number)],
      cursor: after === null ? undefined : sql`(${ideas.releasedOn}, ${ideas.number}) < (${ref((t) => t.releasedOn)}, ${after})`,
    };
  }
  return {
    order: [desc(ideas.publishedOn), desc(ideas.number)],
    cursor: after === null ? undefined : sql`(${ideas.publishedOn}, ${ideas.number}) < (${ref((t) => t.publishedOn)}, ${after})`,
  };
}

export type BoardQuery = { tab: BoardTab; moduleId: string | null; q: string | null; after: number | null; locale: Locale };

/** Страница вкладки доски: до BOARD_PAGE карточек и номер последней для следующей страницы. */
export async function boardTx(tx: Tx, query: BoardQuery, userId: string | null, mode: VoteMode): Promise<{ items: BoardCard[]; next: number | null }> {
  const { order, cursor } = orderOf(tx, query.tab, mode, query.after);
  // Поиск по заголовку на языке пользователя и по оригиналу (решение 22): знаки шаблона экранирует containsText.
  const search = query.q
    ? inArray(
        ideas.ideaId,
        tx
          .select({ id: ideaTranslations.ideaId })
          .from(ideaTranslations)
          .where(
            and(
              containsText(ideaTranslations.title, query.q),
              notInArray(ideaTranslations.status, [...HIDDEN_TEXT]),
              or(eq(ideaTranslations.locale, query.locale), eq(ideaTranslations.status, 'original')),
            ),
          ),
      )
    : undefined;
  const rows = await tx
    .select()
    .from(ideas)
    .where(and(inArray(ideas.status, [...BOARD_TAB_STATUSES[query.tab]]), query.moduleId ? eq(ideas.moduleId, query.moduleId) : undefined, search, cursor))
    .orderBy(...order)
    .limit(BOARD_PAGE + 1);
  const page = rows.slice(0, BOARD_PAGE);
  const items = await cardsOf(tx, page, query.locale, userId, mode);
  return { items, next: rows.length > BOARD_PAGE ? (page[page.length - 1]?.number ?? null) : null };
}

export type IdeaText = { locale: Locale; title: string; body: string; isMachine: boolean };

export type IdeaView = {
  ideaId: string;
  number: number;
  status: IdeaStatus;
  score: number;
  voteCount: number;
  commentCount: number;
  authorName: string;
  /** Название организации автора: только при включённом показе (решение 7). */
  orgName: string | null;
  moduleId: string | null;
  publishedOn: Date | null;
  selectedCycle: string | null;
  releasedIn: string | null;
  releasedOn: string | null;
  /** Причина отклонения: только автору (решение 5). */
  declineReason: string | null;
  /** Номер идеи, с которой объединена эта (решение 6). */
  mergedInto: number | null;
  /** Показанный текст: перевод на язык пользователя или оригинал. */
  text: IdeaText;
  original: IdeaText;
  /** Перевода на язык пользователя нет (ещё не готов, не прошёл сверку или AI-обработка выключена, решение 12). */
  translationUnavailable: boolean;
  attachments: { attachmentId: string; fileName: string; mime: string }[];
  voted: boolean;
  subscribed: boolean;
  isAuthor: boolean;
  /** Своя идея: показ организации (переключатель решения 7). Чужая: false. */
  showOrg: boolean;
  canVote: boolean;
  canEdit: boolean;
  canFollow: boolean;
};

/** Страница идеи для клиента. Невидимая актору идея: null (страница "Не найдено"). */
export async function ideaViewTx(tx: Tx, number: number, locale: Locale, userId: string, mode: VoteMode): Promise<IdeaView | null> {
  const [idea] = await tx.select().from(ideas).where(eq(ideas.number, number)).limit(1);
  if (!idea) return null;
  const texts = await tx
    .select({ ideaId: ideaTranslations.ideaId, locale: ideaTranslations.locale, title: ideaTranslations.title, body: ideaTranslations.body, isMachine: ideaTranslations.isMachine, status: ideaTranslations.status })
    .from(ideaTranslations)
    .where(and(eq(ideaTranslations.ideaId, idea.ideaId), notInArray(ideaTranslations.status, [...HIDDEN_TEXT])));
  const original = texts.find((t) => t.status === 'original');
  if (!original) return null;
  const shown = pickText(texts, idea.ideaId, locale) ?? original;
  const strip = (t: TextRow): IdeaText => ({ locale: t.locale, title: t.title, body: t.body, isMachine: t.isMachine });
  const [vote] = await tx.select({ id: ideaVotes.ideaId }).from(ideaVotes).where(and(eq(ideaVotes.ideaId, idea.ideaId), eq(ideaVotes.userId, userId))).limit(1);
  const [sub] = await tx
    .select({ id: ideaSubscriptions.ideaId })
    .from(ideaSubscriptions)
    .where(and(eq(ideaSubscriptions.ideaId, idea.ideaId), eq(ideaSubscriptions.userId, userId)))
    .limit(1);
  // Чужим политика отдаёт только чистые вложения опубликованной идеи; свои незаконченные загрузки не показываются.
  const files = await tx
    .select({ attachmentId: ideaAttachments.attachmentId, fileName: ideaAttachments.fileName, mime: ideaAttachments.mime })
    .from(ideaAttachments)
    .where(and(eq(ideaAttachments.ideaId, idea.ideaId), eq(ideaAttachments.scanStatus, 'clean')))
    .orderBy(asc(ideaAttachments.createdOn));
  const mergedInto = idea.mergedIntoId
    ? ((await tx.select({ number: ideas.number }).from(ideas).where(eq(ideas.ideaId, idea.mergedIntoId)).limit(1))[0]?.number ?? null)
    : null;
  const isAuthor = idea.authorId === userId;
  const voting = (VOTING_STATUSES as readonly string[]).includes(idea.status);
  return {
    ideaId: idea.ideaId,
    number: idea.number,
    status: idea.status,
    score: mode === 'per_org' ? idea.orgCount : idea.voteCount,
    voteCount: idea.voteCount,
    commentCount: idea.commentCount,
    authorName: idea.authorName,
    orgName: idea.showOrg ? idea.authorOrgName : null,
    moduleId: idea.moduleId,
    publishedOn: idea.publishedOn,
    selectedCycle: idea.selectedCycle,
    releasedIn: idea.releasedIn,
    releasedOn: idea.releasedOn,
    declineReason: isAuthor ? idea.declineReason : null,
    mergedInto,
    text: strip(shown),
    original: strip(original),
    translationUnavailable: original.locale !== locale && shown.locale !== locale,
    attachments: files,
    voted: Boolean(vote),
    subscribed: Boolean(sub),
    isAuthor,
    showOrg: isAuthor && idea.showOrg,
    canVote: voting || (isAuthor && idea.status === 'pending_review'),
    canEdit: isAuthor && idea.status === 'pending_review',
    canFollow: idea.status !== 'declined' && idea.status !== 'merged',
  };
}

/** Последний отбор с выбором и карточка выбранной идеи ("Идея месяца", 8.3). */
export async function ideaOfMonthTx(tx: Tx, locale: Locale, userId: string | null, mode: VoteMode): Promise<{ cycle: string; card: BoardCard } | null> {
  const [cycle] = await tx
    .select({ cycle: ideaCycles.cycle, selectedIdeaId: ideaCycles.selectedIdeaId })
    .from(ideaCycles)
    .where(eq(ideaCycles.status, 'decided'))
    .orderBy(desc(ideaCycles.cycle))
    .limit(1);
  if (!cycle?.selectedIdeaId) return null;
  const rows = await tx.select().from(ideas).where(eq(ideas.ideaId, cycle.selectedIdeaId)).limit(1);
  const [card] = await cardsOf(tx, rows, locale, userId, mode);
  return card ? { cycle: cycle.cycle, card } : null;
}

/** Подписка на видимую идею; отклонённая и объединённая: false (политика вставки отказала бы). */
export async function setFollowTx(tx: Tx, ideaId: string, userId: string, follow: boolean): Promise<void> {
  if (follow) await tx.insert(ideaSubscriptions).values({ ideaId, userId }).onConflictDoNothing();
  else await tx.delete(ideaSubscriptions).where(and(eq(ideaSubscriptions.ideaId, ideaId), eq(ideaSubscriptions.userId, userId)));
}
