// Значения оформления для писем (решение 4 вехи M4). Почтовые программы не понимают переменные CSS,
// поэтому цвета и размеры письма берутся из src/ui/tokens.css этим скриптом и лежат в
// src/modules/hdn/mail/mail-tokens.json. Запуск: node scripts/gen-mail-tokens.mjs. Расхождение ловит pnpm check.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export const MAIL_TOKENS_FILE = 'src/modules/hdn/mail/mail-tokens.json';

/**
 * Переменные блоков с данным селектором в начале строки: светлая тема (:root), слой 3 (@theme), зона клиента.
 * @param {string} css
 * @param {string} selector
 * @returns {Map<string, string>}
 */
function vars(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = css.matchAll(new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)^\\}`, 'gm'));
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const [, body] of blocks)
    for (const [, name, value] of (body ?? '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      if (!found.has(name)) found.set(name, value.trim());
  return found;
}

/**
 * @param {Map<string, string>} map
 * @param {string} name
 */
function take(map, name) {
  const value = map.get(name);
  if (!value) throw new Error(`в tokens.css нет ${name}`);
  return value;
}

/**
 * @param {string} css текст src/ui/tokens.css
 */
export function buildMailTokens(css) {
  const light = vars(css, ':root');
  const theme = vars(css, '@theme');
  const client = vars(css, '[data-zone="client"]');
  const font = take(theme, '--font-sans');
  return {
    color: {
      background: take(light, '--sm-bg'),
      card: take(light, '--sm-card'),
      foreground: take(light, '--sm-ink'),
      secondary: take(light, '--sm-ink2'),
      muted: take(light, '--hub-muted-fg'),
      line: take(light, '--sm-line'),
      soft: take(light, '--sm-soft'),
      primary: take(light, '--sm-pri'),
      onPrimary: take(light, '--hub-on-primary'),
      link: take(light, '--sm-link'),
      tint: take(light, '--sm-tint'),
      tintInk: take(light, '--sm-tintink'),
    },
    radius: { card: take(theme, '--radius-card'), control: take(theme, '--radius-control') },
    // Письмо читают с телефона: размеры зоны клиента (крупнее текст и кнопка не ниже 44 px).
    font: {
      // Почтовые программы не грузят веб-шрифты: Montserrat, если он есть у человека, затем системный.
      family: font.replace('system-ui', 'Arial, Helvetica'),
      size: take(client, '--text-base'),
      lineHeight: take(theme, '--text-base--line-height'),
    },
    control: { height: take(client, '--spacing-control') },
    // Шкала отступов Tailwind по умолчанию (0,25rem): её используют экраны портала, своей шкалы в tokens.css нет.
    space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px' },
    // Ширина письма, высота логотипа и толщина черты: обычные для почтовых программ значения, в портале их нет.
    width: { content: '600px' },
    logo: { height: '32px' },
    border: { width: '1px' },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = readFileSync(resolve(root, 'src/ui/tokens.css'), 'utf8');
  writeFileSync(resolve(root, MAIL_TOKENS_FILE), `${JSON.stringify(buildMailTokens(css), null, 2)}\n`);
  console.log(`Записан ${MAIL_TOKENS_FILE}`);
}
