import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { type Actor, withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdu/api';
import { FRESH_SIGN_IN_SEC, isFresh } from '@/modules/hdu/api/session';
import { findPlaybookTx, listPlaybooksTx, type Playbook, PLAYBOOK_KEEPERS, savePlaybookTx } from './core/playbooks';
import { listAllTemplatesTx, listTemplatesTx, type ReplyTemplate, saveTemplateTx } from './core/templates';
import { loadSlaConfigTx, saveCalendarTx, saveHolidaysTx, saveSlaPolicyTx, type SlaConfig } from './core/sla-config';
import { HdrError } from './error';
import { calendarInput, holidaysInput, playbookInput, slaPolicyInput, templateInput, templateQueryInput } from './input';
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

/** Изменение настройки: администратор со входом не старше 15 минут (ТЗ 14.3, решение 0014; аудит 23.11.2026, S10). */
function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdrError('stale_session');
}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdrError('invalid_input');
  return parsed.data;
}

/** Сроки одного приоритета (FR-SLA-01). Новые значения действуют на новые расчёты (решение 0032). */
export async function saveSlaPolicy(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
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
  requireFreshAdmin(ctx);
  const data = parse(calendarInput, input);
  await saveCalendarTx(ctx.actor, data);
}

/** Праздники одного года (FR-SLA-12). */
export async function saveHolidays(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(holidaysInput, input);
  await saveHolidaysTx(ctx.actor, data.year, data.dates);
}

// --- Памятки первой линии (план M3, задача 9) ---

export { type Playbook, PLAYBOOK_KEEPERS } from './core/playbooks';
export { parseHolidays, playbookItems } from './util';

/** Памятка "что проверить до передачи" для модуля и типа обращения, иначе общая для типа (FR-LINE-10). */
export function getPlaybook(actor: Actor, input: { moduleId: string | null; type: string }): Promise<Playbook | null> {
  const data = parse(playbookInput.pick({ moduleId: true, type: true }), input);
  return findPlaybookTx(actor, data.moduleId, data.type);
}

export function listPlaybooks(ctx: StaffContext): Promise<Playbook[]> {
  return listPlaybooksTx(ctx.actor);
}

/** Сохранить памятку: вторая линия, care и admin (10.5). */
export async function savePlaybook(ctx: StaffContext, input: unknown): Promise<void> {
  if (!(PLAYBOOK_KEEPERS as readonly string[]).includes(ctx.actor.staffRole)) throw new HdrError('forbidden');
  const data = parse(playbookInput, input);
  await savePlaybookTx(ctx.actor, data.moduleId, data.type, data.body);
}

// --- Шаблоны ответов (план M3, задача 10) ---

export type { ReplyTemplate } from './core/templates';
export { filterTemplates, renderTemplate, slashQuery } from './util';

/** Включённые шаблоны для поля ответа (FR-AG-06): общие и шаблоны модуля обращения. Читают сотрудники. */
export function listTemplates(ctx: StaffContext, input: unknown): Promise<ReplyTemplate[]> {
  const data = parse(templateQueryInput, input);
  return listTemplatesTx(ctx.actor, { q: data.q || undefined, moduleId: data.moduleId ?? null });
}

/** Все шаблоны для экрана настроек: только администратор. */
export function listAllTemplates(ctx: StaffContext): Promise<ReplyTemplate[]> {
  requireAdmin(ctx);
  return listAllTemplatesTx(ctx.actor);
}

/** Новый шаблон или правка: только администратор (10.5). */
export async function saveTemplate(ctx: StaffContext, input: unknown): Promise<void> {
  // Текст шаблона уходит клиентам от имени поддержки: меняет его только свежий вход (итоговая проверка W0, I5).
  requireFreshAdmin(ctx);
  const data = parse(templateInput, input);
  await saveTemplateTx(ctx.actor, data);
}
