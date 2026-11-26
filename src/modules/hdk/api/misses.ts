import 'server-only';
import { count, desc, eq, gt, lt } from 'drizzle-orm';
import type { ClientActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import type { StaffContext } from '@/modules/hdc/api';
import { findInText } from '../checks';
import { HdkError } from '../error';
import { KB_PUBLISHER_ROLES } from '../pref';
import { kbSuggestMisses } from '../schema';

// Модуль hdk, слой api: что клиенты ищут и не находят (план W6, задача 9, решение 17; ответ владельца 0070, пункт 5).
// Последний запрос сессии формы без результата подсказки, после маски данных, без пользователя и организации.
// Хранится 90 дней. Видят администратор и роли публикации решений: сводка за неделю по модулю и языку и последние
// тексты. Кеша нет.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.suggest_misses' };
export const MISSES_KEEP_DAYS = 90;
export const MISSES_RECENT = 50;
const MAX_TEXT = 500;

/** Маска данных: найденное проверкой текста (телефон, адрес почты, ИНН, ПИНФЛ, сервер) и длинные числа. */
export function maskQuery(text: string): string {
  let out = text;
  for (const hit of findInText(text)) out = out.split(hit.text).join('***');
  return out.replace(/\d{5,}/g, '***').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/**
 * Исход показа подсказки клиенту: пусто, и запрос из двух слов и больше, значит строка сессии с текстом; нашлось,
 * и строка сессии удаляется (клиент нашёл, что искал). Ошибка записи подсказку не ломает.
 */
export async function noteSuggestOutcome(_actor: ClientActor, input: { sessionId: string; text: string; locale: Locale; moduleId: string | null; found: boolean }): Promise<void> {
  try {
    if (input.found) {
      await withActor(SYSTEM, (tx) => tx.delete(kbSuggestMisses).where(eq(kbSuggestMisses.sessionId, input.sessionId)));
      return;
    }
    if ((input.text.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0) < 2) return;
    const queryText = maskQuery(input.text);
    if (!queryText) return;
    await withActor(SYSTEM, (tx) =>
      tx
        .insert(kbSuggestMisses)
        .values({ sessionId: input.sessionId, locale: input.locale, moduleId: input.moduleId, queryText })
        .onConflictDoUpdate({ target: kbSuggestMisses.sessionId, set: { queryText, locale: input.locale, moduleId: input.moduleId } }),
    );
  } catch {
    // Сводка вспомогательная: сбой записи не должен мешать подсказке.
  }
}

export type MissSummary = { byModule: { moduleId: string | null; locale: Locale; count: number }[]; recent: { text: string; locale: Locale; moduleId: string | null; on: Date }[] };

/** Видит ли сотрудник сводку: администратор и роли публикации решений (команда базы знаний). */
export function canSeeSuggestMisses(ctx: StaffContext): boolean {
  return ctx?.actor?.type === 'staff' && (KB_PUBLISHER_ROLES as readonly string[]).includes(ctx.actor.staffRole);
}

/** Сводка за 7 дней и последние тексты: администратор и роли публикации решений. */
export async function suggestMisses(ctx: StaffContext, now: Date = new Date()): Promise<MissSummary> {
  if (!canSeeSuggestMisses(ctx)) throw new HdkError('forbidden');
  const since = new Date(now.getTime() - 7 * 86_400_000);
  return withActor(ctx.actor, async (tx) => {
    const byModule = await tx
      .select({ moduleId: kbSuggestMisses.moduleId, locale: kbSuggestMisses.locale, count: count() })
      .from(kbSuggestMisses)
      .where(gt(kbSuggestMisses.modifiedOn, since))
      .groupBy(kbSuggestMisses.moduleId, kbSuggestMisses.locale)
      .orderBy(desc(count()));
    const recent = await tx
      .select({ text: kbSuggestMisses.queryText, locale: kbSuggestMisses.locale, moduleId: kbSuggestMisses.moduleId, on: kbSuggestMisses.modifiedOn })
      .from(kbSuggestMisses)
      .orderBy(desc(kbSuggestMisses.modifiedOn))
      .limit(MISSES_RECENT);
    return { byModule: byModule.map((r) => ({ ...r, count: Number(r.count) })), recent };
  });
}

/** Ночная очистка: тексты старше 90 дней удаляются (ответ владельца 0070, пункт 5). */
export async function cleanupSuggestMisses(system: SystemActor, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MISSES_KEEP_DAYS * 86_400_000);
  return withActor(system, async (tx) => (await tx.delete(kbSuggestMisses).where(lt(kbSuggestMisses.modifiedOn, cutoff)).returning({ id: kbSuggestMisses.missId })).length);
}
