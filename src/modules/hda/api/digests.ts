import 'server-only';
import { and, desc, eq, gt, isNotNull, isNull, lt, type SQL, sql } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { logEvent } from '@/lib/log';
import { readSetting, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { staffBotSender } from '@/modules/hdn/api/oncall';
import { codeScanChatText, teamChatText } from '../agent/team-chat';
import { HdaError } from '../error';
import { AGENT_SETTINGS, REPORT_CHAT_KEYS, REPORT_KINDS, type ReportKind, TELEGRAM_CHAT_ID } from '../pref';
import { agentReports, codeScans } from '../schema';

// Модуль hda, слой api: раздел "Сводки" (веха M8b, задача 10; FR-AGT-04, 07, 13, 8.12, 10.5 "Запись: А. Чтение: С.
// К: нет"; план M8b, решения 22-24). Сводки читают все сотрудники, отметку "Просмотрено" ставит сотрудник от своего
// имени с записью журнала аудита той же транзакцией. Сообщение в служебный чат команды собирает портал из чисел и
// номеров сводки по шаблону: текста агента в чате нет. Без настройки agent.team_chat_id сообщения нет.

export const DIGESTS_PAGE = 50;

export type DigestRow = { id: string; kind: ReportKind; title: string; status: 'unverified' | 'reviewed'; createdOn: Date; periodFrom: Date | null; periodTo: Date | null };
export type DigestCard = DigestRow & { body: string; reviewedOn: Date | null; reviewedBy: string | null; ticketNumbers: number[]; numbers: Partial<Record<(typeof REPORT_CHAT_KEYS)[number], number>> };

function requireStaff(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff') throw new HdaError('forbidden');
}

const listInput = z.strictObject({
  kind: z.enum(REPORT_KINDS).optional(),
  status: z.enum(['unverified', 'reviewed']).optional(),
  cursor: z.uuid().optional(),
});

const rowOf = (r: typeof agentReports.$inferSelect): DigestRow => ({ id: r.reportId, kind: r.kind, title: r.title, status: r.status, createdOn: r.createdOn, periodFrom: r.periodFrom, periodTo: r.periodTo });

/** Сводки новые сверху, страницами по 50; фильтр по виду и пометке. */
export async function listDigests(ctx: StaffContext, input: unknown): Promise<{ items: DigestRow[]; nextCursor: string | null }> {
  requireStaff(ctx);
  const parsed = listInput.safeParse(input ?? {});
  if (!parsed.success) throw new HdaError('invalid_input');
  const data = parsed.data;
  const where: (SQL | undefined)[] = [data.kind ? eq(agentReports.kind, data.kind) : undefined, data.status ? eq(agentReports.status, data.status) : undefined, data.cursor ? lt(agentReports.reportId, data.cursor) : undefined];
  const rows = await withActor(ctx.actor, (tx) =>
    tx
      .select()
      .from(agentReports)
      .where(and(...where))
      .orderBy(desc(agentReports.reportId))
      .limit(DIGESTS_PAGE + 1),
  );
  const items = rows.slice(0, DIGESTS_PAGE).map(rowOf);
  return { items, nextCursor: rows.length > DIGESTS_PAGE ? (items.at(-1)?.id ?? null) : null };
}

const chatFields = z.object({
  numbers: z.partialRecord(z.enum(REPORT_CHAT_KEYS), z.number().int().min(0)).catch({}),
  ticket_numbers: z.array(z.number().int().positive()).max(20).catch([]),
});

function chatOf(value: unknown): { numbers: DigestCard['numbers']; ticketNumbers: number[] } {
  const parsed = chatFields.safeParse(value ?? {});
  return parsed.success ? { numbers: parsed.data.numbers, ticketNumbers: parsed.data.ticket_numbers } : { numbers: {}, ticketNumbers: [] };
}

export async function digestCard(ctx: StaffContext, idValue: unknown): Promise<DigestCard | null> {
  requireStaff(ctx);
  const id = z.uuid().safeParse(idValue);
  if (!id.success) return null;
  const [row] = await withActor(ctx.actor, (tx) => tx.select().from(agentReports).where(eq(agentReports.reportId, id.data)).limit(1));
  if (!row) return null;
  const chat = chatOf(row.chatFields);
  return { ...rowOf(row), body: row.body, reviewedOn: row.reviewedOn, reviewedBy: row.reviewedBy, ticketNumbers: chat.ticketNumbers, numbers: chat.numbers };
}

/** "Просмотрено": статус reviewed от имени сотрудника, журнал аудита той же транзакцией. Повтор ничего не меняет. */
export async function markDigestReviewed(ctx: StaffContext, input: unknown): Promise<{ changed: boolean }> {
  requireStaff(ctx);
  const parsed = z.strictObject({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  return withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select({ status: agentReports.status }).from(agentReports).where(eq(agentReports.reportId, parsed.data.id)).limit(1).for('update');
    if (!row) throw new HdaError('not_found');
    if (row.status === 'reviewed') return { changed: false };
    const [updated] = await tx
      .update(agentReports)
      .set({ status: 'reviewed', reviewedBy: ctx.actor.userId, reviewedOn: sql`now()` })
      .where(and(eq(agentReports.reportId, parsed.data.id), eq(agentReports.status, 'unverified')))
      .returning({ id: agentReports.reportId });
    if (!updated) return { changed: false };
    await writeAudit(tx, { action: 'agent.report_reviewed', objectType: 'agent_report', objectId: parsed.data.id, diff: {} });
    return { changed: true };
  });
}

const CHAT_WINDOW_MS = 24 * 3_600_000;

/**
 * Сообщения в чат команды по сводкам с полями для чата за последние сутки, ещё не отправленные. Нет настройки чата или
 * бота: ничего не отправляется. Отметка chat_sent_on ставится и при сбое бота: повторов в чат нет.
 */
export async function sendTeamChatMessages(system: SystemActor, now: Date = new Date()): Promise<{ sent: number }> {
  if (system.type !== 'system') throw new HdaError('forbidden');
  const raw = await readSetting(AGENT_SETTINGS.teamChatId);
  const chatId = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!TELEGRAM_CHAT_ID.test(chatId)) return { sent: 0 };
  const sender = staffBotSender(chatId);
  if (!sender) return { sent: 0 };
  const rows = await withActor(system, (tx) =>
    tx
      .select()
      .from(agentReports)
      .where(and(isNotNull(agentReports.chatFields), isNull(agentReports.chatSentOn), gt(agentReports.createdOn, new Date(now.getTime() - CHAT_WINDOW_MS))))
      .orderBy(agentReports.createdOn)
      .limit(20),
  );
  let sent = 0;
  for (const row of rows) {
    const chat = chatOf(row.chatFields);
    const text = teamChatText({ kind: row.kind, numbers: chat.numbers, ticketNumbers: chat.ticketNumbers }, { locale: 'ru', hubUrl: getEnv().HUB_URL, reportId: row.reportId });
    const marked = await withActor(system, (tx) =>
      tx
        .update(agentReports)
        .set({ chatSentOn: now })
        .where(and(eq(agentReports.reportId, row.reportId), isNull(agentReports.chatSentOn)))
        .returning({ id: agentReports.reportId }),
    );
    if (marked.length === 0) continue;
    try {
      await sender.send(text);
      sent += 1;
    } catch (error) {
      logEvent('warn', 'agent.team_chat_failed', { reportId: row.reportId, error: error instanceof Error ? error.name : 'ошибка' });
    }
  }
  // Сводки о принятых сканированиях кода (веха M8c, FR-CODE-14): из чисел строки истории, без выводов агента.
  const scans = await withActor(system, (tx) =>
    tx
      .select()
      .from(codeScans)
      .where(and(eq(codeScans.status, 'accepted'), isNull(codeScans.chatSentOn), gt(codeScans.receivedOn, new Date(now.getTime() - CHAT_WINDOW_MS))))
      .orderBy(codeScans.receivedOn)
      .limit(20),
  );
  for (const scan of scans) {
    const text = codeScanChatText(
      { repository: scan.repository, commit: scan.commitRef, added: scan.addedCount, changed: scan.changedCount, removed: scan.removedCount },
      { locale: 'ru', hubUrl: getEnv().HUB_URL },
    );
    const marked = await withActor(system, (tx) =>
      tx
        .update(codeScans)
        .set({ chatSentOn: now })
        .where(and(eq(codeScans.scanId, scan.scanId), isNull(codeScans.chatSentOn)))
        .returning({ id: codeScans.scanId }),
    );
    if (marked.length === 0) continue;
    try {
      await sender.send(text);
      sent += 1;
    } catch (error) {
      logEvent('warn', 'agent.team_chat_failed', { scanId: scan.scanId, error: error instanceof Error ? error.name : 'ошибка' });
    }
  }
  return { sent };
}
