// Модуль hdt, слой core: благодарность на решённое обращение (FR-TK-14, решение 15 плана M3, подтверждено владельцем).
// Чистая функция без обращения к базе. Простые признаки: до 200 знаков, без вопросительного знака и вопросительных
// слов, со словом благодарности. Слова "но", "ещё", "не работает" и подобные считаются сомнением: при любом сомнении
// обращение открывается заново. AI уточнит определение в M5b.

const MAX_LENGTH = 200;

/** Основы слов благодарности: слово начинается с основы. Узбекский в обеих письменностях. */
const THANKS_STEMS = ['спасиб', 'благодар', 'помогл', 'rahmat', 'raxmat', 'tashakkur', 'ishladi', 'рахмат', 'ташаккур', 'thank'];
/** Благодарность из двух слов. */
const THANKS_PHRASES = ['все работает', 'всё работает', 'works now'];

/** Вопросительные слова: целое слово. */
const QUESTION_WORDS = new Set([
  'как', 'почему', 'зачем', 'когда', 'где', 'куда', 'сколько', 'какой', 'какая', 'какое', 'какие', 'каким', 'ли',
  'qanday', 'nega', 'nima', 'nimaga', 'qachon', 'qayerda', 'qayerga', 'nechta', 'qaysi',
  'қандай', 'нега', 'нима', 'нимага', 'қачон', 'қаерда', 'нечта', 'қайси',
  'how', 'why', 'what', 'when', 'where', 'which', 'can', 'could', 'should', 'does', 'is',
]);
/** Сомнение: новое затруднение или продолжение вопроса. */
const DOUBT_WORDS = new Set([
  'но', 'однако', 'ещё', 'еще', 'опять', 'снова', 'ошибка', 'ошибку',
  'lekin', 'ammo', 'yana', 'xato', 'ishlamayapti', 'ishlamadi', 'лекин', 'аммо', 'яна', 'хато', 'ишламаяпти', 'ишламади',
  'but', 'still', 'again', 'error', 'fails', 'failed', "doesn't", 'not',
  // Отрицание и "проблема осталась" (итоговая проверка M3): благодарность за попытку, а не за решение.
  'не', 'нет', 'проблема', 'проблемы', 'осталась', 'остался', 'осталось', 'падает', 'вылетает',
  'no', 'problem', 'issue', 'emas', "yo'q", 'yoq', 'hali', 'muammo', 'эмас', 'йўқ', 'ҳали', 'муаммо',
]);
const DOUBT_PHRASES = ['не работает', 'не помогло', 'не получилось', 'не грузится', 'все равно', 'всё равно'];
/** Узбекское отрицание глагола: ishlamadi, ishlamaydi, bo'lmadi, ishlamayapti и то же кириллицей. */
const UZ_NEGATIVE = /(madi|maydi|mayapti|mayman|мади|майди|маяпти|майман)$/;

const normalize = (text: string) =>
  text
    .toLocaleLowerCase('ru')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Благодарность без нового вопроса: обращение остаётся решённым, сообщение сохраняется. */
export function isThanks(text: string): boolean {
  const value = normalize(text);
  if (value.length === 0 || value.length > MAX_LENGTH || value.includes('?')) return false;
  const words = value.split(/[^\p{L}\p{N}']+/u).filter((word) => word.length > 0);
  if (words.some((word) => QUESTION_WORDS.has(word) || DOUBT_WORDS.has(word))) return false;
  // Узбекская частица вопроса -mi: "ishlaydimi", "bo'ladimi".
  if (words.some((word) => word.length > 4 && (word.endsWith('mi') || word.endsWith('ми')))) return false;
  if (DOUBT_PHRASES.some((phrase) => value.includes(phrase))) return false;
  if (words.some((word) => UZ_NEGATIVE.test(word))) return false;
  return words.some((word) => THANKS_STEMS.some((stem) => word.startsWith(stem))) || THANKS_PHRASES.some((phrase) => value.includes(phrase));
}
