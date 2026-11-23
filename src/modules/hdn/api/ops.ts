import 'server-only';
import { createTranslator } from 'next-intl';
import type { SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import type { Locale } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { staleInboundIds } from '../core/inbound';
import { oncallEmails } from '../core/mail-settings';
import { oncallSender } from '../core/oncall';
import type { OncallSender } from '../core/outbox';
import { renderMail } from '../mail/render';
import { type EmailProvider, getEmailProvider } from '../provider';

// Модуль hdn, слой api: сигналы дежурным о состоянии портала (ТЗ 13.8; аудит 23.11.2026, находки O2 и S4).
// Проверки по данным модуля (очередь исходящих, входящие письма) и отправка сигнала: в чат дежурных и письмом на их
// адреса. Сигнал уходит напрямую, мимо очереди исходящих: очередь сама может быть тем, что сломалось.

export { outboxFailedSince, outboxState } from '../core/outbox';

const MESSAGES = { ru, uz, en } as const;

export const OPS_ALERT_CODES = ['jobs_failed', 'outbox_failed', 'outbox_lag', 'inbound_stuck', 'staff_signin_failures', 'infected_files', 'archive_failing'] as const;
export type OpsAlertCode = (typeof OPS_ALERT_CODES)[number];
export type OpsAlert = { code: OpsAlertCode; count: number; minutes?: number };

/** Входящие письма, разбор которых не закончился за 10 минут (не больше 100). */
export async function staleInboundCount(actor: SystemActor, now: Date): Promise<number> {
  return (await staleInboundIds(actor, now, 100)).length;
}

/** Текст сигнала: только вид и числа. Чат дежурных служебный, по умолчанию русский. */
export function opsAlertText(alert: OpsAlert, locale: Locale = 'ru'): string {
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bot.ops' });
  return t(alert.code, { count: alert.count, minutes: alert.minutes ?? 0 });
}

/**
 * Отправляет сигнал дежурным: в чат Telegram и письмом на каждый адрес. Сбой одного способа не мешает другому
 * и не бросает: о сбое говорит журнал процесса. Возвращает, сколько способов сработало.
 */
export async function sendOpsAlert(alert: OpsAlert, now: Date, deps: { provider?: EmailProvider; oncall?: OncallSender | null } = {}): Promise<number> {
  const text = opsAlertText(alert);
  let delivered = 0;
  try {
    const chat = deps.oncall !== undefined ? deps.oncall : await oncallSender();
    if (chat) {
      await chat.send(text);
      delivered++;
    }
  } catch (error) {
    logEvent('error', 'ops.alert_not_sent', { code: alert.code, channel: 'telegram', error });
  }
  try {
    const addresses = await oncallEmails();
    if (addresses.length > 0) {
      const env = getEnv();
      const provider = deps.provider ?? (await getEmailProvider());
      const mail = await renderMail('ops_alert', 'ru', { template: 'ops_alert', text, url: `${env.HUB_URL}/ru/agent`, hubUrl: env.HUB_URL, supportAddress: null });
      // Ключ повторной отправки: вид сигнала и час. Повтор задачи в тот же час письмо не дублирует.
      const hour = Math.floor(now.getTime() / 3_600_000);
      for (const [index, to] of addresses.entries()) {
        try {
          await provider.send({ to, subject: mail.subject, html: mail.html, text: mail.text, headers: { 'Auto-Submitted': 'auto-generated' } }, `ops-${alert.code}-${hour}-${index}`);
          delivered++;
        } catch (error) {
          logEvent('error', 'ops.alert_not_sent', { code: alert.code, channel: 'email', error });
        }
      }
    }
  } catch (error) {
    logEvent('error', 'ops.alert_not_sent', { code: alert.code, channel: 'email', error });
  }
  return delivered;
}
