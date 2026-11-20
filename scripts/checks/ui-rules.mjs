// Правила оформления для кода в src:
// - raw-color: цвета берутся из токенов, а не пишутся в файлах экранов (UX-S-12);
// - arbitrary-size: размеры берутся из шкалы токенов, без значений вида h-[52px];
// - physical-direction: только логические свойства (FR-I18N-09), без left и right;
// - layer1-token: токены слоя 1 (--sm-*) видны только в src/ui/tokens.css.

/** @typedef {'raw-color' | 'arbitrary-size' | 'physical-direction' | 'layer1-token'} UiRule */

const TOKENS_FILE = 'src/ui/tokens.css';

// `#` и 3, 4, 6 или 8 шестнадцатеричных знаков. Перед `#` нет буквы, цифры, `&` и `/`:
// так не задеваются якоря ссылок (/docs#add) и коды символов (&#8212;).
const HEX_COLOR = /(?<![\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
const ARBITRARY_SIZE = /-\[-?\d*\.?\d+(?:px|rem|em)\]/;
const LAYER1_TOKEN = /--sm-[a-z0-9]/;

// Классы Tailwind с физическим направлением. Перед классом стоит начало слова
// или вариант с двоеточием (md:ml-4), допускается знак минус (-ml-1).
const B = '(?<![\\w-])-?';
const PHYSICAL_DIRECTION = new RegExp(
  [
    `${B}(?:scroll-)?[mp][lr]-[\\w\\[]`,
    `${B}(?:left|right)-[\\w\\[]`,
    `${B}(?:border|rounded|divide)-(?:[lr]|[tb][lr])(?![\\w])`,
    `${B}(?:text|float|clear)-(?:left|right)(?![\\w-])`,
  ].join('|'),
);

/**
 * @param {string} path путь от корня репозитория
 * @param {string} text
 * @returns {{ line: number; rule: UiRule }[]}
 */
export function findUiRuleViolations(path, text) {
  /** @type {{ line: number; rule: UiRule }[]} */
  const found = [];
  if (path === TOKENS_FILE) return found;
  const isCode = /\.(?:ts|tsx)$/.test(path);
  const isStyle = /\.css$/.test(path);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = (/** @type {UiRule} */ rule) => found.push({ line: i + 1, rule });
    if ((isCode || isStyle) && (HEX_COLOR.test(line) || COLOR_FUNCTION.test(line))) add('raw-color');
    if (isCode && ARBITRARY_SIZE.test(line)) add('arbitrary-size');
    if (isCode && PHYSICAL_DIRECTION.test(line)) add('physical-direction');
    if (LAYER1_TOKEN.test(line)) add('layer1-token');
  }
  return found;
}
