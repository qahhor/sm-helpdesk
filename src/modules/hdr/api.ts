import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { type Actor, withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdu/api';
import { loadSlaConfigTx, saveCalendarTx, saveHolidaysTx, saveSlaPolicyTx, type SlaConfig } from './core/sla-config';
import { HdrError } from './error';
import { calendarInput, holidaysInput, slaPolicyInput } from './input';
import { productModules } from './schema';

// Модуль hdr (справочники), слой api: то, что могут вызывать страницы и другие модули.
// Справочник модулей Smartup читают все акторы (раздел 10.5).

export type ModuleOption = { moduleId: string; code: string; name: string };

/** Действует ли модуль справочника. Отключённый и несуществующий: ложь. */
export async function isActiveModule(actor: Actor, moduleId: string): Promise<boolean> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ moduleId: productModules.moduleId })
      .from(productModules)
      .where(and(eq(productModules.moduleId, moduleId), eq(productModules.state, 'active')))
      .limit(1),
  );
  return rows.length > 0;
}

/** Действующие модули с названием на языке страницы (русское, если перевода нет), по коду. */
export async function listActiveModules(actor: Actor, locale: string): Promise<ModuleOption[]> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ moduleId: productModules.moduleId, code: productModules.code, name: productModules.name })
      .from(productModules)
      .where(eq(productModules.state, 'active'))
      .orderBy(asc(productModules.code)),
  );
  return rows.map((row) => ({ moduleId: row.moduleId, code: row.code, name: row.name[locale] ?? row.name.ru }));
}

// --- Сроки SLA и рабочий календарь (план M3, задача 2) ---

export { readSlaConfig, type Priority, type SlaCalendar, type SlaConfig, type SlaPolicy } from './core/sla-config';
export { HdrError, isHdrError } from './error';

/** Сроки и календарь. Читает любой актор (раздел 10.5). */
export function loadSlaConfig(actor: Actor): Promise<SlaConfig> {
  return loadSlaConfigTx(actor);
}

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.staffRole !== 'admin') throw new HdrError('forbidden');
}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdrError('invalid_input');
  return parsed.data;
}

/** Сроки одного приоритета (FR-SLA-01). Новые значения действуют на новые расчёты (решение 0032). */
export async function saveSlaPolicy(ctx: StaffContext, input: unknown): Promise<void> {
  requireAdmin(ctx);
  const data = parse(slaPolicyInput, input);
  await saveSlaPolicyTx(ctx.actor, data.priority, {
    firstResponseMinutes: data.firstResponseMinutes,
    resolutionMinutes: data.resolutionMinutes ?? null,
    resolutionDays: data.resolutionDays ?? null,
    clock: data.clock,
  });
}

/** Часовой пояс и график недели. */
export async function saveCalendar(ctx: StaffContext, input: unknown): Promise<void> {
  requireAdmin(ctx);
  const data = parse(calendarInput, input);
  await saveCalendarTx(ctx.actor, data);
}

/** Праздники одного года (FR-SLA-12). */
export async function saveHolidays(ctx: StaffContext, input: unknown): Promise<void> {
  requireAdmin(ctx);
  const data = parse(holidaysInput, input);
  await saveHolidaysTx(ctx.actor, data.year, data.dates);
}
