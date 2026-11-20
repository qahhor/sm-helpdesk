import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/locales';

// Политика обработки данных (раздел 14.6 ТЗ, решение 0017). Текст лежит файлами в content/legal/:
// manifest.json с версией и privacy.<язык>.md. Пока manifest.json нет, политика выключена:
// страницы нет, строк о ней нет. Текст утверждает владелец продукта вместе с юристом.
//
// Формат намеренно простой: "# " заголовок, "## " подзаголовок, "- " пункт списка, остальное абзацы
// (соседние строки абзаца склеиваются). Разметка HTML и ссылки не разбираются: всё выводится как текст.

export type PolicyBlock = { kind: 'h1' | 'h2' | 'p' | 'li'; text: string };
export type Policy = { version: string; locale: Locale; blocks: PolicyBlock[] };

/** Версия политики: дата вида 2026-12-01. Она же попадает в учётную запись пользователя. */
export const POLICY_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_DIR = join(process.cwd(), 'content', 'legal');

/** Разбор текста политики на заголовки, абзацы и пункты. */
export function parsePolicy(source: string): PolicyBlock[] {
  const blocks: PolicyBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') flush();
    else if (line.startsWith('## ')) {
      flush();
      blocks.push({ kind: 'h2', text: line.slice(3).trim() });
    } else if (line.startsWith('# ')) {
      flush();
      blocks.push({ kind: 'h1', text: line.slice(2).trim() });
    } else if (line.startsWith('- ')) {
      flush();
      blocks.push({ kind: 'li', text: line.slice(2).trim() });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Действующая версия политики из manifest.json. Пусто: политика выключена или файл испорчен. */
export async function getPolicyVersion(dir: string = DEFAULT_DIR): Promise<string | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  const version = (manifest as { privacy?: { version?: unknown } } | null)?.privacy?.version;
  return typeof version === 'string' && POLICY_VERSION_PATTERN.test(version) ? version : null;
}

/**
 * Текст политики на языке посетителя, иначе русский. Имя файла строится только из известного кода языка:
 * значение снаружи в путь не попадает. Пусто, если политика выключена или нет русского текста.
 */
export async function getPolicy(locale: Locale, dir: string = DEFAULT_DIR): Promise<Policy | null> {
  const version = await getPolicyVersion(dir);
  if (!version) return null;
  const candidates: Locale[] = isLocale(locale) && locale !== DEFAULT_LOCALE ? [locale, DEFAULT_LOCALE] : [DEFAULT_LOCALE];
  for (const candidate of candidates) {
    try {
      const source = await readFile(join(dir, `privacy.${candidate}.md`), 'utf8');
      return { version, locale: candidate, blocks: parsePolicy(source) };
    } catch {
      // Перевода нет: следующий язык.
    }
  }
  return null;
}
