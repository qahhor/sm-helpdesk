import 'server-only';
import { inArray } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { moduleCodesTx, moduleIdsByCodesTx } from '@/modules/hdr/api';
import { agentProblemOrgsTx, agentTicketPeopleTx } from '@/modules/hdt/api/agent-events';
import { agentRedactionTerms } from '@/modules/hdu/api/orgs';
import { HdaAgentError } from '../../error';
import { candidateSources } from '../../schema';
import { type AgentPerson, type AliasMap, anonymizeForAgent, emptyAliases } from '../anonymize';
import type { Redactor, RedactScope } from '../tool';
import { str } from '../util';
import { agentProblemsView, agentSolutionsView } from '../views';

// Общее для инструментов чтения (веха M8b, задача 5; план M8b, решение 8; независимая проверка M8b, находки I1-I3).
// Слова обезличивания (название и ИНН организаций, имена их участников, приглашённых и гостей, имена людей обращений
// вне участников, имена каналов связи и сотрудников портала) читает система после транзакции агента: агенту они не
// уходят, по ним текст заменяется обозначениями "Клиент 1", "Сотрудник 1", "[организация]". Обозначения устойчивы в
// пределах одного ответа.

const SYSTEM = { type: 'system', job: 'mcp.redact' } as const;
const ORGS_MAX = 200;
const PEOPLE_MAX = 5000;

/** Обезличивание текстов одного ответа по охвату scope. Две транзакции системы одна за другой, без вложения. */
export async function redactorFor(scope: RedactScope): Promise<Redactor> {
  const facts = await withActor(SYSTEM, async (tx) => {
    const candidateIds = [...new Set(scope.candidateIds ?? [])];
    const sources = candidateIds.length
      ? await tx.select({ orgId: candidateSources.orgId, ticketId: candidateSources.ticketId }).from(candidateSources).where(inArray(candidateSources.candidateId, candidateIds))
      : [];
    const problemOrgs = await agentProblemOrgsTx(tx, scope.problemIds ?? []);
    const ticketIds = [...new Set([...(scope.ticketIds ?? []), ...sources.map((s) => s.ticketId)])];
    const userIds = await agentTicketPeopleTx(tx, ticketIds);
    return { orgIds: [...(scope.orgIds ?? []), ...sources.map((s) => s.orgId), ...problemOrgs], userIds };
  });
  const terms = await agentRedactionTerms(SYSTEM, { orgIds: [...new Set(facts.orgIds)].slice(0, ORGS_MAX), userIds: facts.userIds.slice(0, PEOPLE_MAX) });
  const staff: AgentPerson[] = terms.staffNames.map((name) => ({ id: `staff:${name}`, name, kind: 'staff' }));
  const others: AgentPerson[] = terms.otherNames.map((name) => ({ id: `client:other:${name}`, name, kind: 'client' }));
  const membersOf = (orgId: string) => (terms.orgs.get(orgId)?.memberNames ?? []).map((name) => ({ id: `client:${orgId}:${name}`, name, kind: 'client' as const }));
  const all = [...terms.orgs.keys()];
  let aliases: AliasMap = emptyAliases();
  return (orgId, text) => {
    const orgs = orgId === 'all' ? all : orgId ? [orgId] : [];
    const people: AgentPerson[] = [...orgs.flatMap(membersOf), ...others, ...staff];
    const orgTerms = orgs.flatMap((id) => terms.orgs.get(id)?.orgTerms ?? []);
    const result = anonymizeForAgent(text, { people, orgTerms }, aliases);
    aliases = result.aliases;
    return result.text;
  };
}

/** Текст не длиннее max знаков: обрезанный кончается многоточием. */
export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Коды модулей по идентификаторам. */
export async function moduleCodes(tx: Tx, ids: readonly (string | null)[]): Promise<(id: string | null) => string | null> {
  const map = await moduleCodesTx(
    tx,
    ids.filter((id): id is string => id !== null),
  );
  return (id) => (id ? (map.get(id) ?? null) : null);
}

/** Идентификатор модуля по коду; неизвестный код: not_found, как будто объекта нет. */
export async function moduleIdOf(tx: Tx, code: string | undefined): Promise<string | undefined> {
  if (code === undefined) return undefined;
  const id = (await moduleIdsByCodesTx(tx, [code])).get(code);
  if (!id) throw new HdaAgentError('not_found');
  return id;
}

/** Номера известных проблем и решений по идентификаторам: только видимые агенту (у токена запуска пусто). */
export async function numbersOf(tx: Tx, input: { problemIds: readonly (string | null)[]; solutionIds: readonly (string | null)[] }) {
  const problemIds = [...new Set(input.problemIds.filter((id): id is string => id !== null))];
  const solutionIds = [...new Set(input.solutionIds.filter((id): id is string => id !== null))];
  const problems = problemIds.length
    ? await tx.select({ id: agentProblemsView.problemId, number: agentProblemsView.number }).from(agentProblemsView).where(inArray(agentProblemsView.problemId, problemIds))
    : [];
  const solutions = solutionIds.length
    ? await tx.select({ id: agentSolutionsView.articleId, number: agentSolutionsView.number }).from(agentSolutionsView).where(inArray(agentSolutionsView.articleId, solutionIds))
    : [];
  const p = new Map(problems.map((row) => [row.id, row.number]));
  const s = new Map(solutions.map((row) => [row.id, row.number]));
  return { problem: (id: string | null) => (id ? (p.get(id) ?? null) : null), solution: (id: string | null) => (id ? (s.get(id) ?? null) : null) };
}

export const moduleCode = str(80).regex(/^[a-z0-9_.-]+$/);
export const signature = z.string().regex(/^[0-9a-f]{32}$/);
