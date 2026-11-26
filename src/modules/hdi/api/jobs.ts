import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { requestIdeaTranslation } from '@/modules/hda/api/translate';
import { enqueue } from '@/modules/hdc/api';
import { stripInvisible } from '@/modules/hdc/pref';
import { indexIdeaTexts } from '@/modules/hdk/api/idea-search';
import { comparePlainInvariants } from '@/modules/hdk/api/text-checks';
import { orgAiProfile } from '@/modules/hdu/api/orgs';
import { scanUpload } from '../core/files';
import { ideaIndexSourceTx } from '../core/index';
import { translationPlanTx, writeMachineTranslationTx } from '../core/translate';
import { textHash } from '../util';
import type { IdeaScanStatus } from '../pref';

// Модуль hdi, слой api: задачи фонового процесса (план M7). Узкий файл: его тянет фоновый процесс, страниц и Next.js
// в нём нет. В задаче только идентификаторы, остальное берётся из базы.

const scanJob = z.strictObject({ attachmentId: z.uuid() });

/** ideas.scan: проверка изображения идеи (решение 10). Строки уже нет: null, повтор не нужен. */
export function scanIdeaAttachment(system: SystemActor, data: unknown): Promise<IdeaScanStatus | null> {
  const { attachmentId } = scanJob.parse(data);
  return scanUpload(system, attachmentId);
}

const ideaJob = z.strictObject({ ideaId: z.uuid() });

/**
 * ideas.index: строки индекса похожих идей по видимым клиентам текстам опубликованной идеи (решение 23). Идея не
 * опубликована или уже отклонена и объединена: строки снимаются. Сервис векторов недоступен: строки со словами уже
 * записаны, задача бросает ошибку и повторяется.
 */
export async function runIdeaIndexJob(system: SystemActor, data: unknown): Promise<{ indexed: number; removed: number; embedded: number }> {
  const { ideaId } = ideaJob.parse(data);
  const source = await withActor(system, (tx) => ideaIndexSourceTx(tx, ideaId));
  return indexIdeaTexts(system, { ideaId, moduleId: source.moduleId, texts: source.texts });
}

export type TranslationJobResult = { status: 'translated' | 'skipped' | 'ai_disabled' | 'unavailable' | 'limited'; machine: number; rejected: number };

/** Текст модели без невидимых знаков; заголовок одной строкой. */
const cleanModelText = (text: { title: string; body: string }) => ({
  title: stripInvisible(text.title).replace(/[\r\n]+/g, ' ').trim(),
  body: stripInvisible(text.body).trim(),
});

/**
 * ideas.translate (решения 11, 12): заголовок и описание опубликованной идеи на языки без годного перевода. Организация
 * автора выключила AI-обработку: модель не вызывается, клиенты видят оригинал. В модель уходят только заголовок и
 * описание, имя автора и название организации в списке масок (ТЗ 14.3). Перевод сверяется с оригиналом (числа,
 * ссылки, кавычки, находки FR-SOL-04): расхождение даёт rejected, клиент видит оригинал. Затем индекс похожих.
 * Сбой модели бросается: pg-boss повторит задачу.
 */
export async function runIdeaTranslationJob(system: SystemActor, data: unknown): Promise<TranslationJobResult> {
  const { ideaId } = ideaJob.parse(data);
  const plan = await withActor(system, (tx) => translationPlanTx(tx, ideaId, LOCALES, textHash));
  const result: TranslationJobResult = { status: 'skipped', machine: 0, rejected: 0 };
  if (!plan || plan.targets.length === 0) return result;
  const profile = await orgAiProfile(system, { orgId: plan.orgId, userIds: [plan.authorId] });
  if (!profile?.isAiEnabled) {
    logEvent('info', 'ideas.translate_ai_disabled', { ideaId });
    return { ...result, status: 'ai_disabled' };
  }
  const split = (name: string) => [name, ...name.split(/\s+/)];
  const redaction = {
    names: [...split(plan.authorName), ...profile.people.flatMap((p) => split(p.name))],
    orgTerms: [profile.name, ...(profile.inn ? [profile.inn] : [])],
  };
  for (const to of plan.targets) {
    const outcome = await requestIdeaTranslation(system, { ideaId, orgId: plan.orgId, from: plan.original.locale, to, title: plan.original.title, body: plan.original.body, redaction });
    if (outcome.status !== 'ok') return { ...result, status: outcome.status };
    const text = cleanModelText(outcome.value);
    const issues = text.title && text.body ? comparePlainInvariants(plan.original, text) : [{ kind: 'data' as const }];
    const status = issues.length > 0 ? 'rejected' : 'machine';
    if (await withActor(system, (tx) => writeMachineTranslationTx(tx, ideaId, to, text.title && text.body ? text : plan.original, status, plan.sourceHash))) {
      if (status === 'machine') result.machine++;
      else result.rejected++;
    }
    // Расхождения в журнал только видами, без текста.
    if (issues.length > 0) logEvent('warn', 'ideas.translation_rejected', { ideaId, locale: to, kinds: issues.map((issue) => issue.kind) });
  }
  await enqueue('ideas.index', { ideaId });
  return { ...result, status: 'translated' };
}
