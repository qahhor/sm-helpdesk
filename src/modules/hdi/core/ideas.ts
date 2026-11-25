import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { ClientActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import { HdiError } from '../error';
import { ideaRef } from '../pref';
import { ideaAttachments, ideas, ideaSubscriptions, ideaTranslations, ideaVotes } from '../schema';
import { textHash } from '../util';

// Модуль hdi, слой core: подача идеи и правка автором (план M7, задача 2, решения 1, 4, 5, 7, 10, 15). Запросы идут
// в транзакции актора клиента: автор и организация из актора, остальное проверяют политики и триггеры миграции 0079.

export type IdeaRow = typeof ideas.$inferSelect;

/** Видимая актору идея по номеру. Чужая на модерации не находится: политика RLS. */
export async function ideaByNumberTx(tx: Tx, number: number): Promise<IdeaRow | null> {
  const [row] = await tx.select().from(ideas).where(eq(ideas.number, number)).limit(1);
  return row ?? null;
}

export type NewIdea = {
  title: string;
  body: string;
  moduleId: string | null;
  showOrg: boolean;
  locale: Locale;
  attachmentIds: readonly string[];
  /** Имя автора и название его организации снимком (решение 7): из контекста сессии, база сверяет их сама. */
  authorName: string;
  orgName: string;
  /** Виды находок проверки текста, которые клиент видел и отправил всё равно (решение 9): для журнала. */
  findings: readonly string[];
};

/** Прикрепляет свои загрузки к своей идее на модерации. Чужая, уже прикреплённая или неизвестная: not_found. */
async function attachUploadsTx(tx: Tx, actor: ClientActor, ideaId: string, attachmentIds: readonly string[]): Promise<void> {
  if (attachmentIds.length === 0) return;
  const unique = [...new Set(attachmentIds)];
  const attached = await tx
    .update(ideaAttachments)
    .set({ ideaId })
    .where(and(inArray(ideaAttachments.attachmentId, unique), eq(ideaAttachments.uploaderId, actor.userId), isNull(ideaAttachments.ideaId)))
    .returning({ id: ideaAttachments.attachmentId, scanStatus: ideaAttachments.scanStatus });
  if (attached.length !== unique.length || attached.some((row) => row.scanStatus === 'infected' || row.scanStatus === 'rejected')) throw new HdiError('not_found');
}

/**
 * Новая идея на модерации (решение 11 ТЗ): строка идеи, оригинал текста строкой переводов на языке автора, загрузки,
 * голос автора (решение 4) и его подписка (решение 15), запись журнала без текста.
 */
export async function createIdeaTx(tx: Tx, actor: ClientActor, data: NewIdea): Promise<{ ideaId: string; number: number }> {
  const [idea] = await tx
    .insert(ideas)
    .values({
      orgId: actor.orgId,
      authorId: actor.userId,
      moduleId: data.moduleId,
      authorName: data.authorName,
      authorOrgName: data.showOrg ? data.orgName : null,
      showOrg: data.showOrg,
      originalLocale: data.locale,
    })
    .returning({ ideaId: ideas.ideaId, number: ideas.number });
  if (!idea) throw new HdiError('forbidden');
  await tx.insert(ideaTranslations).values({ ideaId: idea.ideaId, locale: data.locale, title: data.title, body: data.body, sourceHash: textHash(data.title, data.body) });
  await attachUploadsTx(tx, actor, idea.ideaId, data.attachmentIds);
  await tx.insert(ideaVotes).values({ orgId: actor.orgId, ideaId: idea.ideaId, userId: actor.userId });
  await tx.insert(ideaSubscriptions).values({ ideaId: idea.ideaId, userId: actor.userId });
  await writeAudit(tx, {
    action: 'idea.submitted',
    objectType: 'idea',
    objectId: idea.ideaId,
    orgId: actor.orgId,
    diff: { number: ideaRef(idea.number), moduleId: data.moduleId, showOrg: data.showOrg, attachments: data.attachmentIds.length, findings: [...data.findings] },
  });
  return idea;
}

/** Своя идея по номеру; чужая не находится (not_found), своя не на модерации: not_editable. */
async function ownPendingTx(tx: Tx, actor: ClientActor, number: number): Promise<IdeaRow> {
  const idea = await ideaByNumberTx(tx, number);
  if (!idea || idea.authorId !== actor.userId) throw new HdiError('not_found');
  if (idea.status !== 'pending_review') throw new HdiError('not_editable');
  return idea;
}

/** Правка своей идеи на модерации (решение 5): текст оригинала, модуль и показ организации. В журнал только отпечатки текста. */
export async function editOwnIdeaTx(
  tx: Tx,
  actor: ClientActor,
  number: number,
  data: { title: string; body: string; moduleId: string | null; showOrg: boolean; orgName: string },
): Promise<void> {
  const idea = await ownPendingTx(tx, actor, number);
  const digest = textHash(data.title, data.body);
  const updated = await tx
    .update(ideaTranslations)
    .set({ title: data.title, body: data.body, sourceHash: digest })
    .where(and(eq(ideaTranslations.ideaId, idea.ideaId), eq(ideaTranslations.status, 'original')))
    .returning({ id: ideaTranslations.translationId });
  if (updated.length === 0) throw new HdiError('not_editable');
  await tx
    .update(ideas)
    .set({ moduleId: data.moduleId, showOrg: data.showOrg, authorOrgName: data.showOrg ? data.orgName : null })
    .where(eq(ideas.ideaId, idea.ideaId));
  await writeAudit(tx, { action: 'idea.edited', objectType: 'idea', objectId: idea.ideaId, orgId: actor.orgId, diff: { number: ideaRef(number), textDigest: digest, moduleId: data.moduleId, showOrg: data.showOrg } });
}

/** Показ названия организации меняет автор в любой момент (FR-IDEA-06, решение 7). */
export async function setShowOrgTx(tx: Tx, actor: ClientActor, number: number, showOrg: boolean, orgName: string): Promise<void> {
  const idea = await ideaByNumberTx(tx, number);
  if (!idea || idea.authorId !== actor.userId) throw new HdiError('not_found');
  if (idea.orgId !== actor.orgId) throw new HdiError('forbidden');
  if (idea.showOrg === showOrg) return;
  await tx.update(ideas).set({ showOrg, authorOrgName: showOrg ? orgName : null }).where(eq(ideas.ideaId, idea.ideaId));
  await writeAudit(tx, { action: 'idea.org_visibility_changed', objectType: 'idea', objectId: idea.ideaId, orgId: actor.orgId, diff: { number: ideaRef(number), showOrg } });
}
