import 'server-only';
import { eq, max } from 'drizzle-orm';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import { writeAudit } from './audit';
import type { ArchiveState } from './ops-alerts';
import { opsBackups, opsHeartbeats, opsHostMarks } from './schema';

// Модуль hdc: наблюдение без внешних сервисов (план подготовки M9, задача 3, решения 5 и 6; ТЗ 13.7, 13.8).
// Отметка "фоновый процесс жив" для адреса /api/ready/worker и отметки удачных резервных копий для сигнала backup_stale.

const NO_STORE = { 'Cache-Control': 'no-store' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Отметка фонового процесса старше 3 минут: процесс не работает (решение 5). Процесс отмечается раз в минуту. */
export const WORKER_STALE_SEC = 180;
const WORKER = 'worker';
/** Сколько ждать ответа базы при проверке отметки: как у /api/ready. */
const READ_TIMEOUT_MS = 2000;
// Адрес /api/ready/worker открыт без входа и сессии не читает: отметку он видит под этим системным актором модуля,
// как настройки портала (settings.ts). Читается одна строка без параметров запроса.
const READ_HEARTBEAT = { type: 'system', job: 'ops.ready-worker' } as const;

/** Фоновый процесс отмечается: при запуске и задачей ops.heartbeat раз в минуту. */
export async function beatWorker(actor: SystemActor, now: Date = new Date()): Promise<void> {
  await withActor(actor, (tx) =>
    tx
      .insert(opsHeartbeats)
      .values({ process: WORKER, beatOn: now })
      .onConflictDoUpdate({ target: opsHeartbeats.process, set: { beatOn: now } }),
  );
}

async function workerBeatOn(): Promise<Date | null> {
  const rows = await withActor(READ_HEARTBEAT, (tx) => tx.select({ beatOn: opsHeartbeats.beatOn }).from(opsHeartbeats).where(eq(opsHeartbeats.process, WORKER)).limit(1));
  return rows[0]?.beatOn ?? null;
}

/**
 * Ответ адреса /api/ready/worker: 200, если фоновый процесс отмечался не позже 3 минут назад, иначе 503. Подробностей
 * (время отметки, ошибка базы) в ответе нет: адрес открыт без входа. /api/ready от этой проверки не зависит.
 */
export async function workerReadyResponse(now: Date = new Date(), read: () => Promise<Date | null> = workerBeatOn): Promise<Response> {
  let ok = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    });
    const beat = await Promise.race([read(), timeout]);
    ok = beat !== null && now.getTime() - beat.getTime() <= WORKER_STALE_SEC * 1000;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  return Response.json({ status: ok ? 'ready' : 'not_ready', checks: { worker: ok ? 'ok' : 'fail' } }, { status: ok ? 200 : 503, headers: NO_STORE });
}

// --- Отметки резервных копий (решение 6) ---

export const BACKUP_KINDS = ['dump', 'base'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
/** Возраст, после которого копия считается устаревшей: ночная 26 часов (ТЗ 13.8), базовая 8 суток, журнал 26 часов. */
export const BACKUP_STALE_HOURS = { dump: 26, base: 8 * 24, wal: 26 } as const;
export type StaleBackupKind = keyof typeof BACKUP_STALE_HOURS;

const markInput = z
  .object({
    kind: z.enum(BACKUP_KINDS),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

/**
 * Отметка удачной копии: её ставит команда hub ops:backup-mark из сценариев backup.sh и base-backup.sh после выгрузки.
 * В той же транзакции запись в журнал аудита. Адресов бакета и имён файлов отметка не хранит.
 */
export async function markBackup(actor: SystemActor, input: { kind: BackupKind; sizeBytes?: number }, now: Date = new Date()): Promise<void> {
  const { kind, sizeBytes } = markInput.parse(input);
  await withActor(actor, async (tx) => {
    const [row] = await tx.insert(opsBackups).values({ kind, sizeBytes: sizeBytes ?? null, finishedOn: now }).returning({ backupId: opsBackups.backupId });
    await writeAudit(tx, { action: 'ops.backup_marked', objectType: 'ops_backup', objectId: row?.backupId, diff: { kind, ...(sizeBytes !== undefined && { sizeBytes }) } });
  });
}

export type LatestBackups = Record<BackupKind, Date | null>;

/** Время последней отметки каждого вида копии. */
export async function latestBackups(actor: SystemActor): Promise<LatestBackups> {
  const rows = await withActor(actor, (tx) => tx.select({ kind: opsBackups.kind, last: max(opsBackups.finishedOn) }).from(opsBackups).groupBy(opsBackups.kind));
  const latest: LatestBackups = { dump: null, base: null };
  for (const row of rows) if (row.last) latest[row.kind] = new Date(row.last);
  return latest;
}

/**
 * Какие копии устарели (решение 6): ночная логическая всегда; базовая и журнал только при включённом архиве, иначе
 * базовую копию сценарий не делает (base-backup.sh отказывает), и сигнал был бы ложным. Отметки нет совсем:
 * копия устарела, сценарий не настроен или не отмечает успех.
 */
export function staleBackupKinds(latest: LatestBackups, archive: ArchiveState, now: Date): StaleBackupKind[] {
  const older = (at: Date | null, hours: number) => at === null || now.getTime() - at.getTime() > hours * HOUR;
  const stale: StaleBackupKind[] = [];
  if (older(latest.dump, BACKUP_STALE_HOURS.dump)) stale.push('dump');
  if (archive.mode !== 'off') {
    if (older(latest.base, BACKUP_STALE_HOURS.base)) stale.push('base');
    if (older(archive.lastArchivedOn, BACKUP_STALE_HOURS.wal)) stale.push('wal');
  }
  return stale;
}

// --- Ресурсы сервера (план M9, задача 9, решение 17; ТЗ 13.8) ---

/** Доля диска, памяти или процессора, с которой ops.watch шлёт сигнал host_pressure. */
export const HOST_PRESSURE_PCT = 80;
/** Отметки нет дольше стольких минут: таймер host-watch остановился или сервер не отвечает (host_mark_stale). */
export const HOST_MARK_STALE_MIN = 15;

const pct = z.number().int().min(0).max(100);
const hostInput = z
  .object({
    host: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/),
    diskPct: pct,
    memPct: pct,
    cpuPct: pct,
    at: z.date().optional(),
  })
  .strict();

export type HostMark = { host: string; diskPct: number; memPct: number; cpuPct: number; markedOn: Date };

/**
 * Отметка ресурсов сервера: её ставит команда hub ops:host-mark из сценария host-watch.sh раз в 5 минут. Одна строка на
 * сервер, новая заменяет прежнюю. Журнала аудита нет: это замер, а не изменение статуса или прав.
 */
export async function markHost(actor: SystemActor, input: { host: string; diskPct: number; memPct: number; cpuPct: number; at?: Date }): Promise<void> {
  if (actor?.type !== 'system') throw new Error('Отметку ресурсов ставит только система');
  const { host, diskPct, memPct, cpuPct, at } = hostInput.parse(input);
  const markedOn = at ?? new Date();
  await withActor(actor, (tx) =>
    tx
      .insert(opsHostMarks)
      .values({ host, diskPct, memPct, cpuPct, markedOn })
      .onConflictDoUpdate({ target: opsHostMarks.host, set: { diskPct, memPct, cpuPct, markedOn } }),
  );
}

/** Последние отметки всех серверов. */
export async function latestHostMarks(actor: SystemActor): Promise<HostMark[]> {
  return withActor(actor, (tx) =>
    tx
      .select({ host: opsHostMarks.host, diskPct: opsHostMarks.diskPct, memPct: opsHostMarks.memPct, cpuPct: opsHostMarks.cpuPct, markedOn: opsHostMarks.markedOn })
      .from(opsHostMarks)
      .orderBy(opsHostMarks.host),
  );
}

export type HostAlert = { code: 'host_pressure' | 'host_mark_stale'; count: number; kinds?: string };

/**
 * Сигналы по отметкам. Отметок нет совсем: таймер ещё не поставлен, сигнала нет (о гибели всего сервера скажет внешняя
 * проверка доступности). Отметка старше 15 минут: host_mark_stale, её доли уже не говорят о нагрузке сейчас. Свежая
 * отметка с долей 80% и выше: host_pressure, в тексте показатель и число, без имени сервера и путей томов.
 */
export function hostAlerts(marks: readonly HostMark[], now: Date): HostAlert[] {
  const fresh = marks.filter((mark) => now.getTime() - mark.markedOn.getTime() <= HOST_MARK_STALE_MIN * 60_000);
  const alerts: HostAlert[] = [];
  const high = fresh.flatMap((mark) =>
    (
      [
        ['disk', mark.diskPct],
        ['mem', mark.memPct],
        ['cpu', mark.cpuPct],
      ] as const
    ).flatMap(([kind, value]) => (value >= HOST_PRESSURE_PCT ? [`${kind} ${value}%`] : [])),
  );
  if (high.length > 0) alerts.push({ code: 'host_pressure', count: high.length, kinds: high.join(', ') });
  const stale = marks.length - fresh.length;
  if (stale > 0) alerts.push({ code: 'host_mark_stale', count: stale });
  return alerts;
}
