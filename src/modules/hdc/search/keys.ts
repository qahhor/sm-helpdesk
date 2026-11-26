import * as z from 'zod';
import { aliasOf, SEARCH_COLLECTIONS, type SearchCollection } from './types';

// Ключи процессов Typesense (план W6, решение 3; документация 30.2, api/api-keys). Главный ключ (--api-key) есть
// только у службы typesense и у команды hub search:keys. Команда создаёт три ключа:
// - поиска клиента: documents:search на hub_tickets, hub_solutions, hub_ideas (без переписки и справочников);
// - поиска сотрудника: documents:search на все псевдонимы hub_*;
// - записи для фонового процесса и hub: коллекции, документы, псевдонимы, синонимы, курирование, словарь, метрики.
// Ключи поиска только documents:search: от них портал считает ключи с областью. Отзыв ключа поиска сразу гасит все
// ключи с областью от него. Значения ключей печатаются один раз и не попадают ни в журнал, ни в аудит.

export const KEY_DESCRIPTIONS = { client: 'hub:search:client', staff: 'hub:search:staff', write: 'hub:write' } as const;

/** Коллекции, которые видит ключ поиска клиента: псевдонимы, через которые портал ищет. */
export const CLIENT_COLLECTIONS: readonly SearchCollection[] = ['tickets', 'solutions', 'ideas'];

const keyResponse = z.object({ id: z.number().int(), value: z.string().min(16) }).passthrough();
const keyList = z.object({ keys: z.array(z.object({ id: z.number().int(), description: z.string().optional() }).passthrough()) });

export type ProcessKeys = { clientSearch: string; staffSearch: string; write: string };

async function call(url: string, masterKey: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'x-typesense-api-key': masterKey, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Typesense ответил ${res.status} на ${method} ${path.split('?')[0]}`);
  return res.json();
}

/** Ключи портала, созданные раньше: по описанию. */
export async function listProcessKeyIds(url: string, masterKey: string): Promise<number[]> {
  const parsed = keyList.parse(await call(url, masterKey, 'GET', '/keys'));
  const ours = new Set<string>(Object.values(KEY_DESCRIPTIONS));
  return parsed.keys.filter((key) => key.description && ours.has(key.description)).map((key) => key.id);
}

/**
 * Создаёт три ключа процессов. rotate: прежние ключи портала удаляются после создания новых, ключи с областью от
 * прежних ключей поиска перестают действовать сразу.
 */
export async function createProcessKeys(url: string, masterKey: string, opts: { rotate: boolean }): Promise<ProcessKeys & { removed: number }> {
  const previous = opts.rotate ? await listProcessKeyIds(url, masterKey) : [];
  const create = async (description: string, actions: string[], collections: string[]) =>
    keyResponse.parse(await call(url, masterKey, 'POST', '/keys', { description, actions, collections })).value;
  const clientSearch = await create(KEY_DESCRIPTIONS.client, ['documents:search'], CLIENT_COLLECTIONS.map(aliasOf));
  const staffSearch = await create(KEY_DESCRIPTIONS.staff, ['documents:search'], SEARCH_COLLECTIONS.map(aliasOf));
  // Ключ записи видит только объекты портала с именами hub_: коллекции, их версии, псевдонимы, набор синонимов, набор
  // курирования и словарь (проверено на 30.2: условие коллекций действует и на них).
  const write = await create(
    KEY_DESCRIPTIONS.write,
    [
      'collections:*',
      'documents:*',
      'aliases:*',
      'synonym_sets:*',
      'curation_sets:*',
      'stemming/dictionaries:get',
      'stemming/dictionaries:list',
      'stemming/dictionaries/import:create',
      'stemming/dictionaries:delete',
      'metrics.json:list',
      'stats.json:list',
    ],
    ['hub_.*'],
  );
  for (const id of previous) await call(url, masterKey, 'DELETE', `/keys/${id}`);
  return { clientSearch, staffSearch, write, removed: previous.length };
}
