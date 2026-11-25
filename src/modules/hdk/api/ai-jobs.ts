import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { stripInvisible } from '@/modules/hdc/pref';
import { requestSolutionDraft } from '@/modules/hda/api/draft';
import { requestTranslation } from '@/modules/hda/api/translate';
import { originalPublishedTx } from '../core/publish';
import { safeParseSolutionDoc } from '../doc-schema';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { sourceTicketIdsTx, untouchedDraftTx } from '../core/from-ticket';
import { aiStatusTx, articleByIdTx, setAiStatusTx, writeMachineTranslationTx } from '../core/translations';
import { draftIntoTemplate } from '../draft';
import { kbArticleVersions } from '../schema';
import { TITLE_MAX } from '../pref';
import { applySegments, textSegments } from '../translation';

// Модуль hdk, слой api: задачи фонового процесса, которые вызывают модель (план M5, задачи 6 и 7, решения 3, 9, 15).
// Узкий файл: его тянет фоновый процесс, страниц и Next.js в нём нет. Задача выполняется, только если язык ждёт её
// (ai_status = pending): повтор после успеха и задача, которую обогнал сотрудник, ничего не меняют. Сбой модели
// бросается дальше, и pg-boss повторяет задачу; язык при этом ждёт (pending), иначе повтор ничего бы не сделал.
// Отметка failed на странице ставится только после последней попытки (повторная проверка M5, 0057).

/** Попытка задачи pg-boss: номер повтора и предел повторов очереди. Без них попытка считается последней. */
export type JobAttempt = { retryCount: number; retryLimit: number };
const LAST_ATTEMPT: JobAttempt = { retryCount: 0, retryLimit: 0 };
const isLastAttempt = (attempt: JobAttempt) => attempt.retryCount >= attempt.retryLimit;

const translateJob = z.strictObject({ articleId: z.uuid(), locale: z.enum(LOCALES) });
const TITLE_SEGMENT = 'title';

/** kb.translate: перевод опубликованного оригинала в черновик языка с пометкой машинного. */
export async function runTranslationJob(system: SystemActor, data: unknown, attempt: JobAttempt = LAST_ATTEMPT): Promise<void> {
  const { articleId, locale } = translateJob.parse(data);
  const source = await withActor(system, async (tx) => {
    const article = await articleByIdTx(tx, articleId);
    if (!article || article.status !== 'active' || locale === article.originalLocale) return null;
    if ((await aiStatusTx(tx, articleId, locale)) !== 'pending') return null;
    const original = await originalPublishedTx(tx, article);
    return original ? { article, original } : null;
  });
  if (!source) return;
  const { article, original } = source;
  const segments = [{ id: TITLE_SEGMENT, text: original.title }, ...textSegments(original.doc)];
  let outcome: Awaited<ReturnType<typeof requestTranslation>>;
  try {
    outcome = await requestTranslation(system, { articleId, from: article.originalLocale, to: locale, segments });
  } catch (error) {
    if (isLastAttempt(attempt)) await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, 'failed'));
    throw error;
  }
  if (outcome.status !== 'ok') {
    await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, outcome.status));
    return;
  }
  const doc = applySegments(original.doc, outcome.value);
  // Заголовок от модели без невидимых знаков, как и текст документа (0057, M1s).
  const rawTitle = outcome.value.get(TITLE_SEGMENT);
  const title = rawTitle === undefined ? undefined : stripInvisible(rawTitle).trim().slice(0, TITLE_MAX);
  if (!doc || !title || !safeParseSolutionDoc(doc).success) {
    // Модель вернула не все куски: машинного текста нет, сотрудник переводит сам или повторяет.
    logEvent('warn', 'kb.translate_incomplete', { articleId, locale });
    await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, 'failed'));
    return;
  }
  await withActor(system, (tx) => writeMachineTranslationTx(tx, article, locale, { title, doc, sourceVersionId: original.versionId }));
}

const draftJob = z.strictObject({ articleId: z.uuid() });
const newBlockId = () => randomBytes(12).toString('base64url');

/**
 * kb.draft (ТЗ 11.10, решение 15): черновик решения из исходного обращения. Отбор данных и отказы (обращение не
 * закрыто, AI-обработка выключена) делает модуль hda до вызова модели. Ответ раскладывается в заготовку кодом,
 * черновик помечается "AI, не проверено" (is_machine) и публикуется только после "Текст прочитан" сотрудником с
 * правом публикации. Сотрудник успел начать писать сам: его текст не затирается (skipped).
 */
export async function runDraftJob(system: SystemActor, data: unknown, attempt: JobAttempt = LAST_ATTEMPT): Promise<void> {
  const { articleId } = draftJob.parse(data);
  const source = await withActor(system, async (tx) => {
    const article = await articleByIdTx(tx, articleId);
    if (!article || article.status !== 'active') return null;
    if ((await aiStatusTx(tx, articleId, article.originalLocale)) !== 'pending') return null;
    const [ticketId] = await sourceTicketIdsTx(tx, articleId);
    return ticketId ? { article, ticketId } : null;
  });
  if (!source) return;
  const { article, ticketId } = source;
  const locale = article.originalLocale;
  let outcome: Awaited<ReturnType<typeof requestSolutionDraft>>;
  try {
    outcome = await requestSolutionDraft(system, { ticketId, locale, articleId });
  } catch (error) {
    if (isLastAttempt(attempt)) await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, 'failed'));
    throw error;
  }
  if (outcome.status !== 'ok') {
    await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, outcome.status === 'refused' ? 'disabled' : outcome.status));
    return;
  }
  const draft = outcome.value;
  await withActor(system, async (tx) => {
    const version = await untouchedDraftTx(tx, articleId, locale);
    const template = version ? safeParseSolutionDoc(version.doc) : null;
    if (!version || !template?.success) return setAiStatusTx(tx, articleId, locale, 'skipped');
    const doc = draftIntoTemplate(template.data, draft, newBlockId);
    if (!safeParseSolutionDoc(doc).success) return setAiStatusTx(tx, articleId, locale, 'failed');
    await tx
      .update(kbArticleVersions)
      .set({ title: stripInvisible(draft.title).trim().slice(0, TITLE_MAX), doc, isMachine: true })
      .where(eq(kbArticleVersions.versionId, version.versionId));
    await setAiStatusTx(tx, articleId, locale, draft.confident ? 'ready' : 'not_confident');
  });
}
