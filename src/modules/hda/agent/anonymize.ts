import { scanText } from '@/modules/hdc/pref';
import { findInText } from '@/modules/hdk/api/text-checks';
import { maskObfuscatedContacts, orgNameTerms } from '../util';

// Обезличивание текста для AI-сотрудника (веха M8b, задача 2; FR-AGT-06, FR-AGT-15, T27; план M8b, решение 8).
// Чистые функции без базы и сети. Текст клиентов и сотрудников уходит агенту только после этой функции: почта,
// телефоны, ИНН, ПИНФЛ и длинные числа, сервер клиента Smartup, имена людей организации обращения и сотрудников,
// название и ИНН организации заменяются метками, невидимые знаки удаляются. Имена получают условные обозначения
// "Клиент 1", "Сотрудник 1", устойчивые в пределах одного ответа инструмента (общий AliasMap).
//
// Правила с запасом: лишняя метка стоит агенту слова, пропущенный телефон клиента уходит внешней модели агента.

export const AGENT_LABELS = {
  email: '[email]',
  phone: '[телефон]',
  number: '[номер]',
  contact: '[контакт]',
  server: '[сервер]',
  org: '[организация]',
  client: 'Клиент',
  staff: 'Сотрудник',
} as const;

export type AgentPerson = { id: string; name: string; kind: 'client' | 'staff' };
export type AgentKnown = { people: readonly AgentPerson[]; orgTerms: readonly string[] };
/** Обозначения людей в пределах одного ответа: идентификатор человека, его обозначение и счётчики по видам. */
export type AliasMap = { readonly byId: Readonly<Record<string, string>>; readonly counts: Readonly<Record<AgentPerson['kind'], number>> };

export function emptyAliases(): AliasMap {
  return { byId: {}, counts: { client: 0, staff: 0 } };
}

/** Обозначение человека: прежнее из карты или следующее по виду. Карта не меняется, возвращается новая. */
export function aliasFor(aliases: AliasMap, id: string, kind: AgentPerson['kind']): { alias: string; aliases: AliasMap } {
  const known = aliases.byId[id];
  if (known) return { alias: known, aliases };
  const number = aliases.counts[kind] + 1;
  const alias = `${AGENT_LABELS[kind]} ${number}`;
  return { alias, aliases: { byId: { ...aliases.byId, [id]: alias }, counts: { ...aliases.counts, [kind]: number } } };
}

const HIT_LABEL = { email: AGENT_LABELS.email, phone: AGENT_LABELS.phone, inn: AGENT_LABELS.number, pinfl: AGENT_LABELS.number, digits: AGENT_LABELS.number, server: AGENT_LABELS.server } as const;
/** Слова имени короче этого заменяются только целым словом, длиннее ловят и окончания (падежи, узбекские аффиксы). */
const STEM_MIN = 4;
const NAME_WORD_MIN = 3;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Слово или фраза целиком, без учёта регистра; stem: с окончанием до 6 букв ("Каримову", "Rashidovaning"). */
function termPattern(term: string, stem: boolean): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}${stem ? '\\p{L}{0,6}' : ''}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Основа кириллического слова без конечных гласных: "Ромашка" ловит "Ромашке" (как orgNameTerms). */
function stemOf(word: string): string {
  const stem = /^[\p{Script=Cyrillic}-]+$/u.test(word) ? word.replace(/[аеёиоуыэюяьй]+$/iu, '') : word;
  return stem.length >= STEM_MIN ? stem : word;
}

/** Что искать для человека: полное имя и каждое его слово от трёх букв. */
function personTerms(person: AgentPerson): { term: string; stem: boolean }[] {
  const full = person.name.replace(/\s+/gu, ' ').trim();
  if (full.length < NAME_WORD_MIN) return [];
  const words = (full.match(/[\p{L}ʻʼ'-]+/gu) ?? []).filter((word) => word.length >= NAME_WORD_MIN);
  const terms = [{ term: full, stem: true }, ...words.map((word) => ({ term: word.length >= STEM_MIN ? stemOf(word) : word, stem: word.length >= STEM_MIN }))];
  return terms.filter((t, i) => terms.findIndex((o) => o.term.toLowerCase() === t.term.toLowerCase()) === i);
}

/**
 * Обезличенный текст и обновлённая карта обозначений. Порядок: невидимые знаки; ИНН организации из orgTerms; почта,
 * телефоны, номера и сервер (правила проверки решений, findInText); имена людей; название организации.
 */
export function anonymizeForAgent(raw: string, known: AgentKnown, aliases: AliasMap = emptyAliases()): { text: string; aliases: AliasMap } {
  let text = scanText(raw);
  const digitTerms = known.orgTerms.map((term) => term.trim()).filter((term) => /^\p{Nd}+$/u.test(term) && term.length >= 5);
  for (const term of digitTerms) text = text.replace(termPattern(term, false), AGENT_LABELS.org);

  // Контакты в обход правил (волна 7, S-M5): почта словами, имена и ссылки мессенджеров, цифры через пробел.
  text = maskObfuscatedContacts(text, AGENT_LABELS);

  const hits = findInText(text)
    .filter((hit): hit is typeof hit & { kind: keyof typeof HIT_LABEL } => hit.kind in HIT_LABEL)
    .sort((a, b) => b.text.length - a.text.length);
  for (const hit of hits) text = text.split(hit.text).join(HIT_LABEL[hit.kind]);

  // Имена: сначала все вхождения (длинные раньше, без пересечений), затем обозначения по порядку появления в тексте.
  let map = aliases;
  const terms = known.people
    .flatMap((person) => personTerms(person).map((term) => ({ ...term, person })))
    .sort((a, b) => b.term.length - a.term.length);
  const spans: { start: number; end: number; person: AgentPerson }[] = [];
  for (const { term, stem, person } of terms)
    for (const match of text.matchAll(termPattern(term, stem))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!spans.some((span) => start < span.end && end > span.start)) spans.push({ start, end, person });
    }
  spans.sort((a, b) => a.start - b.start);
  let named = '';
  let at = 0;
  for (const span of spans) {
    const next = aliasFor(map, span.person.id, span.person.kind);
    map = next.aliases;
    named += text.slice(at, span.start) + next.alias;
    at = span.end;
  }
  text = named + text.slice(at);

  const orgTerms = known.orgTerms
    .filter((term) => !digitTerms.includes(term.trim()))
    .flatMap((term) => [{ term: term.trim(), stem: false }, ...orgNameTerms(term).map((word) => ({ term: word, stem: true }))])
    .filter((t) => t.term.length >= 2)
    .sort((a, b) => b.term.length - a.term.length);
  for (const { term, stem } of orgTerms) text = text.replace(termPattern(term, stem), AGENT_LABELS.org);

  return { text, aliases: map };
}

/** Короткая выдержка для похожих обращений других организаций (FR-AGT-15): до max знаков по границе слова. */
export function agentExcerpt(text: string, max = 300): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
