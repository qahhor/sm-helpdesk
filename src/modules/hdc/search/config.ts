import * as z from 'zod';
import { foldText } from './fold';
import type { StemPair, SynonymItem } from './types';

// Настройки поиска, которые ведёт администратор поддержки (решение владельца 0070, пункт 4): синонимы, словарь
// узбекского и курирование решений. Хранятся в hdc_settings под кодами search.*, запись идёт с аудитом и ставит
// строку очереди config (триггер t_hdc_settings_search), задача search.sync отправляет набор в Typesense.

export const SEARCH_SETTING_CODES = { synonyms: 'search.synonyms', stems: 'search.uz_stems', curation: 'search.curation' } as const;

/** Пределы: набор целиком уходит одним запросом и показывается одной страницей настроек. */
export const SEARCH_SETTINGS_LIMITS = { synonymSets: 300, wordsPerSet: 20, stems: 2000, curationRules: 200, wordLength: 60 } as const;

const word = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(SEARCH_SETTINGS_LIMITS.wordLength)
  // Слово или короткая фраза из букв, цифр, пробела, дефиса и апострофа узбекской латиницы.
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ‘’ʻʼ'-]*$/u);

export const synonymSetsSchema = z.object({
  sets: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,40}$/),
        /** Одностороннее: слова из words находят root, но не наоборот. Нет root: все слова равны. */
        root: word.optional(),
        words: z.array(word).min(1).max(SEARCH_SETTINGS_LIMITS.wordsPerSet),
      }),
    )
    .max(SEARCH_SETTINGS_LIMITS.synonymSets),
});
export type SynonymSets = z.infer<typeof synonymSetsSchema>;

export const stemPairsSchema = z.object({
  pairs: z.array(z.object({ word, root: word })).max(SEARCH_SETTINGS_LIMITS.stems),
});
export type StemPairs = z.infer<typeof stemPairsSchema>;

export const curationSchema = z.object({
  rules: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,40}$/),
        query: word,
        match: z.enum(['exact', 'contains']),
        /** Номер решения KB-<номер>. Курирование ставит только опубликованные решения. */
        articleNumber: z.number().int().positive(),
        position: z.number().int().min(1).max(10),
      }),
    )
    .max(SEARCH_SETTINGS_LIMITS.curationRules),
});
export type CurationRules = z.infer<typeof curationSchema>;

/** Набор синонимов для Typesense. Многостороннему нужно не меньше двух слов. */
export function synonymItems(value: SynonymSets): SynonymItem[] {
  return value.sets.flatMap((set) => {
    if (set.root) return [{ id: set.id, root: set.root, synonyms: set.words }];
    return set.words.length >= 2 ? [{ id: set.id, synonyms: set.words }] : [];
  });
}

/**
 * Пары словаря: как записал администратор и свёрнутые (поля *_fold держат свёрнутый текст). Свёртка одного слова и
 * корня может совпасть: такая пара не нужна.
 */
export function stemDictionary(value: StemPairs): StemPair[] {
  const out = new Map<string, string>();
  for (const pair of value.pairs) {
    if (pair.word !== pair.root) out.set(pair.word, pair.root);
    const fw = foldText(pair.word);
    const fr = foldText(pair.root);
    if (fw && fr && fw !== fr && !fw.includes(' ') && !fr.includes(' ')) out.set(fw, fr);
  }
  return [...out.entries()].map(([w, root]) => ({ word: w, root }));
}
