import 'server-only';
import type { StaffActor } from '@/db/with-actor';
import { FOLD_WEIGHT, foldText, mergeRanked, SEARCH_TIMEOUT_MS, searchAs, type SearchSpec } from '@/modules/hdc/api';

// Модуль hdu, слой core: поиск организаций и людей сотрудника через Typesense (план W6, задача 5). Коллекции hub_orgs и
// hub_people видит только ключ сотрудника. Название и имя с опечаткой и в другой письменности, ИНН и код организации
// частью (infix). Адрес почты здесь не ищется: он есть только в таблицах идентичности, поиск по нему в PostgreSQL.
// null: Typesense выключен или не ответил, вызывающий ищет прежним containsText.

const LIMIT = 250;

async function run(actor: StaffActor, searches: { spec: SearchSpec; weight: number }[]): Promise<string[] | null> {
  const res = await searchAs(actor, 'directory', searches.map((s) => s.spec), { timeoutMs: SEARCH_TIMEOUT_MS.directory });
  if (res.kind === 'fallback') return null;
  return mergeRanked(res.results.map((r, i) => ({ hits: r.hits, weight: searches[i]!.weight })), LIMIT);
}

export function directoryOrgIds(actor: StaffActor, text: string): Promise<string[] | null> {
  const folded = foldText(text);
  return run(actor, [
    { spec: { collection: 'orgs', q: text, queryBy: ['name', 'inn', 'external_company_id'], infix: ['off', 'fallback', 'fallback'], prefix: true, perPage: LIMIT }, weight: 1 },
    ...(folded ? [{ spec: { collection: 'orgs', q: folded, queryBy: ['name_fold'], prefix: true, perPage: LIMIT } satisfies SearchSpec, weight: FOLD_WEIGHT }] : []),
  ]);
}

export function directoryPersonIds(actor: StaffActor, text: string): Promise<string[] | null> {
  const folded = foldText(text);
  return run(actor, [
    { spec: { collection: 'people', q: text, queryBy: ['name'], prefix: true, perPage: LIMIT }, weight: 1 },
    ...(folded ? [{ spec: { collection: 'people', q: folded, queryBy: ['name_fold'], prefix: true, perPage: LIMIT } satisfies SearchSpec, weight: FOLD_WEIGHT }] : []),
  ]);
}
