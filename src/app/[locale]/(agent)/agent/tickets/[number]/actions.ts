'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { LOCALES, type Locale } from '@/i18n/locales';
import { isHdkError } from '@/modules/hdk/api/errors';
import { createSolutionFromTicket } from '@/modules/hdk/api/from-ticket';
import { loadSlaConfig } from '@/modules/hdr/api';
import {
  addTicketTag,
  assignTicket,
  inviteSender,
  type ChangeSummary,
  isHdtError,
  markTicketRead,
  mergeTicket,
  nextInQueue,
  parseNumber,
  postStaffMessage,
  removeTicketTag,
  type PresenceEntry,
  returnToL1,
  saveDraft,
  setPriority,
  setStatus,
  setTicketModule,
  setTicketType,
  type SnoozePreset,
  snoozeTarget,
  snoozeTicket,
  takeTicket,
  syncPresence,
  transferToL2,
  zonedToDate,
} from '@/modules/hdt/api';
import { flagAiAnswer, isHdaError } from '@/modules/hda/api/review';
import { acceptTriage } from '@/modules/hdt/api/triage';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';
import { devTrackerMode, isHdwError, runMacro, sendToDevelopment, setDevTaskStatus, unlinkFromDevelopment } from '@/modules/hdw/api';
import { actionTexts } from '../../settings/rules/run-text';

// Действия сотрудника на странице обращения (план M3, задача 7). Права, переходы и данные проверяет модуль hdt,
// итог показывается кодом в адресе страницы.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/** after: что сделать после удачного действия; вернёт адрес, куда перейти вместо страницы обращения. */
async function run(form: FormData, action: (staff: StaffContext, number: number) => Promise<void>, done: string, after?: (staff: StaffContext, number: number) => Promise<string>): Promise<never> {
  const staff = await requireStaffActor();
  const number = Number(text(form, 'number'));
  const page = `/${await getLocale()}/agent/tickets/SUP-${Number.isInteger(number) ? number : 0}`;
  try {
    await action(staff, number);
  } catch (error) {
    // Отказ передачи в разработку (модуль hdw): тот же показ кодом в адресе страницы.
    if (isHdwError(error)) redirect(`${page}?error=${error.code}`);
    if (!isHdtError(error)) throw error;
    // Обращение изменили другие, пока страница была открыта (FR-AG-12): в адресе только числа сводки, страница
    // после перехода уже свежая, действие можно повторить.
    if (error.code === 'changed' && error.changed)
      redirect(`${page}?error=changed&ch=${error.changed.newMessages}.${error.changed.statusChanged ? 1 : 0}.${error.changed.assigneeChanged ? 1 : 0}`);
    // Кто взял обращение, страница покажет сама из текущего исполнителя: имя в адресе не передаётся.
    redirect(`${page}?error=${error.code}`);
  }
  if (after) redirect(await after(staff, number));
  redirect(`${page}?done=${done}`);
}

/** Подписи трёх блоков формы решения на каждом языке (UX-W-01): решение получает язык обращения. */
async function templateLabels(): Promise<Record<Locale, { what: string; why: string; do: string }>> {
  const entries = await Promise.all(
    LOCALES.map(async (locale) => {
      const t = await getTranslations({ locale, namespace: 'agent.solutions.template' });
      return [locale, { what: t('what'), why: t('why'), do: t('do') }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Locale, { what: string; why: string; do: string }>;
}

const newBlockId = () => randomBytes(12).toString('base64url');

/**
 * Решение из обращения (план M5, задача 7; UX-W-09, S5): статья с источником, черновик от модели готовит фоновый
 * процесс. Итог: страница решения; отказ модуля решений: страница обращения с кодом.
 */
async function solutionFromTicket(staff: StaffContext, number: number): Promise<string> {
  const locale = await getLocale();
  try {
    const labels = await templateLabels();
    const result = await createSolutionFromTicket(staff, { number }, (lang) => labels[lang], newBlockId);
    return `/${locale}/agent/solutions/${result.number}${result.created ? '?done=from_ticket' : ''}`;
  } catch (error) {
    if (!isHdkError(error)) throw error;
    return `/${locale}/agent/tickets/SUP-${number}?error=solution_${error.code}`;
  }
}

/** Кнопка "Создать решение" на странице решённого или закрытого обращения. */
export async function createSolutionAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const number = Number(text(form, 'number'));
  redirect(await solutionFromTicket(staff, Number.isInteger(number) ? number : 0));
}

export async function takeAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => takeTicket(staff, number), 'taken');
}

export async function assignAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => assignTicket(staff, { number, assigneeId: text(form, 'assigneeId') || null, seenVersion: text(form, 'seen') || undefined }), 'assigned');
}

export async function statusAction(form: FormData): Promise<void> {
  await run(
    form,
    (staff, number) =>
      setStatus(staff, {
        number,
        to: text(form, 'to'),
        resolution: text(form, 'resolution') || undefined,
        version: text(form, 'version') || undefined,
        seenVersion: text(form, 'seen') || undefined,
      }),
    'status',
    // "Опубликовать как решение" в окне закрытия (S5): после решения или закрытия сразу черновик решения.
    form.get('publishSolution') === 'on' && ['resolved', 'closed'].includes(text(form, 'to')) ? solutionFromTicket : undefined,
  );
}

export async function priorityAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => setPriority(staff, { number, priority: text(form, 'priority'), reason: text(form, 'reason'), seenVersion: text(form, 'seen') || undefined }), 'priority');
}

/** Тег по названию: нет такого в справочнике, создаётся (FR-AUTO-13). */
export async function addTagAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => addTicketTag(staff, { number, name: text(form, 'name') }), 'tagged');
}

export async function removeTagAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => removeTicketTag(staff, { number, tagId: text(form, 'tagId') }), 'untagged');
}

export async function typeAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => setTicketType(staff, { number, type: text(form, 'type') }), 'type');
}

/** "Принять" у предложения разбора или "Принять всё" (план M5b, задача 7; FR-TRI-02). Поле меняет только это нажатие. */
export async function acceptTriageAction(form: FormData): Promise<void> {
  const field = text(form, 'field');
  await run(form, async (staff, number) => void (await acceptTriage(staff, { number, fields: field === 'all' ? 'all' : [field] })), 'triaged');
}

/** "Отметить ответ как неверный" у сообщения помощника (план M5b, задача 8; FR-AI-16): причина из списка и комментарий. */
export async function flagAiAnswerAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const number = Number(text(form, 'number'));
  const page = `/${await getLocale()}/agent/tickets/SUP-${Number.isInteger(number) ? number : 0}`;
  try {
    await flagAiAnswer(staff, { messageId: text(form, 'messageId'), reason: text(form, 'reason'), comment: text(form, 'comment') });
  } catch (error) {
    if (!isHdaError(error)) throw error;
    redirect(`${page}?error=${error.code === 'forbidden' ? 'forbidden' : 'invalid_input'}`);
  }
  redirect(`${page}?done=flagged`);
}

export async function moduleAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => setTicketModule(staff, { number, moduleId: text(form, 'moduleId') || null }), 'module');
}

/** Отложить: быстрые варианты считаются в часовом поясе поддержки, своя дата вводится в нём же (UX-A-11). */
export async function snoozeAction(form: FormData): Promise<void> {
  await run(
    form,
    async (staff, number) => {
      const preset = text(form, 'preset');
      if (preset === 'clear') return snoozeTicket(staff, { number, until: null });
      const { timeZone } = (await loadSlaConfig(staff.actor)).calendar;
      let until: Date | null = null;
      try {
        until = ['hour', 'tomorrow', 'monday'].includes(preset) ? snoozeTarget(preset as SnoozePreset, new Date(), timeZone) : zonedToDate(text(form, 'until'), timeZone);
      } catch {
        until = null;
      }
      await snoozeTicket(staff, { number, until: until ? until.toISOString() : 'invalid' });
    },
    'snoozed',
  );
}

// --- Поле ответа, черновик, присутствие (план M3, задача 8) ---

export type ComposerState =
  | { status: 'idle' }
  | { status: 'changed'; changed: ChangeSummary; version: string }
  | { status: 'error'; code: string };

/**
 * Ответ клиенту или заметка. Ушло: страница открывается заново с отметкой. Обращение изменили другие: форма
 * показывает, что изменилось, и версию, с которой агент может отправить, уже зная об изменениях (UX-A-06).
 */
export async function staffMessageAction(_prev: ComposerState, form: FormData): Promise<ComposerState> {
  const staff = await requireStaffActor();
  const number = Number(text(form, 'number'));
  const internal = text(form, 'internal') === '1';
  // "Отправить и к следующему" (FR-AG-17): следующее берётся до отправки, пока текущее ещё стоит на своём месте в очереди.
  const wantNext = text(form, 'next') === '1';
  const context = { queue: text(form, 'queue') || 'mine', sort: text(form, 'sort') || 'sla' };
  let result: Awaited<ReturnType<typeof postStaffMessage>>;
  let next: number | null = null;
  try {
    if (wantNext) next = await nextInQueue(staff, { ...context, afterNumber: number });
    result = await postStaffMessage(staff, {
      number,
      body: String(form.get('body') ?? ''),
      internal,
      attachmentIds: form.getAll('attachmentIds').map(String),
      waitForClient: !internal && form.get('waitForClient') === 'on',
      seenVersion: text(form, 'acceptVersion') || text(form, 'seenVersion'),
    });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { status: 'error', code: error.code };
  }
  if (!result.ok) return { status: 'changed', changed: result.changed, version: result.version };
  const locale = await getLocale();
  const back = new URLSearchParams(context).toString();
  if (wantNext) redirect(next ? `/${locale}/agent/tickets/SUP-${next}?${back}` : `/${locale}/agent/queues?${back}&done=queue_done`);
  redirect(`/${locale}/agent/tickets/SUP-${number}?done=${internal ? 'noted' : 'sent'}&${back}`);
}

/** Черновик из поля ответа: через секунду после ввода и при уходе со страницы (UX-A-07). */
export async function saveDraftAction(input: { number: number; body: string; internal: boolean }): Promise<{ ok: boolean }> {
  const staff = await requireStaffActor();
  try {
    await saveDraft(staff, input);
    return { ok: true };
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { ok: false };
  }
}

/**
 * Отметка "просмотрено" (UX-A-15). Ставит страница в браузере после показа, а не чтение страницы на сервере
 * (аудит 23.11.2026, находка A5): предзагрузка ссылки и запрос с чужой страницы обращение прочитанным не делают.
 */
export async function markSeenAction(ticketId: string): Promise<void> {
  const staff = await requireStaffActor();
  try {
    await markTicketRead(staff, ticketId);
  } catch (error) {
    if (!isHdtError(error)) throw error;
  }
}

/** Отметка "открыл" или "печатает" и список коллег на этом обращении (решение 10). */
export async function presenceAction(input: { number: number; mode: 'viewing' | 'typing' }): Promise<PresenceEntry[]> {
  const staff = await requireStaffActor();
  try {
    return await syncPresence(staff, input);
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return [];
  }
}

// --- Передача между линиями (план M3, задача 9) ---

export async function transferAction(form: FormData): Promise<void> {
  await run(
    form,
    (staff, number) =>
      transferToL2(staff, {
        number,
        reason: text(form, 'reason'),
        checked: String(form.get('checked') ?? ''),
        needed: String(form.get('needed') ?? ''),
        checklist: form.getAll('checklist').map(String),
      }),
    'transferred',
  );
}

export async function returnAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => returnToL1(staff, { number, explanation: String(form.get('explanation') ?? '') }), 'returned');
}

// --- Объединение дублей (план M3, задача 11) ---

/** Номер основного из "SUP-1042" или "1042". Непонятный номер сервис отклонит как invalid_input. */
export async function mergeAction(form: FormData): Promise<void> {
  await run(form, async (staff, number) => void (await mergeTicket(staff, { number, intoNumber: parseNumber(text(form, 'into')) ?? 'invalid' })), 'merged');
}

/** "Пригласить отправителя" (решения 13 и 15 вехи M4): приглашение гостю на адрес из письма в организацию обращения. */
export async function inviteSenderAction(form: FormData): Promise<void> {
  await run(
    form,
    async (staff, number) => {
      await inviteSender(staff, number);
    },
    'invited',
  );
}

// --- Передача в разработку (FR-DEV-02, 05, 06; план M8, задача 7) ---

/**
 * Передать обращение в разработку. Ручной режим: номер, ссылка и название задачи из формы. Режим API: задачу создаёт
 * портал, из формы берётся только номер существующей задачи, если сотрудник его указал. Роль и данные проверяет модуль.
 */
export async function sendToDevAction(form: FormData): Promise<void> {
  await run(
    form,
    async (staff, number) => {
      const externalId = text(form, 'externalId');
      await sendToDevelopment(
        staff,
        devTrackerMode() === 'manual' ? { ticketNumber: number, externalId, url: text(form, 'url'), title: text(form, 'title') } : { ticketNumber: number, ...(externalId ? { externalId } : {}) },
      );
    },
    'dev_sent',
  );
}

export async function unlinkDevAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => unlinkFromDevelopment(staff, { ticketNumber: number }), 'dev_unlinked');
}

/** Статус задачи в ручном режиме. Пустая версия: версия не меняется. */
export async function devTaskStatusAction(form: FormData): Promise<void> {
  await run(form, (staff) => setDevTaskStatus(staff, { devTaskId: text(form, 'devTaskId'), status: text(form, 'status'), ...(text(form, 'version') ? { version: text(form, 'version') } : {}) }), 'dev_status');
}

// --- Макросы (FR-AG-15, UX-A-16; план M8, задача 6) ---

/** Итог запуска макроса словами на языке страницы: что сделано, в чём отказано, вставлен ли шаблон. */
export type MacroRunState = { error?: string; title?: string; done?: string; refused?: string[]; template?: string };

const MACRO_ERRORS = new Set(['forbidden', 'not_found', 'invalid_input']);

/**
 * Запустить макрос на обращении. Права и переходы проверяет модуль: макрос выполняется от имени сотрудника.
 * Текст шаблона не отправляется: модуль дописывает его в черновик ответа сотрудника, поле ответа покажет его после
 * перечитывания страницы, сотрудник проверит и отправит сам (решение 7 плана M8). Если сотрудник пишет внутреннюю
 * заметку, шаблон не вставляется: черновик остаётся заметкой, причина видна среди невыполненных действий.
 */
export async function runMacroAction(number: number, macroId: string, seenVersion: string): Promise<MacroRunState> {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent.ticket.macros');
  let changed: ChangeSummary | null = null;
  try {
    const run = await runMacro(staff, { ticketNumber: number, macroId, seenVersion });
    const describe = await actionTexts({ macro: true });
    const done = describe(run.actions.filter((item) => item.ok), 'runs.notDone');
    const refused = describe(run.actions.filter((item) => !item.ok), 'runs.notDone');
    return {
      title: t(run.actions.some((item) => item.ok) ? 'result' : 'resultNone', { name: run.macroName }),
      ...(done.length > 0 ? { done: t('done', { actions: done.join('; ') }) } : {}),
      ...(refused.length > 0 ? { refused } : {}),
      ...(run.template ? { template: t(run.template.fallback ? 'templateFallback' : 'template') } : {}),
    };
  } catch (error) {
    if (isHdwError(error)) return { error: t(`errors.${MACRO_ERRORS.has(error.code) ? error.code : 'other'}`) };
    if (!isHdtError(error)) throw error;
    // Страница устарела: макрос ничего не сделал. Переход на свежую страницу со сводкой, как у остальных действий.
    if (error.code !== 'changed' || !error.changed) return { error: t('errors.other') };
    changed = error.changed;
  }
  const page = `/${await getLocale()}/agent/tickets/SUP-${Number.isInteger(number) ? number : 0}`;
  redirect(`${page}?error=changed&ch=${changed.newMessages}.${changed.statusChanged ? 1 : 0}.${changed.assigneeChanged ? 1 : 0}`);
}
