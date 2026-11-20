import { readFileSync } from 'node:fs';
import * as fontkit from 'fontkit';

type Vars = Record<string, string>;

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Объявления `--имя: значение;` из блока CSS или SCSS. Комментарии `//` и блочные отбрасываются. */
function declarations(block: string, prefix: string): Vars {
  const text = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const vars: Vars = {};
  for (const match of text.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g))
    if (match[1].startsWith(prefix)) vars[match[1].slice(prefix.length)] = clean(match[2]);
  return vars;
}

function blockAfter(text: string, selector: RegExp): string {
  const start = text.search(selector);
  if (start < 0) throw new Error(`Блок ${selector} не найден`);
  const open = text.indexOf('{', start);
  return text.slice(open + 1, text.indexOf('}', open));
}

/** Токены поставки Smartup Web: цвета светлой и тёмной темы и пары цветов меток статуса. */
export function parseScssVars(scss: string): { light: Vars; dark: Vars } {
  const light = declarations(blockAfter(scss, /:root,\s*\.ws\s*\{/), '');
  const dark = declarations(blockAfter(scss, /\.ws\.dk\s*\{/), '');
  const pills = /\$status-pill:\s*\(([\s\S]*?)\n\);/.exec(scss)?.[1] ?? '';
  for (const match of pills.matchAll(/([a-z]+):\s*\((#[0-9A-Fa-f]+),\s*(#[0-9A-Fa-f]+)\)/g)) {
    light[`pill-${match[1]}-fg`] = match[2];
    light[`pill-${match[1]}-bg`] = match[3];
  }
  return { light, dark };
}

/** Слой 1 файла токенов портала: переменные `--sm-*` из блоков `:root` и `.dark`. */
export function parseLayer1(css: string): { light: Vars; dark: Vars } {
  return {
    light: declarations(blockAfter(css, /^:root\s*\{/m), 'sm-'),
    dark: declarations(blockAfter(css, /^\.dark\s*\{/m), 'sm-'),
  };
}

/** Знаки, которые есть в файле шрифта. */
export function codePointsOf(path: string): Set<number> {
  const font = fontkit.create(readFileSync(path)) as unknown as { characterSet: number[] };
  return new Set(font.characterSet);
}
