import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { AgentActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { moduleIdsByCodesTx } from '@/modules/hdr/api';
import { HdaAgentError } from '../error';
import type { CodeChangeKind } from '../pref';
import { type CodeRejectReason, codeErrorEntries, codeErrorTemplates, codeModuleNotes, codeScans } from '../schema';
import { type CodeReportError, type CodeReportModule, type CodeScanReport, type CodeViolation, codeReportViolations, entryDigest, normalizeCodeReport } from './report';

// Модуль hda, знания из кода: приём отчёта о сканировании (веха M8c, задача 3; ТЗ 7.22 FR-CODE-01, 03, 05, 12, 13,
// 14; план M8c, решения 3, 5, 10, 11, 13, 14, 26). В транзакции инструмента code_catalog_upsert от актора agent
// основным токеном: политики и триггеры базы не дают агенту утвердить запись.
//
// Отчёт принимается целиком или не принимается: нарушения правил FR-CODE-05, 12 оставляют только строку истории
// со статусом rejected и причинами без значений. Изменения с прошлого сканирования портал считает сам по отпечатку
// содержимого от агента: новая запись черновиком, изменившаяся снова черновиком (даже утверждённая), неизменная с
// прежним статусом и правками сотрудника, отсутствующая в отчёте того же репозитория исчезает.

/** Сколько причин отклонения хранится и отдаётся агенту. */
const REASONS_MAX = 50;
/** Сколько ключей сменивших статус записей пишется в журнал аудита. */
const AUDIT_KEYS_MAX = 100;

export type CodeScanCounts = { added: number; changed: number; removed: number; unchanged: number };
export type CodeScanOutcome =
  | ({ status: 'accepted'; scanId: string; scanKey: string; duplicate: boolean; modules: Omit<CodeScanCounts, 'unchanged'> } & CodeScanCounts)
  | { status: 'rejected'; scanId: string; scanKey: string; reasons: CodeRejectReason[] };

type Existing = { id: string; key: string; status: string; digest: string; repository: string };

/** Что сделать с одной записью (или модулем) отчёта. */
type Step<T> = { item: T; digest: string; existing: Existing | null; change: CodeChangeKind };

function plan<T>(items: readonly T[], keyOf: (item: T) => string, digestOf: (item: T) => string, existing: ReadonlyMap<string, Existing>): Step<T>[] {
  return items.map((item) => {
    const found = existing.get(keyOf(item)) ?? null;
    const digest = digestOf(item);
    const change: CodeChangeKind = !found || found.status === 'removed' ? 'new' : found.digest === digest ? 'same' : 'changed';
    return { item, digest, existing: found, change };
  });
}

const count = <T>(steps: readonly Step<T>[], change: CodeChangeKind) => steps.filter((step) => step.change === change).length;

async function existingEntriesTx(tx: Tx, repository: string, keys: readonly string[]): Promise<Map<string, Existing>> {
  const rows = await tx
    .select({ id: codeErrorEntries.entryId, key: codeErrorEntries.key, status: codeErrorEntries.status, digest: codeErrorEntries.scanDigest, repository: codeErrorEntries.repository })
    .from(codeErrorEntries)
    .where(keys.length > 0 ? sql`${codeErrorEntries.repository} = ${repository} or ${inArray(codeErrorEntries.key, [...keys])}` : eq(codeErrorEntries.repository, repository));
  return new Map(rows.map((row) => [row.key, row]));
}

async function existingModulesTx(tx: Tx, repository: string, codes: readonly string[]): Promise<Map<string, Existing>> {
  const rows = await tx
    .select({ id: codeModuleNotes.noteId, key: codeModuleNotes.moduleCode, status: codeModuleNotes.status, digest: codeModuleNotes.scanDigest, repository: codeModuleNotes.repository })
    .from(codeModuleNotes)
    .where(codes.length > 0 ? sql`${codeModuleNotes.repository} = ${repository} or ${inArray(codeModuleNotes.moduleCode, [...codes])}` : eq(codeModuleNotes.repository, repository));
  return new Map(rows.map((row) => [row.key, row]));
}

/** Поля записи из отчёта: то, что пишет агент. Статус и утверждение задаёт шаг. */
function entryFields(error: CodeReportError, report: CodeScanReport, scanId: string, moduleIds: ReadonlyMap<string, string>, digest: string) {
  return {
    scanId,
    moduleId: error.module ? (moduleIds.get(error.module) ?? null) : null,
    code: error.code ?? null,
    repository: report.repository,
    moduleCode: error.module ?? null,
    raisedIn: error.raisedIn.map((place) => ({ object: place.object, path: place.path, line: place.line ?? null })),
    conditions: error.conditions,
    userCause: error.userCause,
    whatToCheck: error.whatToCheck,
    kind: error.kind,
    confidence: error.confidence.toFixed(2),
    scanDigest: digest,
  };
}

function templateRows(entryId: string, error: CodeReportError) {
  return Object.entries(error.messageTemplates).flatMap(([locale, template]) => (typeof template === 'string' ? [{ entryId, locale, template }] : []));
}

function moduleFields(module: CodeReportModule, report: CodeScanReport, scanId: string, digest: string) {
  return {
    scanId,
    repository: report.repository,
    name: module.name as Record<string, string>,
    summary: module.summary ?? '',
    dependsOn: module.dependsOn ?? [],
    screens: (module.screens ?? []).map((screen) => ({ code: screen.code, name: screen.name as Record<string, string> })),
    scanDigest: digest,
  };
}

/** Приём отчёта в транзакции инструмента. Повтор принятого отчёта того же репозитория возвращает прежний итог. */
export async function acceptCodeScanTx(tx: Tx, actor: AgentActor, raw: CodeScanReport): Promise<CodeScanOutcome> {
  if (actor.type !== 'agent' || actor.ticketId !== null) throw new HdaAgentError('tool_not_allowed');
  const [previous] = await tx
    .select()
    .from(codeScans)
    .where(and(eq(codeScans.repository, raw.repository), eq(codeScans.scanKey, raw.scanId), eq(codeScans.status, 'accepted')))
    .limit(1);
  if (previous)
    return {
      status: 'accepted',
      scanId: previous.scanId,
      scanKey: previous.scanKey,
      duplicate: true,
      added: previous.addedCount,
      changed: previous.changedCount,
      removed: previous.removedCount,
      unchanged: Math.max(0, previous.errorCount - previous.addedCount - previous.changedCount),
      modules: { added: 0, changed: 0, removed: 0 },
    };

  const scanId = randomUUID();
  const base = { scanId, tokenId: actor.tokenId, scanKey: raw.scanId, repository: raw.repository, commitRef: raw.commit, errorCount: raw.errors.length, moduleCount: raw.modules.length };
  const reject = async (violations: readonly CodeViolation[]): Promise<CodeScanOutcome> => {
    const reasons = violations.slice(0, REASONS_MAX).map((v) => ({ rule: v.rule, path: v.path }));
    await tx.insert(codeScans).values({ ...base, status: 'rejected', rejectReasons: reasons });
    await writeAudit(tx, { action: 'code.scan_rejected', objectType: 'code_scan', objectId: scanId, diff: { repository: raw.repository, scan: raw.scanId, rules: [...new Set(reasons.map((r) => r.rule))] }, ip: actor.ip ?? null });
    return { status: 'rejected', scanId, scanKey: raw.scanId, reasons };
  };
  const violations = codeReportViolations(raw);
  if (violations.length > 0) return reject(violations);
  // Строки для хранения: переводы строк \n, без невидимых знаков (независимая проверка M8c, находка I1).
  const report = normalizeCodeReport(raw);

  // План до записи: числа нужны строке истории, а её меняет только отметка отправки в чат.
  const entries = await existingEntriesTx(
    tx,
    report.repository,
    report.errors.map((e) => e.key),
  );
  // Ключ занят записью другого репозитория (находка M4): запись не переходит между репозиториями каждую неделю.
  // Исчезнувшую запись другой репозиторий может занять.
  const taken = report.errors.flatMap((error, i) => {
    const found = entries.get(error.key);
    return found && found.repository !== report.repository && found.status !== 'removed' ? [{ rule: 'key_conflict' as const, path: `errors.${i}.key` }] : [];
  });
  if (taken.length > 0) return reject(taken);
  const errorSteps = plan(report.errors, (e) => e.key, entryDigest, entries);
  const reported = new Set(report.errors.map((e) => e.key));
  const gone = [...entries.values()].filter((e) => e.repository === report.repository && e.status !== 'removed' && !reported.has(e.key));
  const notes = await existingModulesTx(
    tx,
    report.repository,
    report.modules.map((m) => m.code),
  );
  const moduleSteps = plan(report.modules, (m) => m.code, entryDigest, notes);
  const reportedModules = new Set(report.modules.map((m) => m.code));
  const goneModules = [...notes.values()].filter((n) => n.repository === report.repository && n.status !== 'removed' && !reportedModules.has(n.key));
  const counts: CodeScanCounts = { added: count(errorSteps, 'new'), changed: count(errorSteps, 'changed'), removed: gone.length, unchanged: count(errorSteps, 'same') };

  await tx.insert(codeScans).values({ ...base, addedCount: counts.added, changedCount: counts.changed, removedCount: counts.removed });
  const moduleIds = await moduleIdsByCodesTx(
    tx,
    report.errors.flatMap((e) => (e.module ? [e.module] : [])),
  );

  // Новые записи пачкой; исчезнувшие и вернувшиеся по одной.
  const fresh = errorSteps.filter((step) => step.change === 'new' && !step.existing);
  if (fresh.length > 0) {
    const rows = fresh.map((step) => ({ entryId: randomUUID(), key: step.item.key, status: 'draft' as const, changeKind: 'new' as const, ...entryFields(step.item, report, scanId, moduleIds, step.digest) }));
    await tx.insert(codeErrorEntries).values(rows);
    await tx.insert(codeErrorTemplates).values(rows.flatMap((row, i) => templateRows(row.entryId, fresh[i]!.item)));
  }
  for (const step of errorSteps.filter((s) => s.existing && s.change !== 'same')) {
    const id = step.existing!.id;
    await tx
      .update(codeErrorEntries)
      .set({ ...entryFields(step.item, report, scanId, moduleIds, step.digest), status: 'draft', changeKind: step.change, approvedBy: null, approvedOn: null, rejectReason: null })
      .where(eq(codeErrorEntries.entryId, id));
    await tx.delete(codeErrorTemplates).where(eq(codeErrorTemplates.entryId, id));
    await tx.insert(codeErrorTemplates).values(templateRows(id, step.item));
  }
  const same = errorSteps.filter((s) => s.change === 'same').map((s) => s.existing!.id);
  if (same.length > 0) await tx.update(codeErrorEntries).set({ scanId, changeKind: 'same' }).where(inArray(codeErrorEntries.entryId, same));
  if (gone.length > 0)
    await tx
      .update(codeErrorEntries)
      .set({ status: 'removed', approvedBy: null, approvedOn: null })
      .where(
        inArray(
          codeErrorEntries.entryId,
          gone.map((e) => e.id),
        ),
      );

  // Карта модулей теми же правилами (FR-CODE-13): утверждает администратор.
  for (const step of moduleSteps) {
    const fields = moduleFields(step.item, report, scanId, step.digest);
    if (!step.existing) await tx.insert(codeModuleNotes).values({ moduleCode: step.item.code, status: 'draft', changeKind: 'new', ...fields });
    else if (step.change === 'same') await tx.update(codeModuleNotes).set({ scanId, changeKind: 'same' }).where(eq(codeModuleNotes.noteId, step.existing.id));
    else await tx.update(codeModuleNotes).set({ ...fields, status: 'draft', changeKind: step.change, decidedBy: null, decidedOn: null }).where(eq(codeModuleNotes.noteId, step.existing.id));
  }
  if (goneModules.length > 0)
    await tx
      .update(codeModuleNotes)
      .set({ status: 'removed', decidedBy: null, decidedOn: null })
      .where(
        and(
          inArray(
            codeModuleNotes.noteId,
            goneModules.map((n) => n.id),
          ),
          ne(codeModuleNotes.status, 'removed'),
        ),
      );

  // Ключи сменивших статус записей: до 100 и не больше 2500 знаков (предел описания изменения в журнале аудита).
  // Число сменивших и признак усечения пишутся всегда (находка M1): журнал не теряет записи сверх предела.
  const resetKeys = [...errorSteps.filter((s) => s.existing && s.change !== 'same').map((s) => s.item.key), ...gone.map((e) => e.key)];
  const reset: string[] = [];
  let length = 0;
  for (const key of resetKeys) {
    if (reset.length >= AUDIT_KEYS_MAX || length + key.length > 2500) break;
    reset.push(key);
    length += key.length + 3;
  }
  await writeAudit(tx, {
    action: 'code.scan_accepted',
    objectType: 'code_scan',
    objectId: scanId,
    diff: { repository: report.repository, scan: report.scanId, commit: report.commit, ...counts, reset, resetCount: resetKeys.length, resetTruncated: reset.length < resetKeys.length },
    ip: actor.ip ?? null,
  });
  return {
    status: 'accepted',
    scanId,
    scanKey: report.scanId,
    duplicate: false,
    ...counts,
    modules: { added: count(moduleSteps, 'new'), changed: count(moduleSteps, 'changed'), removed: goneModules.length },
  };
}
