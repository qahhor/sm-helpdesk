// Смысловые векторы (ТЗ 11.11 EmbeddingProvider; план M5, задача 9, решения 5 и 6). Модель BGE-M3 даёт 1024
// измерения, колонка hdk_search_documents.embedding того же размера. Реализации: TEI (локальный контейнер) и
// заглушка. Текст в журнал не попадает ни при какой ошибке: в ошибке только причина.

export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingProvider {
  readonly name: 'tei' | 'stub';
  readonly dimensions: number;
  /** Векторы единичной длины, по одному на текст, в том же порядке. timeoutMs: сколько ждать ответа. */
  embed(texts: readonly string[], opts?: { timeoutMs?: number }): Promise<number[][]>;
}

export type EmbeddingFailure = 'timeout' | 'unreachable' | 'invalid_response' | `http_${number}`;

/** Сервис векторов не ответил вовремя или ответил не тем: подсказка работает без смыслового поиска (решение 5). */
export class EmbeddingUnavailableError extends Error {
  readonly reason: EmbeddingFailure;

  constructor(reason: EmbeddingFailure) {
    super(`векторы недоступны: ${reason}`);
    this.name = 'EmbeddingUnavailableError';
    this.reason = reason;
  }
}
