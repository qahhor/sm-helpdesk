import { type DefaultTreeAdapterMap, parse } from 'parse5';
import type { Locale } from '@/i18n/locales';
import { cleanUserText } from '@/modules/hdc/pref';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { REPLY_MARKERS } from '../mail/render';
import { plain } from '../mail/sanitize';

// Письмо в текст (FR-EM-15, FR-NT-05, угроза T31, решение 0030). Есть текстовая часть: берётся она. Нет: HTML
// разбирается parse5, скрытое выбрасывается: по встроенным стилям и по правилам <style> с простыми селекторами класса,
// идентификатора и тега (план M5b, решение 20): display, visibility, шрифт меньше 4px, прозрачность меньше 0,1, вынос
// за экран, почти белый цвет, нулевая высота со скрытым переполнением. Затем отрезается цитата прошлых писем и подпись, очищаются невидимые
// знаки. Сотрудник видит ровно этот текст, его же получит модель: скрытого для одного и видимого для другого нет.

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

/** Длина темы обращения из письма, знаков. */
export const SUBJECT_MAX = 200;

const SKIPPED = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'img', 'video', 'audio']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'hr', 'center']);
const QUOTE_CLASSES = ['gmail_quote', 'yahoo_quoted', 'moz-cite-prefix', 'protonmail_quote'];
/** После этих элементов Outlook и Thunderbird ставят прошлую переписку: всё дальше отрезается. */
const CUT_IDS = new Set(['divrplyfwdmsg', 'appendonsend', 'mail-editor-reference-message-container']);

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

/** Объявления стиля "свойство: значение" в нижнем регистре, без !important и комментариев. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of css.replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase().split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).replace(/!important/g, '').trim();
    if (name && value) out.set(name, value);
  }
  return out;
}

/** Цвета, почти белые на вид (FR-EM-15, план M5b, решение 20): белый текст на белом фоне письма. */
const NEAR_WHITE_NAMES = new Set(['white', 'snow', 'ivory', 'ghostwhite', 'whitesmoke', 'floralwhite', 'mintcream', 'azure', 'aliceblue', 'seashell', 'honeydew', 'linen', 'oldlace', 'lavenderblush']);

/** Яркость цвета по WCAG 2: 0 чёрный, 1 белый. Нераспознанный цвет: null. */
function luminance(color: string): number | null {
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(color);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (fn) {
    // Почти прозрачный цвет текста не виден: считается белым.
    if (fn[4] !== undefined && Number(fn[4]) < 0.1) return 1;
    rgb = [fn[1], fn[2], fn[3]].map(Number);
  }
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = Math.min(255, v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Размер шрифта в пикселях; проценты и em от 16px. */
function fontPx(value: string): number | null {
  const m = /^(-?[\d.]+)(px|pt|em|rem|%)?$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'pt' ? n * (4 / 3) : m[2] === 'em' || m[2] === 'rem' ? n * 16 : m[2] === '%' ? (n / 100) * 16 : n;
}

/** Отступ дальше -999px: текст вынесен за экран. */
const offscreen = (value: string | undefined) => {
  const m = value ? /^(-[\d.]+)(px|pt|em|rem)?$/.exec(value) : null;
  return m ? Number(m[1]) * (m[2] === 'em' || m[2] === 'rem' ? 16 : 1) <= -999 : false;
};

/** Скрывают ли объявления стиля текст от читателя письма (встроенный стиль или правило <style>). */
function hiddenStyle(style: Map<string, string>): boolean {
  if (style.get('display') === 'none' || style.get('visibility') === 'hidden' || style.get('mso-hide') === 'all') return true;
  const size = style.get('font-size');
  const px = size ? fontPx(size) : null;
  if (px !== null && px < 4) return true;
  const opacity = style.get('opacity');
  if (opacity !== undefined && Number.isFinite(Number(opacity)) && Number(opacity) < 0.1) return true;
  const color = style.get('color');
  if (color && (color === 'transparent' || NEAR_WHITE_NAMES.has(color) || (luminance(color.replace(/\s+/g, ' ')) ?? 0) > 0.92)) return true;
  const position = style.get('position');
  if ((position === 'absolute' || position === 'fixed') && ['left', 'top', 'right', 'bottom'].some((side) => offscreen(style.get(side)))) return true;
  if (offscreen(style.get('text-indent'))) return true;
  const zero = (v: string | undefined) => v !== undefined && /^0(?:px|pt|em|rem|%)?$/.test(v);
  if ((zero(style.get('height')) || zero(style.get('max-height'))) && style.get('overflow') === 'hidden') return true;
  return false;
}

/** Простой селектор правила: тег, классы и идентификатор последнего звена (без каскада и специфичности). */
type SimpleSelector = { tag: string | null; classes: string[]; id: string | null };
type StyleRule = { selector: SimpleSelector; hides: boolean };

/** Правила <style> письма, которые скрывают текст. Псевдоклассы, атрибуты и сложные селекторы не разбираются. */
function styleRules(css: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Самые внутренние блоки "селектор { объявления }": правила внутри @media тоже считаются.
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const hides = hiddenStyle(declarations(match[2] ?? ''));
    if (!hides) continue;
    for (const raw of (match[1] ?? '').split(',')) {
      const last = raw.trim().toLowerCase().split(/[\s>+~]+/).pop() ?? '';
      if (!last || last.startsWith('@') || /[:[\]()*]/.test(last)) continue;
      const parsed = /^([a-z][a-z0-9-]*)?((?:[.#][a-z0-9_-]+)*)$/.exec(last);
      if (!parsed || (!parsed[1] && !parsed[2])) continue;
      const parts = parsed[2]!.match(/[.#][a-z0-9_-]+/g) ?? [];
      rules.push({ selector: { tag: parsed[1] ?? null, classes: parts.filter((p) => p.startsWith('.')).map((p) => p.slice(1)), id: parts.find((p) => p.startsWith('#'))?.slice(1) ?? null }, hides });
    }
  }
  return rules;
}

function matches(el: Element, selector: SimpleSelector): boolean {
  if (selector.tag && el.tagName !== selector.tag) return false;
  const classes = (attr(el, 'class') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (selector.classes.some((c) => !classes.includes(c))) return false;
  return !selector.id || (attr(el, 'id') ?? '').toLowerCase() === selector.id;
}

/** Скрыто ли содержимое элемента от читателя письма: атрибут hidden, встроенный стиль или правило <style>. */
function hidden(el: Element, rules: readonly StyleRule[]): boolean {
  if (attr(el, 'hidden') !== undefined) return true;
  const style = attr(el, 'style');
  if (style && hiddenStyle(declarations(style))) return true;
  return rules.some((rule) => rule.hides && matches(el, rule.selector));
}

/** Тексты всех элементов <style> документа. */
function collectStyles(node: Node, out: string[]): void {
  if ('tagName' in node && (node as Element).tagName === 'style')
    for (const child of (node as Element).childNodes) if (child.nodeName === '#text') out.push((child as DefaultTreeAdapterMap['textNode']).value);
  if ('childNodes' in node) for (const child of node.childNodes) collectStyles(child, out);
}

function quoteBlock(el: Element): boolean {
  const classes = (attr(el, 'class') ?? '').toLowerCase().split(/\s+/);
  if (QUOTE_CLASSES.some((name) => classes.includes(name))) return true;
  return el.tagName === 'blockquote' && (attr(el, 'type') ?? '').toLowerCase() === 'cite';
}

/** Текст HTML без скрытого; без цитаты, если keepQuote ложь. */
function htmlToText(html: string, keepQuote = false): string {
  const out: string[] = [];
  let stopped = false;
  let rules: StyleRule[] = [];
  const newline = () => {
    if (out.length > 0 && !out[out.length - 1]?.endsWith('\n')) out.push('\n');
  };
  const walk = (node: Node) => {
    if (stopped) return;
    if (node.nodeName === '#text') {
      out.push((node as DefaultTreeAdapterMap['textNode']).value.replace(/\s+/g, ' '));
      return;
    }
    if (!('tagName' in node)) {
      if ('childNodes' in node) for (const child of node.childNodes) walk(child);
      return;
    }
    const el = node as Element;
    if (!keepQuote && CUT_IDS.has((attr(el, 'id') ?? '').toLowerCase())) {
      stopped = true;
      return;
    }
    if (SKIPPED.has(el.tagName) || hidden(el, rules) || (!keepQuote && quoteBlock(el))) return;
    if (el.tagName === 'br') {
      out.push('\n');
      return;
    }
    const block = BLOCKS.has(el.tagName) || el.tagName === 'li' || el.tagName === 'blockquote';
    if (block) newline();
    if (el.tagName === 'p' || el.tagName === 'ul' || el.tagName === 'ol') if (out.length > 0) out.push('\n');
    if (el.tagName === 'li') out.push('- ');
    const start = out.length;
    for (const child of el.childNodes) walk(child);
    if (el.tagName === 'a') {
      const href = attr(el, 'href') ?? '';
      const label = out.slice(start).join('').trim();
      if (/^https?:\/\//i.test(href) && label && label !== href) out.push(` (${href})`);
    }
    if (block) newline();
  };
  const doc = parse(html);
  const css: string[] = [];
  collectStyles(doc, css);
  rules = styleRules(css.join('\n'));
  walk(doc);
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const normalize = (line: string) => line.replace(/^[\s>]+/, '').trim();

const HEADER_LINES = [
  /^On\s.+\swrote:$/i,
  /^.{0,200}\s(?:написал|написала|написал\(а\)|пишет|yozdi|yozgan):$/i,
  /^.{0,200}<[^<>\s]+@[^<>\s]+>:$/,
  /^-{2,}\s*(?:Original Message|Исходное сообщение|Пересылаемое сообщение|Forwarded message)\s*-{2,}$/i,
  /^_{20,}$/,
];
const FROM_LINE = /^(?:From|От|Kimdan):\s/i;
const SENT_LINE = /^(?:Sent|Date|Отправлено|Дата|Yuborildi|Sana):\s/i;
const MOBILE_SIGNATURE = /^(?:Sent from my\s|Отправлено с\s|Отправлено из\s|Get Outlook for\s)/i;
const markers = new Set(REPLY_MARKERS.map((m) => m.trim()));

/** Новый текст ответа без цитаты прошлых писем и без подписи. */
export function stripQuote(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = normalize(raw);
    const next = normalize(lines[i + 1] ?? '');
    if (markers.has(line)) break;
    if (raw.trim() === '--' || raw === '-- ') break;
    if (HEADER_LINES.some((re) => re.test(line))) break;
    // "On ... <адрес>" и "wrote:" на следующей строке (Gmail переносит длинную строку).
    if (/^On\s/i.test(line) && /^wrote:$/i.test(next)) break;
    if (FROM_LINE.test(line) && lines.slice(i + 1, i + 5).some((l) => SENT_LINE.test(normalize(l)))) break;
    if (MOBILE_SIGNATURE.test(line)) break;
    if (raw.trimStart().startsWith('>')) continue;
    kept.push(raw);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Письмо в текст: текстовая часть или HTML без скрытого, без невидимых знаков. Цитата прошлых писем отрезается у ответа
 * в обращение; у нового обращения (keepQuote) остаётся: пересланное письмо и есть суть обращения (итоговая проверка M4).
 */
export function emailToText(content: { html: string | null; text: string | null }, opts: { keepQuote?: boolean } = {}): string {
  const keep = opts.keepQuote ?? false;
  const source = content.text?.trim() ? content.text : content.html?.trim() ? htmlToText(content.html, keep) : '';
  const text = cleanUserText(source);
  return (keep ? text : cleanUserText(stripQuote(text))).replace(/\n{3,}/g, '\n\n').trim();
}

const NO_SUBJECT = { ru: ru.mail.noSubject, uz: uz.mail.noSubject, en: en.mail.noSubject } as const;
const PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|tr|отв|ответ|пересл|переслать|res)(?:\s*\[\d+\])?\s*:\s*)+/i;
const TAG = /\[SUP-\d+\]\s*/gi;

/** Тема обращения из темы письма: без Re: и Fwd:, без метки номера, без невидимых знаков, до 200 знаков. */
export function cleanSubject(subject: string, locale: Locale): string {
  let text = cleanUserText(subject).replace(TAG, '');
  for (let i = 0; i < 5 && PREFIX.test(text); i++) text = text.replace(PREFIX, '').replace(TAG, '');
  text = plain(text, SUBJECT_MAX);
  const chars = Array.from(text);
  if (chars.length > SUBJECT_MAX) text = `${chars.slice(0, SUBJECT_MAX - 3).join('')}...`;
  return text || NO_SUBJECT[locale];
}
