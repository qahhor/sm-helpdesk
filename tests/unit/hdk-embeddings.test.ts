import { expect, test } from 'vitest';
import { cosineDistance, createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { createTeiEmbedder } from '@/modules/hdk/embeddings/tei';
import { EMBEDDING_DIMENSIONS, EmbeddingUnavailableError } from '@/modules/hdk/embeddings/types';

// Смысловые векторы подсказки (ТЗ 11.11 EmbeddingProvider; план M5, задача 9, решения 5 и 6). Заглушка детерминирована
// и различает близкие и далёкие тексты достаточно для проверки порядка подсказки; TEI проверяется подменой fetch:
// доступа к huggingface.co и живого контейнера в среде нет.

const stub = createStubEmbedder();
const one = async (text: string) => (await stub.embed([text]))[0]!;
const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

test('заглушка: 1024 измерения, единичная длина, одинаковый текст даёт одинаковый вектор', async () => {
  const [a, b] = await stub.embed(['Заказ не сохраняется: нет остатка на складе', 'Заказ не сохраняется: нет остатка на складе']);
  expect(stub.dimensions).toBe(EMBEDDING_DIMENSIONS);
  expect(a).toHaveLength(1024);
  expect(norm(a!)).toBeCloseTo(1, 6);
  expect(a).toEqual(b);
  expect(await one('')).toHaveLength(1024);
});

test('заглушка: формы одного слова и перестановка ближе, чем другая тема; регистр и знаки не важны', async () => {
  const base = await one('нет остатка на складе при проведении заказа');
  const near = await one('Остаток на складе: заказ не проводится!');
  const far = await one('как поменять пароль входа в мобильное приложение');
  expect(cosineDistance(base, near)).toBeLessThan(cosineDistance(base, far));
  expect(cosineDistance(base, far)).toBeGreaterThan(0.7);
  expect(cosineDistance(await one('ОСТАТОК'), await one('остаток'))).toBeCloseTo(0, 6);
  // Узбекская латиница с разными апострофами одна и та же.
  expect(cosineDistance(await one('o‘zgartirish'), await one("o'zgartirish"))).toBeCloseTo(0, 6);
});

const vector = (seed: number) => Array.from({ length: 1024 }, (_, i) => ((i * 31 + seed) % 17) / 17);

test('TEI: POST /embed с текстами, нормализацией и обрезкой, ответ проверяется по размеру', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const tei = createTeiEmbedder({
    url: 'http://tei:80',
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return Response.json([vector(1), vector(2)]);
    },
  });
  const result = await tei.embed(['первый', 'второй'], { timeoutMs: 1000 });
  expect(result).toEqual([vector(1), vector(2)]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('http://tei:80/embed');
  expect(calls[0]!.init.method).toBe('POST');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ inputs: ['первый', 'второй'], normalize: true, truncate: true });
  expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json');
});

test('TEI: ответ не того размера, ошибка сервиса и обрыв дают EmbeddingUnavailableError', async () => {
  const wrongSize = createTeiEmbedder({ url: 'http://tei:80', fetch: async () => Response.json([[0.1, 0.2]]) });
  await expect(wrongSize.embed(['x'])).rejects.toMatchObject({ name: 'EmbeddingUnavailableError', reason: 'invalid_response' });
  const wrongCount = createTeiEmbedder({ url: 'http://tei:80', fetch: async () => Response.json([vector(1)]) });
  await expect(wrongCount.embed(['x', 'y'])).rejects.toMatchObject({ reason: 'invalid_response' });
  const down = createTeiEmbedder({ url: 'http://tei:80/', fetch: async () => new Response('model loading', { status: 503 }) });
  await expect(down.embed(['x'])).rejects.toMatchObject({ reason: 'http_503' });
  const refused = createTeiEmbedder({ url: 'http://tei:80', fetch: async () => Promise.reject(new TypeError('fetch failed')) });
  await expect(refused.embed(['x'])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
});

test('TEI: ожидание не дольше заданного (150 мс для подсказки, решение 5)', async () => {
  const slow = createTeiEmbedder({
    url: 'http://tei:80',
    fetch: (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json([vector(1)])), 5000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      }),
  });
  const started = performance.now();
  await expect(slow.embed(['x'], { timeoutMs: 150 })).rejects.toMatchObject({ reason: 'timeout' });
  expect(performance.now() - started).toBeLessThan(1000);
});

test('пустой список текстов не вызывает сервис', async () => {
  let called = false;
  const tei = createTeiEmbedder({ url: 'http://tei:80', fetch: async () => ((called = true), Response.json([])) });
  expect(await tei.embed([])).toEqual([]);
  expect(called).toBe(false);
});
