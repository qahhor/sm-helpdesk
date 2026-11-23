import type { SystemActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { archiveFailing, archiveState, claimOpsAlert, failedJobsSince, failedStaffSignIns } from '@/modules/hdc/api';
import { heldInboundCount, type OpsAlert, type OpsAlertCode, outboxFailedSince, outboxState, sendOpsAlert, staleInboundCount } from '@/modules/hdn/api/ops';
import { infectedSince } from '@/modules/hdt/api/jobs';

// Задача ops.watch фонового процесса (ТЗ 13.8; аудит 23.11.2026, находки O2 и S4; план W0, задача 4).
// Раз в 5 минут собирает проверки модулей и шлёт дежурным сигнал: в чат и письмом. Один вид сигнала уходит не чаще
// раза в час. В сигнале только вид и числа. Частью модуля не является: берёт у модулей слой api.

const MINUTE = 60_000;
/** Очередь исходящих считается застрявшей, если самая старая строка ждёт дольше 5 минут. */
export const OUTBOX_LAG_ALERT_SEC = 300;
/** Столько неудачных входов сотрудников за 15 минут считается подбором пароля. */
export const STAFF_SIGNIN_ALERT = 20;
/** Столько писем за час, остановленных пределом частоты, считается потоком. Один шумный отправитель даёт меньше. */
export const INBOUND_HELD_ALERT = 10;

type Deps = Parameters<typeof sendOpsAlert>[2];

export async function collectOpsAlerts(actor: SystemActor, now: Date): Promise<OpsAlert[]> {
  const hourAgo = new Date(now.getTime() - 60 * MINUTE);
  const [jobs, failed, state, stuck, signIns, infected, archive, held] = await Promise.all([
    failedJobsSince(actor, hourAgo),
    outboxFailedSince(actor, hourAgo),
    outboxState(actor, now),
    staleInboundCount(actor, now),
    failedStaffSignIns(actor, now),
    infectedSince(actor, hourAgo),
    archiveState(actor),
    heldInboundCount(actor, hourAgo),
  ]);
  const alerts: OpsAlert[] = [];
  if (jobs > 0) alerts.push({ code: 'jobs_failed', count: jobs });
  if (failed > 0) alerts.push({ code: 'outbox_failed', count: failed });
  if (state.lagSec > OUTBOX_LAG_ALERT_SEC) alerts.push({ code: 'outbox_lag', count: state.queued, minutes: Math.floor(state.lagSec / 60) });
  if (stuck > 0) alerts.push({ code: 'inbound_stuck', count: stuck });
  if (signIns >= STAFF_SIGNIN_ALERT) alerts.push({ code: 'staff_signin_failures', count: signIns });
  if (infected > 0) alerts.push({ code: 'infected_files', count: infected });
  // Архив журнала базы включён, а сегменты не сохраняются: восстановления на момент времени сейчас нет.
  if (archiveFailing(archive)) alerts.push({ code: 'archive_failing', count: archive.failedCount });
  // Предел частоты остановил много писем: в обращения они не попали, среди них могут быть письма новых клиентов.
  if (held >= INBOUND_HELD_ALERT) alerts.push({ code: 'inbound_held', count: held });
  return alerts;
}

/** Проверяет состояние и отправляет новые сигналы. Возвращает виды сигналов, которые дошли хотя бы одним способом. */
export async function opsWatch(actor: SystemActor, now: Date = new Date(), deps: Deps = {}): Promise<OpsAlertCode[]> {
  const sent: OpsAlertCode[] = [];
  for (const alert of await collectOpsAlerts(actor, now)) {
    // Право на сигнал занимается до отправки: при сбое отправки следующий сигнал этого вида уйдёт через час,
    // а не каждые 5 минут. О сбое отправки пишет журнал процесса.
    if (!(await claimOpsAlert(actor, alert.code, now))) continue;
    const delivered = await sendOpsAlert(alert, now, deps);
    if (delivered > 0) sent.push(alert.code);
    // Никуда не ушёл (дежурные не настроены или оба способа отказали): это ошибка в журнале, а не "отправлено"
    // (итоговая проверка W0, I4).
    else logEvent('error', 'ops.alert_undelivered', { code: alert.code, count: alert.count });
  }
  return sent;
}
