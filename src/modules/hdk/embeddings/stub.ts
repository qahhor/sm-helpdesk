import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './types';

// Заглушка векторов (план M5, решение 6): детерминированный вектор по словам и буквосочетаниям. Каждое слово и его
// тройки букв (с границами слова) попадают хешем в одно из 1024 измерений со знаком, вектор нормируется. Формы одного
// слова ("остаток", "остатка") делят большую часть троек и оказываются близко, другая тема далеко. Этого хватает,
// чтобы проверить порядок работы гибридного поиска, но не качество смыслового поиска: смысла заглушка не знает.

/** FNV-1a, 32 бита: быстрый и одинаковый на всех машинах. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Слова текста: строчные буквы и цифры; апострофы узбекской латиницы убираются, как в индексе (миграция 0074). */
export function stubWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[‘’ʻʼ`']/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function add(vector: Float64Array, feature: string, weight: number): void {
  const h = hash(feature);
  vector[h % EMBEDDING_DIMENSIONS]! += (h & 0x80000000) === 0 ? weight : -weight;
}

export function stubVector(text: string): number[] {
  const vector = new Float64Array(EMBEDDING_DIMENSIONS);
  for (const word of stubWords(text)) {
    add(vector, `w:${word}`, 1);
    const padded = `#${word}#`;
    for (let i = 0; i + 3 <= padded.length; i++) add(vector, `t:${padded.slice(i, i + 3)}`, 0.5);
  }
  let length = 0;
  for (const x of vector) length += x * x;
  length = Math.sqrt(length);
  // Пустой текст: постоянный единичный вектор, чтобы у колонки не было нулевого вектора (косинус не определён).
  if (length === 0) {
    vector[0] = 1;
    length = 1;
  }
  return Array.from(vector, (x) => x / length);
}

/** Косинусное расстояние, как оператор <=> pgvector: 0 одинаковые, 1 не связаны, 2 противоположны. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createStubEmbedder(): EmbeddingProvider {
  return {
    name: 'stub',
    dimensions: EMBEDDING_DIMENSIONS,
    embed: async (texts) => texts.map(stubVector),
  };
}
