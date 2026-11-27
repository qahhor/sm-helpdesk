import 'server-only';
import { inArray } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { moduleCodesTx, moduleIdsByCodesTx } from '@/modules/hdr/api';
import { agentRedactionTerms } from '@/modules/hdu/api/orgs';
import { HdaAgentError } from '../../error';
import { type AgentPerson, type AliasMap, anonymizeForAgent, emptyAliases } from '../anonymize';
import { str } from '../util';
import { agentProblemsView, agentSolutionsView } from '../views';

// Общее для инструментов чтения (веха M8b, задача 5; план M8b, решение 8). Слова обезличивания (название и ИНН
// организации, имена её участников и сотрудников портала) читает система: агенту они не уходят, по ним текст
// заменяется обозначениями "Клиент 1", "Сотрудник 1", "[организация]". Обозначения устойчивы в пределах одного ответа.

const SYSTEM = { type: 'system', job: 'mcp.redact' } as const;

export type Redactor = (orgId: string | null, text: string) => string;

/** Обезличивание текстов одного ответа: слова организаций orgIds и сотрудников, общая карта обозначений. */
export async function redactorFor(orgIds: readonly string[]): Promise<Redactor> {
  const terms = await agentRedactionTerms(SYSTEM, orgIds);
  const staff: AgentPerson[] = terms.staffNames.map((name) => ({ id: `staff:${name}`, name, kind: 'staff' }));
  let aliases: AliasMap = emptyAliases();
  return (orgId, text) => {
    const org = orgId ? terms.orgs.get(orgId) : undefined;
    const people: AgentPerson[] = [...(org?.memberNames ?? []).map((name) => ({ id: `client:${orgId}:${name}`, name, kind: 'client' as const })), ...staff];
    const result = anonymizeForAgent(text, { people, orgTerms: org?.orgTerms ?? [] }, aliases);
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
