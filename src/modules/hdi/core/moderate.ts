import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import { findInText } from '@/modules/hdk/api/text-checks';
import { removeIdeaFromIndexTx } from '@/modules/hdk/api/idea-search';
import { HdiError } from '../error';
import { BLOCKING_FINDINGS, type IdeaStatus, ideaRef, MERGE_TARGET_STATUSES, transitionBy } from '../pref';
import { ideas, ideaSubscriptions, ideaTranslations } from '../schema';
import { textHash } from '../util';
import { ideaByNumberTx, type IdeaRow } from './ideas';
import { mergeRecipientsTx, notifyDeclinedTx, notifyMergedTx, notifyPublishedTx } from './notices';

// Модуль hdi, слой core: модерация идеи (ТЗ FR-IDEA-03, S6 (2); план M7, задача 4, решения 5, 6, 9, 11, 19, 23).
// Запросы в транзакции модератора (product, admin): права и переходы ещё раз проверяют политики и триггер
// t_hdi_ideas_guard. Каждое действие пишет журнал аудита той же транзакцией, без текста идеи (только отпечатки).

/** Оригинал текста идеи. */
export async function originalTextTx(tx: Tx, ideaId: string): Promise<{ locale: Locale; title: string; body: string } | null> {
  const [row] = await tx
    .select({ locale: ideaTranslations.locale, title: ideaTranslations.title, body: ideaTranslations.body })
    .from(ideaTranslations)
    .where(and(eq(ideaTranslations.ideaId, ideaId), eq(ideaTranslations.status, 'original')))
    .limit(1);
  return row ?? null;
}

/** Блокирующие находки в заголовке и описании (решение 9): телефон, email, ИНН, ПИНФЛ, адрес сервера. */
export function blockingFindings(text: { title: string; body: string }): string[] {
  const blocking = new Set<string>(BLOCKING_FINDINGS);
  return [...new Set([...findInText(text.title), ...findInText(text.body)].map((hit) => hit.kind).filter((kind) => blocking.has(kind)))];
}

async function load(tx: Tx, number: number): Promise<IdeaRow> {
  const idea = await ideaByNumberTx(tx, number);
  if (!idea) throw new HdiError('not_found');
  return idea;
}

function requireTransition(from: IdeaStatus, to: IdeaStatus): void {
  if (transitionBy(from, to) !== 'moderator') throw new HdiError('bad_transition');
}

/**
 * Публикация с модерации (решение 5): статус open, дату публикации и модератора ставит база. Блокирующая находка без
 * отметки "Проверено" не публикуется (решение 9). Возвращает идею для заданий перевода и индекса.
 */
export async function publishTx(tx: Tx, number: number, findingsChecked: boolean): Promise<IdeaRow> {
  const idea = await load(tx, number);
  requireTransition(idea.status, 'open');
  const original = await originalTextTx(tx, idea.ideaId);
  if (!original) throw new HdiError('not_found');
  const findings = blockingFindings(original);
  if (findings.length > 0 && !findingsChecked && !idea.findingsChecked) throw new HdiError('findings_unchecked');
  const updated = await tx
    .update(ideas)
    .set({ status: 'open', findingsChecked: idea.findingsChecked || (findings.length > 0 && findingsChecked) })
    .where(and(eq(ideas.ideaId, idea.ideaId), eq(ideas.status, 'pending_review')))
    .returning({ id: ideas.ideaId });
  if (updated.length === 0) throw new HdiError('bad_transition');
  await writeAudit(tx, { action: 'idea.published', objectType: 'idea', objectId: idea.ideaId, orgId: idea.orgId, diff: { number: ideaRef(number), from: idea.status, to: 'open', findings } });
  // Автору: колокольчик и письмо той же транзакцией (задача 8, решение 15).
  await notifyPublishedTx(tx, idea);
  return idea;
}

/** Правка заголовка, описания и модуля модератором до публикации (решение 5). В журнал факт правки и отпечатки текста. */
export async function moderatorEditTx(tx: Tx, number: number, data: { title: string; body: string; moduleId: string | null }): Promise<IdeaRow> {
  const idea = await load(tx, number);
  if (idea.status !== 'pending_review') throw new HdiError('not_editable');
  const original = await originalTextTx(tx, idea.ideaId);
  if (!original) throw new HdiError('not_found');
  const digest = textHash(data.title, data.body);
  await tx
    .update(ideaTranslations)
    .set({ title: data.title, body: data.body, sourceHash: digest })
    .where(and(eq(ideaTranslations.ideaId, idea.ideaId), eq(ideaTranslations.status, 'original')));
  if (data.moduleId !== idea.moduleId) await tx.update(ideas).set({ moduleId: data.moduleId }).where(eq(ideas.ideaId, idea.ideaId));
  await writeAudit(tx, {
    action: 'idea.moderator_edited',
    objectType: 'idea',
    objectId: idea.ideaId,
    orgId: idea.orgId,
    diff: { number: ideaRef(number), textDigestFrom: textHash(original.title, original.body), textDigestTo: digest, moduleFrom: idea.moduleId, moduleTo: data.moduleId },
  });
  return idea;
}

/** Отклонение с причиной (решения 5, 18): из модерации и из любого опубликованного статуса по таблице переходов. */
export async function declineTx(tx: Tx, number: number, reason: string): Promise<IdeaRow> {
  const idea = await load(tx, number);
  requireTransition(idea.status, 'declined');
  const updated = await tx
    .update(ideas)
    .set({ status: 'declined', declineReason: reason })
    .where(and(eq(ideas.ideaId, idea.ideaId), eq(ideas.status, idea.status)))
    .returning({ id: ideas.ideaId });
  if (updated.length === 0) throw new HdiError('bad_transition');
  // Похожими клиент её больше не найдёт сразу, не дожидаясь задания (решение 23).
  await removeIdeaFromIndexTx(tx, idea.ideaId);
  await writeAudit(tx, { action: 'idea.declined', objectType: 'idea', objectId: idea.ideaId, orgId: idea.orgId, diff: { number: ideaRef(number), from: idea.status, to: 'declined' } });
  await notifyDeclinedTx(tx, { ...idea, wasPublished: idea.publishedOn !== null });
  return idea;
}

/**
 * Объединение идеи A в опубликованную B (решение 6): голоса и подписки переносятся одним оператором без задвоения
 * (ON CONFLICT DO NOTHING), затем удаляются у A; счётчики пересчитывает триггер. A получает merged и ссылку на B,
 * строки A снимаются из индекса той же транзакцией. Цепочек нет: B не на модерации, не отклонена и не объединена.
 *
 * Сначала строка A блокируется (FOR NO KEY UPDATE, итоговая проверка M7, пункт M1): голос, начатый раньше, успевает
 * зафиксироваться и переносится, а голос во время объединения ждёт и отклоняется триггером (A уже merged). Голоса
 * переносит только функция базы app.hdi_merge_votes после смены статуса (пункт M2, решение 0065): своих политик
 * вставки и удаления голосов у модератора нет.
 */
export async function mergeTx(tx: Tx, number: number, into: number): Promise<{ source: IdeaRow; target: IdeaRow; moved: number }> {
  await tx.select({ id: ideas.ideaId }).from(ideas).where(eq(ideas.number, number)).for('no key update');
  const source = await load(tx, number);
  requireTransition(source.status, 'merged');
  const target = await ideaByNumberTx(tx, into);
  if (!target || target.ideaId === source.ideaId || !(MERGE_TARGET_STATUSES as readonly string[]).includes(target.status)) throw new HdiError('bad_merge_target');
  // Получатели уведомления читаются до переноса: проголосовавшие за источник (решение 15).
  const recipients = await mergeRecipientsTx(tx, source.ideaId, source.authorId);
  await tx.execute(sql`
    insert into ${ideaSubscriptions} (idea_id, user_id)
    select ${target.ideaId}::uuid, user_id from ${ideaSubscriptions} where idea_id = ${source.ideaId}::uuid
    on conflict do nothing`);
  await tx.delete(ideaSubscriptions).where(eq(ideaSubscriptions.ideaId, source.ideaId));
  const updated = await tx
    .update(ideas)
    .set({ status: 'merged', mergedIntoId: target.ideaId })
    .where(and(eq(ideas.ideaId, source.ideaId), eq(ideas.status, source.status)))
    .returning({ id: ideas.ideaId });
  if (updated.length === 0) throw new HdiError('bad_transition');
  const [moved] = await tx.execute<{ n: number }>(sql`select app.hdi_merge_votes(${source.ideaId}::uuid) as n`).then((r) => r.rows);
  const movedVotes = Number(moved?.n ?? 0);
  await removeIdeaFromIndexTx(tx, source.ideaId);
  await writeAudit(tx, {
    action: 'idea.merged',
    objectType: 'idea',
    objectId: source.ideaId,
    orgId: source.orgId,
    diff: { number: ideaRef(number), into: ideaRef(target.number), from: source.status, to: 'merged', movedVotes },
  });
  await notifyMergedTx(tx, source, target.number, recipients);
  return { source, target, moved: movedVotes };
}

/** Правка перевода модератором (решение 11): текст проверен человеком, статус reviewed, пометки машинного нет. */
export async function reviewTranslationTx(tx: Tx, number: number, locale: Locale, text: { title: string; body: string }): Promise<IdeaRow> {
  const idea = await load(tx, number);
  if (idea.status === 'pending_review' || idea.status === 'declined' || idea.status === 'merged') throw new HdiError('not_editable');
  const original = await originalTextTx(tx, idea.ideaId);
  if (!original) throw new HdiError('not_found');
  if (original.locale === locale) throw new HdiError('invalid_input');
  const sourceHash = textHash(original.title, original.body);
  await tx
    .insert(ideaTranslations)
    .values({ ideaId: idea.ideaId, locale, title: text.title, body: text.body, isMachine: false, status: 'reviewed', sourceHash })
    .onConflictDoUpdate({ target: [ideaTranslations.ideaId, ideaTranslations.locale], set: { title: text.title, body: text.body, isMachine: false, status: 'reviewed', sourceHash } });
  await writeAudit(tx, { action: 'idea.translation_reviewed', objectType: 'idea', objectId: idea.ideaId, orgId: idea.orgId, diff: { number: ideaRef(number), locale, textDigest: textHash(text.title, text.body) } });
  return idea;
}

/** Переводы идеи по языкам: статус и отпечаток оригинала, с которого сделан перевод (для задания ideas.translate). */
export async function translationStateTx(tx: Tx, ideaId: string): Promise<{ locale: Locale; status: string; sourceHash: string }[]> {
  return tx
    .select({ locale: ideaTranslations.locale, status: ideaTranslations.status, sourceHash: ideaTranslations.sourceHash })
    .from(ideaTranslations)
    .where(and(eq(ideaTranslations.ideaId, ideaId), inArray(ideaTranslations.status, ['machine', 'reviewed', 'outdated', 'rejected'])));
}
