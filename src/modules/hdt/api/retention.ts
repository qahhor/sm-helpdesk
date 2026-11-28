import 'server-only';
import { and, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { getStorage, readSetting, writeAudit } from '@/modules/hdc/api';
import { contractEndedOrgIds } from '@/modules/hdu/api/orgs';
import { attachments, tickets } from '../schema';

// Модуль hdt, слой api: сроки хранения данных клиентов (ТЗ 14.6, решение 78; волна 7, T2; решение 0162).
//   - вложения хранятся 1 год после закрытия обращения;
//   - обращения и переписка хранятся, пока действует договор, и 3 года после его окончания.
// Ночная задача retention.client_data ВЫКЛЮЧЕНА настройкой retention.client_data_enabled (по умолчанию false):
// включение ждёт ответа юриста и владельца. Пока настройка выключена, задача идёт пробным прогоном: только считает,
// что подошло бы под удаление, пишет числа в журнал работы и ничего не меняет.
//
// Включённая задача удаляет файл вложения из хранилища и ставит строке отметку expired: строка остаётся, клиент её не
// видит (политика отдаёт клиенту только файлы clean). Обращения эта версия не удаляет и во включённом режиме: удаление
// строки обращения требует новых политик удаления в двух десятках связанных таблиц четырёх модулей, это изменение RLS
// согласуется отдельно (решение 0162). Число таких обращений задача считает и пишет в журнал работы.

export const RETENTION_ENABLED_SETTING = 'retention.client_data_enabled';
/** Вложения: год после закрытия обращения. Обращения: три года после окончания договора. */
export const ATTACHMENT_RETENTION_DAYS = 365;
export const TICKET_RETENTION_YEARS = 3;
/** Файлов за один прогон: остальное в следующую ночь. */
const BATCH = 500;

export type RetentionReport = {
  mode: 'dry_run' | 'delete';
  /** Файлы обращений, закрытых больше года назад (в пределах одной пачки). */
  attachmentsDue: number;
  attachmentsExpired: number;
  /** Организации, договор с которыми кончился больше трёх лет назад, и их обращения. */
  orgsDue: number;
  ticketsDue: number;
  ticketsDeleted: number;
};

/** День ГГГГ-ММ-ДД по UTC за years лет до now. */
function yearsBefore(now: Date, years: number): string {
  const day = new Date(now);
  day.setUTCFullYear(day.getUTCFullYear() - years);
  return day.toISOString().slice(0, 10);
}

export async function runClientDataRetention(system: SystemActor, now: Date = new Date()): Promise<RetentionReport> {
  if (system.type !== 'system') throw new Error('hdt: задача сроков хранения только для системы');
  const enabled = (await readSetting(RETENTION_ENABLED_SETTING)) === true;
  const closedBefore = new Date(now.getTime() - ATTACHMENT_RETENTION_DAYS * 86_400_000);
  const orgIds = await contractEndedOrgIds(system, yearsBefore(now, TICKET_RETENTION_YEARS));

  const { due, ticketsDue } = await withActor(system, async (tx) => {
    const due = await tx
      .select({ attachmentId: attachments.attachmentId, storageKey: attachments.storageKey })
      .from(attachments)
      .innerJoin(tickets, eq(tickets.ticketId, attachments.ticketId))
      .where(and(isNotNull(attachments.ticketId), ne(attachments.scanStatus, 'expired'), eq(tickets.status, 'closed'), lt(tickets.closedOn, closedBefore)))
      .orderBy(attachments.createdOn)
      .limit(BATCH);
    const [counted] = orgIds.length
      ? await tx.select({ count: sql<number>`count(*)::int` }).from(tickets).where(inArray(tickets.orgId, orgIds))
      : [{ count: 0 }];
    return { due, ticketsDue: counted?.count ?? 0 };
  });

  const report: RetentionReport = { mode: enabled ? 'delete' : 'dry_run', attachmentsDue: due.length, attachmentsExpired: 0, orgsDue: orgIds.length, ticketsDue, ticketsDeleted: 0 };
  if (!enabled || due.length === 0) {
    logEvent('info', enabled ? 'retention.client_data' : 'retention.client_data_dry_run', { ...report });
    return report;
  }

  // Сначала отметка строк и запись журнала одной транзакцией, затем файлы: строка с отметкой клиенту не видна, а файл
  // без действующей строки никому не выдаётся. Сбой хранилища виден в журнале работы, файл удалит следующий прогон
  // вручную по ключу из журнала.
  const ids = due.map((row) => row.attachmentId);
  const marked = await withActor(system, async (tx) => {
    const rows = await tx
      .update(attachments)
      .set({ scanStatus: 'expired' })
      .where(and(inArray(attachments.attachmentId, ids), ne(attachments.scanStatus, 'expired')))
      .returning({ attachmentId: attachments.attachmentId, storageKey: attachments.storageKey });
    if (rows.length > 0) await writeAudit(tx, { action: 'retention.attachments_expired', objectType: 'retention', objectId: now.toISOString().slice(0, 10), diff: { count: rows.length, olderThanDays: ATTACHMENT_RETENTION_DAYS } });
    return rows;
  });
  const storage = getStorage();
  let failed = 0;
  for (const row of marked) {
    try {
      await storage.remove(row.storageKey);
    } catch {
      failed += 1;
    }
  }
  report.attachmentsExpired = marked.length;
  logEvent(failed > 0 ? 'warn' : 'info', 'retention.client_data', { ...report, storageFailed: failed });
  return report;
}
