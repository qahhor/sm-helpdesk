// Модуль hdu: пароль сотрудника не из частых (аудит 23.11.2026, находка S11; FR-ID-09).
// Длины 12 знаков мало, если пароль это "Password12345": такие пароли первыми идут в словарь подбора.
// Список встроенный, запросов в сеть нет. Проверка отклоняет пароль, который:
//   - целиком складывается из частых слов, кусков клавиатурных рядов, последовательностей и повторов;
//   - частое слово от шести букв с короткой добавкой (MyPassword123, Summer2026!!);
//   - на две трети один ряд, последовательность или повтор (Aa123456789!).
// Фраза из своих слов и случайный пароль с частым словом внутри проходят. Сверх правил пароль сверяется со списком
// 3000 самых частых паролей от 12 знаков (ASVS 5.0.0, требование 6.2.4; common-passwords.ts).

import { COMMON_PASSWORDS } from './common-passwords';

/** Частые слова паролей и слова, которые первым делом попробуют для этого портала. Латиница и кириллица. */
const COMMON_WORDS = [
  'password', 'passwd', 'parol', 'pass', 'qwerty', 'azerty', 'admin', 'administrator', 'root', 'user', 'guest', 'test', 'demo',
  'welcome', 'letmein', 'login', 'access', 'secret', 'changeme', 'default', 'master', 'hello', 'iloveyou', 'love', 'monkey',
  'dragon', 'football', 'baseball', 'sunshine', 'princess', 'superman', 'batman', 'freedom', 'whatever', 'computer', 'internet',
  'google', 'samsung', 'trustno', 'shadow', 'michael', 'killer', 'hunter', 'soccer', 'starwars', 'pokemon',
  'smartup', 'smart', 'hub', 'support', 'helpdesk', 'help', 'desk', 'portal', 'agent', 'staff', 'greenwhite', 'biruni',
  'tashkent', 'toshkent', 'uzbekistan', 'ozbekiston', 'salom', 'assalom',
  'пароль', 'привет', 'админ', 'любовь', 'смартап', 'ташкент',
  // Месяцы, времена года и слова о работе: "Summer2026!!", "Company12345".
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'summer', 'winter', 'spring', 'autumn', 'monday', 'friday', 'sunday',
  'company', 'office', 'manager', 'director', 'service', 'system', 'server', 'secure', 'security', 'private', 'network',
  'yandex', 'telegram', 'windows', 'iphone', 'android', 'qazwsx', 'zaqwsx', 'wsxedc',
  // Частые имена: имя с годом или цифрами подбирают сразу после слова password.
  'alexander', 'alexandr', 'sergey', 'andrey', 'dmitry', 'vladimir', 'maxim', 'natasha', 'elena', 'maria',
  'alisher', 'dilnoza', 'bobur', 'timur', 'rustam', 'jasur', 'sardor', 'shahzod', 'nodir', 'otabek', 'ulugbek', 'javlon',
  'farrukh', 'islom', 'muhammad', 'aziz', 'kamila', 'madina', 'nigora', 'gulnora',
] as const;

/** Слова от шести букв: такое слово с короткой добавкой даёт частый пароль (MyPassword123). */
const LONG_WORDS = COMMON_WORDS.filter((word) => word.length >= 6);
/** Добавка к частому слову не длиннее этого числа знаков: дальше это уже свой пароль со словом внутри. */
const MAX_ADDITION = 8;
/** Из них букв не больше стольких: "My", "New", "ab". */
const MAX_EXTRA_LETTERS = 3;

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

/** Повтор короткого куска: abcabcabcabc, 121212121212, шесть одинаковых значков. Считаются знаки, а не единицы UTF-16. */
function isShortPeriod(text: string): boolean {
  const chars = [...text];
  for (let period = 1; period <= 4; period++) {
    if (chars.length >= period * 3 && chars.every((char, index) => char === chars[index % period])) return true;
  }
  return false;
}

/** Частое слово от шести букв с короткой добавкой: MyPassword123, Summer2026!!, Company12345. */
function isWordWithAddition(lower: string): boolean {
  const letters = [...lower].filter(isLetter).join('');
  return LONG_WORDS.some((word) => letters.includes(word) && lower.length - word.length <= MAX_ADDITION && letters.length - word.length <= MAX_EXTRA_LETTERS);
}

/** Один ряд, последовательность или повтор занимает две трети пароля и больше: Aa123456789!, aaaaaaaaaaab. */
function isMostlyOneRun(lower: string): boolean {
  for (let at = 0; at < lower.length; at++) {
    const run = Math.max(walkLength(lower, at), repeatLength(lower, at));
    if (run * 3 >= lower.length * 2) return true;
  }
  return false;
}

/**
 * Частый ли пароль. Регистр не важен. Проверяются три вида пароля: как есть, с обратной заменой цифр и знаков
 * на буквы (p@ssw0rd), и только буквы (Smartup2026Hub).
 */
export function isCommonPassword(password: string): boolean {
  const lower = password.normalize('NFKC').toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || COMMON_WHOLE.has(lower) || isShortPeriod(lower) || isMostlyOneRun(lower)) return true;
  const trimmed = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  const unleet = [...trimmed].map((char) => LEET[char] ?? char).join('');
  // Восклицательный знак бывает и заменой буквы (adm!n), и разделителем (Passw0rd!Passw0rd!): проверяются оба чтения.
  const unleetKeepBang = [...trimmed].map((char) => (char === '!' ? char : (LEET[char] ?? char))).join('');
  const lettersOnly = [...lower].filter(isLetter).join('');
  // Слово с добавкой ищется в пароле целиком, без обрезки краёв: иначе добавка потерялась бы и не считалась.
  const whole = (keepBang: boolean) => [...lower].map((char) => (keepBang && char === '!' ? char : (LEET[char] ?? char))).join('');
  if ([lower, whole(false), whole(true)].some(isWordWithAddition)) return true;
  // Сокращённые виды считаются, только если в них осталась хотя бы половина пароля: иначе случайный пароль
  // с частым словом внутри (93847!hub2817) был бы отклонён.
  const mostOf = (part: string) => part.length * 2 >= lower.length;
  return madeOfCommonParts(lower) || [unleet, unleetKeepBang, lettersOnly].some((part) => mostOf(part) && madeOfCommonParts(part));
}
