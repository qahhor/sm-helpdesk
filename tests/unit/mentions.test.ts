import { expect, test } from 'vitest';
import { findMentions } from '@/modules/hdt/util';

// Упоминания коллег во внутренней заметке (UX-A-05; план M3, задача 8): "@" и имя сотрудника.

const people = [
  { userId: 'kamila', name: 'Камила Юсупова' },
  { userId: 'aziz-k', name: 'Азиз Каримов' },
  { userId: 'aziz-r', name: 'Азиз Рахимов' },
  { userId: 'rustam', name: 'Rustam Aliev' },
];

test('полное имя и имя, если оно единственное, без учёта регистра', () => {
  expect(findMentions('@Камила Юсупова, посмотри логи', people)).toEqual(['kamila']);
  expect(findMentions('@камила посмотри логи', people)).toEqual(['kamila']);
  expect(findMentions('Передаю @rustam и @Камила.', people)).toEqual(['rustam', 'kamila']);
});

test('два сотрудника с одним именем: упоминание только полным именем', () => {
  expect(findMentions('@Азиз проверь', people)).toEqual([]);
  expect(findMentions('@Азиз Рахимов проверь', people)).toEqual(['aziz-r']);
});

test('часть имени, адрес почты и повтор не создают лишних упоминаний', () => {
  expect(findMentions('@Ками посмотри', people)).toEqual([]);
  expect(findMentions('пишите на support@Камила.uz', people)).toEqual([]);
  expect(findMentions('@Камила и снова @Камила Юсупова', people)).toEqual(['kamila']);
  expect(findMentions('без упоминаний', people)).toEqual([]);
});
