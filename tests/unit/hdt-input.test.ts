import { expect, test } from 'vitest';
import { presignUploadInput } from '@/modules/hdt/input';

// Имя файла показывается сотрудникам и коллегам клиента как есть (вторая проверка M2).

const accepts = (fileName: string) => presignUploadInput.safeParse({ fileName, size: 1 }).success;

test('имя файла без невидимых знаков: смена направления текста, нулевой ширины и разделители строк не принимаются', () => {
  // "photo\u202Egnp.txt" выглядит как "phototxt.png": расширение подменено для глаза.
  for (const name of ['photo\u202Egnp.txt', 'отчёт\u2066.pdf', 'a\u200Bb.txt', 'от\uFEFFчёт.pdf', 'a\u2060b.txt', 'a\u200Eb.txt', 'a\u2028b.txt', 'a\u2029b.txt'])
    expect(accepts(name), JSON.stringify(name)).toBe(false);
  // Обычные имена, в том числе эмодзи из нескольких символов (соединитель нулевой ширины в них законен).
  for (const name of ['Скриншот 2026-11-21.png', 'hisobot (1).xlsx', 'O\u2018zbekiston.pdf', '\u{1F468}\u200D\u{1F4BB} отчёт.pdf', 'ошибка_синхронизации.log'])
    expect(accepts(name), name).toBe(true);
  // Метку порядка байт в начале имени срезает trim: сохраняется чистое имя.
  expect(presignUploadInput.parse({ fileName: '\uFEFFотчёт.pdf', size: 1 }).fileName).toBe('отчёт.pdf');
});
