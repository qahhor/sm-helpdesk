import { stripInvisible } from '@/modules/hdc/pref';
import { normalizeApostrophes } from './language';

// Модуль hda: обязательные темы и просьба позвать человека (FR-AI-06, UX-B-07; план M5b, задача 2, решение 17). Код
// ищет их сам, по спискам слов на языках портала; совпадение ведёт к передаче сотруднику, что бы ни ответила модель.
//
// Текст и слова списков приводятся к одному "скелету": NFKC (полноширинные буквы), без невидимых знаков, строчными,
// апострофы ʻ ʼ ‘ ’ к прямому, буквы-двойники других письменностей (греческие и прочие) к латинице, латинские буквы-двойники внутри кириллического слова к кириллице, затем кириллица
// (русская и узбекская) латиницей по одной таблице. Так "Тўлов" и "To'lov", "oплaтa" и "оплата" дают одно и то же.
// Разрядка ("о п л а т а", "о.п.л.а.т.а") склеивается. Против обходов текст ищется ещё в двух скелетах (S-M4): без
// знаков разметки внутри слова, с цифрами-двойниками буквами и со смешанным словом целиком в одной письменности. Слова списков ищутся как начало слова или подстрока: списки
// составлены из основ и сочетаний, чтобы не ловить обычные вопросы о работе программы.

/** Темы обязательной передачи FR-AI-06: расчёты и оплата, договор, жалоба, удаление или массовое изменение данных, доступы и права, безопасность, юридические вопросы. */
export const RESTRICTED_TOPICS = ['payments', 'contract', 'complaint', 'data_change', 'access', 'security', 'legal'] as const;
export type RestrictedTopic = (typeof RESTRICTED_TOPICS)[number];
export type TopicWords = { ru: string[]; uz: string[]; en: string[] };
export type TopicLists = Record<RestrictedTopic, TopicWords>;

/** Начальные списки (решение 17). Узбекский латиницей: кириллица находится тем же скелетом. Правит admin в настройках AI. */
export const RESTRICTED_TOPICS_DEFAULT: TopicLists = {
  payments: {
    ru: [
      'прошла оплат', 'оплата подписк', 'оплатили', 'списали деньг', 'деньги списал', 'списание денег', 'верн деньг', 'деньги верн', 'возврат денег', 'возврат средств',
      'списал оплат', 'списали дважды', 'дважды списал', 'счёт на оплату', 'тариф', 'стоимость лицензи', 'продление лицензи',
    ],
    uz: ["to'lov o'tma", "obuna to'lov", 'pul yechil', 'pulni qaytar', 'pul qaytar', 'tarif', 'litsenziya narx', "litsenziya to'lov"],
    en: ['payment fail', 'charged', 'refund', 'billing', 'subscription fee', 'license fee'],
  },
  contract: {
    ru: ['договор', 'расторг'],
    uz: ['shartnoma'],
    en: ['contract', 'terminate the agreement'],
  },
  complaint: {
    ru: ['жалоб', 'претензи'],
    uz: ['shikoyat', "e'tiroz"],
    en: ['complaint', 'complain'],
  },
  data_change: {
    ru: ['удалите все', 'удалить все', 'удалите всё', 'удалить всё', 'массово измен', 'массовое измен', 'массово удал', 'очистите баз', 'очистить баз', 'удалите баз'],
    uz: ["o'chirib tashla", "hammasini o'chir", "ommaviy o'zgartir", "ommaviy o'chir", 'bazani tozala'],
    en: ['delete all', 'remove all', 'mass update', 'bulk delete', 'bulk update', 'wipe the'],
  },
  access: {
    ru: ['права администратор', 'дайте права', 'дайте доступ', 'выдайте доступ', 'предоставьте доступ', 'доступ к', 'сбросьте пароль', 'смените пароль'],
    uz: ['administrator huquq', 'huquq bering', 'huquqini bering', 'ruxsat bering', 'kirish huquq', 'parolni almashtir', 'parolni tikla'],
    en: ['admin access', 'admin rights', 'grant access', 'give me access', 'access rights', 'reset password', 'reset my password'],
  },
  security: {
    ru: ['взлом', 'утечк', 'мошенни', 'вирус', 'фишинг', 'украли пароль', 'кто-то зашёл', 'кто-то зашел', 'кто-то вошёл', 'кто-то вошел', 'кто-то залез', 'без спроса'],
    uz: ['buzishdi', 'buzib kir', 'oshkor', 'firibgar', 'virus', 'xakker'],
    en: ['hacked', 'breach', 'leak', 'phishing', 'fraud', 'stolen password'],
  },
  legal: {
    ru: ['в суд', 'судебн', 'юрист', 'адвокат', 'прокуратур', 'исковое', 'подадим иск', 'подать иск'],
    uz: ['sudga', 'sud qaror', 'yurist', 'advokat', 'prokuratura'],
    en: ['lawyer', 'lawsuit', 'legal action', 'court', 'attorney'],
  },
};

/** Сочетания "глагол + к кому": каждое с каждым. */
const pairs = (verbs: readonly string[], whom: readonly string[]) => verbs.flatMap((v) => whom.map((w) => `${v} ${w}`));

/**
 * Просьба позвать человека (решение 17): списком в коде, администратор его не правит. "Менеджер" и "специалист" только в
 * сочетании с просьбой (позовите, поговорить с, нужен): отдельно это обычные роли в Smartup ("менеджер по продажам").
 */
export const ASKS_HUMAN: TopicWords = {
  ru: [
    'позовите оператор', 'позовите человек', 'позовите сотрудник', 'нужен человек', 'нужен оператор', 'нужен сотрудник', 'нужен живой', 'жив человек', 'поговорить с человек', 'поговорить с сотрудник', 'поговорить с оператор', 'свяжите с оператор', 'свяжите с сотрудник', 'соедините с оператор', 'соедините с сотрудник', 'оператор',
    ...pairs(['позов', 'позвать', 'поговор с', 'свяж с', 'связаться с', 'соедин с', 'переключ на', 'нужен', 'хочу к'], ['менеджер', 'специалист']),
    'а не бот', 'не с ботом', 'а не робот',
  ],
  uz: [
    'inson bilan', 'odam kerak', 'jonli odam', 'xodim bilan', 'xodimga ulang', 'operator',
    ...pairs(['menejer', 'menedjer', 'mutaxassis'], ['bilan', 'kerak']),
    'menejerni chaqir', 'menedjerni chaqir', 'mutaxassisni chaqir', 'menejerga ulang', 'mutaxassisga ulang', 'bot emas', 'botmas',
  ],
  en: [
    'human', 'real person', 'talk to a person', 'talk to someone', 'speak to a person', 'live agent', 'support agent', 'operator',
    ...pairs(['talk to', 'speak to', 'speak with', 'talk with', 'connect me to', 'connect me with', 'transfer me to'], ['your manager', 'a manager', 'the manager', 'manager', 'a specialist', 'specialist', 'supervisor']),
    'not a bot', 'not the bot', 'not a robot',
  ],
};

const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h', і: 'i', ї: 'i', є: 'e',
};
/** Латинские буквы, похожие на кириллические, но дающие другую букву скелета. */
const LATIN_LOOKALIKE: Readonly<Record<string, string>> = { p: 'р', c: 'с', y: 'у', h: 'н', b: 'в', k: 'к', m: 'м', t: 'т', x: 'х', a: 'а', o: 'о', e: 'е' };
/**
 * Двойники других письменностей (находка I6 независимой проверки): греческие, армянские и редкие кириллические и
 * латинские буквы, похожие на латинские, сводятся к латинской букве до разбора слова. Внутри кириллического слова она
 * затем становится кириллической, как обычный латинский двойник. Таблица в коде, без внешних библиотек.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ζ: 'z', ϲ: 'c', ϳ: 'j', ς: 'c',
  օ: 'o', ս: 'u', հ: 'h', ո: 'n', ց: 'g',
  ѕ: 's', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l',
  ı: 'i', ɑ: 'a', ɡ: 'g', ɩ: 'i', ʏ: 'y',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join('')}]`, 'gu');
const SEPARATORS = '[\\s.\\-_*·•,/|]+';
/** Разрядка: три и больше одиночных букв через разделители. */
const SPACED = new RegExp(`(?<!\\p{L})\\p{L}(?!\\p{L})(?:${SEPARATORS}\\p{L}(?!\\p{L})){2,}`, 'gu');

/** Кириллические буквы, похожие на латинские: внутри латинского слова становятся латинской буквой (S-M4). */
const CYRILLIC_LOOKALIKE: Readonly<Record<string, string>> = { р: 'p', с: 'c', у: 'y', н: 'h', в: 'b', к: 'k', м: 'm', т: 't', х: 'x', а: 'a', о: 'o', е: 'e', і: 'i', г: 'r', п: 'n', и: 'u' };
/** Латинские буквы, похожие на кириллические только начертанием (r как "г", n как "п", u как "и"): для смешанных слов. */
const LATIN_LOOKALIKE_WIDE: Readonly<Record<string, string>> = { ...LATIN_LOOKALIKE, r: 'г', n: 'п', u: 'и' };
/** Цифры-двойники букв (S-M4): в слове с буквами цифра читается как буква. */
const DIGIT_AS_CYRILLIC: Readonly<Record<string, string>> = { '0': 'о', '3': 'з', '4': 'ч', '6': 'б' };
const DIGIT_AS_LATIN: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };
/** Знаки разметки Markdown и теги HTML между буквами одного слова: "до*го*вор", "ref<!---->und". */
const INWORD_MARKUP = /(?<=[\p{L}\p{N}])(?:<[^<>]{0,40}>|[*_`~\\^])+(?=[\p{L}\p{N}])/gu;

/** Общая часть скелета: без невидимых и пустых знаков, NFKC, строчными, двойники других письменностей, разрядка. */
function baseSkeleton(text: string): string {
  const base = normalizeApostrophes(stripInvisible(text).normalize('NFKC').replace(/[‌‍︀-️]/gu, '')).toLowerCase().replace(CONFUSABLE_RE, (ch) => CONFUSABLE[ch] ?? ch);
  return base.replace(SPACED, (run) => run.replace(new RegExp(SEPARATORS, 'gu'), ''));
}

const translit = (text: string) => text.replace(/[Ѐ-ӿ]/gu, (ch) => TRANSLIT[ch] ?? ch);
const count = (word: string, re: RegExp) => (word.match(re) ?? []).length;

/** Скелет текста для поиска слов списков (см. начало файла). */
export function skeleton(text: string): string {
  return translit(
    baseSkeleton(text).replace(/[\p{L}']+/gu, (word) => {
      const cyr = count(word, /\p{Script=Cyrillic}/gu);
      const lat = count(word, /\p{Script=Latin}/gu);
      return cyr > 0 && cyr >= lat ? word.replace(/[a-z]/g, (ch) => LATIN_LOOKALIKE[ch] ?? ch) : word;
    }),
  );
}

/**
 * Скелет против обходов (проверка на AI-инъекции, волна 7, S-M4): знаки разметки внутри слова убраны, слово со
 * смешением письменностей приведено целиком к одной (prefer), цифра внутри слова с буквами прочитана буквой той же
 * письменности. Ищется в дополнение к основному скелету: слова списков строятся основным.
 */
function hardenedSkeleton(text: string, prefer: 'cyrillic' | 'latin'): string {
  return translit(
    // Разметка убирается до приведения апострофов: обратная кавычка иначе стала бы апострофом, частью слова.
    baseSkeleton(stripInvisible(text).replace(INWORD_MARKUP, ''))
      .replace(/[\p{L}\p{N}']+/gu, (token) => {
        if (!/\p{L}/u.test(token)) return token;
        let word = token;
        const cyr = count(word, /\p{Script=Cyrillic}/gu);
        const lat = count(word, /\p{Script=Latin}/gu);
        if (cyr > 0 && lat > 0)
          word = prefer === 'cyrillic' ? word.replace(/[a-z]/g, (ch) => LATIN_LOOKALIKE_WIDE[ch] ?? ch) : word.replace(/\p{Script=Cyrillic}/gu, (ch) => CYRILLIC_LOOKALIKE[ch] ?? ch);
        const digits = /\p{Script=Cyrillic}/u.test(word) ? DIGIT_AS_CYRILLIC : DIGIT_AS_LATIN;
        return word.replace(/[0-9]/g, (ch) => digits[ch] ?? ch);
      }),
  );
}

/** Все скелеты текста: основной и два против обходов. */
function skeletons(text: string): string[] {
  return [...new Set([skeleton(text), hardenedSkeleton(text, 'cyrillic'), hardenedSkeleton(text, 'latin')])];
}

/** Слово списка как выражение: основы по порядку, между ними хвост слова и до трёх разделителей. */
function wordPattern(entry: string): RegExp | null {
  const parts = skeleton(entry).split(/[^a-z0-9']+/).filter(Boolean);
  if (parts.length === 0) return null;
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join("[a-z0-9']*[^a-z0-9']{0,3}"), 'u');
}

const cache = new Map<string, RegExp | null>();
function compiled(entry: string): RegExp | null {
  if (!cache.has(entry)) {
    if (cache.size > 5000) cache.clear();
    cache.set(entry, wordPattern(entry));
  }
  return cache.get(entry) ?? null;
}

const anyWord = (text: string, words: TopicWords) => {
  const variants = skeletons(text);
  return [...words.ru, ...words.uz, ...words.en].some((entry) => {
    const pattern = compiled(entry);
    return pattern !== null && variants.some((s) => pattern.test(s));
  });
};

/** Первая обязательная тема в тексте (на любом из языков списков) или null. */
export function matchRestrictedTopic(text: string, lists: TopicLists): RestrictedTopic | null {
  for (const topic of RESTRICTED_TOPICS) if (lists[topic] && anyWord(text, lists[topic])) return topic;
  return null;
}

/** Просит ли клиент человека. */
export function asksHuman(text: string): boolean {
  return anyWord(text, ASKS_HUMAN);
}
