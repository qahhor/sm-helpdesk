import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { createSolutionDraftFromAgentTx } from '@/modules/hdk/api/from-agent';
import { readAllowedDomains } from '@/modules/hdk/api/publish';
import { createProblemDraftFromAgentTx } from '@/modules/hdp/api/agent-drafts';
import { HdaAgentError } from '../../error';
import { AGENT_BODY_MAX, AGENT_TITLE_MAX } from '../../pref';
import { defineTool } from '../tool';
import { AGENT_NOTICE, cleanAgentText, notice, UNTRUSTED_HINT } from '../util';
import { agentSolutionsView, agentTicketsView } from '../views';
import { moduleCode, moduleIdOf, signature } from './common';

// Инструменты черновиков (веха M8b, задача 6; FR-AGT-04, 05, 07; план M8b, решения 18, 20, 21, 22): draft_solution и
// draft_known_problem. Черновик решения: статья internal с недоверенным текстом, публикует сотрудник. Черновик
// проблемы: статус draft, сигнатура неактивна, обращения только предложены, принимает сотрудник. Обращения-источники
// и предложенные обращения берутся только из видимых агенту: номер вне видимости даёт not_found для всего вызова.

const ticketNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

async function visibleTickets(tx: Parameters<typeof moduleIdOf>[0], numbers: readonly number[]) {
  const unique = [...new Set(numbers)];
  if (unique.length === 0) return [];
  const rows = await tx.select({ ticketId: agentTicketsView.ticketId, orgId: agentTicketsView.orgId, number: agentTicketsView.number }).from(agentTicketsView).where(inArray(agentTicketsView.number, unique));
  if (rows.length !== unique.length) throw new HdaAgentError('not_found');
  return rows;
}

function cleaned(text: string, domains: readonly string[], allowEmpty = false): string {
  const value = cleanAgentText(text, domains);
  if (!value && !allowEmpty) throw new HdaAgentError('invalid_arguments');
  return value;
}

export const draftSolution = defineTool({
  name: 'draft_solution',
  kind: 'write',
  description: `Create a solution draft for staff review: audience internal, marked "AI staff, not verified", untrusted text that staff must confirm before publishing. Plain text, one paragraph per line. To propose a change to a published solution, pass revises_solution_number: the published solution itself is not changed. Source tickets must be visible to you. ${UNTRUSTED_HINT}`,
  input: z.strictObject({
    title: z.string().min(1).max(AGENT_TITLE_MAX),
    body: z.string().min(1).max(AGENT_BODY_MAX),
    locale: z.enum(LOCALES).default('ru'),
    module: moduleCode.optional(),
    source_ticket_numbers: z.array(ticketNumber).max(20).default([]),
    revises_solution_number: ticketNumber.optional(),
  }),
  output: z.strictObject({ notice, draft: z.strictObject({ number: z.number().int() }) }),
  // Адреса для ссылок читает система до транзакции агента (находка I3).
  prepare: () => readAllowedDomains(),
  async run(tx, actor, args, domains) {
    const moduleId = (await moduleIdOf(tx, args.module)) ?? null;
    const sources = await visibleTickets(tx, args.source_ticket_numbers);
    let revisesArticleId: string | null = null;
    if (args.revises_solution_number !== undefined) {
      const [published] = await tx.select({ articleId: agentSolutionsView.articleId }).from(agentSolutionsView).where(eq(agentSolutionsView.number, args.revises_solution_number)).limit(1);
      if (!published) throw new HdaAgentError('not_found');
      revisesArticleId = published.articleId;
    }
    const draft = await createSolutionDraftFromAgentTx(tx, actor, {
      title: cleaned(args.title, domains).slice(0, AGENT_TITLE_MAX),
      body: cleaned(args.body, domains),
      locale: args.locale,
      moduleId,
      revisesArticleId,
      sources: sources.map((s) => ({ ticketId: s.ticketId, orgId: s.orgId })),
    });
    return {
      result: { notice: AGENT_NOTICE, draft: { number: draft.number } },
      objectRefs: [{ kind: 'solution' as const, ref: draft.number }, ...sources.map((s) => ({ kind: 'ticket' as const, ref: s.number }))],
    };
  },
});

export const draftKnownProblem = defineTool({
  name: 'draft_known_problem',
  kind: 'write',
  description: `Create a known problem draft for staff review: not active, never shown to clients, the error signature stays inactive and the tickets are only proposed for linking. Staff accept, link and reject drafts. Proposed tickets must be visible to you. ${UNTRUSTED_HINT}`,
  input: z.strictObject({
    internal_title: z.string().min(1).max(AGENT_TITLE_MAX),
    description: z.string().max(4000).default(''),
    signature: signature.optional(),
    proposed_ticket_numbers: z.array(ticketNumber).max(100).default([]),
  }),
  output: z.strictObject({ notice, draft: z.strictObject({ number: z.number().int() }) }),
  // Адреса для ссылок читает система до транзакции агента (находка I3).
  prepare: () => readAllowedDomains(),
  async run(tx, actor, args, domains) {
    const proposals = await visibleTickets(tx, args.proposed_ticket_numbers);
    const draft = await createProblemDraftFromAgentTx(tx, actor, {
      internalTitle: cleaned(args.internal_title, domains).slice(0, AGENT_TITLE_MAX),
      description: cleaned(args.description, domains, true),
      signature: args.signature ?? null,
      proposals: proposals.map((p) => ({ ticketId: p.ticketId, orgId: p.orgId })),
    });
    return {
      result: { notice: AGENT_NOTICE, draft: { number: draft.number } },
      objectRefs: [{ kind: 'problem' as const, ref: draft.number }, ...proposals.map((p) => ({ kind: 'ticket' as const, ref: p.number }))],
    };
  },
});

export const draftTools = [draftSolution, draftKnownProblem];
