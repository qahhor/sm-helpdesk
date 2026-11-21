// Модуль hdt, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

import type { DetectedType } from '@/modules/hdc/api';
import { ACCEPTED_TYPES, ALLOWED_FILES, ENCRYPTED_OFFICE_SIGNATURE, MAX_FILE_BYTES, MAX_VIDEO_BYTES, MIME_ALIASES, type RejectReason } from './pref';

// Тема из описания нужна и форме в браузере (подстановка при вводе): общая функция лежит в src/lib/subject.ts.
export { titleFromDescription } from '@/lib/subject';

/** Номер для людей: SUP-1042 (FR-TK-05). */
export const formatNumber = (number: number): string => `SUP-${number}`;

const NUMBER_QUERY = /^\s*(sup-)?(\d{1,12})\s*$/i;

/** Номер из SUP-1042, sup-1042 или 1042. Иначе пусто. */
export function parseNumber(raw: string): number | null {
  const match = NUMBER_QUERY.exec(raw);
  return match ? Number(match[2]) : null;
}

/**
 * Строка поиска в списке обращений (вторая проверка M2). С приставкой SUP- ищется только номер. Одни цифры
 * ищутся и как номер, и в тексте как набраны ("007" остаётся "007", а не 7). Остальное ищется как текст.
 */
export function parseSearch(raw: string): { number?: number; text?: string } {
  const match = NUMBER_QUERY.exec(raw);
  if (!match) return { text: raw };
  const digits = match[2] as string;
  return match[1] ? { number: Number(digits) } : { number: Number(digits), text: digits };
}

/**
 * Тип файла по расширению, сверенный с заявленным браузером (FR-TK-13). null: расширение не из списка
 * или заявлен другой тип (например, text/html для .png). Регистр расширения не важен.
 */
export function fileTypeOf(fileName: string, declared: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  const mime = Object.hasOwn(ALLOWED_FILES, ext) ? ALLOWED_FILES[ext] : undefined;
  if (!mime) return null;
  const given = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (given === '' || given === 'application/octet-stream' || given === mime || MIME_ALIASES[ext]?.includes(given)) return mime;
  return null;
}

/** Предел размера для типа: видео MP4 до 50 МБ, остальное до 25 МБ. */
export const maxBytesFor = (mime: string): number => (mime === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES);

/** Ключи хранилища (раздел 11.11): до проверки файл лежит в карантине, после чистой проверки в папке организации. */
export const quarantineKey = (attachmentId: string): string => `quarantine/${attachmentId}`;
export const fileKey = (orgId: string, attachmentId: string): string => `files/${orgId}/${attachmentId}`;

/** Допустим ли настоящий тип файла для его заявленного типа (ACCEPTED_TYPES). */
export const typeMatches = (mime: string, detected: DetectedType): boolean => ACCEPTED_TYPES[mime]?.includes(detected) ?? false;

/**
 * Причина отказа по подписи (решение 0027, пункт 20). Эвристики ClamAV Heuristics.Encrypted.* и
 * Heuristics.Limits.Exceeded.* означают "проверить нельзя", а не "заражён". Остальные подписи: null.
 */
export function rejectReasonOf(signature: string | null): RejectReason | null {
  if (signature === null) return null;
  if (signature === ENCRYPTED_OFFICE_SIGNATURE || signature.startsWith('Heuristics.Encrypted.')) return 'encrypted';
  if (signature.startsWith('Heuristics.Limits.Exceeded.')) return 'limits';
  return null;
}

/** Документ Office нового формата в контейнере OLE: так хранится документ с паролем. */
export const isEncryptedOffice = (mime: string, detected: DetectedType): boolean =>
  detected === 'ole' && mime.startsWith('application/vnd.openxmlformats-officedocument.');

const LETTER = /[\p{L}\p{N}_]/u;

/**
 * Кого упомянули во внутренней заметке (UX-A-05): "@" в начале слова и полное имя сотрудника, или одно имя,
 * если такое имя у сотрудников одно. Регистр не важен, после имени не должно идти буквы. Порядок первого упоминания.
 */
export function findMentions(body: string, people: readonly { userId: string; name: string }[]): string[] {
  const firstNames = new Map<string, number>();
  for (const person of people) {
    const first = person.name.trim().split(/\s+/)[0]?.toLocaleLowerCase('ru') ?? '';
    if (first) firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  // Длинные варианты первыми: "@Азиз Рахимов" не должно совпасть с "Азиз".
  const variants = people
    .flatMap((person) => {
      const full = person.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
      const first = full.split(' ')[0] ?? '';
      return [{ userId: person.userId, text: full }, ...(first !== full && firstNames.get(first) === 1 ? [{ userId: person.userId, text: first }] : [])];
    })
    .filter((variant) => variant.text.length > 0)
    .sort((a, b) => b.text.length - a.text.length);
  const lower = body.toLocaleLowerCase('ru');
  const found: string[] = [];
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && LETTER.test(lower[at - 1] ?? '')) continue;
    const rest = lower.slice(at + 1).replace(/^(\S+)\s+/, (_, word: string) => `${word} `);
    const hit = variants.find((variant) => rest.startsWith(variant.text) && !LETTER.test(rest[variant.text.length] ?? ''));
    if (hit && !found.includes(hit.userId)) found.push(hit.userId);
  }
  return found;
}

/** Срок "взять в работу" для второй линии, рабочих минут (FR-LINE-06): из настройки по приоритету, иначе срок первого ответа. */
export function pickupMinutes(priority: string, setting: unknown, firstResponseMinutes: number): number {
  if (setting && typeof setting === 'object' && !Array.isArray(setting)) {
    const value = (setting as Record<string, unknown>)[priority];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000) return value;
  }
  return firstResponseMinutes;
}
