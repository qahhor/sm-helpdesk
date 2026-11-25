import 'server-only';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { containsText } from '@/db/contains';
import type { Locale } from '@/i18n/locales';
import type { IdeaStatus, IdeaTranslationStatus } from '../pref';
import { ideaAttachments, ideas, ideaTranslations, ideaVotes } from '../schema';

// Модуль hdi, слой core: идеи на рабочем месте (ТЗ FR-IDEA-15, 8.11; план M7, задача 6, решения 9, 24). Читается в
// транзакции сотрудника: политики отдают сотрудникам все идеи, тексты, голоса и вложения. Разбивка голосов считается
// группировкой по организации: идентификаторы и имена голосовавших из базы не выбираются вовсе (решение 24).

export const STAFF_PAGE = 30;

export type StaffIdeaRow = {
  ideaId: string;
  number: number;
  orgId: string;
  status: IdeaStatus;
  title: string;
  locale: Locale;
  authorName: string;
  voteCount: number;
  orgCount: number;
  commentCount: number;
  moduleId: string | null;
  createdOn: Date;
};

export type StaffListQuery =
  | { tab: 'moderation' }
  | { tab: 'all'; status: IdeaStatus | null; moduleId: string | null; orgIds: string[] | null; q: string | null; after: number | null };

/** Список идей для сотрудника: "Модерация" от старых к новым, "Все" от новых к старым с фильтрами (решение 22 для сотрудника). */
export async function staffListTx(tx: Tx, query: StaffListQuery): Promise<{ rows: StaffIdeaRow[]; next: number | null }> {
  const where =
    query.tab === 'moderation'
      ? eq(ideas.status, 'pending_review')
      : and(
          query.status ? eq(ideas.status, query.status) : undefined,
          query.moduleId ? eq(ideas.moduleId, query.moduleId) : undefined,
          query.orgIds ? inArray(ideas.orgId, query.orgIds.length > 0 ? query.orgIds : ['00000000-0000-0000-0000-000000000000']) : undefined,
          query.q ? inArray(ideas.ideaId, tx.select({ id: ideaTranslations.ideaId }).from(ideaTranslations).where(containsText(ideaTranslations.title, query.q))) : undefined,
          query.after ? lt(ideas.number, query.after) : undefined,
        );
  const rows = await tx
    .select()
    .from(ideas)
    .where(where)
    .orderBy(...(query.tab === 'moderation' ? [asc(ideas.createdOn), asc(ideas.number)] : [desc(ideas.number)]))
    .limit(STAFF_PAGE + 1);
  const page = rows.slice(0, STAFF_PAGE);
  if (page.length === 0) return { rows: [], next: null };
  const originals = await tx
    .select({ ideaId: ideaTranslations.ideaId, title: ideaTranslations.title, locale: ideaTranslations.locale })
    .from(ideaTranslations)
    .where(and(inArray(ideaTranslations.ideaId, page.map((row) => row.ideaId)), eq(ideaTranslations.status, 'original')));
  const byId = new Map(originals.map((o) => [o.ideaId, o]));
  return {
    rows: page.map((row) => ({
      ideaId: row.ideaId,
      number: row.number,
      orgId: row.orgId,
      status: row.status,
      title: byId.get(row.ideaId)?.title ?? '',
      locale: byId.get(row.ideaId)?.locale ?? row.originalLocale,
      authorName: row.authorName,
      voteCount: row.voteCount,
      orgCount: row.orgCount,
      commentCount: row.commentCount,
      moduleId: row.moduleId,
      createdOn: row.createdOn,
    })),
    next: query.tab === 'all' && rows.length > STAFF_PAGE ? (page[page.length - 1]?.number ?? null) : null,
  };
}

export type StaffText = { locale: Locale; title: string; body: string; status: IdeaTranslationStatus; isMachine: boolean };

export type StaffIdeaDetail = {
  idea: typeof ideas.$inferSelect;
  texts: StaffText[];
  attachments: { attachmentId: string; fileName: string; mime: string; scanStatus: string }[];
  mergedInto: number | null;
};

/** Идея со всеми текстами (оригинал первым) и вложениями для карточки сотрудника. */
export async function staffDetailTx(tx: Tx, number: number): Promise<StaffIdeaDetail | null> {
  const [idea] = await tx.select().from(ideas).where(eq(ideas.number, number)).limit(1);
  if (!idea) return null;
  const texts = await tx
    .select({ locale: ideaTranslations.locale, title: ideaTranslations.title, body: ideaTranslations.body, status: ideaTranslations.status, isMachine: ideaTranslations.isMachine })
    .from(ideaTranslations)
    .where(eq(ideaTranslations.ideaId, idea.ideaId))
    .orderBy(sql`${ideaTranslations.status} <> 'original'`, asc(ideaTranslations.createdOn));
  const attachments = await tx
    .select({ attachmentId: ideaAttachments.attachmentId, fileName: ideaAttachments.fileName, mime: ideaAttachments.mime, scanStatus: ideaAttachments.scanStatus })
    .from(ideaAttachments)
    .where(eq(ideaAttachments.ideaId, idea.ideaId))
    .orderBy(asc(ideaAttachments.createdOn));
  const mergedInto = idea.mergedIntoId ? ((await tx.select({ number: ideas.number }).from(ideas).where(eq(ideas.ideaId, idea.mergedIntoId)).limit(1))[0]?.number ?? null) : null;
  return { idea, texts, attachments, mergedInto };
}

/** Голоса идеи по организациям: только организация и число, без голосовавших (решение 24). */
export async function votesByOrgTx(tx: Tx, ideaId: string): Promise<{ orgId: string; votes: number }[]> {
  return tx
    .select({ orgId: ideaVotes.orgId, votes: sql<number>`count(*)::int` })
    .from(ideaVotes)
    .where(eq(ideaVotes.ideaId, ideaId))
    .groupBy(ideaVotes.orgId)
    .orderBy(desc(sql`count(*)`), asc(ideaVotes.orgId));
}

/** Когда поданы идеи, которые ждут модерации (сводка модерации, решение 15). */
export async function pendingSinceTx(tx: Tx): Promise<Date[]> {
  const rows = await tx.select({ createdOn: ideas.createdOn }).from(ideas).where(eq(ideas.status, 'pending_review'));
  return rows.map((row) => row.createdOn);
}
