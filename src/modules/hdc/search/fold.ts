// Свёртка написаний (план W6, решение 8). Фонетики (soundex) в Typesense 30.2 нет, поэтому похожие написания сводит
// портал: кириллица русского и узбекского в латиницу по одной схеме, нижний регистр, апострофы узбекской латиницы
// убраны, x, h и kh в h, q в k, ц и ts в s, ж и zh в j, ы в i, э и ё в e, ь и ъ убраны, двойные буквы в одну.
// Свёрнутый текст лежит в полях *_fold, запрос сворачивается той же функцией. Чистая функция: и документ, и запрос.

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Узбекская кириллица: ў это o‘, ғ это g‘, қ и ҳ.
  ў: 'o', ғ: 'g', қ: 'k', ҳ: 'h',
};

/** Апострофы узбекской латиницы (o‘, o', oʻ, g`) и мягкий знак латиницей: часть буквы, а не разделитель. */
const APOSTROPHES = /[‘’ʻʼ`'´]/g;

/** Латинские сочетания одного звука. Порядок важен: kh раньше x, zh раньше z. */
const LATIN: [RegExp, string][] = [
  [/kh/g, 'h'],
  [/x/g, 'h'],
  [/q/g, 'k'],
  [/zh/g, 'j'],
  [/ts/g, 's'],
  [/([a-z])\1+/g, '$1'],
];

function foldWord(word: string): string {
  let out = '';
  for (const char of word) out += CYRILLIC[char] ?? char;
  // Каждое правило укорачивает слово или переводит букву в ту, которую правила больше не трогают, поэтому повтор
  // до неподвижной точки конечен. Повтор нужен, чтобы foldText(foldText(x)) = foldText(x): "kkh" даёт "kh", затем "h".
  for (let i = 0; i < 8; i++) {
    let next = out;
    for (const [pattern, replacement] of LATIN) next = next.replace(pattern, replacement);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Свёрнутый текст: слова из латинских букв и цифр через один пробел. */
export function foldText(text: string): string {
  const words = text.toLowerCase().normalize('NFC').replace(APOSTROPHES, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .map(foldWord)
    .filter((word) => word.length > 0)
    .join(' ');
}
