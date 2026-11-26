import type { Locale } from '@/i18n/locales';
import { cleanUserText } from '@/modules/hdc/pref';

// Модуль hda: язык обращения определяет код (FR-AI-06, FR-AI-12; план M5b, задача 2, решение 16). Модель язык не
// выбирает: ответ помощника идёт на языке, который назвал этот код, а язык вне языков портала ведёт к передаче.
//
// По письменности и частым словам: кириллица с узбекскими буквами (ў, қ, ғ, ҳ) или узбекскими частыми словами даёт uz,
// прочая кириллица ru; латиница с узбекскими сочетаниями (o', g') и словарём uz, иначе по словарю en. Короче трёх
// слов: язык пользователя. Прочая кириллица ru. Другая письменность или латиница без словаря: null.

const UZ_CYRILLIC_LETTERS = /[ўқғҳЎҚҒҲ]/u;
const UZ_CYRILLIC_WORDS = new Set(['ва', 'бу', 'учун', 'билан', 'эмас', 'керак', 'менга', 'мен', 'сиз', 'нима', 'қандай', 'хато', 'ёрдам', 'беринг', 'илтимос', 'ишламаяпти', 'чиқди', 'бўлди', 'йўқ', 'бор', 'ҳам', 'лекин', 'қилиш', 'очилмаяпти', 'ҳисобот', 'буюртма', 'мумкин', 'бўлса', 'кейин', 'олдин', 'ҳозир', 'нега', 'ишлайди', 'бериш', 'чиқяпти']);
const RU_WORDS = new Set(['и', 'в', 'не', 'на', 'что', 'с', 'по', 'как', 'при', 'это', 'я', 'у', 'мы', 'но', 'для', 'из', 'за', 'после', 'нет', 'ошибка', 'документ', 'выходит', 'делать', 'работает', 'можно', 'нужно', 'не', 'или', 'же', 'уже', 'когда', 'почему', 'отчёт', 'отчет', 'открывается', 'проводится', 'помогите', 'пожалуйста', 'есть', 'был', 'было', 'все', 'всё', 'то', 'от', 'до']);
const UZ_LATIN_WORDS = new Set(['va', 'bu', 'uchun', 'bilan', 'emas', 'kerak', 'menga', 'men', 'siz', 'nima', 'qanday', 'xato', 'yordam', 'bering', 'iltimos', 'ishlamayapti', 'chiqdi', "bo'ldi", "yo'q", 'bor', 'ham', 'lekin', 'qilish', 'ochilmayapti', 'hisobot', 'buyurtma', 'mumkin', "bo'lsa", 'keyin', 'oldin', 'hozir', 'nega', 'ishlaydi', 'chiqyapti', 'qilib', 'qilmoqchiman', 'kerakmi']);
const EN_WORDS = new Set(['the', 'is', 'are', 'and', 'not', 'to', 'of', 'in', 'for', 'with', 'my', 'can', 'does', 'do', 'how', 'what', 'it', 'an', 'a', 'i', 'we', 'please', 'error', 'when', 'after', 'this', 'that', 'on', 'cannot', "can't", "doesn't", "don't", 'invoice', 'report', 'help', 'page', 'fix', 'prints', 'empty', 'open', 'opens', 'works', 'work']);
/** Узбекская латиница: o' и g' (апостроф любого вида уже приведён к прямому). */
const UZ_LATIN_MARKS = /\b[og]'/u;
/** Узбекская латиница: q без следующей u (qil-, qanday, qoldiq); в английском q почти всегда с u. */
const UZ_LATIN_Q = /q(?!u)/u;

/** Узбекские апострофы к одному виду (UX-B-07): ʻ ʼ ‘ ’ ` ´ становятся прямым. */
export function normalizeApostrophes(text: string): string {
  return text.replace(/[ʻʼ‘’`´]/gu, "'");
}

/** Язык текста обращения или null (передача language). userLocale: язык пользователя для короткого текста. */
export function detectLanguage(text: string, userLocale: Locale): Locale | null {
  const clean = normalizeApostrophes(cleanUserText(text).normalize('NFKC')).toLowerCase();
  const words = clean.match(/[\p{L}']+/gu)?.filter((w) => /\p{L}/u.test(w)) ?? [];
  let cyrillic = 0;
  let latin = 0;
  let other = 0;
  for (const char of clean.match(/\p{L}/gu) ?? []) {
    if (/\p{Script=Cyrillic}/u.test(char)) cyrillic++;
    else if (/\p{Script=Latin}/u.test(char)) latin++;
    else other++;
  }
  // Другая письменность (арабская, китайская): передача, даже если слов мало (у китайского нет пробелов).
  if (other > cyrillic && other > latin) return null;
  if (words.length < 3) return userLocale;
  const hits = (dictionary: Set<string>) => words.filter((w) => dictionary.has(w)).length;
  if (cyrillic >= latin) {
    const uz = hits(UZ_CYRILLIC_WORDS) + (UZ_CYRILLIC_LETTERS.test(clean) ? 2 : 0);
    const ru = hits(RU_WORDS);
    if (uz > 0 && uz >= ru) return 'uz';
    // Прочая кириллица: русский (решение 16). Кириллица другого языка портала не бывает.
    return 'ru';
  }
  const uz = hits(UZ_LATIN_WORDS) + (UZ_LATIN_MARKS.test(clean) ? 2 : 0) + (UZ_LATIN_Q.test(clean) ? 2 : 0);
  const en = hits(EN_WORDS);
  if (uz > 0 && uz >= en) return 'uz';
  return en > 0 ? 'en' : null;
}
