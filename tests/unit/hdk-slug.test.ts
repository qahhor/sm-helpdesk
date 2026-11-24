import { expect, test } from 'vitest';
import { parseSolutionRef, solutionSlug } from '@/modules/hdk/slug';

// Адрес решения /help/a/{номер}-{slug} (правка 11 раздела 10.6; план M5, задача 4).

test('slug из заголовка: кириллица и узбекская латиница в латиницу, строчные, дефисы', () => {
  expect(solutionSlug('Остаток не списывается!')).toBe('ostatok-ne-spisyvaetsya');
  expect(solutionSlug("Qoldiq o'chmayapti")).toBe('qoldiq-ochmayapti');
  expect(solutionSlug('Ошибка ORA-20001 при проведении')).toBe('oshibka-ora-20001-pri-provedenii');
  expect(solutionSlug('Ёлка, щука и объём')).toBe('yolka-shchuka-i-obyom');
});

test('slug не длиннее 80 знаков, без дефиса на конце; пустой заголовок даёт solution', () => {
  const slug = solutionSlug('очень '.repeat(40));
  expect(slug.length).toBeLessThanOrEqual(80);
  expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(solutionSlug('!!!')).toBe('solution');
});

test('адрес: номер с slug или без, мусор отклоняется', () => {
  expect(parseSolutionRef('1001-ostatok-ne-spisyvaetsya')).toEqual({ number: 1001, slug: 'ostatok-ne-spisyvaetsya' });
  expect(parseSolutionRef('1001')).toEqual({ number: 1001, slug: '' });
  for (const bad of ['', 'abc', '-1', '0', '1001-', '1001-Ostatok', '1001-a/b', '9999999999999-x']) expect(parseSolutionRef(bad), bad).toBeNull();
});
