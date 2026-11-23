import 'server-only';
import { and, eq, gt, sql } from 'drizzle-orm';
import { type SystemActor, withActor } from '@/db/with-actor';
import { consumeRateLimit } from './rate-limit';
import { opsAlerts, rateLimits } from './schema';

// Модуль hdc: сигналы дежурным о состоянии портала (ТЗ 13.8; аудит 23.11.2026, находки O2 и S4).
// Здесь отметка "сигнал этого вида уже уходил" и проверки по данным самого модуля: счётчик неудачных входов и
// очередь задач.

/** Один вид сигнала уходит не чаще раза в час. */
export const OPS_ALERT_EVERY_MS = 60 * 60_000;

/**
 * Занимает право отправить сигнал: истина, если сигнал этого вида не уходил последний час. Одна команда базы,
 * поэтому два фоновых процесса не отправят один сигнал дважды.
 */
export async function claimOpsAlert(actor: SystemActor, code: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - OPS_ALERT_EVERY_MS);
  const rows = await withActor(actor, (tx) =>
    tx
      .insert(opsAlerts)
      .values({ code, lastSentOn: now })
      .onConflictDoUpdate({ target: opsAlerts.code, set: { lastSentOn: now }, setWhere: sql`${opsAlerts.lastSentOn} <= ${cutoff}` })
      .returning({ code: opsAlerts.code }),
  );
  return rows.length > 0;
}

const SIGNIN_COUNTER = 'ops:staff-signin-failures';
/** Окно счёта неудачных входов сотрудников: 15 минут. */
export const STAFF_SIGNIN_WINDOW_SEC = 15 * 60;

/**
 * Учитывает неудачный вход сотрудника в общем счётчике портала. Журнал аудита для счёта не годится: его читает
 * только администратор, а повторные неудачи одной блокировки в него не пишутся. Счётчик лежит в hdc_rate_limits,
 * в нём нет ни адреса, ни учётной записи.
 */
export async function noteStaffSignInFailure(now: Date = new Date()): Promise<void> {
  await consumeRateLimit(SIGNIN_COUNTER, { limit: 2_000_000_000, windowSec: STAFF_SIGNIN_WINDOW_SEC }, now);
}

/** Неудачные входы сотрудников в текущем окне 15 минут: признак подбора пароля. */
export async function failedStaffSignIns(actor: SystemActor, now: Date): Promise<number> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ hits: rateLimits.hits })
      .from(rateLimits)
      .where(and(eq(rateLimits.code, SIGNIN_COUNTER), gt(rateLimits.windowOn, new Date(now.getTime() - STAFF_SIGNIN_WINDOW_SEC * 1000)))),
  );
  return rows[0]?.hits ?? 0;
}

/** Фоновые задачи, которые исчерпали повторы и не выполнены, с этого времени. */
export async function failedJobsSince(actor: SystemActor, since: Date): Promise<number> {
  const rows = await withActor(actor, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where state = 'failed' and completed_on > ${since}`));
  return rows.rows[0]?.n ?? 0;
}
