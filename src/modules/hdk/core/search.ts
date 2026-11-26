import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { SEARCH_LIST_LIMIT, SEMANTIC_MAX_DISTANCE, TRIGRAM_MIN_SIMILARITY } from '../pref';
import type { KbAudience, SearchKind } from '../pref';

// Модуль hdk, слой core: гибридный поиск решений (ТЗ 11.6, FR-SOL-08; план M5, задача 10, решение 17). Три списка:
// полнотекстовый (слова запроса по конфигурации языка документа, любое из слов), триграммы по заголовку и смысловой
// (косинусное расстояние вектора запроса меньше порога). Каждый список даёт не больше 20 мест, документ получает очки
// 1/(60 + место) за каждый список (RRF). Запрос идёт в транзакции актора: клиенту политика RLS отдаёт только строки
// с аудиторией clients, копию для читателей тоже. Отбор по уверенности, прибавка за модуль и не больше трёх решений
// делает слой api (rankHits). Обращения в этом запросе не участвуют вовсе: время ответа от них не зависит.

export type SearchHit = {
  articleId: string;
  locale: Locale;
  moduleId: string | null;
  audience: KbAudience;
  number: number;
  slug: string;
  title: string;
  /** Сумма 1/(60 + место) по спискам. */
  rrf: number;
  /** В скольких списках из трёх нашёлся документ. */
  lists: number;
  /** Все слова запроса есть в документе (их не меньше двух). */
  allWords: boolean;
  /** Косинусное расстояние до вектора запроса, если документ попал в смысловой список. */
  distance: number | null;
};

export type SearchQuery = {
  text: string;
  /** Вектор запроса; null: сервис векторов недоступен, смыслового списка нет (решение 5). */
  vector: readonly number[] | null;
  locales: readonly Locale[];
  audiences: readonly KbAudience[];
};

/**
 * Общая часть гибридного запроса 11.6 для одного вида документов индекса: CTE q, docs, fts, trg, vec. Решения и
 * похожие идеи (план M7, решение 23) ищутся одним и тем же запросом; различается только итоговая выборка.
 */
function hybridCte(query: SearchQuery, kind: SearchKind) {
  const vector = query.vector ? `[${query.vector.join(',')}]` : null;
  // Триграммы: более короткая из двух строк (запрос или заголовок) ищется как часть более длинной (word_similarity).
  // Конфигурации языков записаны прямо: так же, как app.hdk_text_config у триггера миграции 0074.
  return sql`
    with q as (
      select
        nullif(replace(plainto_tsquery('pg_catalog.russian', ${query.text})::text, ' & ', ' | '), '')::tsquery as ru_any,
        nullif(replace(plainto_tsquery('pg_catalog.english', ${query.text})::text, ' & ', ' | '), '')::tsquery as en_any,
        nullif(replace(plainto_tsquery('pg_catalog.simple', app.hdk_search_text('uz', ${query.text}))::text, ' & ', ' | '), '')::tsquery as uz_any,
        plainto_tsquery('pg_catalog.russian', ${query.text}) as ru_all,
        plainto_tsquery('pg_catalog.english', ${query.text}) as en_all,
        plainto_tsquery('pg_catalog.simple', app.hdk_search_text('uz', ${query.text})) as uz_all
    ),
    docs as (
      select d.search_document_id as id, d.ref_id, d.locale, d.module_id, d.audience, d.published_id, d.title, d.tsv, d.embedding,
             case d.locale when 'ru' then q.ru_any when 'en' then q.en_any else q.uz_any end as any_words,
             case d.locale when 'ru' then q.ru_all when 'en' then q.en_all else q.uz_all end as all_words
        from hdk_search_documents d, q
       where d.kind = ${kind} and d.audience = any(${sql.param(query.audiences)}::text[]) and d.locale = any(${sql.param(query.locales)}::text[])
    ),
    fts as (
      select id, row_number() over (order by ts_rank(tsv, any_words) desc, id) as r,
             numnode(all_words) >= 3 and tsv @@ all_words as every_word
        from docs
       where any_words is not null and tsv @@ any_words
       order by r
       limit ${SEARCH_LIST_LIMIT}
    ),
    trg as (
      select id, row_number() over (order by sim desc, id) as r
        from (select id,
                     case when char_length(title) >= ${query.text.length} then word_similarity(${query.text}, title) else word_similarity(title, ${query.text}) end as sim
                from docs) s
       where sim >= ${TRIGRAM_MIN_SIMILARITY}
       order by r
       limit ${SEARCH_LIST_LIMIT}
    ),
    vec as (
      select id, row_number() over (order by dist, id) as r, dist
        from (select id, embedding <=> ${vector}::vector as dist from docs where ${vector}::text is not null and embedding is not null) s
       where dist < ${SEMANTIC_MAX_DISTANCE}
       order by r
       limit ${SEARCH_LIST_LIMIT}
    )`;
}

/** Очки и признаки уверенности документа по трём спискам (RRF). */
const scoreColumns = sql`
           (coalesce(1.0 / (60 + fts.r), 0) + coalesce(1.0 / (60 + trg.r), 0) + coalesce(1.0 / (60 + vec.r), 0))::float8 as rrf,
           ((fts.id is not null)::int + (trg.id is not null)::int + (vec.id is not null)::int) as lists,
           coalesce(fts.every_word, false) as all_words,
           vec.dist::float8 as distance`;

const scoreJoins = sql`
      left join fts on fts.id = d.id
      left join trg on trg.id = d.id
      left join vec on vec.id = d.id
     where fts.id is not null or trg.id is not null or vec.id is not null`;

export async function hybridSearchTx(tx: Tx, query: SearchQuery): Promise<SearchHit[]> {
  const result = await tx.execute<{
    article_id: string;
    locale: Locale;
    module_id: string | null;
    audience: KbAudience;
    article_number: string;
    slug: string;
    title: string;
    rrf: number;
    lists: number;
    all_words: boolean;
    distance: number | null;
  }>(sql`${hybridCte(query, 'article')}
    select d.ref_id as article_id, d.locale, d.module_id, d.audience, p.article_number, p.slug, p.title, ${scoreColumns}
      from docs d
      join hdk_published p on p.published_id = d.published_id
      ${scoreJoins}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    locale: row.locale,
    moduleId: row.module_id,
    audience: row.audience,
    number: Number(row.article_number),
    slug: row.slug,
    title: row.title,
    rrf: Number(row.rrf),
    lists: Number(row.lists),
    allWords: row.all_words,
    distance: row.distance === null ? null : Number(row.distance),
  }));
}

/** Документ идеи в выдаче гибридного поиска: идентификатор идеи, язык строки и очки. Текст и счётчики даёт модуль hdi. */
export type IdeaSearchHit = { ideaId: string; locale: Locale; rrf: number; lists: number; allWords: boolean; distance: number | null };

/** Похожие идеи (план M7, решение 23): тот же запрос 11.6 по строкам вида idea, только аудитория clients. */
export async function hybridIdeaSearchTx(tx: Tx, query: Omit<SearchQuery, 'audiences'>): Promise<IdeaSearchHit[]> {
  const result = await tx.execute<{ ref_id: string; locale: Locale; rrf: number; lists: number; all_words: boolean; distance: number | null }>(sql`${hybridCte(
    { ...query, audiences: ['clients'] },
    'idea',
  )}
    select d.ref_id, d.locale, ${scoreColumns}
      from docs d
      ${scoreJoins}`);
  return result.rows.map((row) => ({
    ideaId: row.ref_id,
    locale: row.locale,
    rrf: Number(row.rrf),
    lists: Number(row.lists),
    allWords: row.all_words,
    distance: row.distance === null ? null : Number(row.distance),
  }));
}

/** Опубликованная копия решения на одном из языков: для точного совпадения сигнатуры (решение 17). */
export async function publishedForArticleTx(tx: Tx, articleId: string, locales: readonly Locale[], audiences: readonly KbAudience[]) {
  const result = await tx.execute<{ locale: Locale; module_id: string | null; audience: KbAudience; article_number: string; slug: string; title: string }>(sql`
    select p.locale, p.module_ids[1] as module_id, p.audience, p.article_number, p.slug, p.title
      from hdk_published p
     where p.article_id = ${articleId}::uuid and p.audience = any(${sql.param(audiences)}::text[]) and p.locale = any(${sql.param(locales)}::text[])
     order by array_position(${sql.param(locales)}::text[], p.locale)
     limit 1`);
  const row = result.rows[0];
  return row ? { articleId, locale: row.locale, moduleId: row.module_id, audience: row.audience, number: Number(row.article_number), slug: row.slug, title: row.title } : null;
}
