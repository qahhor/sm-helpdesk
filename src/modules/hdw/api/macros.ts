import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from '@/modules/hdc/api';
import { isHdrError, listAllTemplates, listTags, renderTemplate, type Tag, templatesByIdTx } from '@/modules/hdr/api';
import { addTicketTag, assignTicket, isHdtError, loadDraft, postStaffMessage, removeTicketTag, returnToL1, saveDraft, setPriority, setStatus, snoozeTicket, transferToL2 } from '@/modules/hdt/api';
import { macroTicket, type MacroTicket, recordMacroRun } from '@/modules/hdt/api/macros';
import { PRIORITIES, STAFF_WRITE_ROLES } from '@/modules/hdt/pref';
import { type AssignableStaff, listAssignableStaff } from '@/modules/hdu/api/staff-lookup';
import { deleteMacroTx, listMacrosTx, type MacroRecord, moveMacroTx, readMacroTx, runnableMacroTx, saveMacroTx } from '../core/macros';
import { missingActionRefs } from '../core/references';
import { HdwError } from '../error';
import { draftWithTemplate } from '../macro-draft';
import { type MacroAction, parseMacro } from '../macro-schema';
import { MACRO_ACTIONS, MACRO_QUEUES, type MacroResult, RULE_STATUS_TARGETS } from '../pref';
import type { ActionDone } from '../schema';

// Модуль hdw, слой api: макросы (FR-AG-15, UX-A-16, FR-ADM-10; план M8, задача 6, решение 7).
//
// Настройка: читает и меняет макросы только администратор, изменение требует входа не старше 15 минут (ТЗ 14.3).
//
// Запуск (runMacro): макрос выполняется от имени сотрудника и с его правами. Каждое действие это обычное действие
// обращения из модуля hdt (setStatus, assignTicket, transferToL2 и другие): те же проверки роли, переходов и данных,
// та же история и журнал, что у ручного действия. Действие, которого сотруднику нельзя, получает отказ с кодом
// (forbidden, transition_refused), остальные действия выполняются. Каждое действие идёт своей транзакцией: действия
// модуля обращений в одну транзакцию не складываются, поэтому итог записан по каждому действию. События предметной
// области от действий макроса помечены как порождённые правилом: правила на макрос не срабатывают (FR-AUTO-07).
// Ответ по шаблону макрос не отправляет: возвращает текст на языке обращения, страница кладёт его в поле ответа.

export type { MacroRecord } from '../core/macros';
export type { MacroAction, MacroDefinition } from '../macro-schema';
export { MACRO_ACTIONS, MACRO_NAME_MAX, MACRO_QUEUES, MAX_MACROS, type MacroResult } from '../pref';

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdwError('forbidden');
}

function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdwError('stale_session');
}

/** Ведёт ли сотрудник обращения: только такой запускает макросы (роль product читает). */
const canRun = (ctx: StaffContext): boolean => ctx.actor.type === 'staff' && (STAFF_WRITE_ROLES as readonly string[]).includes(ctx.actor.staffRole);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdwError('invalid_input');
  return parsed.data;
}

const idInput = z.strictObject({ macroId: z.uuid() });
const moveInput = z.strictObject({ macroId: z.uuid(), direction: z.enum(['up', 'down']) });
/** seenVersion: версия, с которой открыта страница обращения (FR-AG-12). Не передана: проверки устаревшей страницы нет. */
const runInput = z.strictObject({ ticketNumber: z.number().int().positive().max(999_999_999_999), macroId: z.uuid(), seenVersion: z.iso.datetime().optional() });

// --- Настройка ---

/** Все макросы по порядку. Только администратор. */
export async function listMacros(ctx: StaffContext): Promise<MacroRecord[]> {
  requireAdmin(ctx);
  return listMacrosTx(ctx.actor);
}

/** Макрос по идентификатору. Нет такого или идентификатор негоден: null. */
export async function readMacro(ctx: StaffContext, macroId: unknown): Promise<MacroRecord | null> {
  requireAdmin(ctx);
  const id = z.uuid().safeParse(macroId);
  return id.success ? readMacroTx(ctx.actor, id.data) : null;
}

/**
 * Создать макрос (без macroId: последним по порядку) или изменить существующий. Отказ invalid_input несёт issues:
 * путь до поля и код, в том числе reference_missing для удалённого тега, шаблона или сотрудника.
 */
export async function saveMacro(ctx: StaffContext, input: unknown): Promise<{ macroId: string }> {
  requireFreshAdmin(ctx);
  const parsed = parseMacro(input);
  if (!parsed.ok) throw new HdwError('invalid_input', parsed.issues);
  const issues = await missingActionRefs(ctx.actor, parsed.macro.actions);
  if (issues.length > 0) throw new HdwError('invalid_input', issues);
  return saveMacroTx(ctx.actor, parsed.macro);
}

/** Сдвинуть макрос на одно место вверх или вниз. На краю списка ничего не меняется. */
export async function moveMacro(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(moveInput, input);
  await moveMacroTx(ctx.actor, data.macroId, data.direction);
}

export async function deleteMacro(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  await deleteMacroTx(ctx.actor, parse(idInput, input).macroId);
}

export type MacroOptions = {
  actions: readonly string[];
  queues: readonly string[];
  priorities: readonly string[];
  statusTargets: readonly string[];
  /** Сотрудники, которых можно назначить исполнителем. */
  staff: AssignableStaff[];
  tags: Tag[];
  templates: { templateId: string; title: string; isEnabled: boolean }[];
};

/** Списки для редактора макроса. Только администратор. */
export async function macroOptions(ctx: StaffContext): Promise<MacroOptions> {
  requireAdmin(ctx);
  const [staff, tags, templates] = await Promise.all([listAssignableStaff(ctx), listTags(ctx), listAllTemplates(ctx)]);
  return {
    actions: MACRO_ACTIONS,
    queues: MACRO_QUEUES,
    priorities: PRIORITIES,
    statusTargets: RULE_STATUS_TARGETS,
    staff,
    tags,
    templates: templates.map((item) => ({ templateId: item.templateId, title: item.title, isEnabled: item.isEnabled })),
  };
}

// --- Запуск ---

/** Включённые макросы для меню на странице обращения. Тому, кто обращений не ведёт (product), список пуст. */
export async function listRunnableMacros(ctx: StaffContext): Promise<{ macroId: string; name: string }[]> {
  if (!canRun(ctx)) return [];
  const list = await listMacrosTx(ctx.actor);
  return list.filter((macro) => macro.isEnabled && macro.isValid).map((macro) => ({ macroId: macro.macroId, name: macro.name }));
}

export type MacroRun = {
  macroName: string;
  /** Итог каждого действия по порядку: выполнено, менять было нечего или отказ с кодом. */
  actions: ActionDone[];
  /**
   * Текст шаблона, вставленный в черновик ответа, на языке обращения. fallback: перевода нет, текст русский. null:
   * действия с шаблоном нет или шаблон не вставлен (сотрудник пишет внутреннюю заметку: действие записано отказом
   * draft_is_note).
   */
  template: { text: string; fallback: boolean } | null;
};

const HOUR_MS = 3_600_000;
/** Коды отказов действий обращения, которые макрос передаёт как есть. Остальные записываются общим кодом refused. */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set(['forbidden', 'transition_refused', 'merged', 'not_found', 'invalid_input', 'rate_limited', 'resolution_required', 'changed', 'too_many_tags']);

type Outcome = Omit<ActionDone, 'action'>;
const done = (from?: string | null, to?: string | null): Outcome => ({ ok: true, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
const unchanged = (value: string | null): Outcome => ({ ok: true, from: value, to: value, unchanged: true });
const refused = (detail: string): Outcome => ({ ok: false, detail });

/** Справочники запуска: читаются один раз и только если нужны действию. */
type Lookups = { staff: () => Promise<AssignableStaff[]>; tags: () => Promise<Map<string, Tag>> };

async function perform(
  ctx: StaffContext,
  macro: MacroRecord,
  action: MacroAction,
  ticket: MacroTicket,
  number: number,
  lookups: Lookups,
  texts: { text: string; fallback: boolean }[],
  seenVersion: string | undefined,
): Promise<Outcome> {
  const byMacro = { byMacro: true } as const;
  switch (action.action) {
    case 'set_queue': {
      if (ticket.queue === action.queue) return unchanged(action.queue);
      // Передача между линиями это действие сотрудника с запиской (FR-LINE-03, 04): записка называет макрос.
      if (action.queue === 'l2') await transferToL2(ctx, { number, reason: 'other', checked: macro.name, needed: macro.name });
      else await returnToL1(ctx, { number, explanation: macro.name }, byMacro);
      return done(ticket.queue, action.queue);
    }
    case 'assign':
    case 'assign_me': {
      const userId = action.action === 'assign' ? action.userId : ctx.user.id;
      const member = (await lookups.staff()).find((item) => item.userId === userId);
      if (!member) return refused('user_missing');
      if (ticket.assigneeId === userId) return unchanged(member.name);
      await assignTicket(ctx, { number, assigneeId: userId, seenVersion });
      return done(undefined, member.name);
    }
    case 'set_priority':
      // Тот же приоритет макрос не трогает: подтверждение приоритета это решение сотрудника, а не макроса.
      if (ticket.priority === action.priority) return unchanged(action.priority);
      await setPriority(ctx, { number, priority: action.priority, reason: macro.name, seenVersion }, byMacro);
      return done(ticket.priority, action.priority);
    case 'add_tag': {
      const tag = (await lookups.tags()).get(action.tagId);
      if (!tag) return refused('tag_missing');
      if (ticket.tagIds.includes(tag.tagId)) return unchanged(tag.name);
      await addTicketTag(ctx, { number, name: tag.name });
      return done(null, tag.name);
    }
    case 'remove_tag': {
      const tag = (await lookups.tags()).get(action.tagId);
      if (!tag) return refused('tag_missing');
      if (!ticket.tagIds.includes(tag.tagId)) return unchanged(null);
      await removeTicketTag(ctx, { number, tagId: tag.tagId });
      return done(tag.name, null);
    }
    case 'add_note': {
      // Заметка сотрудника стирает его черновик ответа: черновик, начатый до макроса, возвращается на место.
      // Проверка устаревшей страницы по той же версии, что у остальных действий; без версии проверки нет.
      const draft = await loadDraft(ctx, number);
      const posted = await postStaffMessage(ctx, { number, body: action.text, internal: true, seenVersion: seenVersion ?? new Date(Date.now() + 60_000).toISOString() });
      if (draft && draft.body !== '') await saveDraft(ctx, { number, body: draft.body, internal: draft.internal });
      return posted.ok ? done() : refused('changed');
    }
    case 'reply_template': {
      const template = (await withActor(ctx.actor, (tx) => templatesByIdTx(tx, [action.templateId]))).get(action.templateId);
      if (!template) return refused('template_missing');
      if (!template.isEnabled) return refused('template_disabled');
      // Текст на языке обращения; перевода нет: русский с отметкой для агента (FR-AG-06). Ничего не отправляется.
      const rendered = renderTemplate(template, ticket.locale);
      if (!rendered.text.trim()) return refused('template_missing');
      texts.push(rendered);
      return done(undefined, template.title);
    }
    case 'snooze': {
      const until = new Date(Date.now() + action.hours * HOUR_MS);
      await snoozeTicket(ctx, { number, until });
      return done(undefined, until.toISOString());
    }
    case 'set_status':
      if (ticket.status === action.status) return unchanged(action.status);
      await setStatus(ctx, { number, to: action.status, seenVersion }, byMacro);
      return done(ticket.status, action.status);
  }
}

const resultOf = (actions: readonly ActionDone[]): MacroResult => (actions.every((item) => item.ok) ? 'applied' : actions.some((item) => item.ok) ? 'partial' : 'failed');

/**
 * Запустить макрос на обращении от имени сотрудника. Отказы: forbidden (сотрудник не ведёт обращения), invalid_input,
 * not_found (нет обращения; макроса нет, он выключен или негоден), changed модуля обращений (страница с версией
 * seenVersion устарела, ничего не выполнено). Действия идут по порядку; отказ одного не
 * останавливает остальные. В историю обращения пишется одна внутренняя запись о запуске, в журнал запись macro.run.
 *
 * Текст шаблона не отправляется: он дописывается в черновик ответа сотрудника (решение 7 плана M8). В непустой
 * черновик внутренней заметки шаблон не вставляется (draftWithTemplate): черновик не меняется, действие записывается
 * отказом draft_is_note, сотрудник видит причину в итоге макроса.
 */
export async function runMacro(ctx: StaffContext, input: unknown): Promise<MacroRun> {
  if (!canRun(ctx)) throw new HdwError('forbidden');
  const data = parse(runInput, input);
  const number = data.ticketNumber;
  const macro = await runnableMacroTx(ctx.actor, data.macroId);
  if (!macro) throw new HdwError('not_found');
  // Страница устарела (обращение изменили другие после seenVersion): ошибка changed модуля обращений, ни одно действие
  // не выполняется и запись о запуске не пишется (FR-AG-12, решение 0040). Версия передаётся и действиям: изменение
  // другого человека посреди макроса даёт этому и следующим действиям отказ changed. Свои действия изменением не считаются.
  const seen = data.seenVersion ? new Date(data.seenVersion) : undefined;
  if (!(await macroTicket(ctx, number, { seen }))) throw new HdwError('not_found');

  let staff: Promise<AssignableStaff[]> | undefined;
  let tags: Promise<Map<string, Tag>> | undefined;
  const lookups: Lookups = {
    staff: () => (staff ??= listAssignableStaff(ctx)),
    tags: () => (tags ??= listTags(ctx).then((list) => new Map(list.map((tag) => [tag.tagId, tag])))),
  };
  const texts: { text: string; fallback: boolean }[] = [];
  const actions: ActionDone[] = [];
  for (const action of macro.actions) {
    // Действие "исполнитель я" записывается как назначение исполнителя: в истории оно читается так же.
    const code = action.action === 'assign_me' ? 'assign' : action.action;
    let outcome: Outcome;
    try {
      // Состояние обращения читается перед каждым действием: предыдущее действие макроса могло его изменить.
      const ticket = await macroTicket(ctx, number);
      outcome = ticket ? await perform(ctx, macro, action, ticket, number, lookups, texts, data.seenVersion) : refused('not_found');
    } catch (error) {
      if (isHdtError(error) || isHdrError(error)) outcome = refused(KNOWN_REFUSALS.has(error.code) ? error.code : 'refused');
      else {
        // Вид ошибки без её текста: в тексте могут быть данные клиента. Остальные действия макроса идут дальше.
        logEvent('error', 'macro.action_failed', { macroId: macro.macroId, action: action.action, error: error instanceof Error ? error.name : 'ошибка' });
        outcome = refused('error');
      }
    }
    actions.push({ action: code, ...outcome });
  }
  let template: MacroRun['template'] = null;
  if (texts.length > 0) {
    const text = texts.map((item) => item.text).join('\n\n');
    const draft = draftWithTemplate(await loadDraft(ctx, number), text);
    if (draft) {
      await saveDraft(ctx, { number, ...draft });
      template = { text, fallback: texts.some((item) => item.fallback) };
    } else {
      // Действие "вставить шаблон" считалось выполненным, пока текст был только собран: в черновик он не попал.
      for (const [index, item] of actions.entries()) if (item.action === 'reply_template' && item.ok) actions[index] = { action: item.action, ...refused('draft_is_note') };
    }
  }
  await recordMacroRun(ctx, { number, macroId: macro.macroId, macroName: macro.name, result: resultOf(actions), actions });
  return { macroName: macro.name, actions, template };
}
