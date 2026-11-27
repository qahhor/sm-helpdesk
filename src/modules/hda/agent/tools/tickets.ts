import 'server-only';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or, type SQL, sql } from 'drizzle-orm';
import * as z from 'zod';
import { PRIORITIES, QUEUES, TICKET_STATUSES } from '@/modules/hdt/pref';
import { HdaAgentError } from '../../error';
import { agentExcerpt } from '../anonymize';
import { defineTool, type Redactor, type RedactScope, type ToolOutcome } from '../tool';
import { AGENT_NOTICE, iso, moment, notice, str, UNTRUSTED_HINT } from '../util';
import { agentMessagesView, agentTicketsView } from '../views';
import { cap, moduleCode, moduleCodes, moduleIdOf, numbersOf, signature } from './common';

// Инструменты чтения обращений (веха M8b, задача 5; FR-AGT-03, 06, 14, 15; план M8b, решения 6-9, 17; решение 0114):
// search_tickets, get_ticket, similar_tickets, sla_risk_tickets. Строки отбирают представления hda_agent_tickets и
// hda_agent_messages (организации с AI-обработкой, без "Неопознанных", у токена запуска только его обращение). Код
// обезличивает каждый текст людей и кладёт его только в поля untrusted_customer_text (клиент) и untrusted_text
// (сотрудник, помощник, агент, система). Организация идентификатором и категорией. Номер вне видимости: not_found.

const LIST_MAX = 50;
/**
 * Поиск по тексту темы идёт по обезличенной теме (долг M8b M7): иначе по числу совпадений агент проверил бы, есть ли
 * имя в обращениях. Поэтому строки отбираются остальными фильтрами, не больше стольких новых, обезличиваются и только
 * потом сверяются с текстом.
 */
const TEXT_SCAN_MAX = 500;
const SIMILAR_MAX = 10;
const TITLE_MAX = 500;
const DESCRIPTION_MAX = 20_000;
const MESSAGE_MAX = 8000;
const MESSAGES_MAX = 200;
const OPEN = TICKET_STATUSES.filter((status) => status !== 'resolved' && status !== 'closed');

const org = z.strictObject({ id: z.uuid(), category: z.enum(['A', 'B', 'C', 'D']).nullable() });
const summary = z.strictObject({
  number: z.number().int(),
  status: str(30),
  priority: str(5),
  type: str(30),
  queue: str(10).nullable(),
  module: str(80).nullable(),
  signature: str(32).nullable(),
  created_on: moment,
  org,
  untrusted_customer_text: z.strictObject({ title: str(TITLE_MAX + 1) }),
});

type TicketRow = typeof agentTicketsView.$inferSelect;
const orgOf = (row: TicketRow) => ({ id: row.orgId, category: (row.orgCategory as 'A' | 'B' | 'C' | 'D' | null) ?? null });

/** Охват обезличивания строк: их организации и люди их обращений (находка I1). */
const scopeOf = (rows: TicketRow[]): RedactScope => ({ orgIds: rows.map((row) => row.orgId), ticketIds: rows.map((row) => row.ticketId) });

/** Краткие строки обращений: коды модулей читаются в транзакции агента, тексты обезличиваются после неё. */
async function summaries(tx: Parameters<typeof moduleCodes>[0], rows: TicketRow[]) {
  const code = await moduleCodes(
    tx,
    rows.map((row) => row.moduleId),
  );
  return (redact: Redactor) => rows.map((row) => ({
    number: row.number,
    status: row.status,
    priority: row.priority,
    type: row.type,
    queue: row.queue,
    module: code(row.moduleId),
    signature: row.errorSignature,
    created_on: row.createdOn.toISOString(),
    org: orgOf(row),
    untrusted_customer_text: { title: cap(redact(row.orgId, row.title), TITLE_MAX) },
  }));
}

const ticketRefs = (items: { number: number }[]) => items.map((item) => ({ kind: 'ticket' as const, ref: item.number }));

// --- search_tickets ---

export const searchTickets = defineTool({
  name: 'search_tickets',
  kind: 'read',
  description: `Search tickets visible to the AI staff by status, queue, module code, priority, period of creation, error signature and text in the anonymized subject (among the newest ${TEXT_SCAN_MAX} tickets matching the other filters). Newest first, at most ${LIST_MAX}. Organizations are given by id and category only. ${UNTRUSTED_HINT}`,
  input: z.strictObject({
    status: z.array(z.enum(TICKET_STATUSES)).min(1).max(TICKET_STATUSES.length).optional(),
    queue: z.enum(QUEUES).optional(),
    module: moduleCode.optional(),
    priority: z.array(z.enum(PRIORITIES)).min(1).max(PRIORITIES.length).optional(),
    created_from: moment.optional(),
    created_to: moment.optional(),
    signature: signature.optional(),
    text: z.string().trim().min(2).max(200).optional(),
    limit: z.number().int().min(1).max(LIST_MAX).default(20),
  }),
  output: z.strictObject({ notice, items: z.array(summary).max(LIST_MAX) }),
  async run(tx, _actor, args) {
    const moduleId = await moduleIdOf(tx, args.module);
    const v = agentTicketsView;
    const where: (SQL | undefined)[] = [
      args.status ? inArray(v.status, args.status) : undefined,
      args.queue ? eq(v.queue, args.queue) : undefined,
      moduleId ? eq(v.moduleId, moduleId) : undefined,
      args.priority ? inArray(v.priority, args.priority) : undefined,
      args.created_from ? gte(v.createdOn, new Date(args.created_from)) : undefined,
      args.created_to ? lte(v.createdOn, new Date(args.created_to)) : undefined,
      args.signature ? eq(v.errorSignature, args.signature) : undefined,
    ];
    const rows = await tx
      .select()
      .from(v)
      .where(and(...where))
      .orderBy(desc(v.createdOn), desc(v.number))
      .limit(args.text ? TEXT_SCAN_MAX : args.limit);
    const build = await summaries(tx, rows);
    const needle = args.text?.toLocaleLowerCase('ru');
    return {
      redact: scopeOf(rows),
      finish: (redact: Redactor) => {
        const all = build(redact);
        const items = (needle ? all.filter((item) => item.untrusted_customer_text.title.toLocaleLowerCase('ru').includes(needle)) : all).slice(0, args.limit);
        return { result: { notice: AGENT_NOTICE, items }, objectRefs: ticketRefs(items) };
      },
    };
  },
});

// --- get_ticket ---

const message = z.strictObject({
  author: str(20),
  kind: z.enum(['public', 'internal_note', 'agent_note']),
  created_on: moment,
  ai_kind: str(30).optional(),
  solution_number: z.number().int().optional(),
  problem_number: z.number().int().optional(),
  untrusted_customer_text: str(MESSAGE_MAX + 1).optional(),
  untrusted_text: str(MESSAGE_MAX + 1).optional(),
});
const transfer = z.strictObject({
  created_on: moment,
  from_line: str(10).nullable(),
  to_line: str(10).nullable(),
  reason_code: str(40).nullable(),
  untrusted_text: z.strictObject({ checked: str(MESSAGE_MAX + 1).nullable(), needed: str(MESSAGE_MAX + 1).nullable(), explanation: str(MESSAGE_MAX + 1).nullable() }),
});
const ticketOut = z.strictObject({
  number: z.number().int(),
  status: str(30),
  priority: str(5),
  impact: str(20),
  type: str(30),
  queue: str(10).nullable(),
  module: str(80).nullable(),
  locale: str(5),
  source: str(30),
  created_on: moment,
  org,
  signature: str(32).nullable(),
  known_problem: z.number().int().nullable(),
  solution: z.number().int().nullable(),
  resolution_type: str(30).nullable(),
  ai_state: str(30).nullable(),
  ai_handoff_reason: str(40).nullable(),
  sla: z.strictObject({
    first_response_due_on: moment.nullable(),
    resolution_due_on: moment.nullable(),
    first_responded_on: moment.nullable(),
    resolved_on: moment.nullable(),
    closed_on: moment.nullable(),
    first_response_breached_on: moment.nullable(),
    resolution_breached_on: moment.nullable(),
    paused_on: moment.nullable(),
    client_waiting_since: moment.nullable(),
  }),
  untrusted_customer_text: z.strictObject({ title: str(TITLE_MAX + 1), description: str(DESCRIPTION_MAX + 1) }),
  messages: z.array(message).max(MESSAGES_MAX),
  messages_truncated: z.boolean(),
  transfers: z.array(transfer).max(50),
});

const PEOPLE_TYPES = new Set(['client', 'staff']);

export const getTicket = defineTool({
  name: 'get_ticket',
  kind: 'read',
  description: `One ticket by number: status, priority, queue, module, SLA dates, organization id and category, the conversation (public messages, assistant messages, staff internal notes, AI staff notes) and line transfers. No attachments. Customer text is in untrusted_customer_text, staff and other text in untrusted_text, all anonymized. ${UNTRUSTED_HINT}`,
  input: z.strictObject({ number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  output: z.strictObject({ notice, ticket: ticketOut }),
  async run(tx, _actor, args) {
    const [row] = await tx.select().from(agentTicketsView).where(eq(agentTicketsView.number, args.number)).limit(1);
    if (!row) throw new HdaAgentError('not_found');
    const items = await tx
      .select()
      .from(agentMessagesView)
      .where(eq(agentMessagesView.ticketId, row.ticketId))
      .orderBy(asc(agentMessagesView.createdOn), asc(agentMessagesView.itemId))
      .limit(MESSAGES_MAX + 51);
    const code = await moduleCodes(tx, [row.moduleId]);
    const numbers = await numbersOf(tx, { problemIds: [row.knownProblemId], solutionIds: [row.solutionId] });
    return { redact: scopeOf([row]), finish: (redact: Redactor) => ticketOf(row, items, code, numbers, redact) };
  },
});

type ItemRow = typeof agentMessagesView.$inferSelect;

/** Ответ get_ticket из прочитанных строк с готовым обезличиванием. */
function ticketOf(
  row: TicketRow,
  items: ItemRow[],
  code: (id: string | null) => string | null,
  numbers: Awaited<ReturnType<typeof numbersOf>>,
  redact: Redactor,
): ToolOutcome<unknown> {
    const text = (value: string | null) => (value === null ? null : cap(redact(row.orgId, value), MESSAGE_MAX));
    const messages = items
      .filter((item) => item.itemKind === 'message')
      .map((item) => {
        const author = PEOPLE_TYPES.has(item.authorType) ? `${item.authorType}:${item.authorNo ?? 0}` : item.authorType;
        const kind: 'public' | 'internal_note' | 'agent_note' = !item.isInternal ? 'public' : item.authorType === 'agent' ? 'agent_note' : 'internal_note';
        const body = text(item.body ?? '') ?? '';
        return {
          author,
          kind,
          created_on: item.createdOn.toISOString(),
          ...(item.aiKind ? { ai_kind: item.aiKind.slice(0, 30) } : {}),
          ...(item.aiSolutionNumber !== null ? { solution_number: item.aiSolutionNumber } : {}),
          ...(item.aiProblemNumber !== null ? { problem_number: item.aiProblemNumber } : {}),
          ...(item.authorType === 'client' ? { untrusted_customer_text: body } : { untrusted_text: body }),
        };
      });
    const transfers = items
      .filter((item) => item.itemKind === 'line_transfer')
      .slice(0, 50)
      .map((item) => ({
        created_on: item.createdOn.toISOString(),
        from_line: item.fromLine,
        to_line: item.toLine,
        reason_code: item.reasonCode,
        untrusted_text: { checked: text(item.checked), needed: text(item.needed), explanation: text(item.explanation) },
      }));
    const ticket = {
      number: row.number,
      status: row.status,
      priority: row.priority,
      impact: row.impact,
      type: row.type,
      queue: row.queue,
      module: code(row.moduleId),
      locale: row.locale,
      source: row.source,
      created_on: row.createdOn.toISOString(),
      org: orgOf(row),
      signature: row.errorSignature,
      known_problem: numbers.problem(row.knownProblemId),
      solution: numbers.solution(row.solutionId),
      resolution_type: row.resolutionType,
      ai_state: row.aiState,
      ai_handoff_reason: row.aiHandoffReason,
      sla: {
        first_response_due_on: iso(row.firstResponseDueOn),
        resolution_due_on: iso(row.resolutionDueOn),
        first_responded_on: iso(row.firstRespondedOn),
        resolved_on: iso(row.resolvedOn),
        closed_on: iso(row.closedOn),
        first_response_breached_on: iso(row.firstResponseBreachedOn),
        resolution_breached_on: iso(row.resolutionBreachedOn),
        paused_on: iso(row.slaPausedOn),
        client_waiting_since: iso(row.clientWaitingSince),
      },
      untrusted_customer_text: { title: cap(redact(row.orgId, row.title), TITLE_MAX), description: cap(redact(row.orgId, row.description), DESCRIPTION_MAX) },
      messages: messages.slice(0, MESSAGES_MAX),
      messages_truncated: messages.length > MESSAGES_MAX,
      transfers,
    };
    return { result: { notice: AGENT_NOTICE, ticket }, objectRefs: [{ kind: 'ticket' as const, ref: row.number }] };
}

// --- similar_tickets ---

const POOL = 200;
const words = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 50));

export const similarTickets = defineTool({
  name: 'similar_tickets',
  kind: 'read',
  description: `Tickets similar to the given one: the same error signature first, then the same module with overlapping subject words. At most ${SIMILAR_MAX}. For every ticket: subject and the first 300 characters of the description, anonymized. ${UNTRUSTED_HINT}`,
  input: z.strictObject({ number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  output: z.strictObject({
    notice,
    items: z
      .array(
        z.strictObject({
          number: z.number().int(),
          status: str(30),
          created_on: moment,
          same_org: z.boolean(),
          signature_match: z.boolean(),
          org,
          untrusted_customer_text: z.strictObject({ title: str(TITLE_MAX + 1), excerpt: str(302) }),
        }),
      )
      .max(SIMILAR_MAX),
  }),
  async run(tx, _actor, args) {
    const v = agentTicketsView;
    const [base] = await tx.select().from(v).where(eq(v.number, args.number)).limit(1);
    if (!base) throw new HdaAgentError('not_found');
    const bySignature = base.errorSignature
      ? await tx
          .select()
          .from(v)
          .where(and(eq(v.errorSignature, base.errorSignature), ne(v.ticketId, base.ticketId), isNull(v.mergedIntoId)))
          .orderBy(desc(v.createdOn))
          .limit(SIMILAR_MAX)
      : [];
    const byModule =
      bySignature.length < SIMILAR_MAX && base.moduleId
        ? await tx
            .select()
            .from(v)
            .where(and(eq(v.moduleId, base.moduleId), ne(v.ticketId, base.ticketId), isNull(v.mergedIntoId), bySignature.length ? notInArray(v.ticketId, bySignature.map((r) => r.ticketId)) : undefined))
            .orderBy(desc(v.createdOn))
            .limit(POOL)
        : [];
    const target = words(base.title);
    const ranked = byModule
      .map((row) => ({ row, score: [...words(row.title)].filter((word) => target.has(word)).length }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.row);
    const rows = [...bySignature, ...ranked].slice(0, SIMILAR_MAX);
    return {
      redact: scopeOf(rows),
      finish: (redact: Redactor) => {
    const items = rows.map((row) => ({
      number: row.number,
      status: row.status,
      created_on: row.createdOn.toISOString(),
      same_org: row.orgId === base.orgId,
      signature_match: base.errorSignature !== null && row.errorSignature === base.errorSignature,
      org: orgOf(row),
      untrusted_customer_text: { title: cap(redact(row.orgId, row.title), TITLE_MAX), excerpt: agentExcerpt(redact(row.orgId, row.description), 300) },
    }));
    return { result: { notice: AGENT_NOTICE, items }, objectRefs: ticketRefs([{ number: base.number }, ...items]) };
      },
    };
  },
});

// --- sla_risk_tickets ---

export const slaRiskTickets = defineTool({
  name: 'sla_risk_tickets',
  kind: 'read',
  description: `Open tickets whose first response or resolution deadline is already breached or falls within the next N hours (1-72, default 4). Breached first, then by the nearest deadline; at most ${LIST_MAX}. ${UNTRUSTED_HINT}`,
  input: z.strictObject({ hours: z.number().int().min(1).max(72).default(4), limit: z.number().int().min(1).max(LIST_MAX).default(LIST_MAX) }),
  output: z.strictObject({
    notice,
    items: z
      .array(summary.extend({ risk: z.enum(['first_response', 'resolution']), breached: z.boolean(), due_on: moment.nullable() }).strict())
      .max(LIST_MAX),
  }),
  async run(tx, _actor, args) {
    const v = agentTicketsView;
    const horizon = sql`now() + make_interval(hours => ${args.hours})`;
    const firstRisk = and(isNull(v.firstRespondedOn), or(isNotNull(v.firstResponseBreachedOn), and(isNotNull(v.firstResponseDueOn), lte(v.firstResponseDueOn, horizon))));
    const resolutionRisk = and(isNull(v.resolvedOn), or(isNotNull(v.resolutionBreachedOn), and(isNotNull(v.resolutionDueOn), lte(v.resolutionDueOn, horizon))));
    const rows = await tx
      .select()
      .from(v)
      .where(and(inArray(v.status, OPEN), or(firstRisk, resolutionRisk)))
      .limit(500);
    const limit = Date.now() + args.hours * 3_600_000;
    const graded = rows
      .map((row) => {
        const firstOpen = row.firstRespondedOn === null;
        const resolutionOpen = row.resolvedOn === null;
        const firstBreached = firstOpen && row.firstResponseBreachedOn !== null;
        const resolutionBreached = resolutionOpen && row.resolutionBreachedOn !== null;
        const firstSoon = firstOpen && row.firstResponseDueOn !== null && row.firstResponseDueOn.getTime() <= limit;
        // Нарушенный срок важнее близкого, первый ответ важнее решения.
        const risk: 'first_response' | 'resolution' = firstBreached || (!resolutionBreached && firstSoon) ? 'first_response' : 'resolution';
        const due = risk === 'first_response' ? row.firstResponseDueOn : row.resolutionDueOn;
        return { row, risk, due, breached: risk === 'first_response' ? firstBreached : resolutionBreached };
      })
      .sort((a, b) => Number(b.breached) - Number(a.breached) || (a.due?.getTime() ?? 0) - (b.due?.getTime() ?? 0))
      .slice(0, args.limit);
    const picked = graded.map((entry) => entry.row);
    const build = await summaries(tx, picked);
    return {
      redact: scopeOf(picked),
      finish: (redact: Redactor) => {
        const items = build(redact).map((item, i) => ({ ...item, risk: graded[i]!.risk, breached: graded[i]!.breached, due_on: iso(graded[i]!.due) }));
        return { result: { notice: AGENT_NOTICE, items }, objectRefs: ticketRefs(items) };
      },
    };
  },
});

export const ticketTools = [searchTickets, getTicket, similarTickets, slaRiskTickets];
