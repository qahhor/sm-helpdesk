import 'server-only';
import { and, arrayContains, desc, eq, or } from 'drizzle-orm';
import * as z from 'zod';
import { containsText } from '@/db/contains';
import { CANDIDATE_STATUSES } from '../../pref';
import { HdaAgentError } from '../../error';
import { agentExcerpt, anonymizeForAgent } from '../anonymize';
import { defineTool, type Redactor } from '../tool';
import { AGENT_NOTICE, iso, moment, notice, str, UNTRUSTED_HINT } from '../util';
import { agentCandidatesView, agentSolutionsView } from '../views';
import { cap, moduleCode, moduleCodes, moduleIdOf } from './common';

// Инструменты решений (веха M8b, задача 5; FR-AGT-03; план M8b, решение 17): search_solutions, get_solution,
// list_candidates. Решения только опубликованные (копия публикации обеих аудиторий, представление
// hda_agent_solutions): черновиков, решений из кандидата до публикации и кандидатов в поиске решений нет. Тексты решений
// пишут люди и AI: они обезличиваются общими правилами (их проверила публикация); тексты кандидатов, сделанные из
// обращений, ещё и словами организаций и людей обращений-источников (находка I2). Всё лежит в untrusted_text.

const LIST_MAX = 20;
const CANDIDATES_MAX = 50;
const BODY_MAX = 20_000;
const LOCALES = ['ru', 'uz', 'en'] as const;
const clean = (text: string) => anonymizeForAgent(text, { people: [], orgTerms: [] }).text;

const stats = z.strictObject({ shown: z.number().int(), helped: z.number().int(), not_helped: z.number().int(), staff_useful: z.number().int() });
const solutionItem = z.strictObject({
  number: z.number().int(),
  locale: str(5),
  type: str(30),
  audience: str(20),
  modules: z.array(str(80)).max(50),
  is_machine_translation: z.boolean(),
  is_outdated: z.boolean(),
  published_on: moment,
  updated_on: moment,
  stats,
  untrusted_text: z.strictObject({ title: str(501), excerpt: str(302) }),
});

type SolutionRow = typeof agentSolutionsView.$inferSelect;

async function solutionItems(tx: Parameters<typeof moduleCodes>[0], rows: SolutionRow[]) {
  const code = await moduleCodes(
    tx,
    rows.flatMap((row) => row.moduleIds),
  );
  return rows.map((row) => ({
    number: row.number,
    locale: row.locale,
    type: row.type,
    audience: row.audience,
    modules: row.moduleIds.flatMap((id) => code(id) ?? []).slice(0, 50),
    is_machine_translation: row.isMachine,
    is_outdated: row.isOutdated,
    published_on: row.publishedOn.toISOString(),
    updated_on: row.articleModifiedOn.toISOString(),
    stats: { shown: row.shownCount, helped: row.helpedCount, not_helped: row.notHelpedCount, staff_useful: row.staffUsefulCount },
    untrusted_text: { title: cap(clean(row.title), 500), excerpt: agentExcerpt(clean(row.bodyText), 300) },
  }));
}

export const searchSolutions = defineTool({
  name: 'search_solutions',
  kind: 'read',
  description: `Published solutions of both audiences (clients and internal) with statistics: shown, helped, not helped, useful for staff, last update. Filter by text in the title or body, module code, audience and language. Drafts and candidates are never returned. At most ${LIST_MAX}. ${UNTRUSTED_HINT}`,
  input: z.strictObject({
    text: z.string().trim().min(2).max(200).optional(),
    module: moduleCode.optional(),
    audience: z.enum(['clients', 'internal']).optional(),
    locale: z.enum(LOCALES).optional(),
    limit: z.number().int().min(1).max(LIST_MAX).default(10),
  }),
  output: z.strictObject({ notice, items: z.array(solutionItem).max(LIST_MAX) }),
  async run(tx, _actor, args) {
    const v = agentSolutionsView;
    const moduleId = await moduleIdOf(tx, args.module);
    const rows = await tx
      .select()
      .from(v)
      .where(
        and(
          args.text ? or(containsText(v.title, args.text), containsText(v.bodyText, args.text)) : undefined,
          moduleId ? arrayContains(v.moduleIds, [moduleId]) : undefined,
          args.audience ? eq(v.audience, args.audience) : undefined,
          args.locale ? eq(v.locale, args.locale) : undefined,
        ),
      )
      .orderBy(desc(v.articleModifiedOn), desc(v.number))
      .limit(args.limit);
    const items = await solutionItems(tx, rows);
    return { result: { notice: AGENT_NOTICE, items }, objectRefs: items.map((item) => ({ kind: 'solution' as const, ref: item.number })) };
  },
});

export const getSolution = defineTool({
  name: 'get_solution',
  kind: 'read',
  description: `One published solution by number: full text of the publication in the requested language (or the first available), statistics and modules. ${UNTRUSTED_HINT}`,
  input: z.strictObject({ number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), locale: z.enum(LOCALES).optional() }),
  output: z.strictObject({
    notice,
    solution: solutionItem.omit({ untrusted_text: true }).extend({ untrusted_text: z.strictObject({ title: str(501), body: str(BODY_MAX + 1) }) }).strict(),
  }),
  async run(tx, _actor, args) {
    const v = agentSolutionsView;
    const rows = await tx.select().from(v).where(eq(v.number, args.number)).limit(10);
    const row = rows.find((r) => r.locale === args.locale) ?? rows[0];
    if (!row) throw new HdaAgentError('not_found');
    const [item] = await solutionItems(tx, [row]);
    const { untrusted_text: _excerpt, ...rest } = item!;
    void _excerpt;
    const solution = { ...rest, untrusted_text: { title: cap(clean(row.title), 500), body: cap(clean(row.bodyText), BODY_MAX) } };
    return { result: { notice: AGENT_NOTICE, solution }, objectRefs: [{ kind: 'solution' as const, ref: row.number }] };
  },
});

export const listCandidates = defineTool({
  name: 'list_candidates',
  kind: 'read',
  description: `Solution candidates prepared by the assistant from resolved tickets: AI draft text, status and source ticket numbers. A candidate built from a ticket of an organization without AI processing is not returned. At most ${CANDIDATES_MAX}. ${UNTRUSTED_HINT}`,
  input: z.strictObject({ status: z.enum(CANDIDATE_STATUSES).optional(), limit: z.number().int().min(1).max(CANDIDATES_MAX).default(CANDIDATES_MAX) }),
  output: z.strictObject({
    notice,
    items: z
      .array(
        z.strictObject({
          id: z.uuid(),
          status: str(20),
          module: str(80).nullable(),
          locale: str(5),
          source_count: z.number().int(),
          org_count: z.number().int(),
          source_numbers: z.array(z.number().int()).max(50),
          created_on: moment,
          updated_on: moment.nullable(),
          untrusted_text: z.strictObject({ title: str(501), problem: str(4001), steps: z.array(str(2001)).max(30) }),
        }),
      )
      .max(CANDIDATES_MAX),
  }),
  async run(tx, _actor, args) {
    const v = agentCandidatesView;
    const rows = await tx
      .select()
      .from(v)
      .where(and(args.status ? eq(v.status, args.status) : undefined))
      .orderBy(desc(v.createdOn))
      .limit(args.limit);
    const code = await moduleCodes(
      tx,
      rows.map((row) => row.moduleId),
    );
    // Текст кандидата сделан из обращений: он обезличивается словами организаций и людей его обращений-источников и
    // именами сотрудников (находка I2), их читает система после транзакции агента.
    return {
      redact: { candidateIds: rows.map((row) => row.candidateId) },
      finish: (redact: Redactor) => {
    const text = (value: string) => redact('all', value);
    const items = rows.map((row) => ({
      id: row.candidateId,
      status: row.status,
      module: code(row.moduleId),
      locale: row.locale,
      source_count: row.sourceCount,
      org_count: row.orgCount,
      source_numbers: row.sourceNumbers.slice(0, 50),
      created_on: row.createdOn.toISOString(),
      updated_on: iso(row.modifiedOn),
      untrusted_text: {
        title: cap(text(row.title), 500),
        problem: cap(text(row.problem), 4000),
        steps: (Array.isArray(row.steps) ? row.steps : []).slice(0, 30).map((step) => cap(text(String(step)), 2000)),
      },
    }));
    return { result: { notice: AGENT_NOTICE, items }, objectRefs: items.map((item) => ({ kind: 'candidate' as const, ref: item.id })) };
      },
    };
  },
});

export const solutionTools = [searchSolutions, getSolution, listCandidates];
