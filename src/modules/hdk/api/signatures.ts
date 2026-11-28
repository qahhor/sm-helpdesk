import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffContext, type TicketSignatureInput, type TicketSignatureRecorder, writeAudit } from '@/modules/hdc/api';
import { stripClientData } from '@/modules/hda/api/redact';
import { setTicketErrorSignatureTx, ticketsMissingSignature } from '@/modules/hdt/api/solution-source';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { orgAiProfile } from '@/modules/hdu/api/orgs';
import { articleByNumberTx } from '../core/editor';
import { articleSignaturesTx, bindSignatureTx, type SignatureRow, noteSignatureTx, unbindSignatureTx } from '../core/signatures';
import { HdkError } from '../error';
import { kbErrorSignatures, kbSignatureOrgs } from '../schema';
import { ARTICLE_NUMBER_MAX, KB_WRITER_ROLES } from '../pref';
import { normalizeErrorMessage, type TicketSignature } from '../signature';
import { resolveErrorSignature, resolveStaffSignature } from './signature-text';

// Модуль hdk, слой api: сигнатуры ошибок (план M5, задача 8; ТЗ 11.5, FR-SOL-07, 12; решения 7 и 8).
//
// Сигнатуру нового обращения считает сервер от имени системы (запись подключается через hdc в src/wiring.ts):
// клиент её не передаёт и не задаёт. Встреча пополняет hdk_signature_orgs: число различных организаций для пометки
// "встречалось у N клиентов", клиенту показывается только число и только от трёх. Пример текста для сотрудников
// строится из текста ошибки после очистки от данных клиента (почта, телефоны, длинные числа, имена участников,
// название и ИНН организации) и нормализации 11.5 (числа, значения в кавычках, идентификаторы).
//
// Сотрудник привязывает решение к одной или нескольким сигнатурам в редакторе: роли черновиков пишут, все сотрудники
// читают. Привязка и отвязка пишутся в журнал аудита той же транзакцией: от неё зависит, что увидит клиент точным
// совпадением.

export { type CorpusEntry, type CorpusReport, groupCorpus, parseCorpus } from '../signature';
export type { SignatureRow as SolutionSignature } from '../core/signatures';

const SYSTEM: SystemActor = { type: 'system', job: 'kb.signature' };

/** Пример текста ошибки без данных клиента: очистка до нормализации, иначе часть адреса почты пережила бы её. */
function sampleOf(found: TicketSignature, known: { names?: readonly string[]; orgTerms?: readonly string[] } = {}): string {
  return normalizeErrorMessage(stripClientData(found.raw, known));
}

/** Запись сигнатуры нового обращения: обращение, сигнатура, организация. Подключается в src/wiring.ts. */
export const ticketSignatureRecorder: TicketSignatureRecorder = {
  async recordTicket(input: TicketSignatureInput): Promise<string | null> {
    // Утверждённые шаблоны знаний из кода, затем 11.5 (веха M8c, решение 8).
    const found = await resolveErrorSignature({ text: input.description, errorCode: input.context?.errorCode, errorText: input.context?.errorText });
    if (!found) return null;
    const profile = await orgAiProfile(SYSTEM, { orgId: input.orgId, userIds: input.authorId ? [input.authorId] : [] });
    const sample = sampleOf(found, {
      names: profile?.people.map((person) => person.name) ?? [],
      orgTerms: [profile?.name, profile?.inn].filter((term): term is string => Boolean(term)),
    });
    await withActor(SYSTEM, async (tx) => {
      await setTicketErrorSignatureTx(tx, { ticketId: input.ticketId, signature: found.signature });
      await noteSignatureTx(tx, { signature: found.signature, code: found.code, sample, orgId: input.orgId, moduleId: input.moduleId, countOrg: input.countOrg ?? true });
    });
    return found.signature;
  },
};

/** Окно починки сигнатур: обращения не старше трёх суток и не моложе 10 минут (свежее ещё пишет свой процесс). */
const REPAIR_WINDOW_MS = 3 * 86_400_000;
const REPAIR_MIN_AGE_MS = 10 * 60_000;
/** Сколько обращений чинится за один запуск: остальное догонит следующий. */
const REPAIR_BATCH = 200;

/**
 * Починка потерянных сигнатур (0057, M7m), ночью вместе с kb.reconcile: обращение записано, а процесс упал до записи
 * сигнатуры. Берутся обращения окна без сигнатуры со строкой, похожей на ошибку; сигнатура пишется так же, как при
 * создании. Обращение и сигнатура пишутся одной транзакцией, поэтому повтор ничего не удваивает.
 */
export async function repairTicketSignatures(system: SystemActor, now: Date = new Date()): Promise<{ checked: number; repaired: number }> {
  const rows = await ticketsMissingSignature(system, {
    from: new Date(now.getTime() - REPAIR_WINDOW_MS),
    to: new Date(now.getTime() - REPAIR_MIN_AGE_MS),
    excludeOrgId: SERVICE_ORG_ID,
    limit: REPAIR_BATCH,
  });
  let repaired = 0;
  for (const row of rows) {
    const context = row.context && (row.context.errorCode || row.context.errorText) ? { errorCode: row.context.errorCode, errorText: row.context.errorText } : null;
    const signature = await ticketSignatureRecorder.recordTicket({
      ticketId: row.ticketId,
      orgId: row.orgId,
      authorId: row.authorId,
      description: row.description,
      context,
      moduleId: row.moduleId,
      countOrg: !row.senderUnconfirmed,
    });
    if (signature) repaired++;
  }
  return { checked: rows.length, repaired };
}

// --- Привязка в редакторе (FR-SOL-07) ---

const number = z.coerce.number().int().positive().max(ARTICLE_NUMBER_MAX);
const bindInput = z.union([
  z.strictObject({ number, signatureId: z.uuid() }),
  z.strictObject({ number, errorCode: z.string().trim().max(80).optional(), errorText: z.string().trim().max(2000) }),
]);
const unbindInput = z.strictObject({ number, signatureId: z.uuid() });

function requireStaff(ctx: StaffContext): void {
  if ((ctx?.actor as { type?: string } | undefined)?.type !== 'staff') throw new HdkError('forbidden');
}

function requireWriter(ctx: StaffContext): void {
  requireStaff(ctx);
  if (!(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdkError('forbidden');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  return parsed.data;
}

/** Сигнатуры решения с примером текста, числом организаций и встреч. Все сотрудники. */
export async function solutionSignatures(ctx: StaffContext, input: unknown): Promise<SignatureRow[]> {
  requireStaff(ctx);
  const data = parse(z.strictObject({ number }), input);
  return withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article) throw new HdkError('not_found');
    return articleSignaturesTx(tx, article.articleId);
  });
}

export type BindOutcome = { status: 'bound' } | { status: 'taken'; number: number };

/**
 * Привязка решения к сигнатуре: по коду и тексту ошибки (сигнатура считается тем же правилом, что у обращения) или
 * по строке списка "частые ошибки без решения". Сигнатура другого решения не перехватывается.
 */
export async function bindSolutionSignature(ctx: StaffContext, input: unknown): Promise<BindOutcome> {
  requireWriter(ctx);
  const data = parse(bindInput, input);
  let target: { signatureId: string } | { signature: string; code: string; sample: string };
  if ('signatureId' in data) target = { signatureId: data.signatureId };
  else {
    const found = await resolveStaffSignature({ ...(data.errorCode ? { code: data.errorCode } : {}), text: data.errorText });
    if (!found) throw new HdkError('invalid_input');
    target = { signature: found.signature, code: found.code, sample: sampleOf(found) };
  }
  return withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number, { lock: true });
    if (!article) throw new HdkError('not_found');
    const result = await bindSignatureTx(tx, article.articleId, target);
    if (result.status === 'not_found') throw new HdkError('not_found');
    if (result.status === 'taken') return result;
    if (result.changed)
      await writeAudit(tx, { action: 'solution.signature_bound', objectType: 'solution', objectId: article.articleId, diff: { number: article.number, signature: result.signature } });
    return { status: 'bound' };
  });
}

/** Отвязка сигнатуры от решения. */
export async function unbindSolutionSignature(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parse(unbindInput, input);
  await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number, { lock: true });
    if (!article) throw new HdkError('not_found');
    const signature = await unbindSignatureTx(tx, article.articleId, data.signatureId);
    if (signature) await writeAudit(tx, { action: 'solution.signature_unbound', objectType: 'solution', objectId: article.articleId, diff: { number: article.number, signature } });
  });
}

/**
 * Организации, у которых встречались сигнатуры (волна 7, S-M3): для обезличивания образца текста ошибки в ответе
 * сервера MCP. Транзакция системы: агенту список организаций не уходит.
 */
export async function signatureOrgIdsTx(tx: Tx, signatures: readonly string[]): Promise<string[]> {
  const unique = [...new Set(signatures)];
  if (unique.length === 0) return [];
  const rows = await tx
    .selectDistinct({ orgId: kbSignatureOrgs.orgId })
    .from(kbSignatureOrgs)
    .innerJoin(kbErrorSignatures, eq(kbErrorSignatures.signatureId, kbSignatureOrgs.signatureId))
    .where(inArray(kbErrorSignatures.signature, unique));
  return rows.map((row) => row.orgId);
}

/** Образец текста ошибки шаблоном (11.5): числа, значения в кавычках и идентификаторы заменены, регистр нижний. */
export function errorSampleTemplate(text: string): string {
  return normalizeErrorMessage(text);
}
