import { readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { FALLBACKS, LOCALES } from '@/i18n/locales';
import { loadMessages, localeNames } from '@/i18n/messages';

const sources = {
  ru: { common: { a: 'А', b: 'Б' } },
  uz: { common: { a: 'A-uz' } },
  en: { common: { a: 'A-en', b: 'B-en' } },
};

test('недостающий ключ берётся из запасного языка по цепочке (FR-I18N-05)', async () => {
  expect((await loadMessages('uz', sources)).common).toEqual({ a: 'A-uz', b: 'Б' });
});

test('свой перевод не заменяется запасным, вложенные объекты объединяются', async () => {
  const nested = {
    ru: { client: { home: { title: 'Чем помочь?', idea: 'Предложить идею' } } },
    uz: { client: { home: { title: 'Sizga qanday yordam kerak?' } } },
    en: { client: { home: { title: 'How can we help?', idea: 'Suggest an idea', extra: 'Only en' } } },
  };
  expect(await loadMessages('uz', nested)).toEqual({
    client: { home: { title: 'Sizga qanday yordam kerak?', idea: 'Предложить идею', extra: 'Only en' } },
  });
});

test('исходные сообщения при объединении не меняются', async () => {
  const copy = structuredClone(sources);
  await loadMessages('uz', sources);
  expect(sources).toEqual(copy);
});

test('в файлах нет языков сверх LOCALES и наоборот', () => {
  expect(
    readdirSync('messages')
      .map((f) => f.replace('.json', ''))
      .sort(),
  ).toEqual([...LOCALES].sort());
});

test('цепочки запасных языков заданы для каждого языка и не ссылаются на себя', () => {
  for (const locale of LOCALES) {
    expect(FALLBACKS[locale], locale).toBeDefined();
    expect(FALLBACKS[locale]).not.toContain(locale);
    for (const fallback of FALLBACKS[locale]) expect(LOCALES).toContain(fallback);
  }
});

test('название каждого языка на нём самом берётся из его файла', async () => {
  expect(await localeNames()).toMatchObject({ ru: 'Русский', uz: "O'zbekcha", en: 'English' });
  expect(Object.keys(await localeNames()).sort()).toEqual([...LOCALES].sort());
});

test('настоящие файлы: главная переведена на три языка', async () => {
  expect(((await loadMessages('ru')).client as { home: { title: string } }).home.title).toBe('Чем помочь?');
  expect(((await loadMessages('uz')).client as { home: { title: string } }).home.title).toBe(
    'Sizga qanday yordam kerak?',
  );
  expect(((await loadMessages('en')).client as { home: { title: string } }).home.title).toBe('How can we help?');
});
