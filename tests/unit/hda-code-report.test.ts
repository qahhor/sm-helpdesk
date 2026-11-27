import { describe, expect, test } from 'vitest';
import { codeReportViolations, codeScanReport, entryDigest, templateViolations, textLines } from '@/modules/hda/code/report';
import { codeLines, sampleReport } from '../helpers/code-scan';

// Схема отчёта о сканировании и правила отклонения (веха M8c, задача 2; ТЗ 7.22 FR-CODE-01, 02, 05, 12; план M8c,
// решения 4, 5, 25).

const parse = (value: unknown) => codeScanReport.safeParse(value);
/** Строки обычного текста: не код, правило code_like их не отклоняет. */
const proseLines = (count: number) => Array.from({ length: count }, (_, i) => `Проверить склад ${i + 1}`).join('\n');

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
      place(short, proseLines(10));
      expect(codeReportViolations(parse(short).data!)).toEqual([]);
    }
    const report = sampleReport();
    report.errors[1]!.conditions = proseLines(12);
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
    for (const template of ['Недостаточно остатка товара {product} на складе {warehouse}', 'Сумма (итог) больше лимита: {limit}.', 'Документ "{doc}" уже проведён!', 'Нельзя удалить товар {product}, он есть в заказах', "Ombor {w} bo'sh, mahsulot yo'q"])
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

// Независимая проверка вехи M8c (находки C2, I1, M5; решение 0134).
describe('независимая проверка: управляющие знаки, строки и код', () => {
  const withText = (text: string, place: (r: ReturnType<typeof sampleReport>, t: string) => void = (r, t) => (r.errors[0]!.conditions = t)) => {
    const report = sampleReport();
    place(report, text);
    const parsed = parse(report);
    return parsed.success ? codeReportViolations(parsed.data).map((v) => v.rule) : ['schema'];
  };

  test('C2: управляющий знак в шаблоне отклоняется, а не становится подстановкой', () => {
    const template = `Недостаточно товара ${'\u0001'.repeat(300)}`;
    expect(templateViolations(template)).toContain('control_char');
    expect(withText(template, (r, t) => (r.errors[0]!.messageTemplates.ru = t))).toContain('control_char');
    for (const char of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '\u200b', '\u202e', '\u2066', '\ufeff', '\u{e0041}'])
      expect(templateViolations(`Недостаточно остатка товара ${char}{product} на складе`), JSON.stringify(char)).toContain('control_char');
  });

  test('C2: управляющие и форматирующие знаки в любом тексте отчёта отклоняются', () => {
    for (const char of ['\u0001', '\t', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029', '\u200d', '\u202e'])
      for (const place of [
        (r: ReturnType<typeof sampleReport>, t: string) => (r.errors[0]!.conditions = t),
        (r: ReturnType<typeof sampleReport>, t: string) => (r.errors[0]!.whatToCheck[0] = t),
        (r: ReturnType<typeof sampleReport>, t: string) => (r.modules[0]!.summary = t),
      ])
        expect(withText(`Остаток товара${char}на складе заказа`, place), JSON.stringify(char)).toContain('control_char');
  });

  test('I1: строки считаются по любому переводу строки; Windows-перевод \\r\\n допустим', () => {
    expect(textLines('a\rb\rc')).toBe(3);
    expect(textLines('a\u2028b\u2029c\u0085d\u000be\u000cf')).toBe(6);
    expect(withText(proseLines(10).replaceAll('\n', '\r\n'))).toEqual([]);
    expect(withText(proseLines(12).replaceAll('\n', '\r'))).toContain('code_too_long');
  });

  test('I1: строка длиннее 300 знаков отклоняется (line_too_long)', () => {
    expect(withText(`Остаток ${'товара на складе '.repeat(19)}`)).toContain('line_too_long');
    expect(withText(`Остаток ${'товара на складе '.repeat(17)}`)).toEqual([]);
  });

  test('I1: текст, похожий на код, отклоняется (code_like)', () => {
    for (const code of [
      'v_qty := v_qty + 1',
      'select qty from stock_balances where warehouse_id = 1',
      'begin raise_error(1); end;',
      'if a > 0 then x(1); y(2); z(3); end if',
      `Данные ${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(4)}`,
      `Вызов ${'order_pkg.save_order_with_lines_and_reserve_stock_and_prices_v2'.repeat(2)}`,
    ])
      expect(withText(code), code).toContain('code_like');
    for (const prose of ['Выберите склад из списка и сохраните заказ', 'Select the warehouse from the list', 'Дата начала (begin) должна быть раньше даты конца (end)', 'Проверить: остаток; резерв; цену'])
      expect(withText(prose), prose).toEqual([]);
    expect(templateViolations('Ошибка v_qty := {x} при сохранении заказа')).toContain('code_like');
  });

  test('M5: шаблон проходит только с 15 буквами, двумя словами и не чаще подстановки на 5 букв', () => {
    expect(templateViolations('{a} {b} {c} не найдено')).toContain('template_too_loose');
    expect(templateViolations('Нет товара {p}')).toContain('template_too_loose');
    expect(templateViolations('Недостаточнотоварасклад {p}')).toContain('template_too_loose');
    expect(templateViolations('{a} {b} {c} {d} нет остатка товара')).toContain('template_too_loose');
    expect(templateViolations('В маршруте {route} нет ни одной точки')).toEqual([]);
    expect(templateViolations('Недостаточно остатка товара {product} на складе {warehouse}')).toEqual([]);
  });
});
