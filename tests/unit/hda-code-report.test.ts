import { describe, expect, test } from 'vitest';
import { codeReportViolations, codeScanReport, entryDigest, templateViolations, textLines } from '@/modules/hda/code/report';
import { codeLines, sampleReport } from '../helpers/code-scan';

// Схема отчёта о сканировании и правила отклонения (веха M8c, задача 2; ТЗ 7.22 FR-CODE-01, 02, 05, 12; план M8c,
// решения 4, 5, 25).

const parse = (value: unknown) => codeScanReport.safeParse(value);

describe('схема отчёта', () => {
  test('отчёт-пример 7.22 проходит схему и правила', () => {
    const parsed = parse(sampleReport());
    expect(parsed.success).toBe(true);
    expect(codeReportViolations(parsed.data!)).toEqual([]);
  });

  test('лишнее поле отклоняется схемой: выражение агент передать не может', () => {
    for (const field of ['pattern', 'regex', 'source']) {
      const report = sampleReport() as Record<string, unknown> & { errors: Record<string, unknown>[] };
      report.errors[0]![field] = '.*';
      expect(parse(report).success, field).toBe(false);
    }
    expect(parse({ ...sampleReport(), code: 'x' }).success).toBe(false);
  });

  test('место в коде только ссылкой: путь относительный, без "..", строка числом', () => {
    for (const path of ['../secret.pkb', '/etc/passwd', 'C:\\src\\a.pkb', 'db/../x.pkb', '']) {
      const report = sampleReport();
      report.errors[0]!.raisedIn[0]!.path = path;
      expect(parse(report).success, path).toBe(false);
    }
    const report = sampleReport() as unknown as { errors: { raisedIn: Record<string, unknown>[] }[] };
    report.errors[0]!.raisedIn[0]!.code = 'select 1';
    expect(parse(report).success).toBe(false);
  });

  test('ключ, код ошибки, род и уверенность по правилам', () => {
    for (const [field, value] of [
      ['key', 'Orders.Bad'],
      ['key', 'orders'],
      ['code', 'ora-20001'],
      ['kind', 'bug'],
      ['confidence', 1.5],
    ] as const) {
      const report = sampleReport() as unknown as { errors: Record<string, unknown>[] };
      report.errors[0]![field] = value;
      expect(parse(report).success, `${field}=${value}`).toBe(false);
    }
  });
});

describe('правила отклонения', () => {
  test('поле больше 10 строк в любом месте отчёта: code_too_long, 10 строк проходит', () => {
    const places: ((r: ReturnType<typeof sampleReport>, text: string) => void)[] = [
      (r, t) => (r.errors[0]!.conditions = t),
      (r, t) => (r.errors[0]!.userCause = t),
      (r, t) => (r.errors[0]!.whatToCheck[0] = t),
      (r, t) => (r.modules[0]!.summary = t),
    ];
    for (const place of places) {
      const long = sampleReport();
      place(long, codeLines(11));
      const parsed = parse(long);
      expect(parsed.success).toBe(true);
      expect(codeReportViolations(parsed.data!).map((v) => v.rule)).toContain('code_too_long');
      const short = sampleReport();
      place(short, codeLines(10));
      expect(codeReportViolations(parse(short).data!)).toEqual([]);
    }
    const report = sampleReport();
    report.errors[1]!.conditions = codeLines(12);
    expect(codeReportViolations(parse(report).data!)).toEqual([{ rule: 'code_too_long', path: 'errors.1.conditions' }]);
  });

  test('шаблон с синтаксисом регулярного выражения: regex', () => {
    for (const template of ['Остаток .* на складе {w}', 'Ошибка \\d+ в строке {n}', 'Код [A-Z]+ не найден {x}', '^Ошибка сохранения {x}', 'Ответ (да|нет) для {x}', 'Повтор {n,3} раз заказа', 'Товар {p} на складе.+', 'Склад {w} пуст$', 'Документ (?i)закрыт {x}'])
      expect(templateViolations(template), template).toContain('regex');
  });

  test('подстановки по правилу: имя, не больше 10, не меньше 8 букв вне подстановок', () => {
    expect(templateViolations('Нет товара {1abc} на складе')).toContain('bad_placeholder');
    expect(templateViolations('Нет товара { product } на складе')).toContain('bad_placeholder');
    expect(templateViolations(`Ошибка заказа ${Array.from({ length: 11 }, (_, i) => `{p${i}}`).join(' ')}`)).toContain('bad_placeholder');
    expect(templateViolations('{x} {y}')).toEqual(['template_too_loose']);
  });

  test('обычные знаки препинания, кавычки и скобки вокруг слов проходят', () => {
    for (const template of ['Недостаточно остатка товара {product} на складе {warehouse}', 'Сумма (итог) больше лимита: {limit}.', 'Документ "{doc}" уже проведён!', 'Нельзя удалить товар {product}, он есть в заказах', "Ombor {w} bo'sh"])
      expect(templateViolations(template), template).toEqual([]);
  });

  test('нарушения шаблонов в отчёте называют путь поля, без значения', () => {
    const report = sampleReport();
    report.errors[2]!.messageTemplates.ru = 'В маршруте .* нет точек';
    expect(codeReportViolations(parse(report).data!)).toEqual([{ rule: 'regex', path: 'errors.2.messageTemplates.ru' }]);
  });

  test('число строк текста', () => {
    expect(textLines('')).toBe(1);
    expect(textLines('a\nb\r\nc')).toBe(3);
    expect(textLines('a\n')).toBe(1);
  });
});

describe('отпечаток записи', () => {
  test('не зависит от порядка ключей и меняется от любого поля агента', () => {
    const [entry] = parse(sampleReport()).data!.errors;
    const reordered = Object.fromEntries(Object.entries(entry!).reverse()) as typeof entry;
    expect(entryDigest(reordered!)).toBe(entryDigest(entry!));
    expect(entryDigest(entry!)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [{ conditions: 'Другое' }, { confidence: 0.5 }, { whatToCheck: ['Одно'] }, { messageTemplates: { ru: 'Другой шаблон {x} сообщения' } }, { raisedIn: [] }])
      expect(entryDigest({ ...entry!, ...change }), JSON.stringify(change)).not.toBe(entryDigest(entry!));
  });
});
