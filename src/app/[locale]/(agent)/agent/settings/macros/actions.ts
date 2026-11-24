'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';
import { deleteMacro, isHdwError, moveMacro, saveMacro } from '@/modules/hdw/api';
import type { Issue } from '../rules/rule-draft';

// Действия раздела "Макросы" (FR-AG-15, FR-ADM-10; план M8, задача 6). Права, свежесть входа и данные проверяет
// модуль hdw: макрос приходит одной строкой JSON и разбирается схемой модуля. Отказ схемы возвращается редактору
// с путём до строки, остальные итоги показываются кодом в адресе страницы.

const KNOWN_ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found', 'too_many']);
/** Макрос из десяти действий с заметками по 2000 знаков заведомо меньше. */
const MACRO_JSON_MAX = 50_000;

export type MacroFormState = { error?: string; reauth?: boolean; issues?: Issue[] };

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** Сохранить макрос из редактора. Успех: переход на страницу макроса; отказ: текст и места ошибок. */
export async function saveMacroAction(json: string): Promise<MacroFormState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  let macro: unknown;
  try {
    macro = typeof json === 'string' && json.length <= MACRO_JSON_MAX ? (JSON.parse(json) as unknown) : undefined;
  } catch {
    macro = undefined;
  }
  const isNew = !(macro !== null && typeof macro === 'object' && 'macroId' in macro);
  let macroId: string;
  try {
    ({ macroId } = await saveMacro(staff, macro));
  } catch (error) {
    if (!isHdwError(error)) throw error;
    const t = await getTranslations('agent.settings.macros');
    const code = KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input';
    return { error: t(`errors.${code}`), reauth: code === 'stale_session', issues: error.issues };
  }
  redirect(`/${locale}/agent/settings/macros/${macroId}?done=${isNew ? 'created' : 'saved'}`);
}

async function run(action: (staff: StaffContext) => Promise<void>, done: string, back?: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const list = `/${await getLocale()}/agent/settings/macros`;
  try {
    await action(staff);
  } catch (error) {
    if (!isHdwError(error)) throw error;
    redirect(`${back ? `${list}/${back}` : list}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${list}?done=${done}`);
}

export async function moveMacroAction(form: FormData): Promise<void> {
  await run((staff) => moveMacro(staff, { macroId: text(form, 'macroId'), direction: text(form, 'direction') }), 'moved');
}

export async function deleteMacroAction(form: FormData): Promise<void> {
  const macroId = text(form, 'macroId');
  // Отказ показывается на странице макроса, если идентификатор похож на настоящий.
  await run((staff) => deleteMacro(staff, { macroId }), 'deleted', /^[0-9a-f-]{36}$/.test(macroId) ? macroId : undefined);
}
