import 'server-only';
import type { Tx } from '@/db/client';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { enqueue, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { readAllowedDomains } from '@/modules/hdk/api/publish';
import { solutionIdByNumberTx, solutionNumbersTx } from '@/modules/hdk/api/refs';
import { lockProblemTicketTx, problemOrgIdsTx, problemTicketTx, problemTicketSignaturesTx, problemTicketsTx, signatureTicketCountsTx } from '@/modules/hdt/api/known-problems';
import { proposalsTx } from './agent-drafts';
import type { TicketStatus } from '@/modules/hdt/pref';
import { namesOf } from '@/modules/hdu/api';
import { orgFacts } from '@/modules/hdu/api/orgs';
import { linkLockedTicketTx } from '../core/links';
import {
  activeProblemBySignatureTx,
  deleteSignatureTx,
  insertProblemTx,
  insertSignatureTx,
  isPublishedText,
  listProblemsTx,
  type ProblemHead,
  requireProblemTx,
  signaturesTx,
  translationsTx,
  unacceptMachineTranslationsTx,
  updateProblemTx,
  upsertTranslationTx,
  problemTx,
} from '../core/problems';
import { HdpError } from '../error';
import {
  createProblemInput,
  fromTicketInput,
  listInput,
  parseInput,
  problemNumberInput,
  requestTranslationInput,
  saveProblemInput,
  shownInput,
  signatureInput,
  statusInput,
  translationInput,
} from '../input';
import { PROBLEM_WRITER_ROLES, type ProblemStatus } from '../pref';
import type { ProblemRow } from '../types';
import { checkPublicText, pgErrorCode, type PublicTextFinding } from '../util';

// Модуль hdp, слой api: ведение известной проблемы сотрудником (ТЗ 7.15, FR-KP-01..03, 10, FR-ADM-12; план M5c,
// задача 2, решения 3-6, 17). Создают, меняют статус, признак показа, сигнатуры и публичный текст agent_l2, care,
// admin (FR-KP-03); читают все сотрудники. Каждое изменение пишет журнал аудита той же транзакцией. Публичный текст
// пишет сотрудник и проверяет checkPublicText: телефоны, почта, ИНН, ссылки вне разрешённых доменов и названия и
// ИНН организаций привязанных обращений (решение 6, угроза T23). Машинный перевод клиенту не виден до принятия.

export { type PublicTextFinding } from '../util';
export { acceptProblemDraft, linkProposedTickets, type ProposalOutcome, rejectProblemDraft } from './agent-drafts';

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(PROBLEM_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdpError('forbidden');
}

function requireStaff(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff') throw new HdpError('forbidden');
}

/** Термины организаций привязанных обращений для проверки текста: название и ИНН. */
async function orgTermsOf(actor: StaffActor | SystemActor, tx: Tx, problemId: string): Promise<string[]> {
  const orgIds = await problemOrgIdsTx(tx, problemId);
  const facts = await orgFacts(actor, orgIds);
  return facts.flatMap((org) => [org.name, org.inn ?? '']).filter(Boolean);
}

/** Проверка публичного текста проблемы (решение 6). Находка: отказ text_findings с находками для показа. */
export async function assertPublicText(actor: StaffActor | SystemActor, tx: Tx, problemId: string, texts: readonly string[]): Promise<void> {
  const allowedDomains = await readAllowedDomains();
  const orgTerms = await orgTermsOf(actor, tx, problemId);
  const findings: PublicTextFinding[] = texts.flatMap((text) => checkPublicText(text, { orgTerms, allowedDomains }));
  if (findings.length > 0) throw new HdpError('text_findings', { findings });
}

/** Новая проблема без обращения (кнопка "Создать" в списке). Владелец: создатель. */
export async function createProblem(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  requireWriter(ctx);
  const data = parseInput(createProblemInput, input);
  return withActor(ctx.actor, async (tx) => {
    const { number } = await insertProblemTx(tx, { internalTitle: data.internalTitle, moduleId: data.moduleId ?? null, ownerId: ctx.actor.userId });
    await writeAudit(tx, { action: 'problem.created', objectType: 'problem', diff: { number } });
    return { number };
  });
}

/**
 * Создание из обращения одним нажатием (FR-KP-03, решение 4): внутреннее название из темы, модуль, сигнатура (если не
 * занята другой активной проблемой), первое появление; обращение сразу привязано, владелец создатель. Публичные поля
 * пусты, признак показа выключен: текст клиента не уходит другим клиентам (T23).
 */
export async function createProblemFromTicket(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  requireWriter(ctx);
  const data = parseInput(fromTicketInput, input);
  return withActor(ctx.actor, async (tx) => {
    const ticket = await lockProblemTicketTx(tx, { number: data.ticketNumber }).catch(() => {
      throw new HdpError('not_found');
    });
    if (ticket.knownProblemId) throw new HdpError('already_linked');
    const title = ticket.title.trim().slice(0, 200) || `SUP-${ticket.number}`;
    const created = await insertProblemTx(tx, { internalTitle: title, moduleId: ticket.moduleId, ownerId: ctx.actor.userId });
    const problem = await requireProblemTx(tx, { problemId: created.problemId }, { lock: true });
    if (ticket.errorSignature && !(await activeProblemBySignatureTx(tx, ticket.errorSignature)))
      await insertSignatureTx(tx, { problemId: problem.problemId, signature: ticket.errorSignature, addedBy: null });
    await linkLockedTicketTx(tx, ctx.actor, ticket, problem, 'created');
    await writeAudit(tx, { action: 'problem.created', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, fromTicket: ticket.number } });
    return { number: problem.number };
  });
}

/** Внутреннее название, модуль и обходной путь (решение из базы знаний по номеру). */
export async function saveProblem(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(saveProblemInput, input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    const workaroundSolutionId = data.workaroundNumber === null ? null : await solutionIdByNumberTx(tx, data.workaroundNumber);
    if (data.workaroundNumber !== null && !workaroundSolutionId) throw new HdpError('invalid_input');
    await updateProblemTx(tx, problem.problemId, { internalTitle: data.internalTitle, moduleId: data.moduleId, workaroundSolutionId });
    await writeAudit(tx, {
      action: 'problem.updated',
      objectType: 'problem',
      objectId: problem.problemId,
      diff: { number: problem.number, moduleId: data.moduleId, workaroundNumber: data.workaroundNumber },
    });
  });
}

/** Смена статуса карточкой (FR-KP-02). Закрытие только окном закрытия с итоговым текстом (решение 20). */
export async function setProblemStatus(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(statusInput, input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    // Черновик выходит из статуса draft только принятием (решение 20; находка M3 независимой проверки M8b).
    if (problem.status === 'draft') throw new HdpError('not_accepted');
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    if (problem.status === data.status) return;
    try {
      await updateProblemTx(tx, problem.problemId, { status: data.status });
    } catch (error) {
      // Возврат исправленной проблемы в работу: её сигнатура уже у другой активной (решение 7).
      if (pgErrorCode(error) === '23505') throw new HdpError('signature_taken');
      throw error;
    }
    await writeAudit(tx, { action: 'problem.status_changed', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, from: problem.status, to: data.status } });
  });
}

/** Признак показа (решения 5, 6): включается только с публичным текстом хотя бы на одном языке и без находок. */
export async function setProblemShown(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(shownInput, input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    // Черновик клиентам не показывается, признак у него не меняется (находка M3).
    if (problem.status === 'draft') throw new HdpError('not_accepted');
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    if (problem.showToClients === data.shown) return;
    if (data.shown) {
      const shown = (await translationsTx(tx, problem.problemId)).filter(isPublishedText);
      if (shown.length === 0) throw new HdpError('public_text_required');
      // Текст мог пройти проверку до привязки обращения новой организации: проверка ещё раз.
      await assertPublicText(ctx.actor, tx, problem.problemId, shown.flatMap((t) => [t.publicTitle, t.publicBody]));
    }
    await updateProblemTx(tx, problem.problemId, { showToClients: data.shown });
    await writeAudit(tx, { action: 'problem.shown_changed', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, shown: data.shown } });
  });
}

/**
 * Публичное название и описание на языке (FR-KP-01). acceptMachine: сотрудник принимает машинный перевод без правки;
 * с правкой текст становится текстом сотрудника. Находка проверки: text_findings, ничего не сохраняется.
 */
export async function saveProblemTranslation(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(translationInput, input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    await assertPublicText(ctx.actor, tx, problem.problemId, [data.publicTitle, data.publicBody]);
    const current = (await translationsTx(tx, problem.problemId)).find((t) => t.locale === data.locale);
    const accepting = data.acceptMachine === true && current?.isMachine === true && current.publicTitle === data.publicTitle && current.publicBody === data.publicBody;
    await upsertTranslationTx(tx, {
      problemId: problem.problemId,
      locale: data.locale,
      publicTitle: data.publicTitle,
      publicBody: data.publicBody,
      isMachine: accepting,
      acceptedBy: accepting ? ctx.actor.userId : null,
    });
    // Первый язык публичного текста становится языком оригинала: с него переводятся остальные.
    if (!current && !accepting && (await translationsTx(tx, problem.problemId)).filter((t) => !t.isMachine).length === 1)
      await updateProblemTx(tx, problem.problemId, { sourceLocale: data.locale });
    // Изменился текст оригинала: принятые машинные переводы с него устарели и клиенту больше не показываются (решение 0109).
    const sourceEdited = !accepting && data.locale === problem.sourceLocale && current !== undefined && !current.isMachine && (current.publicTitle !== data.publicTitle || current.publicBody !== data.publicBody);
    if (sourceEdited) {
      const outdated = await unacceptMachineTranslationsTx(tx, problem.problemId, data.locale);
      if (outdated.length > 0) await writeAudit(tx, { action: 'problem.translations_outdated', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, locales: outdated } });
    }
    // Скрыть показанную проблему, если пропал последний видимый клиенту текст: пустой баннер хуже, чем никакого.
    if (problem.showToClients && !(await translationsTx(tx, problem.problemId)).some(isPublishedText)) {
      await updateProblemTx(tx, problem.problemId, { showToClients: false });
      await writeAudit(tx, { action: 'problem.shown_changed', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, shown: false } });
    }
    await writeAudit(tx, { action: 'problem.translation_saved', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, locale: data.locale, accepted: accepting } });
  });
}

/** Машинный перевод публичного текста на язык задачей problems.translate (решение 17). */
export async function requestProblemTranslation(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(requestTranslationInput, input);
  const problem = await withActor(ctx.actor, (tx) => requireProblemTx(tx, { number: data.number }));
  if (problem.status === 'closed') throw new HdpError('problem_closed');
  if (data.locale === problem.sourceLocale) throw new HdpError('invalid_input');
  await enqueue('problems.translate', { problemId: problem.problemId, locale: data.locale });
}

export async function addProblemSignature(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(signatureInput, input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    if (await insertSignatureTx(tx, { problemId: problem.problemId, signature: data.signature, addedBy: ctx.actor.userId }))
      await writeAudit(tx, { action: 'problem.signature_added', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, signature: data.signature } });
  });
}

export async function removeProblemSignature(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(signatureInput, input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    if (await deleteSignatureTx(tx, problem.problemId, data.signature))
      await writeAudit(tx, { action: 'problem.signature_removed', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, signature: data.signature } });
  });
}

export async function listProblems(ctx: StaffContext, input: unknown): Promise<ProblemRow[]> {
  requireStaff(ctx);
  const data = parseInput(listInput, input);
  return withActor(ctx.actor, (tx) => listProblemsTx(tx, data));
}

export type ProblemCard = Omit<ProblemHead, 'workaroundSolutionId'> & {
  ownerName: string | null;
  workaround: { articleId: string; number: number } | null;
  categories: Partial<Record<'A' | 'B' | 'C' | 'D' | 'none', number>>;
  translations: { locale: Locale; publicTitle: string; publicBody: string; isMachine: boolean; accepted: boolean; shown: boolean }[];
  signatures: { signature: string; ticketCount: number; isActive: boolean }[];
  /** Сигнатуры привязанных обращений, которых ещё нет у проблемы: "Добавить сигнатуру" (раздел 8.12). */
  suggestedSignatures: { signature: string; ticketCount: number }[];
  tickets: { number: number; title: string; status: TicketStatus; orgName: string; createdOn: Date }[];
  /** Черновик AI-сотрудника или всплеска (веха M8b, решение 20): обращения, которые он предлагает привязать. */
  proposals: { number: number; title: string; status: TicketStatus; orgName: string }[];
};

/** Карточка проблемы (раздел 8.12, FR-KP-10): сведения, тексты, сигнатуры, обращения. Нет такой: null. */
export async function problemCard(ctx: StaffContext, numberValue: unknown): Promise<ProblemCard | null> {
  requireStaff(ctx);
  const parsed = problemNumberInput.safeParse(numberValue);
  if (!parsed.success) return null;
  const loaded = await withActor(ctx.actor, async (tx) => {
    // Проблемы может не быть: это ответ, а не ошибка. Ошибка базы не глотается (проверка качества, Q16).
    const problem = await problemTx(tx, { number: parsed.data });
    if (!problem) return null;
    const signatures = await signaturesTx(tx, problem.problemId);
    const counts = await signatureTicketCountsTx(tx, problem.problemId, signatures.map((s) => s.signature));
    const ticketSignatures = await problemTicketSignaturesTx(tx, problem.problemId);
    const workaround = problem.workaroundSolutionId ? ((await solutionNumbersTx(tx, [problem.workaroundSolutionId])).get(problem.workaroundSolutionId) ?? null) : null;
    return {
      problem,
      translations: await translationsTx(tx, problem.problemId),
      signatures: signatures.map((s) => ({ ...s, ticketCount: counts.get(s.signature) ?? 0 })),
      suggested: ticketSignatures.filter((s) => !signatures.some((own) => own.signature === s.signature)),
      tickets: await problemTicketsTx(tx, problem.problemId),
      proposals: (await Promise.all((await proposalsTx(tx, problem.problemId)).map((p) => problemTicketTx(tx, { ticketId: p.ticketId })))).filter((t) => t !== null),
      workaround,
    };
  });
  if (!loaded) return null;
  const { problem } = loaded;
  const facts = new Map((await orgFacts(ctx.actor, [...new Set([...loaded.tickets, ...loaded.proposals].map((t) => t.orgId))])).map((o) => [o.orgId, o]));
  const categories: ProblemCard['categories'] = {};
  for (const org of facts.values()) categories[org.category ?? 'none'] = (categories[org.category ?? 'none'] ?? 0) + 1;
  const owner = problem.ownerId ? ((await namesOf(ctx.actor, [problem.ownerId])).get(problem.ownerId) ?? null) : null;
  const { workaroundSolutionId, ...rest } = problem;
  return {
    ...rest,
    ownerName: owner,
    workaround: workaroundSolutionId && loaded.workaround !== null ? { articleId: workaroundSolutionId, number: loaded.workaround } : null,
    categories,
    translations: loaded.translations.map((t) => ({ locale: t.locale, publicTitle: t.publicTitle, publicBody: t.publicBody, isMachine: t.isMachine, accepted: t.acceptedBy !== null, shown: isPublishedText(t) })),
    signatures: loaded.signatures,
    suggestedSignatures: loaded.suggested,
    tickets: loaded.tickets.map((t) => ({ number: t.number, title: t.title, status: t.status, orgName: facts.get(t.orgId)?.name ?? '', createdOn: t.createdOn })),
    proposals: loaded.proposals.map((t) => ({ number: t.number, title: t.title, status: t.status, orgName: facts.get(t.orgId)?.name ?? '' })),
  };
}

/** Проблема обращения для блока в правой колонке обращения сотрудника; без проблемы или без обращения: null. */
export async function problemOfTicket(ctx: StaffContext, ticketNumber: number): Promise<{ number: number; internalTitle: string; status: ProblemStatus; showToClients: boolean } | null> {
  requireStaff(ctx);
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber <= 0) return null;
  return withActor(ctx.actor, async (tx) => {
    const ticket = await problemTicketTx(tx, { number: ticketNumber });
    if (!ticket?.knownProblemId) return null;
    const problem = await requireProblemTx(tx, { problemId: ticket.knownProblemId });
    return { number: problem.number, internalTitle: problem.internalTitle, status: problem.status, showToClients: problem.showToClients };
  });
}

export type { ProblemStatus };
