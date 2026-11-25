import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { articlesOutOfSyncTx, cleanupDeflectionsTx, embeddingText, syncArticleIndexTx, writeEmbeddingTx } from '../core/search-index';
import { EmbeddingUnavailableError, getEmbedder } from '../embeddings';

// Модуль hdk, слой api: задачи фонового процесса для поискового индекса (план M5, задача 9, решения 5, 11, 12).
// Узкий файл: его тянет фоновый процесс, страниц и Next.js в нём нет. В задаче только идентификатор статьи.
//
// kb.index ставит публикация, архив, возврат из архива и смена модуля или аудитории, всегда после фиксации. Строки
// индекса пишутся сразу, вектор после них: если сервис векторов недоступен, полнотекстовый поиск уже работает, а задача
// бросает ошибку, и pg-boss повторяет её с растущей паузой. Пропущенное находит ночная сверка kb.reconcile.

const indexJob = z.strictObject({ articleId: z.uuid() });

/** Сколько ждать вектор документа: задаче спешить некуда, в отличие от подсказки (150 мс). */
export const INDEX_EMBED_TIMEOUT_MS = 15_000;
/** Сколько статей сверка переиндексирует за ночь: остальное догонит следующая ночь. */
const RECONCILE_BATCH = 500;

export type IndexResult = { indexed: number; removed: number; embedded: number };

async function indexArticle(system: SystemActor, articleId: string): Promise<IndexResult> {
  const { indexed, removed, pending } = await withActor(system, (tx) => syncArticleIndexTx(tx, articleId));
  if (pending.length === 0) return { indexed, removed, embedded: 0 };
  let vectors: number[][];
  try {
    vectors = await getEmbedder().embed(pending.map(embeddingText), { timeoutMs: INDEX_EMBED_TIMEOUT_MS });
  } catch (error) {
    // В журнал только причина и статья, без текста (решение 5).
    logEvent('warn', 'kb.index_embedding_unavailable', { articleId, reason: error instanceof EmbeddingUnavailableError ? error.reason : 'error' });
    throw error;
  }
  let embedded = 0;
  await withActor(system, async (tx) => {
    for (const [i, row] of pending.entries()) if (await writeEmbeddingTx(tx, row, vectors[i]!)) embedded++;
  });
  return { indexed, removed, embedded };
}

/** kb.index: строки индекса статьи по её копиям для читателей и векторы к ним. */
export async function runIndexJob(system: SystemActor, data: unknown): Promise<IndexResult> {
  const { articleId } = indexJob.parse(data);
  return indexArticle(system, articleId);
}

/**
 * kb.reconcile, ночью: статьи, индекс которых расходится с копиями для читателей (нет строки, нет вектора, другой
 * текст), и исходы подсказки старше 13 месяцев. Сбой векторов у одной статьи не останавливает остальные.
 */
export async function reconcileSearchIndex(system: SystemActor, now: Date = new Date()): Promise<{ articles: number; failed: number; deflections: number }> {
  const ids = await withActor(system, (tx) => articlesOutOfSyncTx(tx, RECONCILE_BATCH));
  let failed = 0;
  for (const articleId of ids) {
    try {
      await indexArticle(system, articleId);
    } catch {
      failed++;
    }
  }
  const deflections = await withActor(system, (tx) => cleanupDeflectionsTx(tx, now));
  return { articles: ids.length, failed, deflections };
}
