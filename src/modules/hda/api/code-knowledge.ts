import 'server-only';
import { asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { applyModuleProposalTx, moduleScreensByCodesTx } from '@/modules/hdr/api';
import { signatureShareTx } from '@/modules/hdt/api/solution-source';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { CODE_TEMPLATE_LOCALES, codeEntryKey, templateViolations, textLines } from '../code/report';
import { HdaError } from '../error';
import { CODE_ENTRY_STATUSES, CODE_KINDS, CODE_MAX_LINES, CODE_READER_ROLES, type CodeChangeKind, type CodeEntryStatus, type CodeKind, type CodeLocation } from '../pref';
import { codeErrorEntries, codeErrorTemplates, codeModuleNotes, codeScans } from '../schema';

// Модуль hda, слой api: очередь "Знания из кода", карточка записи, история сканирований, заметки о модулях и
// показатель пользы (веха M8c, задача 4; ТЗ 7.22 FR-CODE-03, 11, 13, 15, FR-ADM-15, 8.12; план M8c, решения 9, 14,
// 23, 24, 26). Видят и решают agent_l2, care, admin; заметки о модулях утверждает только администратор со свежим
// входом: утверждение меняет справочник модулей. Каждое решение пишет журнал аудита той же транзакцией. База
// проверяет права второй раз (политики и триггеры миграции 0118).

export const CODE_ENTRIES_PAGE = 50;

export type CodeEntryListItem = {
  key: string;
  code: string | null;
  repository: string;
  moduleCode: string | null;
  kind: CodeKind;
  confidence: number;
  status: CodeEntryStatus;
  changeKind: CodeChangeKind;
  /** Новое или изменённое в последнем сканировании и ещё не решённое: выделяется в очереди. */
  highlighted: boolean;
  modifiedOn: Date;
};

export type CodeEntryCard = CodeEntryListItem & {
  entryId: string;
  signature: string;
  conditions: string;
  userCause: string;
  whatToCheck: string[];
  raisedIn: CodeLocation[];
  rejectReason: string | null;
  approvedBy: { id: string } | null;
  approvedOn: Date | null;
  templates: { locale: string; template: string }[];
  scan: { scanKey: string; commit: string; receivedOn: Date } | null;
};

function requireReader(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff' || !(CODE_READER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
}

function requireFreshAdmin(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  return parsed.data;
}

const listColumns = {
  key: codeErrorEntries.key,
  code: codeErrorEntries.code,
  repository: codeErrorEntries.repository,
  moduleCode: codeErrorEntries.moduleCode,
  kind: codeErrorEntries.kind,
  confidence: codeErrorEntries.confidence,
  status: codeErrorEntries.status,
  changeKind: codeErrorEntries.changeKind,
  modifiedOn: codeErrorEntries.modifiedOn,
};

type ListRow = Omit<CodeEntryListItem, 'confidence' | 'highlighted'> & { confidence: string };

function listItem(row: ListRow): CodeEntryListItem {
  return {
    key: row.key,
    code: row.code,
    repository: row.repository,
    moduleCode: row.moduleCode,
    kind: row.kind,
    confidence: Number(row.confidence),
    status: row.status,
    changeKind: row.changeKind,
    highlighted: row.status === 'draft' && row.changeKind !== 'same',
    modifiedOn: row.modifiedOn,
  };
}

const listInput = z.strictObject({ status: z.enum([...CODE_ENTRY_STATUSES, 'all']).optional(), page: z.number().int().min(0).max(1000).optional() });

/** Очередь утверждения: по умолчанию черновики, новые и изменённые первыми. */
export async function listCodeEntries(ctx: StaffContext, input: unknown): Promise<{ items: CodeEntryListItem[]; hasMore: boolean; drafts: number }> {
  requireReader(ctx);
  const data = parse(listInput, input ?? {});
  const status = data.status ?? 'draft';
  const page = data.page ?? 0;
  return withActor(ctx.actor, async (tx) => {
    const rows = await tx
      .select(listColumns)
      .from(codeErrorEntries)
      .where(status === 'all' ? undefined : eq(codeErrorEntries.status, status))
      .orderBy(sql`case ${codeErrorEntries.changeKind} when 'same' then 1 else 0 end`, desc(codeErrorEntries.modifiedOn), asc(codeErrorEntries.key))
      .limit(CODE_ENTRIES_PAGE + 1)
      .offset(page * CODE_ENTRIES_PAGE);
    const [drafts] = await tx.select({ n: count() }).from(codeErrorEntries).where(eq(codeErrorEntries.status, 'draft'));
    return { items: rows.slice(0, CODE_ENTRIES_PAGE).map(listItem), hasMore: rows.length > CODE_ENTRIES_PAGE, drafts: drafts?.n ?? 0 };
  });
}

async function entryByKeyTx(tx: Tx, key: string, opts: { lock?: boolean } = {}) {
  const query = tx.select().from(codeErrorEntries).where(eq(codeErrorEntries.key, key)).limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row ?? null;
}

const keyInput = z.strictObject({ key: codeEntryKey });

/** Карточка записи: шаблоны, условия, что проверить, место в коде ссылкой. Кода в портале нет. */
export async function codeEntryCard(ctx: StaffContext, input: unknown): Promise<CodeEntryCard> {
  requireReader(ctx);
  const { key } = parse(keyInput, input);
  return withActor(ctx.actor, async (tx) => {
    const row = await entryByKeyTx(tx, key);
    if (!row) throw new HdaError('not_found');
    const templates = await tx
      .select({ locale: codeErrorTemplates.locale, template: codeErrorTemplates.template })
      .from(codeErrorTemplates)
      .where(eq(codeErrorTemplates.entryId, row.entryId))
      .orderBy(asc(codeErrorTemplates.locale));
    const [scan] = await tx.select({ scanKey: codeScans.scanKey, commit: codeScans.commitRef, receivedOn: codeScans.receivedOn }).from(codeScans).where(eq(codeScans.scanId, row.scanId)).limit(1);
    return {
      ...listItem(row),
      entryId: row.entryId,
      signature: row.signature,
      conditions: row.conditions,
      userCause: row.userCause,
      whatToCheck: row.whatToCheck,
      raisedIn: row.raisedIn,
      rejectReason: row.rejectReason,
      approvedBy: row.approvedBy ? { id: row.approvedBy } : null,
      approvedOn: row.approvedOn,
      templates,
      scan: scan ?? null,
    };
  });
}

/** Утвердить запись от своего имени: черновик или отклонённую. Повтор ничего не меняет. */
export async function approveCodeEntry(ctx: StaffContext, input: unknown): Promise<void> {
  requireReader(ctx);
  const { key } = parse(keyInput, input);
  await withActor(ctx.actor, async (tx) => {
    const row = await entryByKeyTx(tx, key, { lock: true });
    if (!row || row.status === 'removed') throw new HdaError('not_found');
    if (row.status === 'approved') return;
    await tx.update(codeErrorEntries).set({ status: 'approved', approvedBy: ctx.actor.userId, approvedOn: sql`now()`, rejectReason: null }).where(eq(codeErrorEntries.entryId, row.entryId));
    await writeAudit(tx, { action: 'code.entry_approved', objectType: 'code_entry', objectId: row.entryId, diff: { entry: key } });
  });
}

const rejectInput = z.strictObject({ key: codeEntryKey, reason: z.string().trim().max(500).optional() });

/** Отклонить запись: черновик или утверждённую. Утверждённая перестаёт давать точную сигнатуру. */
export async function rejectCodeEntry(ctx: StaffContext, input: unknown): Promise<void> {
  requireReader(ctx);
  const data = parse(rejectInput, input);
  await withActor(ctx.actor, async (tx) => {
    const row = await entryByKeyTx(tx, data.key, { lock: true });
    if (!row || row.status === 'removed') throw new HdaError('not_found');
    if (row.status === 'rejected') return;
    await tx
      .update(codeErrorEntries)
      .set({ status: 'rejected', approvedBy: null, approvedOn: null, rejectReason: data.reason || null })
      .where(eq(codeErrorEntries.entryId, row.entryId));
    await writeAudit(tx, { action: 'code.entry_rejected', objectType: 'code_entry', objectId: row.entryId, diff: { entry: data.key } });
  });
}

const multiline = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => textLines(text) <= CODE_MAX_LINES);
const templateText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]*$/u)
  .refine((text) => templateViolations(text).length === 0);

const editInput = z.strictObject({
  key: codeEntryKey,
  conditions: multiline(2000),
  userCause: multiline(2000),
  whatToCheck: z.array(multiline(300)).min(1).max(10),
  kind: z.enum(CODE_KINDS),
  templates: z
    .strictObject(Object.fromEntries(CODE_TEMPLATE_LOCALES.map((locale) => [locale, templateText.optional()])) as Record<(typeof CODE_TEMPLATE_LOCALES)[number], z.ZodOptional<typeof templateText>>)
    .refine((value) => Object.values(value).some((text) => typeof text === 'string')),
});

/** Правка записи сотрудником: тексты, род и шаблоны по тем же правилам, что у отчёта. Статус не меняется. */
export async function editCodeEntry(ctx: StaffContext, input: unknown): Promise<void> {
  requireReader(ctx);
  const data = parse(editInput, input);
  await withActor(ctx.actor, async (tx) => {
    const row = await entryByKeyTx(tx, data.key, { lock: true });
    if (!row || row.status === 'removed') throw new HdaError('not_found');
    await tx.update(codeErrorEntries).set({ conditions: data.conditions, userCause: data.userCause, whatToCheck: data.whatToCheck, kind: data.kind }).where(eq(codeErrorEntries.entryId, row.entryId));
    const templates = Object.entries(data.templates).flatMap(([locale, template]) => (typeof template === 'string' ? [{ entryId: row.entryId, locale, template }] : []));
    await tx.delete(codeErrorTemplates).where(eq(codeErrorTemplates.entryId, row.entryId));
    await tx.insert(codeErrorTemplates).values(templates);
    await writeAudit(tx, { action: 'code.entry_edited', objectType: 'code_entry', objectId: row.entryId, diff: { entry: data.key, locales: templates.map((t) => t.locale) } });
  });
}

export type CodeScanItem = { scanId: string; scanKey: string; repository: string; commit: string; status: 'accepted' | 'rejected'; added: number; changed: number; removed: number; errors: number; modules: number; reasons: { rule: string; path: string }[]; receivedOn: Date };

/** История сканирований (FR-CODE-14, FR-ADM-15): последние 100. */
export async function listCodeScans(ctx: StaffContext): Promise<CodeScanItem[]> {
  requireReader(ctx);
  const rows = await withActor(ctx.actor, (tx) => tx.select().from(codeScans).orderBy(desc(codeScans.receivedOn)).limit(100));
  return rows.map((row) => ({
    scanId: row.scanId,
    scanKey: row.scanKey,
    repository: row.repository,
    commit: row.commitRef,
    status: row.status,
    added: row.addedCount,
    changed: row.changedCount,
    removed: row.removedCount,
    errors: row.errorCount,
    modules: row.moduleCount,
    reasons: row.rejectReasons,
    receivedOn: row.receivedOn,
  }));
}

export type ModuleNoteItem = {
  moduleCode: string;
  repository: string;
  name: Record<string, string>;
  summary: string;
  dependsOn: string[];
  screens: { code: string; name: Record<string, string> }[];
  status: CodeEntryStatus;
  changeKind: CodeChangeKind;
  /** Отличие от справочника: модуля нет, экраны отличаются, совпадает. */
  directory: 'missing' | 'screens_differ' | 'same';
};

const sameScreens = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Заметки о модулях с отличием от справочника (FR-CODE-13). Читают agent_l2, care, admin. */
export async function listModuleNotes(ctx: StaffContext): Promise<ModuleNoteItem[]> {
  requireReader(ctx);
  return withActor(ctx.actor, async (tx) => {
    const rows = await tx.select().from(codeModuleNotes).where(inArray(codeModuleNotes.status, ['draft', 'approved', 'rejected'])).orderBy(asc(codeModuleNotes.moduleCode)).limit(500);
    const directory = await moduleScreensByCodesTx(
      tx,
      rows.map((row) => row.moduleCode),
    );
    return rows.map((row) => {
      const screens = directory.get(row.moduleCode);
      const normalized = row.screens.map((screen) => ({ code: screen.code, name: { ...screen.name, ru: screen.name.ru ?? screen.code } }));
      return {
        moduleCode: row.moduleCode,
        repository: row.repository,
        name: row.name,
        summary: row.summary,
        dependsOn: row.dependsOn,
        screens: row.screens,
        status: row.status,
        changeKind: row.changeKind,
        directory: screens === undefined ? 'missing' : sameScreens(screens, normalized) ? 'same' : 'screens_differ',
      };
    });
  });
}

const codeInput = z.strictObject({ code: z.string().min(1).max(80) });

/** Утвердить заметку о модуле: предложение применяется к справочнику модулей. Только администратор со свежим входом. */
export async function approveModuleNote(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const { code } = parse(codeInput, input);
  await withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select().from(codeModuleNotes).where(eq(codeModuleNotes.moduleCode, code)).limit(1).for('update');
    if (!row || row.status === 'removed') throw new HdaError('not_found');
    const applied = await applyModuleProposalTx(tx, { code, name: row.name, screens: row.screens });
    if (row.status !== 'approved')
      await tx.update(codeModuleNotes).set({ status: 'approved', decidedBy: ctx.actor.userId, decidedOn: sql`now()` }).where(eq(codeModuleNotes.noteId, row.noteId));
    await writeAudit(tx, { action: 'code.module_approved', objectType: 'code_module_note', objectId: row.noteId, diff: { module: code, applied } });
  });
}

/** Отклонить заметку о модуле: справочник не меняется. Только администратор со свежим входом. */
export async function rejectModuleNote(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const { code } = parse(codeInput, input);
  await withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select().from(codeModuleNotes).where(eq(codeModuleNotes.moduleCode, code)).limit(1).for('update');
    if (!row || row.status === 'removed') throw new HdaError('not_found');
    if (row.status === 'rejected') return;
    await tx.update(codeModuleNotes).set({ status: 'rejected', decidedBy: ctx.actor.userId, decidedOn: sql`now()` }).where(eq(codeModuleNotes.noteId, row.noteId));
    await writeAudit(tx, { action: 'code.module_rejected', objectType: 'code_module_note', objectId: row.noteId, diff: { module: code } });
  });
}

export type CodeKnowledgeMetrics = { days: number; withSignature: number; fromTemplate: number; solutionsFromEntries: number };

/**
 * Показатель пользы (FR-CODE-15) за последние дни: обращения клиентов с сигнатурой ошибки, из них с сигнатурой записи
 * каталога, и решения, созданные из записей. Только числа.
 */
export async function codeKnowledgeMetrics(ctx: StaffContext, input: unknown): Promise<CodeKnowledgeMetrics> {
  requireReader(ctx);
  const { days } = parse(z.strictObject({ days: z.number().int().min(1).max(365) }), input);
  const since = new Date(Date.now() - days * 86_400_000);
  return withActor(ctx.actor, async (tx) => {
    const signatures = (await tx.select({ signature: codeErrorEntries.signature }).from(codeErrorEntries)).map((row) => row.signature);
    const share = await signatureShareTx(tx, { since, signatures, excludeOrgId: SERVICE_ORG_ID });
    // Решения из записей каталога считает задача 6 вехи M8c (колонка hdk_articles.code_entry_id).
    return { days, withSignature: share.withSignature, fromTemplate: share.matched, solutionsFromEntries: 0 };
  });
}
