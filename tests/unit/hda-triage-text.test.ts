import { describe, expect, test } from 'vitest';
import { safeTriageSummary, safeTriageTitle } from '@/modules/hda/triage-text';

// Проверка предложенного заголовка до записи (план M5b, решение 18; FR-TRI-02): после принятия его видят клиент и
// коллеги, поэтому он проверяется так же, как текст для клиента. Не прошёл: предложения нет.

describe('safeTriageTitle', () => {
  test.each([
    ['Позвоните +998 90 123 45 67', 'телефон'],
    ['Откройте https://evil.example/login', 'адрес сайта'],
    ['Зайдите на evil.example', 'адрес без схемы'],
    ['Пишите на help@evil.example', 'почта'],
    ['Код 123456 из СМС', 'число длиннее четырёх знаков'],
    ['Счёт 12 345 678 не проводится', 'число с пробелами'],
    ['<b>Отчёт</b> не строится', 'разметка'],
    ['', 'пусто'],
    ['   ', 'пробелы'],
    ['x'.repeat(81), 'длиннее 80 знаков'],
  ])('%s: нет предложения (%s)', (title) => {
    expect(safeTriageTitle(title)).toBeNull();
  });

  test('простой текст проходит, невидимые знаки и лишние пробелы убираются', () => {
    expect(safeTriageTitle('  Отчёт​ по агентам   не строится за 2025 год ')).toBe('Отчёт по агентам не строится за 2025 год');
    expect(safeTriageTitle("Hisobot ochilmayapti (o'zbekcha)")).toBe("Hisobot ochilmayapti (o'zbekcha)");
  });
});

describe('safeTriageSummary', () => {
  test('резюме только для сотрудника: невидимые знаки убраны, длина до 300, пустое отбрасывается', () => {
    expect(safeTriageSummary('Клиент‮ не может\n\nнапечатать')).toBe('Клиент не может напечатать');
    expect(safeTriageSummary('а'.repeat(400))?.length).toBe(300);
    expect(safeTriageSummary(' ​ ')).toBeNull();
  });
});
