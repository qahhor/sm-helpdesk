import 'server-only';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { MailPayload } from '../mail/render';
import { type NotificationKind, notifications, outbox } from '../schema';

// Модуль hdn, слой core: уведомления по идеям (ТЗ FR-IDEA-11, FR-NT-01, 03, 04; план M7, задача 8, решения 14, 15).
// Колокольчик получает каждое событие; письмо уходит, если человек не выключил письма об идеях (настройка ideas, по
// умолчанию включена) и за последние сутки не получал письма по этой же идее (кроме "Выпущена": always). Строки
// колокольчика и очереди писем ставятся двумя командами INSERT ... SELECT на всех получателей сразу, в транзакции
// действия: откат действия не оставляет ни уведомлений, ни писем, идея с тысячами голосов даёт одну пачку.

export type IdeaNotice = {
  kind: NotificationKind;
  /** Идея уведомления (переход из колокольчика) или null (сводка сотрудникам). */
  ideaId: string | null;
  userIds: readonly string[];
  /** Данные колокольчика: номер идеи, статус, число. Без текста клиентов. */
  payload: Record<string, string | number>;
  mail: {
    payload: MailPayload;
    settingsPath: string;
    /** Письмо уходит, даже если по этой идее сегодня уже было письмо ("Выпущена", решение 14). */
    always: boolean;
    /** Ключ "одно письмо в сутки": идея письма, для сводки пустая строка. */
    dayKey: string;
  } | null;
};

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** Колокольчик и письма одного события. Возвращает, сколько строк поставлено. */
export async function notifyManyTx(tx: Tx, notice: IdeaNotice): Promise<{ bell: number; emails: number }> {
  const ids = [...new Set(notice.userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return { bell: 0, emails: 0 };
  const bell = await tx.execute(sql`
    insert into ${notifications} (user_id, idea_id, kind, payload)
    select u, ${notice.ideaId}::uuid, ${notice.kind}, ${JSON.stringify(notice.payload)}::jsonb from unnest(${uuidArray(ids)}) as u`);
  if (!notice.mail) return { bell: bell.rowCount ?? 0, emails: 0 };
  const { payload, settingsPath, always, dayKey } = notice.mail;
  const emails = await tx.execute(sql`
    insert into ${outbox} (channel, recipient_kind, recipient_user_id, template, settings_path, payload)
    select 'email', 'user', u, ${payload.template}, ${settingsPath}, ${JSON.stringify(payload)}::jsonb
      from unnest(${uuidArray(ids)}) as u
     where not exists (select 1 from hdn_notification_prefs p where p.user_id = u and p.kind = 'ideas' and not p.email_enabled)
       and (${always} or not exists (
             select 1 from hdn_outbox o
              where o.template = ${payload.template} and o.recipient_user_id = u
                and coalesce(o.payload ->> 'ideaId', '') = ${dayKey} and o.created_on > now() - interval '1 day'))`);
  return { bell: bell.rowCount ?? 0, emails: emails.rowCount ?? 0 };
}

/** Было ли уже сегодня (за 20 часов) уведомление этого вида без идеи: ежедневная сводка не повторяется. */
export async function noticeSentRecentlyTx(tx: Tx, kind: NotificationKind): Promise<boolean> {
  const rows = await tx
    .select({ id: notifications.notificationId })
    .from(notifications)
    .where(and(eq(notifications.kind, kind), gt(notifications.createdOn, sql`now() - interval '20 hours'`)))
    .limit(1);
  return rows.length > 0;
}
