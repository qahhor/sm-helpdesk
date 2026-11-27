'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { requestCodeAnalysis } from '@/modules/hda/api/code-analysis';
import { createSolutionFromCodeEntry } from '@/modules/hda/api/code-knowledge';
import { isHdaError } from '@/modules/hda/api/agent-admin';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия блока "Что известно по коду" (веха M8c, задачи 6 и 7; FR-CODE-07, 08): решение из записи каталога и
// анализ обращения по коду. Права, проверку данных и журнал аудита делает модуль hda; отказ показывается кодом в адресе.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const newBlockId = () => randomBytes(12).toString('base64url');

/** "Создать решение из записи": черновик открывается в редакторе решений. */
export async function createSolutionFromEntryAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const number = Number(text(form, 'number'));
  const ticketPage = `/${locale}/agent/tickets/SUP-${Number.isInteger(number) ? number : 0}`;
  const lang = isLocale(locale) ? locale : 'ru';
  let target: string;
  try {
    const t = await getTranslations({ locale: lang, namespace: 'agent.solutions.template' });
    const outcome = await createSolutionFromCodeEntry(staff, { key: text(form, 'key'), locale: lang }, { what: t('what'), why: t('why'), do: t('do') }, newBlockId);
    target = `/${locale}/agent/solutions/${outcome.number}${outcome.signature === 'taken' ? '?done=code_signature_taken' : ''}`;
  } catch (error) {
    if (!isHdaError(error)) throw error;
    target = `${ticketPage}?error=code_${error.code}`;
  }
  redirect(target);
}

/** "Разобрать по коду": запрос анализа AI-сотруднику; ответ придёт внутренней заметкой. */
export async function requestAnalysisAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const number = Number(text(form, 'number'));
  const ticketPage = `/${locale}/agent/tickets/SUP-${Number.isInteger(number) ? number : 0}`;
  let status = 'done=code_requested';
  try {
    await requestCodeAnalysis(staff, { number });
  } catch (error) {
    if (!isHdaError(error)) throw error;
    status = `error=code_${error.code}`;
  }
  redirect(`${ticketPage}?${status}`);
}
