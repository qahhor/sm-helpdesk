import { expect, test } from 'vitest';
import { formatDate, formatDateTime, formatNumber } from '@/i18n/format';

// В Ташкенте в этот момент уже 11.11.2026, 00:30.
const d = new Date('2026-11-10T19:30:00Z');
const NBSP = String.fromCharCode(0xa0);

test('даты считаются по часовому поясу Asia/Tashkent (FR-I18N-08)', () => {
  expect(formatDate(d, 'ru')).toBe('11.11.2026');
  expect(formatDate(d, 'uz')).toBe('11.11.2026');
  expect(formatDate(d, 'en')).toBe('11 Nov 2026');
  expect(formatDateTime(d, 'ru')).toBe('11.11.2026, 00:30');
  expect(formatDateTime(d, 'uz')).toBe('11.11.2026, 00:30');
  expect(formatDateTime(d, 'en')).toBe('11 Nov 2026, 00:30');
  expect(formatDate(d, 'ru', 'UTC')).toBe('10.11.2026');
});

test('числа: разряды по правилам языка', () => {
  expect(formatNumber(1250000, 'ru')).toBe(`1${NBSP}250${NBSP}000`);
  expect(formatNumber(1250000, 'uz')).toBe(`1${NBSP}250${NBSP}000`);
  expect(formatNumber(1250000, 'en')).toBe('1,250,000');
});

test('четырёхзначное число тоже делится на разряды', () => {
  expect(formatNumber(1500, 'ru')).toBe(`1${NBSP}500`);
  expect(formatNumber(999, 'ru')).toBe('999');
});
