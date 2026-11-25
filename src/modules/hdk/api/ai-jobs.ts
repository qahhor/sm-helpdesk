import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { requestTranslation } from '@/modules/hda/api/translate';
import { originalPublishedTx } from '../core/publish';
import { safeParseSolutionDoc } from '../doc-schema';
import { aiStatusTx, articleByIdTx, setAiStatusTx, writeMachineTranslationTx } from '../core/translations';
import { TITLE_MAX } from '../pref';
import { applySegments, textSegments } from '../translation';

// Модуль hdk, слой api: задачи фонового процесса, которые вызывают модель (план M5, задачи 6 и 7, решения 3, 9, 15).
// Узкий файл: его тянет фоновый процесс, страниц и Next.js в нём нет. Задача выполняется, только если язык ждёт её
// (ai_status = pending): повтор после успеха и задача, которую обогнал сотрудник, ничего не меняют. Сбой модели
// отмечается на странице (failed) и бросается дальше: pg-boss повторит задачу.

const translateJob = z.strictObject({ articleId: z.uuid(), locale: z.enum(LOCALES) });
const TITLE_SEGMENT = 'title';

/** kb.translate: перевод опубликованного оригинала в черновик языка с пометкой машинного. */
export async function runTranslationJob(system: SystemActor, data: unknown): Promise<void> {
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
    await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, 'failed'));
    throw error;
  }
  if (outcome.status !== 'ok') {
    await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, outcome.status));
    return;
  }
  const doc = applySegments(original.doc, outcome.value);
  const title = outcome.value.get(TITLE_SEGMENT)?.trim().slice(0, TITLE_MAX);
  if (!doc || !title || !safeParseSolutionDoc(doc).success) {
    // Модель вернула не все куски: машинного текста нет, сотрудник переводит сам или повторяет.
    logEvent('warn', 'kb.translate_incomplete', { articleId, locale });
    await withActor(system, (tx) => setAiStatusTx(tx, articleId, locale, 'failed'));
    return;
  }
  await withActor(system, (tx) => writeMachineTranslationTx(tx, article, locale, { title, doc, sourceVersionId: original.versionId }));
}
