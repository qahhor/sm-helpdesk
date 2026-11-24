'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionTemplate } from '@/modules/hdk/api/doc';
import { restoreSolutionVersion, saveSolutionDraft, saveSolutionMeta, type SaveResult } from '@/modules/hdk/api/editor';
import { isHdkError } from '@/modules/hdk/api/errors';
import { completeSolutionFile, presignSolutionFile, type PresignedFile, solutionFileStatus } from '@/modules/hdk/api/files';
import type { FileScanStatus } from '@/modules/hdk/pref';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия раздела "Решения" (план M5, задача 3). Права, данные и версию строки проверяет модуль hdk; страница
// получает итог кодом. Ошибки модуля не бросаются наружу: автосохранение показывает их строкой состояния.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; retryAfterSec?: number };

async function attempt<T extends object>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    if (!isHdkError(error)) throw error;
    return {
      ok: false,
      code: error.code,
      ...(error.retryAfterSec ? { retryAfterSec: error.retryAfterSec } : {}),
    };
  }
}

/** Идентификатор блока заготовки: 16 знаков base64url. */
const newBlockId = () => randomBytes(12).toString('base64url');

/** Новое решение: статья и черновик с тремя блоками формы на языке решения (UX-W-01). */
export async function createSolutionAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const page = await getLocale();
  const lang = String(form.get('locale') ?? '');
  const moduleId = String(form.get('moduleId') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const locale = isLocale(lang) ? lang : page;
  const t = await getTranslations({
    locale,
    namespace: 'agent.solutions.template',
  });
  let number: number;
  try {
    ({ number } = await createDraftArticle(staff, {
      locale,
      title,
      audience: form.get('internal') === 'on' ? 'internal' : 'clients',
      ...(moduleId ? { moduleId } : {}),
      doc: solutionTemplate({ what: t('what'), why: t('why'), do: t('do') }, newBlockId),
    }));
  } catch (error) {
    if (!isHdkError(error)) throw error;
    redirect(`/${page}/agent/solutions/new?error=${error.code}`);
  }
  redirect(`/${page}/agent/solutions/${number}`);
}

/** Автосохранение (UX-W-04). Конфликт версии строки приходит итогом, а не ошибкой. */
export async function saveDraftAction(input: unknown): Promise<ActionResult<{ result: SaveResult }>> {
  const staff = await requireStaffActor();
  return attempt(async () => ({
    result: await saveSolutionDraft(staff, input),
  }));
}

/** Модуль и флаг "только через сотрудника". */
export async function saveMetaAction(input: unknown): Promise<ActionResult> {
  const staff = await requireStaffActor();
  return attempt(async () => {
    await saveSolutionMeta(staff, input);
    return {};
  });
}

/** Возврат к прежней версии: страница открывается заново с новым черновиком. */
export async function restoreVersionAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const page = await getLocale();
  const number = String(form.get('number') ?? '');
  const safeNumber = /^\d{1,12}$/.test(number) ? number : '';
  try {
    await restoreSolutionVersion(staff, {
      number,
      locale: String(form.get('locale') ?? ''),
      versionId: String(form.get('versionId') ?? ''),
    });
  } catch (error) {
    if (!isHdkError(error)) throw error;
    redirect(`/${page}/agent/solutions/${safeNumber}?error=${error.code}`);
  }
  redirect(`/${page}/agent/solutions/${safeNumber}?done=restored`);
}

export async function presignFileAction(input: unknown): Promise<ActionResult<PresignedFile>> {
  const staff = await requireStaffActor();
  return attempt(() => presignSolutionFile(staff, input));
}

export async function completeFileAction(input: unknown): Promise<ActionResult<{ status: FileScanStatus }>> {
  const staff = await requireStaffActor();
  return attempt(() => completeSolutionFile(staff, input));
}

export async function fileStatusAction(input: unknown): Promise<ActionResult<{ status: FileScanStatus }>> {
  const staff = await requireStaffActor();
  return attempt(() => solutionFileStatus(staff, input));
}
