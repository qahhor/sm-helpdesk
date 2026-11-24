import * as z from 'zod';
import { cleanUserText } from '@/modules/hdc/pref';
import { MACRO_NAME_MAX, MACRO_QUEUES, MAX_ACTIONS } from './pref';
import { actionSchemas, issuesOf, type RuleIssue } from './rule-schema';

// Модуль hdw: схема макроса (FR-AG-15, UX-A-16; план M8, задача 6). Макрос это название и от одного до десяти
// действий из набора правил, без вебхука, распределения по кругу и уведомления. Чистый файл без базы: существование
// тегов, шаблонов и сотрудников проверяет слой api при сохранении.
//
// Отличия от действий правила:
//   - очередь только первая или вторая линия: это передача и возврат, которые делает сотрудник; очереди Customer
//     Care у сотрудника нет действия, и макрос не может сделать то, чего нельзя сотруднику;
//   - исполнитель: названный сотрудник или тот, кто запустил макрос (assign_me);
//   - ответ по шаблону не отправляется: текст вставляется в поле ответа (решение 7).

const action = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set_queue'), queue: z.enum(MACRO_QUEUES) }),
  actionSchemas.assign,
  z.strictObject({ action: z.literal('assign_me') }),
  actionSchemas.set_priority,
  actionSchemas.add_tag,
  actionSchemas.remove_tag,
  actionSchemas.add_note,
  actionSchemas.reply_template,
  actionSchemas.snooze,
  actionSchemas.set_status,
]);
export type MacroAction = z.infer<typeof action>;

const actions = z.array(action).min(1).max(MAX_ACTIONS);

/** Действия сохранённого макроса: той же схемой читает их выполнение, негодный макрос не запускается. */
export const storedMacro = z.object({ actions });

export const macroInput = z.strictObject({
  macroId: z.uuid().optional(),
  name: z.string().overwrite(cleanUserText).trim().min(1).max(MACRO_NAME_MAX),
  actions,
  isEnabled: z.boolean().default(true),
});

export type MacroDefinition = { macroId?: string; name: string; actions: MacroAction[]; isEnabled: boolean };

/** Проверяет ввод макроса. Отказ несёт путь до поля и код, как у правила. */
export function parseMacro(input: unknown): { ok: true; macro: MacroDefinition } | { ok: false; issues: RuleIssue[] } {
  const parsed = macroInput.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  const { macroId, ...rest } = parsed.data;
  return { ok: true, macro: { ...(macroId ? { macroId } : {}), ...rest } };
}
