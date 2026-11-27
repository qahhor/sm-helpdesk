'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { AI_PURPOSES, RESTRICTED_TOPICS } from '@/modules/hda/api/constants';
import { isHdaError, liftAiCutoff, saveAiModels, saveAiSettings, saveRestrictedTopics } from '@/modules/hda/api/settings';
import { liftTriageFieldOff } from '@/modules/hda/api/triage';
import { requireStaffActor } from '@/modules/hdu/api';

// Раздел "AI-помощник" настроек (план M5b, задача 1; FR-ADM-09, FR-AI-17). Права, свежий вход и значения проверяет
// модуль hda, итог показывается кодом в адресе страницы.

async function run(done: string, fn: () => Promise<string | void>): Promise<void> {
  const page = `/${await getLocale()}/agent/settings/ai`;
  let result: string | void;
  try {
    result = await fn();
  } catch (error) {
    if (!isHdaError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=${result ?? done}`);
}

export async function saveAiSettingsAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  await run('saved', () =>
    saveAiSettings(staff, {
      ...(form.get('enabled') ? { enabled: 'on' } : {}),
      ...(form.get('triageEnabled') ? { triageEnabled: 'on' } : {}),
      minScore: String(form.get('minScore') ?? ''),
      monthlyBudgetUsd: String(form.get('monthlyBudgetUsd') ?? ''),
      userDailyLimit: String(form.get('userDailyLimit') ?? ''),
      orgDailyLimit: String(form.get('orgDailyLimit') ?? ''),
      cutoffPercent: String(form.get('cutoffPercent') ?? ''),
      triageFieldsOff: form.getAll('triageFieldsOff').map(String),
    }),
  );
}

export async function saveAiModelsAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  await run('models', async () => {
    const { changed } = await saveAiModels(staff, Object.fromEntries(AI_PURPOSES.map((p) => [p, String(form.get(p) ?? '')])));
    return changed ? 'models_changed' : 'models';
  });
}

export async function liftAiCutoffAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  await run('lifted', () => liftAiCutoff(staff, { cutoffId: String(form.get('cutoffId') ?? '') }));
}

/** Обязательные темы со списками слов по языкам (план M5b, задача 2, решение 17). */
export async function saveRestrictedTopicsAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const fields = RESTRICTED_TOPICS.flatMap((topic) => (['ru', 'uz', 'en'] as const).map((lang) => [`${topic}.${lang}`, String(form.get(`${topic}.${lang}`) ?? '')] as const));
  await run('topics', () => saveRestrictedTopics(staff, Object.fromEntries(fields)));
}

/** Включить обратно поле разбора, отключённое ночной задачей (план M5b, задача 7; FR-TRI-04). */
export async function liftTriageFieldOffAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  await run('field_on', () => liftTriageFieldOff(staff, { offId: String(form.get('offId') ?? '') }));
}
