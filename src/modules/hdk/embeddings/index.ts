import 'server-only';
import { env } from '@/env';
import { createStubEmbedder } from './stub';
import { createTeiEmbedder } from './tei';
import type { EmbeddingProvider } from './types';

// Выбор реализации векторов по окружению (план M5, решение 6): EMBEDDINGS=tei и EMBEDDINGS_URL, иначе заглушка.

let override: EmbeddingProvider | null = null;
let real: EmbeddingProvider | undefined;

export function getEmbedder(): EmbeddingProvider {
  if (override) return override;
  return (real ??= env.EMBEDDINGS === 'tei' && env.EMBEDDINGS_URL ? createTeiEmbedder({ url: env.EMBEDDINGS_URL }) : createStubEmbedder());
}

/** Тесты подменяют реализацию (null возвращает настоящую). */
export function setEmbedderForTests(provider: EmbeddingProvider | null): void {
  override = provider;
}

export { EMBEDDING_DIMENSIONS, type EmbeddingProvider, EmbeddingUnavailableError } from './types';
