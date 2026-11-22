import { type DefaultTreeAdapterMap, parse } from 'parse5';
import type { Locale } from '@/i18n/locales';
import { cleanUserText } from '@/modules/hdc/pref';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { REPLY_MARKERS } from '../mail/render';
import { plain } from '../mail/sanitize';

// Письмо в текст (FR-EM-15, FR-NT-05, угроза T31, решение 0030). Есть текстовая часть: берётся она. Нет: HTML
// разбирается parse5, скрытое выбрасывается. Затем отрезается цитата прошлых писем и подпись, очищаются невидимые
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

/** Скрыто ли содержимое элемента от читателя письма. Белый цвет записан как #f{3}: это шаблон распознавания, а не цвет. */
function hidden(el: Element): boolean {
  if (attr(el, 'hidden') !== undefined) return true;
  const style = (attr(el, 'style') ?? '').toLowerCase().replace(/\s+/g, '');
  if (!style) return false;
  if (/(?:^|;)display:none/.test(style) || /(?:^|;)visibility:hidden/.test(style) || /(?:^|;)mso-hide:all/.test(style)) return true;
  if (/(?:^|;)font-size:0(?:px|pt|em|rem|%)?(?:;|$|!)/.test(style)) return true;
  if (/(?:^|;)opacity:0(?:\.0+)?(?:;|$|!)/.test(style)) return true;
  if (/(?:^|;)color:(?:#f{3}(?:f{3})?|white|transparent|rgba?\(255,255,255(?:,[\d.]+)?\)|rgba\(\d+,\d+,\d+,0\))(?:;|$|!)/.test(style)) return true;
  if (/(?:^|;)(?:max-)?height:0(?:px)?(?:;|$|!)/.test(style) && /(?:^|;)overflow:hidden/.test(style)) return true;
  return false;
}

function quoteBlock(el: Element): boolean {
  const classes = (attr(el, 'class') ?? '').toLowerCase().split(/\s+/);
  if (QUOTE_CLASSES.some((name) => classes.includes(name))) return true;
  return el.tagName === 'blockquote' && (attr(el, 'type') ?? '').toLowerCase() === 'cite';
}

/** Текст HTML без скрытого и без цитаты. */
function htmlToText(html: string): string {
  const out: string[] = [];
  let stopped = false;
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
    if (CUT_IDS.has((attr(el, 'id') ?? '').toLowerCase())) {
      stopped = true;
      return;
    }
    if (SKIPPED.has(el.tagName) || hidden(el) || quoteBlock(el)) return;
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
  walk(parse(html));
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

/** Письмо в текст: текстовая часть или HTML без скрытого, без цитаты, без невидимых знаков. */
export function emailToText(content: { html: string | null; text: string | null }): string {
  const source = content.text?.trim() ? content.text : content.html?.trim() ? htmlToText(content.html) : '';
  return cleanUserText(stripQuote(cleanUserText(source))).trim();
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
