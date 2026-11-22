import { expect, test } from 'vitest';
import { filterTemplates, slashQuery } from '@/modules/hdr/util';

// Шаблоны ответов (FR-AG-06, UX-A-05; план M3, задача 10): "/" в поле ответа открывает список с поиском.

const templates = [
  { shortcut: 'greet', title: 'Приветствие', isEnabled: true },
  { shortcut: 'logs', title: 'Попросить журнал ошибок', isEnabled: true },
  { shortcut: 'old-greet', title: 'Старое приветствие', isEnabled: false },
  { shortcut: 'screen', title: 'Попросить снимок экрана', isEnabled: true },
];

test('поиск по "/" находит по коду и названию, выключенные не показаны', () => {
  expect(filterTemplates(templates, '').map((t) => t.shortcut)).toEqual(['greet', 'logs', 'screen']);
  expect(filterTemplates(templates, 'gr').map((t) => t.shortcut)).toEqual(['greet']);
  expect(filterTemplates(templates, 'попросить').map((t) => t.shortcut)).toEqual(['logs', 'screen']);
  expect(filterTemplates(templates, 'ЭКРАН').map((t) => t.shortcut)).toEqual(['screen']);
  expect(filterTemplates(templates, 'нет такого')).toEqual([]);
  // Совпадение кода с начала выше совпадения в названии.
  expect(filterTemplates([...templates, { shortcut: 'x', title: 'logs в названии', isEnabled: true }], 'logs').map((t) => t.shortcut)).toEqual(['logs', 'x']);
});

test('"/" открывает поиск только в начале слова перед кареткой', () => {
  expect(slashQuery('/gr', 3)).toEqual({ start: 0, query: 'gr' });
  expect(slashQuery('Добрый день!\n/logs', 18)).toEqual({ start: 13, query: 'logs' });
  expect(slashQuery('Текст /', 7)).toEqual({ start: 6, query: '' });
  expect(slashQuery('https://example.com', 19)).toBeNull();
  expect(slashQuery('1/2', 3)).toBeNull();
  expect(slashQuery('/gr и дальше', 12)).toBeNull();
});
