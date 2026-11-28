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

// Проверка на AI-инъекции (волна 7, S-M6): заголовок после принятия видит клиент, поэтому в нём нет слов
// обязательных тем (договор, оплата, жалоба и другие списки topics) и адресов, записанных словами.
describe('safeTriageTitle: списки слов и адреса словами', () => {
  test.each([
    ['Ваш договор расторгнут', 'тема: договор'],
    ['Возврат денег одобрен', 'тема: оплата'],
    ['Shartnoma bekor qilindi', 'тема на узбекском'],
    ['Your refund is approved', 'тема на английском'],
    ['Ваш д0г0вор расторгнут', 'тема с цифрами-двойниками'],
    ['Пишите на evil точка com', 'адрес словами'],
    ['Write to evil dot com', 'адрес словами на английском'],
    ['evil nuqta uz ga yozing', 'адрес словами на узбекском'],
    ['Почта support собака evil', 'слово вместо знака почты'],
    ['Напишите в телеграм evil_support', 'мессенджер'],
    ['Напишите нам: wa.me/evil', 'ссылка мессенджера'],
  ])('%s: нет предложения (%s)', (title) => {
    expect(safeTriageTitle(title)).toBeNull();
  });

  test('список тем из настройки администратора тоже действует', () => {
    const lists = { payments: { ru: ['акт сверки'], uz: [], en: [] }, contract: { ru: [], uz: [], en: [] }, complaint: { ru: [], uz: [], en: [] }, data_change: { ru: [], uz: [], en: [] }, access: { ru: [], uz: [], en: [] }, security: { ru: [], uz: [], en: [] }, legal: { ru: [], uz: [], en: [] } };
    expect(safeTriageTitle('Нужен акт сверки', lists)).toBeNull();
    expect(safeTriageTitle('Не печатается накладная', lists)).toBe('Не печатается накладная');
  });

  test('обычный заголовок со словом "точка" проходит', () => {
    expect(safeTriageTitle('Торговая точка не видна в отчёте')).toBe('Торговая точка не видна в отчёте');
  });
});

describe('safeTriageSummary', () => {
  test('резюме только для сотрудника: невидимые знаки убраны, длина до 300, пустое отбрасывается', () => {
    expect(safeTriageSummary('Клиент‮ не может\n\nнапечатать')).toBe('Клиент не может напечатать');
    expect(safeTriageSummary('а'.repeat(400))?.length).toBe(300);
    expect(safeTriageSummary(' ​ ')).toBeNull();
  });
});
