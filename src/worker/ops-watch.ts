import type { SystemActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { archiveFailing, archiveState, claimOpsAlert, droppedEventsSince, eventsState, failedJobsSince, failedStaffSignIns } from '@/modules/hdc/api';
import { heldInboundCount, type OpsAlert, type OpsAlertCode, outboxFailedSince, outboxState, sendOpsAlert, staleInboundCount } from '@/modules/hdn/api/ops';
import { infectedSince, unidentifiedSince } from '@/modules/hdt/api/jobs';
import { inactiveBuiltinRules } from '@/modules/hdw/api/engine';

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
/** Столько обращений из писем с неизвестных адресов за час считается потоком. */
export const UNIDENTIFIED_FLOOD_ALERT = 60;
/** Очередь событий автоматизации считается застрявшей, если самое старое событие ждёт разбора дольше 5 минут. */
export const AUTOMATION_LAG_ALERT_SEC = 300;

type Deps = Parameters<typeof sendOpsAlert>[2];

export async function collectOpsAlerts(actor: SystemActor, now: Date): Promise<OpsAlert[]> {
  const hourAgo = new Date(now.getTime() - 60 * MINUTE);
  const [jobs, failed, state, stuck, signIns, infected, archive, held, unidentified, dropped, events, inactive] = await Promise.all([
    failedJobsSince(actor, hourAgo),
    outboxFailedSince(actor, hourAgo),
    outboxState(actor, now),
    staleInboundCount(actor, now),
    failedStaffSignIns(actor, now),
    infectedSince(actor, hourAgo),
    archiveState(actor),
    heldInboundCount(actor, hourAgo),
    unidentifiedSince(actor, hourAgo),
    droppedEventsSince(actor, hourAgo),
    eventsState(actor, now),
    inactiveBuiltinRules(actor),
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
  // Предел частоты остановил много писем одного отправителя или в одно обращение: в обращения они не попали.
  if (held >= INBOUND_HELD_ALERT) alerts.push({ code: 'inbound_held', count: held });
  // Поток писем с неизвестных адресов: письма не теряются, но очередь "Неопознанные" растёт. Решает человек.
  if (unidentified >= UNIDENTIFIED_FLOOD_ALERT) alerts.push({ code: 'unidentified_flood', count: unidentified });
  // Событие обращения снято с очереди после пяти сбоев разбора: его правила и уведомления не выполнены. Среди них
  // может быть сообщение дежурным о P1 (предустановленное правило; план M8, задача 10), поэтому сигнал от одного события.
  if (dropped > 0) alerts.push({ code: 'automation_dropped', count: dropped });
  // Очередь событий стоит (фоновая задача не идёт или события ждут повтора после сбоев): правила и уведомления
  // опаздывают, среди них сообщение дежурным о P1 (проверка вехи M8, находка I7).
  if (events.lagSec > AUTOMATION_LAG_ALERT_SEC) alerts.push({ code: 'automation_lag', count: events.pending, minutes: Math.floor(events.lagSec / 60) });
  // Встроенное уведомление портала выключено, негодно или осталось без своего действия: пока это так, дежурные о
  // P1, руководитель линии о сроке или Customer Care о низкой оценке не узнают. Сигнал повторяется раз в час.
  if (inactive.length > 0) alerts.push({ code: 'builtin_rule_inactive', count: inactive.length, rules: inactive.join(', ') });
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
