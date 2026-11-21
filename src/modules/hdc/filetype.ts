// Настоящий тип файла по первым байтам (угроза T6, решение 0027). Расширение и заявленный тип браузера
// подделать легко, поэтому перед выдачей файл сверяется по содержимому. HTML и SVG узнаются всегда:
// их нельзя отдавать ни под каким расширением.

export const DETECTED_TYPES = ['png', 'jpeg', 'gif', 'webp', 'heic', 'pdf', 'zip', 'ole', 'mp4', 'text', 'html', 'svg', 'executable', 'unknown'] as const;
export type DetectedType = (typeof DETECTED_TYPES)[number];

/** Сколько первых байт достаточно для определения. */
export const SNIFF_BYTES = 4096;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

const startsWith = (head: Uint8Array, signature: readonly number[], offset = 0) =>
  head.length >= offset + signature.length && signature.every((byte, i) => head[offset + i] === byte);
const ascii = (head: Uint8Array, from: number, to: number) => String.fromCharCode(...head.subarray(from, to));

/** Начало текстового файла без BOM и пробелов, в нижнем регистре, для поиска разметки. */
function markupStart(head: Uint8Array): string {
  const textHead = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, SNIFF_BYTES));
  return textHead.replace(/^\uFEFF/, '').trimStart().toLowerCase();
}

/**
 * Теги, по которым браузер узнаёт HTML в начале файла (WHATWG MIME Sniffing, шаблон HTML), и теги, которые
 * исполняют сценарий или отправляют данные сами по себе (img, form, input, base, frame).
 */
const HTML_START =
  /^<(?:!doctype\s+html|html|head|body|script|iframe|frameset|frame|object|embed|meta|link|style|base|title|div|span|p|a|b|i|u|br|hr|h[1-6]|font|table|form|input|button|textarea|select|img|video|audio|template|math)[\s>/]/;

/** Разметка, которую браузер исполнит: HTML и SVG, в том числе после пролога XML и комментариев. */
function markupType(start: string): 'html' | 'svg' | null {
  if (HTML_START.test(start)) return 'html';
  if (/^<svg[\s>/]/.test(start)) return 'svg';
  if (start.startsWith('<?xml') || start.startsWith('<!--') || start.startsWith('<!doctype')) {
    // После пролога, комментариев и объявления типа первым элементом идёт svg или тег HTML.
    const rest = start.replace(/^(?:<\?[^]*?\?>|<!--[^]*?-->|<!doctype[^>]*>|\s+)*/, '');
    if (/^<svg[\s>/]/.test(rest)) return 'svg';
    if (HTML_START.test(rest)) return 'html';
  }
  return null;
}

export function sniffFileType(head: Uint8Array): DetectedType {
  if (head.length === 0) return 'unknown';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp';
  if (ascii(head, 4, 8) === 'ftyp') return HEIC_BRANDS.has(ascii(head, 8, 12)) ? 'heic' : 'mp4';
  if (ascii(head, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  // Windows (MZ), Linux (ELF), macOS (Mach-O, в том числе универсальный).
  if (ascii(head, 0, 2) === 'MZ' || ascii(head, 0, 4) === '\x7fELF') return 'executable';
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ])
    if (startsWith(head, magic)) return 'executable';
  // Текст в UTF-16 с меткой порядка байт (журналы Windows, "Юникод-текст" Excel): нулевые байты в нём законны.
  // Метка перед двоичными данными текстом их не делает: символ U+0000, управляющие символы и битые суррогаты
  // (U+FFFD) в тексте не встречаются. Одна битая пара допустима: начало файла могло разрезать её на краю.
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) {
    const encoding = head[0] === 0xff ? 'utf-16le' : 'utf-16be';
    const decoded = new TextDecoder(encoding).decode(head.subarray(2, SNIFF_BYTES));
    if (/[\u0000-\u0008\u000E-\u001F]/.test(decoded) || (decoded.match(/\uFFFD/g)?.length ?? 0) > 1) return 'unknown';
    return markupType(decoded.trimStart().toLowerCase()) ?? 'text';
  }
  if (head.subarray(0, SNIFF_BYTES).includes(0)) return 'unknown';
  return markupType(markupStart(head)) ?? 'text';
}
