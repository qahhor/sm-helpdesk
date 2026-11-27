'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdpError, parseProblemRef } from '@/modules/hdp/api';
import {
  addProblemSignature,
  createProblem,
  createProblemFromTicket,
  removeProblemSignature,
  requestProblemTranslation,
  saveProblem,
  saveProblemTranslation,
  setProblemShown,
  setProblemStatus,
} from '@/modules/hdp/api/problems';
import { confirmBroadcast, prepareBroadcast } from '@/modules/hdp/api/broadcasts';
import { linkTicketToProblem, unlinkTicket } from '@/modules/hdp/api/links';
import { listProblems } from '@/modules/hdp/api/problems';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия карточки известной проблемы (план M5c, задача 2). Права (agent_l2, care, admin), данные и проверку текста
// делает модуль hdp и ещё раз база; страница получает итог отметкой в адресе. Формы обычные: работают без скриптов.

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

async function run(form: FormData, action: (number: number) => Promise<unknown>, done: string, tab = ''): Promise<never> {
  const locale = await getLocale();
  const number = parseProblemRef(text(form, 'number'));
  if (!number) redirect(`/${locale}/agent/problems`);
  let status = done;
  let kinds = '';
  try {
    await action(number);
  } catch (error) {
    if (!isHdpError(error)) throw error;
    status = `error-${error.code}`;
    // В адрес идут только виды находок, а не найденный текст.
    if (error.findings.length > 0) kinds = `&kinds=${[...new Set(error.findings.map((f) => f.kind))].join(',')}`;
  }
  redirect(`/${locale}/agent/problems/${number}?status=${status}${kinds}${tab ? `&tab=${tab}` : ''}`);
}

export async function createProblemAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  let target = `/${locale}/agent/problems?status=error-forbidden`;
  try {
    const { number } = await createProblem(staff, { internalTitle: text(form, 'internalTitle'), moduleId: text(form, 'moduleId') || null });
    target = `/${locale}/agent/problems/${number}?status=created`;
  } catch (error) {
    if (!isHdpError(error)) throw error;
    target = `/${locale}/agent/problems?status=error-${error.code}`;
  }
  redirect(target);
}

/** "Создать известную проблему" из обращения (FR-KP-03): карточка новой проблемы или отказ на странице обращения. */
export async function createFromTicketAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const ticketNumber = Number(text(form, 'ticketNumber'));
  let target: string;
  try {
    const { number } = await createProblemFromTicket(staff, { ticketNumber });
    target = `/${locale}/agent/problems/${number}?status=created`;
  } catch (error) {
    if (!isHdpError(error)) throw error;
    target = `/${locale}/agent/tickets/SUP-${Number.isSafeInteger(ticketNumber) ? ticketNumber : 0}?error=problem_${error.code}`;
  }
  redirect(target);
}

export async function saveProblemAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const workaround = text(form, 'workaroundNumber').trim();
  await run(
    form,
    (number) => saveProblem(staff, { number, internalTitle: text(form, 'internalTitle'), moduleId: text(form, 'moduleId') || null, workaroundNumber: workaround ? Number(workaround) : null }),
    'saved',
  );
}

export async function problemStatusAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(form, (number) => setProblemStatus(staff, { number, status: text(form, 'status') }), 'status');
}

export async function problemShownAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const shown = text(form, 'shown') === 'true';
  await run(form, (number) => setProblemShown(staff, { number, shown }), shown ? 'shown' : 'hidden');
}

export async function problemTranslationAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(
    form,
    (number) =>
      saveProblemTranslation(staff, {
        number,
        locale: text(form, 'locale'),
        publicTitle: text(form, 'publicTitle'),
        publicBody: text(form, 'publicBody'),
        acceptMachine: text(form, 'accept') === 'true',
      }),
    'translation',
  );
}

export async function requestTranslationAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(form, (number) => requestProblemTranslation(staff, { number, locale: text(form, 'locale') }), 'translating');
}

export async function addSignatureAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(form, (number) => addProblemSignature(staff, { number, signature: text(form, 'signature').trim().toLowerCase() }), 'signature_added');
}

export async function removeSignatureAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(form, (number) => removeProblemSignature(staff, { number, signature: text(form, 'signature') }), 'signature_removed');
}

/** Обращение по номеру из формы и адрес его страницы. */
function ticketTarget(locale: string, form: FormData): { ticketNumber: number; base: string } {
  const ticketNumber = Number(text(form, 'ticketNumber'));
  return { ticketNumber, base: `/${locale}/agent/tickets/SUP-${Number.isSafeInteger(ticketNumber) ? ticketNumber : 0}` };
}

/**
 * Привязать обращение к проблеме из блока обращения (FR-KP-04): номер KP-n или часть внутреннего названия; по
 * названию привязывается только единственная найденная активная проблема.
 */
export async function linkTicketAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const { ticketNumber, base } = ticketTarget(locale, form);
  const query = text(form, 'problem').trim();
  let target = `${base}?done=problem_linked`;
  try {
    let problemNumber = parseProblemRef(query);
    if (!problemNumber && query.length >= 3) {
      const found = await listProblems(staff, { status: 'active', q: query.slice(0, 200) });
      problemNumber = found.length === 1 ? found[0]!.number : null;
    }
    if (!problemNumber) target = `${base}?error=problem_not_found`;
    else await linkTicketToProblem(staff, { ticketNumber, problemNumber });
  } catch (error) {
    if (!isHdpError(error)) throw error;
    target = `${base}?error=problem_${error.code}`;
  }
  redirect(target);
}

export async function unlinkTicketAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const { ticketNumber, base } = ticketTarget(locale, form);
  let target = `${base}?done=problem_unlinked`;
  try {
    await unlinkTicket(staff, { ticketNumber });
  } catch (error) {
    if (!isHdpError(error)) throw error;
    target = `${base}?error=problem_${error.code}`;
  }
  redirect(target);
}

// --- Рассылка и закрытие (задача 5, решения 17-20) ---

/** "Написать обновление всем" и "Закрыть проблему": черновик рассылки и переход на экран подтверждения. */
export async function prepareBroadcastAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const number = parseProblemRef(text(form, 'number'));
  if (!number) redirect(`/${locale}/agent/problems`);
  const kind = text(form, 'kind') === 'closing' ? 'closing' : 'update';
  let target: string;
  try {
    const { broadcastId } = await prepareBroadcast(staff, { number, kind, body: text(form, 'body'), locale: text(form, 'locale') || locale });
    target = `/${locale}/agent/problems/${number}/broadcast/${broadcastId}`;
  } catch (error) {
    if (!isHdpError(error)) throw error;
    const kinds = error.findings.length > 0 ? `&kinds=${[...new Set(error.findings.map((f) => f.kind))].join(',')}` : '';
    target = `/${locale}/agent/problems/${number}?status=error-${error.code}${kinds}&tab=updates`;
  }
  redirect(target);
}

/** Подтверждение рассылки: тексты на языках получателей из формы, флажок "текстом оригинала". */
export async function confirmBroadcastAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const number = parseProblemRef(text(form, 'number'));
  const broadcastId = text(form, 'broadcastId');
  if (!number) redirect(`/${locale}/agent/problems`);
  const translations = Object.fromEntries(['ru', 'uz', 'en'].flatMap((lang) => (form.has(`text-${lang}`) ? [[lang, text(form, `text-${lang}`)]] : [])));
  let target = `/${locale}/agent/problems/${number}?status=broadcast_sent&tab=updates`;
  try {
    await confirmBroadcast(staff, { broadcastId, translations, fallbackToOriginal: text(form, 'fallback') === 'on' });
  } catch (error) {
    if (!isHdpError(error)) throw error;
    const kinds = error.findings.length > 0 ? `&kinds=${[...new Set(error.findings.map((f) => f.kind))].join(',')}` : '';
    target = `/${locale}/agent/problems/${number}/broadcast/${broadcastId}?status=error-${error.code}${kinds}`;
  }
  redirect(target);
}
