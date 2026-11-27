'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdaError } from '@/modules/hda/api/agent-admin';
import { approveCodeEntry, approveModuleNote, editCodeEntry, rejectCodeEntry, rejectModuleNote } from '@/modules/hda/api/code-knowledge';
import { CODE_TEMPLATE_LOCALES } from '@/modules/hda/api/constants';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия раздела "Знания из кода" (веха M8c, задача 4; FR-CODE-03, 13; план M8c, решения 9, 14, 26): утвердить,
// отклонить, править запись каталога; применить или отклонить заметку о модуле. Права, проверку данных и журнал
// аудита делает модуль hda; итог кодом в адресе страницы.

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

async function run(path: string, done: string, action: () => Promise<void>): Promise<never> {
  const locale = await getLocale();
  let status = `done=${done}`;
  try {
    await action();
  } catch (error) {
    if (!isHdaError(error)) throw error;
    status = `error=${error.code}`;
  }
  redirect(`/${locale}${path}?${status}`);
}

export async function approveEntryAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const key = text(form, 'key');
  await run(`/agent/code-knowledge/${encodeURIComponent(key)}`, 'approved', () => approveCodeEntry(staff, { key, version: text(form, 'version') }));
}

export async function rejectEntryAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const key = text(form, 'key');
  const reason = text(form, 'reason').trim();
  await run(`/agent/code-knowledge/${encodeURIComponent(key)}`, 'rejected', () => rejectCodeEntry(staff, { key, ...(reason ? { reason } : {}) }));
}

export async function editEntryAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const key = text(form, 'key');
  const templates = Object.fromEntries(CODE_TEMPLATE_LOCALES.flatMap((locale) => (text(form, `template_${locale}`).trim() ? [[locale, text(form, `template_${locale}`)]] : [])));
  const whatToCheck = text(form, 'whatToCheck')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  await run(`/agent/code-knowledge/${encodeURIComponent(key)}`, 'edited', () =>
    editCodeEntry(staff, { key, version: text(form, 'version'), conditions: text(form, 'conditions'), userCause: text(form, 'userCause'), whatToCheck, kind: text(form, 'kind'), templates }),
  );
}

export async function approveModuleAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const code = text(form, 'code');
  await run('/agent/code-knowledge/modules', 'approved', () => approveModuleNote(staff, { code }));
}

export async function rejectModuleAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const code = text(form, 'code');
  await run('/agent/code-knowledge/modules', 'rejected', () => rejectModuleNote(staff, { code }));
}
