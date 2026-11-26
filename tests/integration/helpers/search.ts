import { createProcessKeys, type ProcessKeys } from '@/modules/hdc/search/keys';
import { createTypesenseReader, createTypesenseWriter } from '@/modules/hdc/search/typesense';
import { createBreaker } from '@/modules/hdc/search/breaker';
import type { SearchIndexWriter, SearchReader } from '@/modules/hdc/search/types';

// Настоящий Typesense для договорных тестов (план W6): контейнер поднимает globalSetup (TYPESENSE_TEST_URL). Нет
// контейнера: тесты пропускаются с причиной TYPESENSE_TEST_SKIP, а не делают вид, что прошли.

export const typesenseUrl = process.env.TYPESENSE_TEST_URL ?? '';
export const typesenseMasterKey = process.env.TYPESENSE_TEST_MASTER_KEY ?? '';
export const typesenseSkip = typesenseUrl ? null : (process.env.TYPESENSE_TEST_SKIP ?? 'TYPESENSE_TEST_URL не задан');

/** Запрос главным ключом: подготовка и уборка между тестами. */
export async function master(method: string, path: string, body?: unknown, ndjson?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${typesenseUrl}${path}`, {
    method,
    headers: { 'x-typesense-api-key': typesenseMasterKey, 'content-type': 'application/json' },
    ...(ndjson !== undefined ? { body: ndjson } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Ответ не JSON (импорт отдаёт строки JSON): остаётся текстом.
  }
  return { status: res.status, body: parsed };
}

/** Удаляет псевдонимы, коллекции и ключи: каждый тест начинает с пустого сервера. */
export async function resetTypesense(): Promise<void> {
  const aliases = (await master('GET', '/aliases')).body as { aliases: { name: string }[] };
  for (const alias of aliases.aliases ?? []) await master('DELETE', `/aliases/${alias.name}`);
  const collections = (await master('GET', '/collections')).body as { name: string }[];
  for (const c of collections ?? []) await master('DELETE', `/collections/${c.name}`);
  const keys = (await master('GET', '/keys')).body as { keys: { id: number }[] };
  for (const key of keys.keys ?? []) await master('DELETE', `/keys/${key.id}`);
}

export type LiveSearch = { keys: ProcessKeys; writer: SearchIndexWriter; reader: SearchReader };

/** Ключи процессов, коллекции и клиенты на свежем сервере. */
export async function liveSearch(): Promise<LiveSearch> {
  await resetTypesense();
  const keys = await createProcessKeys(typesenseUrl, typesenseMasterKey, { rotate: false });
  const writer = createTypesenseWriter({ url: typesenseUrl, key: keys.write });
  await writer.ensureCollections();
  const reader = createTypesenseReader({ url: typesenseUrl, breaker: createBreaker() });
  return { keys, writer, reader };
}
