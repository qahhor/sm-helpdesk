import { createHash } from 'node:crypto';
import type { SearchCollection, StemPair } from './types';

// Схемы коллекций Typesense (план W6, решения 1, 7-9; документация 30.2, api/collections, guide/locale, api/stemming).
// Что попадает в индекс: только поля ниже. У обращения нет имени автора, адресов, ИНН и названия организации; в
// переписке нет вложений; решения только из hdk_published; идеи только опубликованные; у организаций и людей нет
// адресов почты и телефонов. Текст лежит в поле своего языка: у поля один locale, стемминг Snowball для ru и en,
// для uz стемминга нет (поле с locale uz принимается, stem для него Typesense отклоняет, проверено на 30.2), поэтому
// узбекским полям подключён свой словарь hub_uz_stems. Поля *_fold держат свёрнутый текст (fold.ts) без locale.

export const UZ_STEMS = 'hub_uz_stems';
/**
 * Отметка словаря корней (независимая проверка, B1; решение 0172): отпечаток пар без учёта порядка. Коллекция получает
 * её в метаданных при создании, по ней видно, с каким словарём она построена. В отметке нет самих слов.
 */
export function stemsMarkOf(pairs: readonly StemPair[]): string {
  const key = pairs
    .map((pair) => `${pair.word}\u0000${pair.root}`)
    .sort()
    .join('\u0001');
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}
export const SYNONYM_SET = 'hub_synonyms';
export const CURATION_SET = 'hub_solutions_curation';

/**
 * Стоп-слова (api/stopwords): вежливые и служебные слова длинных описаний клиентов отбрасываются из запроса, не из
 * индекса. Один набор с locale ru: без locale Typesense 30.2 не применял набор к полю с locale ru, набор с locale ru
 * действует и на поля uz, en и *_fold, а список наборов через запятую 30.2 не принимает (проверено). Список ведёт код.
 */
export const STOPWORDS: Record<'ru' | 'uz' | 'en', string[]> = {
  ru: ['пожалуйста', 'помогите', 'помочь', 'подскажите', 'срочно', 'здравствуйте', 'добрый', 'день', 'спасибо', 'заранее', 'привет'],
  uz: ['iltimos', 'yordam', 'bering', 'salom', 'assalomu', 'alaykum', 'rahmat', 'tezroq', 'илтимос', 'ёрдам', 'беринг', 'салом', 'рахмат'],
  en: ['please', 'help', 'hello', 'hi', 'thanks', 'thank', 'urgent', 'urgently'],
};
export const STOPWORD_SETS = 'hub_stopwords';

export type FieldSpec = {
  name: string;
  type: 'string' | 'string[]' | 'int64' | 'bool';
  optional?: boolean;
  facet?: boolean;
  locale?: 'ru' | 'en' | 'uz';
  stem?: boolean;
  stem_dictionary?: string;
  infix?: boolean;
  index?: boolean;
};

export type CollectionSchema = { fields: FieldSpec[]; synonym_sets?: string[]; curation_sets?: string[] };

/** Поле текста на каждом языке портала: ru и en со стеммингом, uz со словарём. */
function localized(base: string, opts: { uzDictionary: boolean }): FieldSpec[] {
  return [
    { name: `${base}_ru`, type: 'string', optional: true, locale: 'ru', stem: true },
    { name: `${base}_en`, type: 'string', optional: true, locale: 'en', stem: true },
    { name: `${base}_uz`, type: 'string', optional: true, locale: 'uz', ...(opts.uzDictionary ? { stem_dictionary: UZ_STEMS } : {}) },
  ];
}

const version: FieldSpec = { name: 'version', type: 'int64' };
/**
 * Отпечаток индексируемых полей (SHA-256 без version): сверка сравнивает содержимое, а не время изменения строки.
 * Время изменения растёт и от правок вне индекса (статус, назначение, голоса, категория), и сверка считала бы такие
 * документы устаревшими (независимая проверка W6, замечание 1). Поле только хранится, не индексируется.
 */
const contentHash: FieldSpec = { name: 'content_hash', type: 'string', optional: true, index: false };

export const COLLECTION_SCHEMAS: Record<SearchCollection, CollectionSchema> = {
  tickets: {
    fields: [
      { name: 'org_id', type: 'string' },
      // Автор и видимость нужны только фильтру ключа клиента: личное обращение коллеги не занимает место в выдаче
      // (независимая проверка W6, замечание 4). Имени автора нет, только идентификатор.
      { name: 'author_id', type: 'string' },
      { name: 'visibility', type: 'string' },
      { name: 'number', type: 'int64' },
      ...localized('title', { uzDictionary: false }),
      ...localized('description', { uzDictionary: false }),
      { name: 'title_fold', type: 'string', optional: true },
      { name: 'created_on', type: 'int64' },
      version,
      contentHash,
    ],
    synonym_sets: [SYNONYM_SET],
  },
  // Переписка и внутренние заметки: только ключ сотрудника (решение 0070, пункт 3). Идентификатор документа
  // <обращение>_<сообщение>: из него берётся обращение, текст из Typesense не нужен.
  ticket_texts: {
    fields: [
      { name: 'ticket_id', type: 'string', facet: true },
      { name: 'org_id', type: 'string' },
      { name: 'is_internal', type: 'bool' },
      ...localized('body', { uzDictionary: false }),
      version,
      contentHash,
    ],
    synonym_sets: [SYNONYM_SET],
  },
  solutions: {
    fields: [
      { name: 'article_id', type: 'string', facet: true },
      { name: 'locale', type: 'string' },
      { name: 'audience', type: 'string' },
      { name: 'module_ids', type: 'string[]', optional: true },
      ...localized('title', { uzDictionary: true }),
      ...localized('body', { uzDictionary: true }),
      { name: 'title_fold', type: 'string', optional: true, stem_dictionary: UZ_STEMS },
      { name: 'body_fold', type: 'string', optional: true, stem_dictionary: UZ_STEMS },
      version,
      contentHash,
    ],
    synonym_sets: [SYNONYM_SET],
    curation_sets: [CURATION_SET],
  },
  ideas: {
    fields: [
      { name: 'idea_id', type: 'string', facet: true },
      { name: 'locale', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'module_id', type: 'string', optional: true },
      ...localized('title', { uzDictionary: true }),
      ...localized('body', { uzDictionary: true }),
      { name: 'title_fold', type: 'string', optional: true, stem_dictionary: UZ_STEMS },
      { name: 'body_fold', type: 'string', optional: true, stem_dictionary: UZ_STEMS },
      version,
      contentHash,
    ],
    synonym_sets: [SYNONYM_SET],
  },
  orgs: {
    fields: [
      { name: 'name', type: 'string' },
      { name: 'name_fold', type: 'string', optional: true },
      // ИНН и код организации на сервере Smartup ищутся частью (infix): замена ILIKE '%...%' для кодов.
      { name: 'inn', type: 'string', optional: true, infix: true },
      { name: 'external_company_id', type: 'string', optional: true, infix: true },
      { name: 'state', type: 'string' },
      { name: 'kind', type: 'string' },
      version,
      contentHash,
    ],
  },
  people: {
    fields: [
      { name: 'name', type: 'string' },
      { name: 'name_fold', type: 'string', optional: true },
      version,
      contentHash,
    ],
  },
};

/** Предел текста в документе, знаков (решение 1): память Typesense считается по индексируемым полям. */
export const TEXT_LIMITS = { ticketDescription: 1000, ticketText: 2000, solutionBody: 5000, ideaBody: 5000 } as const;

/** Поля текста коллекции на всех языках: для query_by. */
export function localizedFields(base: string): string[] {
  return [`${base}_ru`, `${base}_en`, `${base}_uz`];
}

/** Поле языка текста; язык вне портала идёт в русское поле (больше всего обращений на русском). */
export function localeField(base: string, locale: string): string {
  return `${base}_${locale === 'en' || locale === 'uz' ? locale : 'ru'}`;
}
