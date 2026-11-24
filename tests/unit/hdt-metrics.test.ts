import { expect, test } from 'vitest';
import { TASHKENT_DEFAULT } from '@/modules/hdt/sla';
import { average, buildCsv, CSV_BOM, csvCell, decimal, lineOf, lineUsage, median, METRICS_MAX_DAYS, parsePeriod, percent, splitMinutes } from '@/modules/hdt/metrics-util';

// Показатели (FR-MET-01, 04; план M8, задача 9, решения 15 и 16): разбор периода, сборка CSV и расчёт линии.
// Чистые функции без базы.

const TZ = 'Asia/Tashkent';
// 24.11.2026 15:00 по Ташкенту (UTC+5).
const NOW = new Date('2026-11-24T10:00:00Z');

test('период 7, 30 и 90 дней: сегодня входит, границы по полуночи Ташкента', () => {
  const week = parsePeriod({ period: '7' }, NOW, TZ);
  expect(week).toMatchObject({ preset: '7', fromDay: '2026-11-18', toDay: '2026-11-24', days: 7 });
  expect(week?.from.toISOString()).toBe('2026-11-17T19:00:00.000Z');
  expect(week?.to.toISOString()).toBe('2026-11-24T19:00:00.000Z');
  expect(parsePeriod({ period: '30' }, NOW, TZ)).toMatchObject({ fromDay: '2026-10-26', toDay: '2026-11-24', days: 30 });
  expect(parsePeriod({ period: '90' }, NOW, TZ)).toMatchObject({ fromDay: '2026-08-27', toDay: '2026-11-24', days: 90 });
  // Период не назван: 30 дней.
  expect(parsePeriod({}, NOW, TZ)).toMatchObject({ preset: '30', days: 30 });
  // Поздний вечер по UTC это уже следующий день в Ташкенте.
  expect(parsePeriod({ period: '7' }, new Date('2026-11-24T20:30:00Z'), TZ)).toMatchObject({ fromDay: '2026-11-19', toDay: '2026-11-25' });
});

test('свой период: обе даты входят, не длиннее 366 дней, мусор отклоняется', () => {
  const custom = parsePeriod({ period: 'custom', from: '2026-11-01', to: '2026-11-10' }, NOW, TZ);
  expect(custom).toMatchObject({ preset: 'custom', fromDay: '2026-11-01', toDay: '2026-11-10', days: 10 });
  expect(custom?.from.toISOString()).toBe('2026-10-31T19:00:00.000Z');
  expect(custom?.to.toISOString()).toBe('2026-11-10T19:00:00.000Z');
  expect(parsePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-10' }, NOW, TZ)).toMatchObject({ days: 1 });
  expect(METRICS_MAX_DAYS).toBe(366);
  expect(parsePeriod({ period: 'custom', from: '2025-11-24', to: '2026-11-24' }, NOW, TZ)).toMatchObject({ days: 366 });
  expect(parsePeriod({ period: 'custom', from: '2025-11-23', to: '2026-11-24' }, NOW, TZ)).toBeNull();
  // Конец раньше начала, несуществующая дата, чужой вид периода, не строка.
  expect(parsePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-09' }, NOW, TZ)).toBeNull();
  expect(parsePeriod({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW, TZ)).toBeNull();
  expect(parsePeriod({ period: 'custom', from: '2026-11-01' }, NOW, TZ)).toBeNull();
  expect(parsePeriod({ period: '14' }, NOW, TZ)).toBeNull();
  expect(parsePeriod({ period: 'custom', from: "2026-11-01'; drop table", to: '2026-11-02' }, NOW, TZ)).toBeNull();
  expect(parsePeriod({ period: ['7'] }, NOW, TZ)).toBeNull();
});

test('ячейка CSV: кавычки по RFC 4180, формула получает апостроф', () => {
  expect(csvCell('ACME Trade')).toBe('ACME Trade');
  expect(csvCell('a;b')).toBe('"a;b"');
  expect(csvCell('он сказал "да"')).toBe('"он сказал ""да"""');
  expect(csvCell('две\nстроки')).toBe('"две\nстроки"');
  expect(csvCell(null)).toBe('');
  expect(csvCell(42)).toBe('42');
  // Формулы Excel (решение 16, пункт 6 проверки): текст с такого знака не исполняется.
  expect(csvCell('=HYPERLINK("http://evil.example";"x")')).toBe(`"'=HYPERLINK(""http://evil.example"";""x"")"`);
  expect(csvCell('+1')).toBe("'+1");
  expect(csvCell('-1')).toBe("'-1");
  expect(csvCell('@x')).toBe("'@x");
  expect(csvCell('\tcmd')).toBe("'\tcmd");
  expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
  // Пробелы перед знаком формулу не прячут.
  expect(csvCell('  =1+1')).toBe("'  =1+1");
});

test('файл CSV: метка порядка байтов, точка с запятой, CRLF, строка об усечении первой', () => {
  const csv = buildCsv(['Организация', 'Создано'], [['ACME; Trade', 3], ['=cmd', 1]]);
  expect(csv.startsWith(CSV_BOM)).toBe(true);
  expect(CSV_BOM).toBe('﻿');
  expect(csv).toBe('﻿Организация;Создано\r\n"ACME; Trade";3\r\n\'=cmd;1\r\n');
  const cut = buildCsv(['a'], [['1']], { notice: 'Показаны первые 50000 строк' });
  expect(cut).toBe('﻿Показаны первые 50000 строк\r\na\r\n1\r\n');
});

test('доля, среднее, медиана, запись числа и минут', () => {
  expect(percent(1, 3)).toBe(33.3);
  expect(percent(0, 0)).toBeNull();
  expect(percent(5, 5)).toBe(100);
  expect(average([])).toBeNull();
  expect(average([10, 20, 60])).toBe(30);
  expect(median([])).toBeNull();
  expect(median([5, 1, 9])).toBe(5);
  expect(median([4, 1, 9, 6])).toBe(5);
  expect(decimal(4.25)).toBe('4,25');
  expect(decimal(95)).toBe('95');
  expect(decimal(null)).toBe('');
  expect(splitMinutes(135)).toEqual({ hours: 2, minutes: 15 });
  expect(splitMinutes(59.6)).toEqual({ hours: 1, minutes: 0 });
});

test('линия вычисляется из очереди и статуса (ТЗ 10.5)', () => {
  expect(lineOf('l1', 'in_progress')).toBe('first');
  expect(lineOf('l2', 'new')).toBe('second');
  expect(lineOf('care', 'waiting_customer')).toBe('second');
  expect(lineOf('l2', 'in_development')).toBe('development');
});

test('время на линиях и возвраты по событиям обращения', () => {
  // Понедельник 02.11.2026, рабочий день 08:00-20:00 по Ташкенту (03:00-15:00 UTC).
  const at = (hhmm: string, day = '02') => new Date(`2026-11-${day}T${hhmm}:00Z`);
  const usage = lineUsage(
    { createdOn: at('04:00'), resolvedOn: at('10:00', '03'), queue: 'l2' },
    [
      { kind: 'queue', from: 'l1', to: 'l2', at: at('05:00') },
      { kind: 'status', from: 'new', to: 'in_progress', at: at('05:30') },
      { kind: 'queue', from: 'l2', to: 'l1', at: at('06:00') },
      { kind: 'queue', from: 'l1', to: 'l2', at: at('07:00') },
      { kind: 'status', from: 'in_progress', to: 'in_development', at: at('09:00') },
      { kind: 'status', from: 'in_development', to: 'resolved', at: at('10:00', '03') },
      // После решения: в расчёт не входит.
      { kind: 'status', from: 'resolved', to: 'closed', at: at('11:00', '03') },
    ],
    TASHKENT_DEFAULT,
  );
  // Первая: 04-05 и 06-07. Вторая: 05-06 и 07-09. Разработка: 09:00-15:00 в понедельник и 03:00-10:00 во вторник.
  expect(usage).toEqual({ resolvedLine: 'development', minutes: { first: 120, second: 180, development: 780 }, returns: 1 });
  // Событий нет: всё время на линии текущей очереди.
  expect(lineUsage({ createdOn: at('04:00'), resolvedOn: at('05:00'), queue: 'l1' }, [], TASHKENT_DEFAULT)).toEqual({
    resolvedLine: 'first',
    minutes: { first: 60 },
    returns: 0,
  });
  // Правило автоматизации пишет прежнюю очередь в поле was: событие читается так же.
  expect(lineUsage({ createdOn: at('04:00'), resolvedOn: at('06:00'), queue: 'care' }, [{ kind: 'queue', from: 'l1', to: 'care', at: at('05:00') }], '24x7')).toEqual({
    resolvedLine: 'second',
    minutes: { first: 60, second: 60 },
    returns: 0,
  });
});
