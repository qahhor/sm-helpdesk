'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isHduError, requireStaffActor, searchOrganizations, type StaffContext } from '@/modules/hdu/api';
import { deleteRule, dryRunRule, isHdwError, moveRule, restoreBuiltinRule, saveRule, setRuleEnabled } from '@/modules/hdw/api';
import type { Issue } from './rule-draft';
import { actionTexts } from './run-text';

// Действия раздела "Правила автоматизации" (FR-AUTO-01, 06, 08; план M8, задача 4). Права, свежесть входа и данные
// проверяет модуль hdw: правило приходит одной строкой JSON и разбирается схемой модуля. Отказ схемы возвращается
// редактору с путём до поля, остальные итоги показываются кодом в адресе страницы.

const KNOWN_ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found', 'builtin_rule', 'not_builtin']);
/** Правило из двадцати условий и десяти действий с заметками по 2000 знаков заведомо меньше. */
const RULE_JSON_MAX = 100_000;
const DRY_RUN_SHOWN = 20;

export type RuleFormState = { error?: string; reauth?: boolean; issues?: Issue[] };
export type DryRunView = { checked: number; count: number; matches: { number: number; priority: string; orgName: string; actions: string[] }[] };
export type DryRunState = RuleFormState & { result?: DryRunView };

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** Правило из строки JSON. Негодная строка: undefined, схема модуля ответит invalid_input. */
function ruleOf(json: unknown): unknown {
  if (typeof json !== 'string' || json.length > RULE_JSON_MAX) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

async function failure(error: unknown): Promise<RuleFormState> {
  if (!isHdwError(error)) throw error;
  const t = await getTranslations('agent.settings.rules');
  const code = KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input';
  return { error: t(`errors.${code}`), reauth: code === 'stale_session', issues: error.issues };
}

/** Сохранить правило из редактора. Успех: переход на страницу правила; отказ: текст и места ошибок. */
export async function saveRuleAction(json: string): Promise<RuleFormState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  const rule = ruleOf(json);
  const isNew = !(rule !== null && typeof rule === 'object' && 'ruleId' in rule);
  let ruleId: string;
  try {
    ({ ruleId } = await saveRule(staff, rule));
  } catch (error) {
    return failure(error);
  }
  redirect(`/${locale}/agent/settings/rules/${ruleId}?done=${isNew ? 'created' : 'saved'}`);
}

/** Пробный прогон правила из редактора, в том числе несохранённого. Ничего не меняет. */
export async function dryRunRuleAction(json: string): Promise<DryRunState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  try {
    const result = await dryRunRule(staff, ruleOf(json));
    const describe = await actionTexts();
    return {
      result: {
        checked: result.checked,
        count: result.count,
        matches: result.matches.slice(0, DRY_RUN_SHOWN).map((match) => ({ number: match.number, priority: match.priority.toUpperCase(), orgName: match.orgName, actions: describe(match.actions, 'dry.failed') })),
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Организации для условия "организация": поиск по названию и ИНН, не больше десяти. */
export async function searchRuleOrgsAction(query: string): Promise<{ value: string; label: string }[]> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  if (typeof query !== 'string' || query.trim() === '' || query.length > 200) return [];
  try {
    const found = await searchOrganizations(staff, { query: query.trim() });
    return found.items.slice(0, 10).map((org) => ({ value: org.orgId, label: org.name }));
  } catch (error) {
    if (!isHduError(error)) throw error;
    return [];
  }
}

async function run(action: (staff: StaffContext) => Promise<void>, done: string, back?: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const list = `/${await getLocale()}/agent/settings/rules`;
  try {
    await action(staff);
  } catch (error) {
    if (!isHdwError(error)) throw error;
    redirect(`${back ? `${list}/${back}` : list}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${list}?done=${done}`);
}

export async function moveRuleAction(form: FormData): Promise<void> {
  await run((staff) => moveRule(staff, { ruleId: text(form, 'ruleId'), direction: text(form, 'direction') }), 'moved');
}

export async function setRuleEnabledAction(form: FormData): Promise<void> {
  const enabled = text(form, 'enabled') === 'true';
  await run((staff) => setRuleEnabled(staff, { ruleId: text(form, 'ruleId'), enabled }), enabled ? 'enabled' : 'disabled');
}

export async function deleteRuleAction(form: FormData): Promise<void> {
  const ruleId = text(form, 'ruleId');
  // Отказ показывается на странице правила, если идентификатор похож на настоящий.
  await run((staff) => deleteRule(staff, { ruleId }), 'deleted', /^[0-9a-f-]{36}$/.test(ruleId) ? ruleId : undefined);
}

/** "Вернуть исходное" у предустановленного правила (решение 2 плана M8): итог показывается на странице правила. */
export async function restoreBuiltinRuleAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const ruleId = text(form, 'ruleId');
  const list = `/${await getLocale()}/agent/settings/rules`;
  const page = /^[0-9a-f-]{36}$/.test(ruleId) ? `${list}/${ruleId}` : list;
  try {
    await restoreBuiltinRule(staff, { ruleId });
  } catch (error) {
    if (!isHdwError(error)) throw error;
    redirect(`${page}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${page}?done=restored`);
}
