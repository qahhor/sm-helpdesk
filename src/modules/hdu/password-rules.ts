// Модуль hdu: пароль сотрудника не из частых (аудит 23.11.2026, находка S11; FR-ID-09).
// Длины 12 знаков мало, если пароль это "Password12345": такие пароли первыми идут в словарь подбора.
// Список встроенный, запросов в сеть нет. Проверка отклоняет пароль, который целиком складывается из частых слов,
// кусков клавиатурных рядов, цифровых и буквенных последовательностей и повторов. Фраза из своих слов проходит.

/** Частые слова паролей и слова, которые первым делом попробуют для этого портала. Латиница и кириллица. */
const COMMON_WORDS = [
  'password', 'passwd', 'parol', 'pass', 'qwerty', 'azerty', 'admin', 'administrator', 'root', 'user', 'guest', 'test', 'demo',
  'welcome', 'letmein', 'login', 'access', 'secret', 'changeme', 'default', 'master', 'hello', 'iloveyou', 'love', 'monkey',
  'dragon', 'football', 'baseball', 'sunshine', 'princess', 'superman', 'batman', 'freedom', 'whatever', 'computer', 'internet',
  'google', 'samsung', 'trustno', 'shadow', 'michael', 'killer', 'hunter', 'soccer', 'starwars', 'pokemon',
  'smartup', 'smart', 'hub', 'support', 'helpdesk', 'help', 'desk', 'portal', 'agent', 'staff', 'greenwhite', 'biruni',
  'tashkent', 'toshkent', 'uzbekistan', 'ozbekiston', 'salom', 'assalom',
  'пароль', 'привет', 'админ', 'любовь', 'смартап', 'ташкент',
] as const;

/** Частые пароли, которые не складываются из слов и рядов: проходы по клавиатуре наискось и чередования. */
const COMMON_WHOLE = new Set([
  '1q2w3e4r5t6y', '1q2w3e4r5t6y7u', 'q1w2e3r4t5y6', '1qaz2wsx3edc', '1qaz2wsx3edc4rfv', 'zaq12wsxcde3', 'qazwsxedcrfv', 'qazwsxedcrfvtgb',
  'a1b2c3d4e5f6', '1a2b3c4d5e6f', 'q1w2e3r4t5y6u7', 'zaq1xsw2cde3',
]);

/** Ряды, по которым идут "проходы": клавиатура (латиница и кириллица), алфавиты и цифры. */
const ROWS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю',
  'abcdefghijklmnopqrstuvwxyz', 'абвгдежзийклмнопрстуфхцчшщъыьэюя', '01234567890123456789', '!@#$%^&*()',
];
const WALKS = [...ROWS, ...ROWS.map((row) => [...row].reverse().join(''))];

/** Замены букв цифрами и знаками, которые подбор пробует сразу: p@ssw0rd это password. */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

const isLetter = (char: string) => /\p{L}/u.test(char);

/** Длина самого длинного куска ряда, с которого начинается text с позиции from. Короче трёх знаков не считается. */
function walkLength(text: string, from: number): number {
  let best = 0;
  for (const row of WALKS) {
    for (let start = row.indexOf(text[from] as string); start !== -1; start = row.indexOf(text[from] as string, start + 1)) {
      let length = 0;
      while (from + length < text.length && start + length < row.length && text[from + length] === row[start + length]) length += 1;
      best = Math.max(best, length);
    }
  }
  return best >= 3 ? best : 0;
}

/** Длина повтора одного знака с позиции from. Короче трёх не считается. */
function repeatLength(text: string, from: number): number {
  let length = 1;
  while (from + length < text.length && text[from + length] === text[from]) length += 1;
  return length >= 3 ? length : 0;
}

/** Сколько одиночных цифр и знаков допускается как склейка между частями: Admin_Admin!2 это всё ещё admin и admin. */
const MAX_GLUE = 4;

/**
 * Складывается ли строка целиком из частых слов, кусков рядов и повторов. Между частями допускается до MAX_GLUE
 * одиночных цифр и знаков. Больше склейки: это уже случайные знаки, а не украшение частого слова.
 */
function madeOfCommonParts(text: string): boolean {
  if (text.length <= MAX_GLUE) return false;
  // glue[i]: наименьшее число знаков склейки, с которым строку удалось сложить до позиции i.
  const glue = new Array<number>(text.length + 1).fill(Infinity);
  glue[0] = 0;
  for (let at = 0; at < text.length; at++) {
    const used = glue[at] as number;
    if (used > MAX_GLUE) continue;
    const mark = (length: number, add: number) => {
      if (length > 0) glue[at + length] = Math.min(glue[at + length] as number, used + add);
    };
    for (const word of COMMON_WORDS) if (text.startsWith(word, at)) mark(word.length, 0);
    mark(walkLength(text, at), 0);
    mark(repeatLength(text, at), 0);
    if (!isLetter(text[at] as string)) mark(1, 1);
  }
  return (glue[text.length] as number) <= MAX_GLUE;
}

/** Повтор короткого куска: abcabcabcabc, 121212121212. */
function isShortPeriod(text: string): boolean {
  for (let period = 1; period <= 4; period++) {
    if (text.length >= period * 3 && [...text].every((char, index) => char === text[index % period])) return true;
  }
  return false;
}

/**
 * Частый ли пароль. Регистр не важен. Проверяются три вида пароля: как есть, с обратной заменой цифр и знаков
 * на буквы (p@ssw0rd), и только буквы (Smartup2026Hub).
 */
export function isCommonPassword(password: string): boolean {
  const lower = password.normalize('NFKC').toLowerCase();
  if (COMMON_WHOLE.has(lower) || isShortPeriod(lower)) return true;
  const trimmed = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  const unleet = [...trimmed].map((char) => LEET[char] ?? char).join('');
  const lettersOnly = [...lower].filter(isLetter).join('');
  // Сокращённые виды считаются, только если в них осталась хотя бы половина пароля: иначе случайный пароль
  // с частым словом внутри (93847!hub2817) был бы отклонён.
  const mostOf = (part: string) => part.length * 2 >= lower.length;
  return madeOfCommonParts(lower) || [unleet, lettersOnly].some((part) => mostOf(part) && madeOfCommonParts(part));
}
