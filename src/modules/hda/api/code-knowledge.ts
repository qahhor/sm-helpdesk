import 'server-only';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { applyModuleProposalTx, moduleScreensByCodesTx } from '@/modules/hdr/api';
import { createSolutionFromCodeEntryTx, solutionsFromCodeEntriesTx } from '@/modules/hdk/api/from-code';
import type { TemplateLabels } from '@/modules/hdk/api/doc';
import { templateCandidateLines, templateMatchCode } from '@/modules/hdk/api/signature-text';
import { KB_WRITER_ROLES } from '@/modules/hdk/pref';
import { signatureShareTx, ticketCodeFactsTx } from '@/modules/hdt/api/solution-source';
import { LOCALES } from '@/i18n/locales';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { CODE_TEMPLATE_LOCALES, codeEntryKey, normalizeCodeText, templateViolations, textViolations } from '../code/report';
import { codeTemplateMatchesTx } from './code-match';
import { HdaError } from '../error';
import { CODE_ENTRY_STATUSES, CODE_KINDS, CODE_READER_ROLES, type CodeChangeKind, type CodeEntryStatus, type CodeKind, type CodeLocation } from '../pref';
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
  /** Версия записи для утверждения и правки: изменилась, пока страница открыта, будет conflict (находка I7). */
  version: string;
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

/**
 * Версия записи, которую видел сотрудник (независимая проверка M8c, находка I7): начало отпечатка содержимого от агента
 * и момент последнего изменения строки в микросекундах. Любое сканирование или правка меняют её.
 */
const versionColumn = sql<string>`left(${codeErrorEntries.scanDigest}, 16) || '-' || (extract(epoch from ${codeErrorEntries.modifiedOn}) * 1000000)::bigint::text`;
const codeEntryVersion = z.string().regex(/^[0-9a-f]{16}-\d{1,20}$/);

async function entryByKeyTx(tx: Tx, key: string, opts: { lock?: boolean } = {}) {
  const query = tx
    .select({ row: codeErrorEntries, version: versionColumn })
    .from(codeErrorEntries)
    .where(eq(codeErrorEntries.key, key))
    .limit(1);
  const [found] = opts.lock ? await query.for('update') : await query;
  return found ? { ...found.row, version: found.version } : null;
}

const keyInput = z.strictObject({ key: codeEntryKey });
const versionedInput = z.strictObject({ key: codeEntryKey, version: codeEntryVersion });

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
      version: row.version,
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
  const { key, version } = parse(versionedInput, input);
  await withActor(ctx.actor, async (tx) => {
    const row = await entryByKeyTx(tx, key, { lock: true });
    if (!row || row.status === 'removed') throw new HdaError('not_found');
    if (row.status === 'approved') return;
    // Запись изменилась, пока страница была открыта: утверждается только то, что сотрудник видел (находка I7).
    if (row.version !== version) throw new HdaError('conflict');
    await tx.update(codeErrorEntries).set({ status: 'approved', approvedBy: ctx.actor.userId, approvedOn: sql`now()`, rejectReason: null }).where(eq(codeErrorEntries.entryId, row.entryId));
    await writeAudit(tx, { action: 'code.entry_approved', objectType: 'code_entry', objectId: row.entryId, diff: { entry: key } });
  });
}

const rejectInput = z.strictObject({
  key: codeEntryKey,
  reason: z
    .string()
    .transform(normalizeCodeText)
    .pipe(
      z
        .string()
        .trim()
        .max(500)
        .refine((text) => textViolations(text).filter((rule) => rule !== 'line_too_long' && rule !== 'code_like').length === 0),
    )
    .optional(),
});

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

// Поля правки по тем же правилам, что у отчёта (находки C2, I1): переводы строк формы \r\n как \n, без
// невидимых знаков; управляющие знаки, больше 10 строк, строка длиннее 300 знаков и похожее на код отклоняются.
const multiline = (max: number) =>
  z
    .string()
    .transform(normalizeCodeText)
    .pipe(
      z
        .string()
        .trim()
        .min(1)
        .max(max)
        .refine((text) => textViolations(text).length === 0),
    );
const templateText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((text) => templateViolations(text).length === 0)
  .transform(normalizeCodeText);

const editInput = z.strictObject({
  key: codeEntryKey,
  version: codeEntryVersion,
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
    if (row.version !== data.version) throw new HdaError('conflict');
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
    return { days, withSignature: share.withSignature, fromTemplate: share.matched, solutionsFromEntries: await solutionsFromCodeEntriesTx(tx, since) };
  });
}

// --- Блок "Что известно по коду" и решение из записи (задача 6; FR-CODE-06, 07, 11; решения 16, 17) ---

export type TicketCodeEntry = {
  key: string;
  code: string | null;
  status: 'draft' | 'approved';
  conditions: string;
  whatToCheck: string[];
  raisedIn: CodeLocation[];
  /** Как запись найдена: по сигнатуре обращения или по совпадению шаблона со строкой обращения. */
  match: 'signature' | 'template';
};

export type TicketCodeKnowledge =
  | { view: 'full'; entries: TicketCodeEntry[]; canCreateSolution: boolean }
  | { view: 'checks'; checks: { key: string; whatToCheck: string[] }[] }
  | { view: 'none' };

/** Сколько записей показывает блок. */
const TICKET_ENTRIES_MAX = 5;

/**
 * Блок "Что известно по коду" (FR-CODE-06, 11): agent_l2, care, admin видят утверждённую запись по сигнатуре обращения
 * и записи, чьи шаблоны совпали со строками обращения (черновики с пометкой "не проверено"); первая линия только "что
 * проверить" утверждённой записи по сигнатуре; product ничего.
 */
export async function ticketCodeKnowledge(ctx: StaffContext, input: unknown): Promise<TicketCodeKnowledge> {
  const { number } = parse(z.strictObject({ number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }), input);
  if (ctx?.actor?.type !== 'staff') throw new HdaError('forbidden');
  const role = ctx.actor.staffRole;
  const reader = (CODE_READER_ROLES as readonly string[]).includes(role);
  if (!reader && role !== 'agent_l1') return { view: 'none' };
  return withActor(ctx.actor, async (tx) => {
    const facts = await ticketCodeFactsTx(tx, number);
    if (!facts) throw new HdaError('not_found');
    if (!reader) {
      if (!facts.errorSignature) return { view: 'checks', checks: [] };
      const rows = await tx.execute<{ key: string; what_to_check: string[] }>(sql`select key, what_to_check from hda_code_checks where signature = ${facts.errorSignature} order by key limit ${TICKET_ENTRIES_MAX}`);
      return { view: 'checks', checks: rows.rows.map((row) => ({ key: row.key, whatToCheck: row.what_to_check })) };
    }
    const lines = templateCandidateLines({ errorText: facts.errorText, description: facts.description });
    // Код и строки те же, что у сигнатуры обращения, и то же сопоставление базы (находка M2).
    const code = templateMatchCode({ text: facts.description, errorCode: facts.errorCode, errorText: facts.errorText });
    const columns = { key: codeErrorEntries.key, code: codeErrorEntries.code, status: codeErrorEntries.status, conditions: codeErrorEntries.conditions, whatToCheck: codeErrorEntries.whatToCheck, raisedIn: codeErrorEntries.raisedIn, signature: codeErrorEntries.signature };
    const bySignature = facts.errorSignature
      ? await tx.select(columns).from(codeErrorEntries).where(and(eq(codeErrorEntries.signature, facts.errorSignature), eq(codeErrorEntries.status, 'approved'))).limit(1)
      : [];
    const matched = (await codeTemplateMatchesTx(tx, { code, lines, statuses: ['draft', 'approved'] }))
      .sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, TICKET_ENTRIES_MAX);
    const found = matched.length > 0 ? await tx.select(columns).from(codeErrorEntries).where(inArray(codeErrorEntries.entryId, matched.map((m) => m.entryId))) : [];
    const byTemplate = matched.flatMap((m) => found.filter((row) => row.key === m.key));
    const seen = new Set<string>();
    const entries: TicketCodeEntry[] = [];
    for (const [row, match] of [...bySignature.map((r) => [r, 'signature'] as const), ...byTemplate.map((r) => [r, 'template'] as const)]) {
      if (seen.has(row.key) || entries.length >= TICKET_ENTRIES_MAX) continue;
      seen.add(row.key);
      entries.push({ key: row.key, code: row.code, status: row.status as 'draft' | 'approved', conditions: row.conditions, whatToCheck: row.whatToCheck, raisedIn: row.raisedIn, match });
    }
    return { view: 'full', entries, canCreateSolution: (KB_WRITER_ROLES as readonly string[]).includes(role) };
  });
}

const solutionInput = z.strictObject({ key: codeEntryKey, locale: z.enum(LOCALES) });
/** Подстановка в заголовке решения: место значения, которое у каждого клиента своё. */
const PLACEHOLDER_TEXT = '...';

/**
 * "Создать решение из записи" (FR-CODE-07): черновик решения для клиентов из утверждённой записи. В черновик идут
 * только заголовок из шаблона (подстановки заменены многоточием), причина у пользователя и "что проверить"; ключ,
 * код ошибки, условия и место в коде не попадают. Сигнатура записи привязывается к решению.
 */
export async function createSolutionFromCodeEntry(ctx: StaffContext, input: unknown, labels: TemplateLabels, newId: () => string): Promise<{ number: number; signature: 'bound' | 'taken' }> {
  requireReader(ctx);
  if (!(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
  const data = parse(solutionInput, input);
  return withActor(ctx.actor, async (tx) => {
    const row = await entryByKeyTx(tx, data.key, { lock: true });
    if (!row || row.status !== 'approved') throw new HdaError('not_found');
    const templates = await tx.select({ locale: codeErrorTemplates.locale, template: codeErrorTemplates.template }).from(codeErrorTemplates).where(eq(codeErrorTemplates.entryId, row.entryId));
    const template = templates.find((t) => t.locale === data.locale) ?? templates.find((t) => t.locale === 'ru') ?? templates[0];
    const title = (template?.template ?? row.userCause).replace(/\{[A-Za-z_][A-Za-z0-9_]{0,39}\}/g, PLACEHOLDER_TEXT).replace(/\s+/g, ' ').trim().slice(0, 140);
    const outcome = await createSolutionFromCodeEntryTx(
      tx,
      ctx.actor,
      {
        locale: data.locale,
        title,
        problem: row.userCause,
        steps: row.whatToCheck.slice(0, 12),
        moduleId: row.moduleId,
        entryId: row.entryId,
        entryKey: row.key,
        signature: row.signature,
        sampleCode: row.code ?? '',
        sample: title.slice(0, 300),
      },
      labels,
      newId,
    );
    return { number: outcome.number, signature: outcome.signature };
  });
}
