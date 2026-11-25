import 'server-only';
import type { Tx } from '@/db/client';
import type { ClientActor, StaffActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { hybridIdeaSearchTx, type IdeaSearchHit } from '../core/search';
import { embeddingText, type IdeaIndexText, removeIdeaIndexTx, syncIdeaIndexTx, writeEmbeddingTx } from '../core/search-index';
import { EmbeddingUnavailableError, getEmbedder } from '../embeddings';
import { INDEX_EMBED_TIMEOUT_MS } from './search-jobs';
import { localeChain, queryVector } from './suggest';

// Модуль hdk, слой api: идеи в общем поисковом индексе (ТЗ 10.4; план M7, задача 3, решение 23). Индекс и гибридный
// поиск те же, что у подсказки решений: строка на язык идеи вида idea с аудиторией clients, вектор тем же путём
// (заглушка до доступа к huggingface.co). Что опубликовано и какой текст виден клиентам, решает модуль hdi: сюда
// приходят только заголовок и описание, без автора и организации.

export type { IdeaIndexText, IdeaSearchHit };

/** Строки индекса идеи и векторы к ним (задание ideas.index, система). Пустой список текстов снимает идею. */
export async function indexIdeaTexts(system: SystemActor, input: { ideaId: string; moduleId: string | null; texts: readonly IdeaIndexText[] }): Promise<{ indexed: number; removed: number; embedded: number }> {
  const { indexed, removed, pending } = await withActor(system, (tx) => syncIdeaIndexTx(tx, input.ideaId, input.moduleId, input.texts));
  if (pending.length === 0) return { indexed, removed, embedded: 0 };
  let vectors: number[][];
  try {
    vectors = await getEmbedder().embed(pending.map(embeddingText), { timeoutMs: INDEX_EMBED_TIMEOUT_MS });
  } catch (error) {
    // Строки со словами уже записаны: поиск по словам работает, задача повторится за вектором. Без текста в журнале.
    logEvent('warn', 'kb.index_embedding_unavailable', { ideaId: input.ideaId, reason: error instanceof EmbeddingUnavailableError ? error.reason : 'error' });
    throw error;
  }
  let embedded = 0;
  await withActor(system, async (tx) => {
    for (const [i, row] of pending.entries()) if (await writeEmbeddingTx(tx, row, vectors[i]!)) embedded++;
  });
  return { indexed, removed, embedded };
}

/** Снимает идею из индекса в транзакции модератора (отклонение, объединение): клиент не найдёт её сразу. */
export function removeIdeaFromIndexTx(tx: Tx, ideaId: string): Promise<number> {
  return removeIdeaIndexTx(tx, ideaId);
}

/**
 * Похожие идеи от имени актора: все три языка цепочки, одна строка на идею (лучшая по очкам), по убыванию очков.
 * Запрос из одного слова не ищется (как подсказка, FR-SOL-09).
 */
export async function searchIdeaDocuments(actor: ClientActor | StaffActor, input: { text: string; locale: Locale; limit: number }): Promise<IdeaSearchHit[]> {
  const words = input.text.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;
  if (words < 2) return [];
  const vector = await queryVector(input.text);
  const hits = await withActor(actor, (tx) => hybridIdeaSearchTx(tx, { text: input.text, vector, locales: localeChain(input.locale) }));
  const best = new Map<string, IdeaSearchHit>();
  for (const hit of hits) {
    const prev = best.get(hit.ideaId);
    if (!prev || hit.rrf > prev.rrf) best.set(hit.ideaId, hit);
  }
  return [...best.values()].sort((a, b) => b.rrf - a.rrf || a.ideaId.localeCompare(b.ideaId)).slice(0, input.limit);
}
