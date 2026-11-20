// Контраст текста и фона по WCAG 2.2: не ниже 4,5:1 в светлой и тёмной теме (UX-S-08).
// Пары "текст, фон" перечислены в scripts/checks/contrast-pairs.json именами токенов слоя 2.

/** @typedef {{ r: number; g: number; b: number; a: number }} Rgba */
/** @typedef {{ name: string; fg: string; bg: string; under?: string }} Pair */

/**
 * @param {string} value цвет: #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba(), transparent
 * @returns {Rgba}
 */
export function parseColor(value) {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const part = (/** @type {number} */ i) => parseInt(full.slice(i, i + 2), 16);
    return { r: part(0), g: part(2), b: part(4), a: full.length === 8 ? part(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha };
  }
  throw new Error(`Не удалось разобрать цвет: ${value}`);
}

/** Накладывает полупрозрачный цвет на непрозрачную подложку. */
function over(/** @type {Rgba} */ top, /** @type {Rgba} */ bottom) {
  const mix = (/** @type {number} */ t, /** @type {number} */ b) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance(/** @type {Rgba} */ color) {
  const channel = (/** @type {number} */ value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Отношение контраста текста к фону. Полупрозрачный фон накладывается на подложку under.
 * @param {string} fg
 * @param {string} bg
 * @param {string} [under] подложка под полупрозрачным фоном, по умолчанию белая
 * @returns {number}
 */
export function contrastRatio(fg, bg, under = '#FFFFFF') {
  const base = over(parseColor(bg), over(parseColor(under), { r: 255, g: 255, b: 255, a: 1 }));
  const text = over(parseColor(fg), base);
  const [light, dark] = [luminance(text), luminance(base)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Объявления `--имя: значение` из всех блоков с данным селектором в начале строки. */
function blockVars(/** @type {string} */ css, /** @type {RegExp} */ selector) {
  /** @type {Map<string, string>} */
  const vars = new Map();
  for (const block of css.matchAll(selector))
    for (const match of block[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) vars.set(match[1], match[2].trim());
  return vars;
}

/**
 * Пары, у которых контраст ниже 4,5:1.
 * @param {string} tokensCss текст src/ui/tokens.css
 * @param {Pair[]} pairs
 * @returns {{ pair: string; theme: 'light' | 'dark'; ratio: number }[]}
 */
export function checkContrast(tokensCss, pairs) {
  const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = blockVars(css, /^:root\s*\{([^}]*)\}/gm);
  const dark = blockVars(css, /^\.dark\s*\{([^}]*)\}/gm);
  const theme = blockVars(css, /^@theme inline\s*\{([^}]*)\}/gm);
  // Без блока тёмной темы проверка молча посчитала бы светлые значения дважды.
  if (dark.size === 0) throw new Error('В файле токенов не найден блок тёмной темы (.dark)');

  const resolve = (/** @type {string} */ value, /** @type {'light' | 'dark'} */ mode, depth = 0) => {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value.trim());
    if (!ref) return value.trim();
    if (depth > 10) throw new Error(`Циклическая ссылка в токене ${ref[1]}`);
    const next = (mode === 'dark' ? dark.get(ref[1]) : undefined) ?? root.get(ref[1]);
    if (next === undefined) throw new Error(`Токен --${ref[1]} не определён`);
    return resolve(next, mode, depth + 1);
  };
  const color = (/** @type {string} */ name, /** @type {'light' | 'dark'} */ mode) => {
    const value = theme.get(`color-${name}`);
    if (value === undefined) throw new Error(`В слое 2 нет цвета ${name} (--color-${name})`);
    return resolve(value, mode);
  };

  /** @type {{ pair: string; theme: 'light' | 'dark'; ratio: number }[]} */
  const failed = [];
  for (const mode of /** @type {const} */ (['light', 'dark']))
    for (const pair of pairs) {
      const ratio = contrastRatio(color(pair.fg, mode), color(pair.bg, mode), color(pair.under ?? 'card', mode));
      if (ratio < 4.5) failed.push({ pair: pair.name, theme: mode, ratio: Math.round(ratio * 100) / 100 });
    }
  return failed;
}
