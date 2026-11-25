import * as z from 'zod';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider, EmbeddingUnavailableError } from './types';

// Векторы от локального TEI (Text Embeddings Inference) с моделью BGE-M3 (ТЗ 13.3; план M5, решения 5 и 6).
// Договор: POST {EMBEDDINGS_URL}/embed с телом {"inputs": [...], "normalize": true, "truncate": true}, ответ массив
// векторов в порядке текстов. Адрес внутренний (проверяет src/env.ts), поэтому вызов идёт обычным fetch, мимо защиты
// исходящих запросов: та запрещает именно внутренние адреса. Договор проверен только подменой fetch: живого
// контейнера и весов модели в среде разработки нет (huggingface.co недоступен), см. docs/decisions/0053.

/** Ожидание без заданного: задание индекса может ждать дольше, чем подсказка. */
const DEFAULT_TIMEOUT_MS = 10_000;

const response = z.array(z.array(z.number()).length(EMBEDDING_DIMENSIONS));

export function createTeiEmbedder(cfg: { url: string; fetch?: typeof fetch }): EmbeddingProvider {
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/embed`;
  const send = cfg.fetch ?? fetch;
  return {
    name: 'tei',
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, opts = {}) {
      if (texts.length === 0) return [];
      const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let res: Response;
      try {
        res = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputs: texts, normalize: true, truncate: true }),
          signal,
        });
      } catch {
        throw new EmbeddingUnavailableError(signal.aborted ? 'timeout' : 'unreachable');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new EmbeddingUnavailableError(`http_${res.status}`);
      }
      let parsed: z.infer<typeof response>;
      try {
        parsed = response.parse(await res.json());
      } catch {
        throw new EmbeddingUnavailableError(signal.aborted ? 'timeout' : 'invalid_response');
      }
      if (parsed.length !== texts.length) throw new EmbeddingUnavailableError('invalid_response');
      return parsed;
    },
  };
}
