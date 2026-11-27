import 'server-only';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, readSetting, type StaffContext, writeSettingTx } from '@/modules/hdc/api';
import { createProblemFromSignature, problemNumbersTx, signaturesWithProblemTx } from '@/modules/hdp/api/agent-drafts';
import { PROBLEM_WRITER_ROLES } from '@/modules/hdp/pref';
import { signatureOrgCountsTx, signatureTicketIdsTx } from '@/modules/hdt/api/known-problems';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { spikeDecision } from '../agent/spikes';
import { HdaError } from '../error';
import { AGENT_SETTINGS, SPIKE_DEFAULTS, SPIKE_LIMITS } from '../pref';
import { signatureSpikes } from '../schema';

// Модуль hda, слой api: всплеск сигнатуры (веха M8b, задача 8; FR-AGT-11, 10.5; план M8b, решение 25). Задача
// agent.spikes раз в 5 минут: сигнатура у обращений не меньше чем agent.spike_org_count разных организаций клиентов
// за agent.spike_window_minutes, нет активной проблемы или черновика с ней, не было всплеска за 24 часа: строка
// hda_signature_spikes. Считаются все организации, а не только с AI-обработкой: это счётчик. Сотрудники видят
// всплески блоком на странице известных проблем; "Создать известную проблему" работает и без агента.

export type SpikeSettings = { orgCount: number; windowMinutes: number };

const countField = z.number().int().min(SPIKE_LIMITS.orgCount.min).max(SPIKE_LIMITS.orgCount.max);
const windowField = z.number().int().min(SPIKE_LIMITS.windowMinutes.min).max(SPIKE_LIMITS.windowMinutes.max);

/** Настройки всплеска: нет строки или значение неверно, значение по умолчанию. */
export async function spikeSettings(): Promise<SpikeSettings> {
  const count = countField.safeParse(await readSetting(AGENT_SETTINGS.spikeOrgCount));
  const window = windowField.safeParse(await readSetting(AGENT_SETTINGS.spikeWindowMinutes));
  return { orgCount: count.success ? count.data : SPIKE_DEFAULTS.orgCount, windowMinutes: window.success ? window.data : SPIKE_DEFAULTS.windowMinutes };
}

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
}

export async function spikeSettingsView(ctx: StaffContext): Promise<SpikeSettings> {
  requireAdmin(ctx);
  return spikeSettings();
}

const settingsInput = z.strictObject({ orgCount: z.coerce.number().pipe(countField), windowMinutes: z.coerce.number().pipe(windowField) });

/** Порог и окно всплеска: только администратор со входом не старше 15 минут, журнал аудита той же транзакцией. */
export async function saveSpikeSettings(ctx: StaffContext, input: unknown): Promise<void> {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
  const parsed = settingsInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const current = await spikeSettings();
  await withActor(ctx.actor, async (tx) => {
    if (current.orgCount !== parsed.data.orgCount) await writeSettingTx(tx, AGENT_SETTINGS.spikeOrgCount, parsed.data.orgCount);
    if (current.windowMinutes !== parsed.data.windowMinutes) await writeSettingTx(tx, AGENT_SETTINGS.spikeWindowMinutes, parsed.data.windowMinutes);
  });
}

export type DetectedSpike = { spikeId: string; signature: string; orgCount: number; ticketCount: number; windowMinutes: number; detectedOn: Date };

/** Поиск всплесков одной транзакцией системы. Возвращает найденные: задача событий (задача 9) ставит по ним события. */
export async function detectSpikesTx(tx: Parameters<Parameters<typeof withActor>[1]>[0], now: Date, settings: SpikeSettings): Promise<DetectedSpike[]> {
  const since = new Date(now.getTime() - settings.windowMinutes * 60_000);
  const counts = await signatureOrgCountsTx(tx, { since, until: now, minOrgs: settings.orgCount, excludeOrgId: SERVICE_ORG_ID });
  if (counts.length === 0) return [];
  const withProblem = await signaturesWithProblemTx(
    tx,
    counts.map((c) => c.signature),
  );
  const recent = await tx
    .select({ signature: signatureSpikes.signature, detectedOn: sql<Date>`max(${signatureSpikes.detectedOn})` })
    .from(signatureSpikes)
    .where(and(inArray(signatureSpikes.signature, counts.map((c) => c.signature)), gte(signatureSpikes.detectedOn, new Date(now.getTime() - 2 * 86_400_000))))
    .groupBy(signatureSpikes.signature);
  const last = new Map(recent.map((row) => [row.signature, new Date(row.detectedOn)]));
  const detected: DetectedSpike[] = [];
  for (const count of counts) {
    const decision = spikeDecision({ orgCount: count.orgCount, threshold: settings.orgCount, activeProblem: withProblem.has(count.signature), lastSpikeOn: last.get(count.signature) ?? null, now });
    if (decision !== 'spike') continue;
    const [row] = await tx
      .insert(signatureSpikes)
      .values({ signature: count.signature, orgCount: count.orgCount, ticketCount: count.ticketCount, windowMinutes: settings.windowMinutes, detectedOn: now })
      .returning({ spikeId: signatureSpikes.spikeId });
    detected.push({ spikeId: row!.spikeId, signature: count.signature, orgCount: count.orgCount, ticketCount: count.ticketCount, windowMinutes: settings.windowMinutes, detectedOn: now });
  }
  return detected;
}

/** Задача agent.spikes. */
export async function runSpikeDetection(system: SystemActor, now: Date = new Date()): Promise<{ detected: number }> {
  if (system.type !== 'system') throw new HdaError('forbidden');
  const settings = await spikeSettings();
  const detected = await withActor(system, (tx) => detectSpikesTx(tx, now, settings));
  return { detected: detected.length };
}

export type SpikeView = { spikeId: string; signature: string; orgCount: number; ticketCount: number; windowMinutes: number; detectedOn: Date; problemNumber: number | null };

/** Всплески за 7 суток для блока "Всплески сигнатур": все сотрудники. */
export async function listSpikes(ctx: StaffContext): Promise<SpikeView[]> {
  if (ctx.actor.type !== 'staff') throw new HdaError('forbidden');
  return withActor(ctx.actor, async (tx) => {
    const rows = await tx
      .select()
      .from(signatureSpikes)
      .where(gte(signatureSpikes.detectedOn, new Date(Date.now() - 7 * 86_400_000)))
      .orderBy(desc(signatureSpikes.detectedOn))
      .limit(20);
    const numbers = await problemNumbersTx(
      tx,
      rows.flatMap((row) => (row.problemId ? [row.problemId] : [])),
    );
    return rows.map((row) => ({
      spikeId: row.spikeId,
      signature: row.signature,
      orgCount: row.orgCount,
      ticketCount: row.ticketCount,
      windowMinutes: row.windowMinutes,
      detectedOn: row.detectedOn,
      problemNumber: row.problemId ? (numbers.get(row.problemId) ?? null) : null,
    }));
  });
}

const fromSpikeInput = z.strictObject({ spikeId: z.uuid(), internalTitle: z.string().trim().min(1).max(200) });

/** "Создать известную проблему" по всплеску: роль ведения проблем, обращения окна привязываются, всплеск ссылается на проблему. */
export async function createProblemFromSpike(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  if (ctx.actor.type !== 'staff' || !(PROBLEM_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
  const parsed = fromSpikeInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const actor = ctx.actor;
  const spike = await withActor(actor, async (tx) => {
    const [row] = await tx.select().from(signatureSpikes).where(eq(signatureSpikes.spikeId, parsed.data.spikeId)).limit(1);
    if (!row || row.problemId) return null;
    const ticketIds = await signatureTicketIdsTx(tx, { signature: row.signature, since: new Date(row.detectedOn.getTime() - row.windowMinutes * 60_000), until: row.detectedOn });
    return { row, ticketIds };
  });
  if (!spike) throw new HdaError('not_found');
  const problem = await createProblemFromSignature(ctx, { internalTitle: parsed.data.internalTitle, signature: spike.row.signature, ticketIds: spike.ticketIds });
  await withActor(actor, (tx) => tx.update(signatureSpikes).set({ problemId: problem.problemId }).where(eq(signatureSpikes.spikeId, spike.row.spikeId)));
  return { number: problem.number };
}
