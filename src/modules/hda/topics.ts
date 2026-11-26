import { cleanUserText } from '@/modules/hdc/pref';
import { normalizeApostrophes } from './language';

// Модуль hda: обязательные темы и просьба позвать человека (FR-AI-06, UX-B-07; план M5b, задача 2, решение 17). Код
// ищет их сам, по спискам слов на языках портала; совпадение ведёт к передаче сотруднику, что бы ни ответила модель.
//
// Текст и слова списков приводятся к одному "скелету": NFKC (полноширинные буквы), без невидимых знаков, строчными,
// апострофы ʻ ʼ ‘ ’ к прямому, латинские буквы-двойники внутри кириллического слова к кириллице, затем кириллица
// (русская и узбекская) латиницей по одной таблице. Так "Тўлов" и "To'lov", "oплaтa" и "оплата" дают одно и то же.
// Разрядка ("о п л а т а", "о.п.л.а.т.а") склеивается. Слова списков ищутся как начало слова или подстрока: списки
// составлены из основ и сочетаний, чтобы не ловить обычные вопросы о работе программы.

/** Темы обязательной передачи FR-AI-06: расчёты и оплата, договор, жалоба, удаление или массовое изменение данных, доступы и права, безопасность, юридические вопросы. */
export const RESTRICTED_TOPICS = ['payments', 'contract', 'complaint', 'data_change', 'access', 'security', 'legal'] as const;
export type RestrictedTopic = (typeof RESTRICTED_TOPICS)[number];
export type TopicWords = { ru: string[]; uz: string[]; en: string[] };
export type TopicLists = Record<RestrictedTopic, TopicWords>;

/** Начальные списки (решение 17). Узбекский латиницей: кириллица находится тем же скелетом. Правит admin в настройках AI. */
export const RESTRICTED_TOPICS_DEFAULT: TopicLists = {
  payments: {
    ru: ['прошла оплат', 'оплата подписк', 'оплатили', 'списали деньг', 'деньги списал', 'списание денег', 'вернуть деньг', 'возврат денег', 'счёт на оплату', 'тариф', 'стоимость лицензи', 'продление лицензи'],
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
    ru: ['взлом', 'утечк', 'мошенни', 'вирус', 'фишинг', 'украли пароль'],
    uz: ['buzishdi', 'buzib kir', 'oshkor', 'firibgar', 'virus', 'xakker'],
    en: ['hacked', 'breach', 'leak', 'phishing', 'fraud', 'stolen password'],
  },
  legal: {
    ru: ['в суд', 'судебн', 'юрист', 'адвокат', 'прокуратур', 'исковое', 'подадим иск', 'подать иск'],
    uz: ['sudga', 'sud qaror', 'yurist', 'advokat', 'prokuratura'],
    en: ['lawyer', 'lawsuit', 'legal action', 'court', 'attorney'],
  },
};

/** Просьба позвать человека (решение 17): списком в коде, администратор его не правит. */
export const ASKS_HUMAN: TopicWords = {
  ru: ['позовите оператор', 'позовите человек', 'позовите сотрудник', 'нужен человек', 'нужен оператор', 'нужен сотрудник', 'нужен живой', 'жив человек', 'поговорить с человек', 'поговорить с сотрудник', 'поговорить с оператор', 'свяжите с оператор', 'свяжите с сотрудник', 'соедините с оператор', 'соедините с сотрудник', 'оператор'],
  uz: ['inson bilan', 'odam kerak', 'jonli odam', 'xodim bilan', 'xodimga ulang', 'operator'],
  en: ['human', 'real person', 'talk to a person', 'talk to someone', 'speak to a person', 'live agent', 'support agent', 'operator'],
};

const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h', і: 'i', ї: 'i', є: 'e',
};
/** Латинские буквы, похожие на кириллические, но дающие другую букву скелета. */
const LATIN_LOOKALIKE: Readonly<Record<string, string>> = { p: 'р', c: 'с', y: 'у', h: 'н', b: 'в', k: 'к', m: 'м', t: 'т', x: 'х', a: 'а', o: 'о', e: 'е' };
const SEPARATORS = '[\\s.\\-_*·•,/|]+';
/** Разрядка: три и больше одиночных букв через разделители. */
const SPACED = new RegExp(`(?<!\\p{L})\\p{L}(?!\\p{L})(?:${SEPARATORS}\\p{L}(?!\\p{L})){2,}`, 'gu');

/** Скелет текста для поиска слов списков (см. начало файла). */
export function skeleton(text: string): string {
  const base = normalizeApostrophes(cleanUserText(text).normalize('NFKC').replace(/[‌‍︀-️]/gu, '')).toLowerCase();
  const joined = base.replace(SPACED, (run) => run.replace(new RegExp(SEPARATORS, 'gu'), ''));
  return joined
    .replace(/[\p{L}']+/gu, (word) => {
      const cyr = (word.match(/\p{Script=Cyrillic}/gu) ?? []).length;
      const lat = (word.match(/\p{Script=Latin}/gu) ?? []).length;
      return cyr > 0 && cyr >= lat ? word.replace(/[a-z]/g, (ch) => LATIN_LOOKALIKE[ch] ?? ch) : word;
    })
    .replace(/[Ѐ-ӿ]/gu, (ch) => TRANSLIT[ch] ?? ch);
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
  const s = skeleton(text);
  return [...words.ru, ...words.uz, ...words.en].some((entry) => compiled(entry)?.test(s) ?? false);
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
