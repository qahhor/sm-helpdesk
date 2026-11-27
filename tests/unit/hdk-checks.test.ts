import { describe, expect, test } from 'vitest';
import { checkSolution, findInText, isAllowedDomain, normalizeDomain, readiness, solutionBodyText } from '@/modules/hdk/checks';
import { findCommands } from '@/modules/hdk/checks';
import type { SolutionDoc } from '@/modules/hdk/doc-schema';

// Проверка текста решения перед публикацией (FR-SOL-04; план M5, задача 4, решение 14) и панель готовности
// (UX-W-07). Чистые функции: те же правила работают при сохранении (подсветка в редакторе) и при публикации.

const kinds = (text: string) => findInText(text).map((f) => `${f.kind}:${f.text}`);

describe('персональные данные', () => {
  test('телефоны: узбекский с кодом и без, международный, с разделителями', () => {
    expect(kinds('Позвоните +998 90 123-45-67 или (90) 123 45 67')).toEqual(['phone:+998 90 123-45-67', 'phone:(90) 123 45 67']);
    expect(kinds('Номер 998901234567')).toEqual(['phone:998901234567']);
    expect(kinds('Офис в Москве +7 (495) 123-45-67')).toEqual(['phone:+7 (495) 123-45-67']);
  });
  test('email', () => {
    expect(kinds('Пишите на ivan.petrov@client-company.uz')).toEqual(['email:ivan.petrov@client-company.uz']);
  });
  test('ИНН 9 цифр, ПИНФЛ 14 цифр, длинные числа', () => {
    expect(kinds('ИНН 301234567, ПИНФЛ 31234567890123, договор 12345678')).toEqual(['inn:301234567', 'pinfl:31234567890123', 'digits:12345678']);
  });
  test('обычные числа не находки: код ошибки, год, дата, сумма с разделителями, версия', () => {
    expect(kinds('Ошибка ORA-20001 с 2026 года, 24.11.2026, сумма 1 250 000, версия 8.15.6, шаг 3')).toEqual([]);
  });
});

describe('адреса серверов и внутренние имена', () => {
  test('сервер клиента: поддомен Smartup с кодом клиента, адрес IP, адрес с портом', () => {
    expect(kinds('Откройте https://mycompany1.smartup.uz/xtrade')).toContain('server:mycompany1.smartup.uz');
    expect(kinds('Сервер 10.20.30.40:8080 не отвечает')).toContain('server:10.20.30.40:8080');
    expect(kinds('База на db.client.local:5432')).toContain('server:db.client.local:5432');
    // Публичные адреса Smartup не находка сервера.
    expect(kinds('Документация на https://help.smartup.uz/docs')).not.toContain('server:help.smartup.uz');
  });
  test('пакеты, таблицы и пути', () => {
    expect(kinds('Вызывается Mkr_Api.Save_Order')).toContain('internal:Mkr_Api.Save_Order');
    expect(kinds('строка в таблице md_users и z_Md_Users')).toEqual(expect.arrayContaining(['internal:md_users', 'internal:z_Md_Users']));
    expect(kinds('лог в /var/log/hub/app.log')).toContain('internal:/var/log/hub/app.log');
    expect(kinds('файл main/oracle/ui/ui_vhr123.pkb')).toContain('internal:main/oracle/ui/ui_vhr123.pkb');
    expect(kinds('путь C:\\Smartup\\config.xml')).toContain('internal:C:\\Smartup\\config.xml');
  });
  test('обычный текст без находок, в том числе слова через подчёркивание нет', () => {
    expect(kinds('Откройте раздел Склад, нажмите Обновить и подождите минуту.')).toEqual([]);
  });
});

describe('домены ссылок', () => {
  test('разрешён домен и его поддомены, больше ничего', () => {
    expect(isAllowedDomain('smartup.uz', ['smartup.uz'])).toBe(true);
    expect(isAllowedDomain('docs.smartup.uz', ['smartup.uz'])).toBe(true);
    expect(isAllowedDomain('evilsmartup.uz', ['smartup.uz'])).toBe(false);
    expect(isAllowedDomain('smartup.uz.evil.com', ['smartup.uz'])).toBe(false);
    expect(isAllowedDomain('smartup.uz', [])).toBe(false);
  });
  test('настройка принимает домен, адрес или строку с пробелами и отклоняет мусор', () => {
    expect(normalizeDomain(' https://Docs.Smartup.UZ/path ')).toBe('docs.smartup.uz');
    expect(normalizeDomain('smartup.uz')).toBe('smartup.uz');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('*.smartup.uz')).toBeNull();
    expect(normalizeDomain('10.0.0.1')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });
});

const p = (id: string, text: string, marks?: object[]) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text, ...(marks ? { marks } : {}) }] });
const doc = (...blocks: object[]): SolutionDoc => ({ version: 1, blocks: blocks as SolutionDoc['blocks'] });

describe('проверка документа', () => {
  test('находки привязаны к блоку, ссылка вне списка блокирует, остальное требует подтверждения', () => {
    const findings = checkSolution(
      {
        title: 'Остаток не списывается',
        doc: doc(
          p('pphone0001', 'Звоните +998 90 123 45 67'),
          p('plink00001', 'документация', [{ type: 'link', attrs: { href: 'https://evil.example/x' } }]),
          p('plinkok001', 'справка', [{ type: 'link', attrs: { href: 'https://docs.smartup.uz/a' } }]),
          p('plinkin001', 'обращения', [{ type: 'link', attrs: { href: '/tickets/new' } }]),
          { type: 'step', attrs: { id: 'step000001' }, content: [p('pstep00001', 'Откройте http://raw.example/path')] },
        ),
      },
      { allowedDomains: ['smartup.uz'] },
    );
    expect(findings.map((f) => [f.kind, f.blockId, f.text, f.blocking])).toEqual([
      ['phone', 'pphone0001', '+998 90 123 45 67', false],
      ['link', 'plink00001', 'evil.example', true],
      ['link', 'pstep00001', 'raw.example', true],
    ]);
  });
  test('заголовок тоже проверяется', () => {
    expect(checkSolution({ title: 'Ошибка у ivan@client.uz', doc: doc() }, { allowedDomains: [] }).map((f) => [f.kind, f.blockId])).toEqual([['email', null]]);
  });
  test('текст без разметки для копии и индекса: блоки через перевод строки, без идентификаторов и атрибутов', () => {
    const text = solutionBodyText(doc(p('pa00000001', 'Первый'), { type: 'step', attrs: { id: 'stepb00001' }, content: [p('pb00000001', 'Шаг')] }));
    expect(text).toBe('Первый\nШаг');
  });
});

describe('панель готовности', () => {
  const base = { title: 'Заголовок', moduleId: '019ab8c0-0000-7000-8000-000000000001', isMachine: false, findings: [] };
  const withStep = doc(p('pa00000001', 'Текст'), { type: 'step', attrs: { id: 'stepa00001' }, content: [p('pa00000002', 'Шаг')] });
  test('всё готово: можно публиковать без подтверждения', () => {
    expect(readiness({ ...base, doc: withStep })).toEqual({
      items: { title: true, module: true, steps: true, checks: true, textRead: true },
      ready: true,
      needsConfirm: false,
      blocked: false,
    });
  });
  test('нет заголовка, модуля, шагов: не готово', () => {
    const r = readiness({ ...base, title: ' ', moduleId: null, doc: doc(p('pa00000001', 'Текст')) });
    expect(r.items).toMatchObject({ title: false, module: false, steps: false });
    expect(r.ready).toBe(false);
  });
  test('пустой шаг не считается', () => {
    expect(readiness({ ...base, doc: doc({ type: 'step', attrs: { id: 'stepa00001' }, content: [{ type: 'paragraph', attrs: { id: 'pa00000002' } }] }) }).items.steps).toBe(false);
  });
  test('находки требуют подтверждения, ссылка вне списка блокирует, текст от AI требует отметки "Текст прочитан"', () => {
    expect(readiness({ ...base, doc: withStep, findings: [{ kind: 'phone', blockId: null, text: '1', blocking: false }] })).toMatchObject({
      ready: true,
      needsConfirm: true,
      blocked: false,
    });
    expect(readiness({ ...base, doc: withStep, findings: [{ kind: 'link', blockId: null, text: 'x', blocking: true }] })).toMatchObject({ ready: false, blocked: true });
    expect(readiness({ ...base, doc: withStep, isMachine: true })).toMatchObject({ items: { textRead: false }, ready: false });
  });
});

// Повторная проверка M5 (I2s, docs/decisions/0057): тот же обход для проверки FR-SOL-04.
describe('обход проверки другими цифрами, полноширинными знаками и соединителями', () => {
  const ZWJ = String.fromCodePoint(0x200d);
  const ZWSP = String.fromCodePoint(0x200b);
  test.each([
    ['звоните +998 ９０ １２３ ４５ ６７', 'phone'],
    ['тел ٩٩٨٩٠١٢٣٤٥٦٧', 'phone'],
    ['тел 90/123/45/67', 'phone'],
    ['почта ivan＠mail.ru', 'email'],
    [`почта ivan@mail${ZWSP}.ru`, 'email'],
    [`почта iv${ZWJ}an@mail.ru`, 'email'],
    ['почта ivan @ mail.ru', 'email'],
    [`тел 9${ZWJ}0 1${ZWJ}23 45 67`, 'phone'],
    ['+998 90 123 45 67', 'phone'],
    ['ИНН 3０５１２３４５６', 'inn'],
  ])('%s находится как %s', (input, kind) => {
    const found = findInText(input);
    expect(found.map((f) => f.kind)).toEqual([kind]);
    // Находка целиком, а не её хвост.
    if (kind === 'email') expect(found[0]!.text.replace(/\s/g, '')).toBe('ivan@mail.ru');
  });
  test('90.123.45.67 остаётся находкой (адрес сервера или телефон)', () => {
    expect(findInText('тел 90.123.45.67')).toHaveLength(1);
  });
  test.each(['Срок 25.11.2026', 'Срок 25/11/2026', 'Срок 25.11.2026 10:30', 'Период 01.11.2026-30.11.2026', 'Версия 5.12.3'])('даты и версии не находка: %s', (input) => {
    expect(findInText(input)).toEqual([]);
  });
});

// --- Команды и код в недоверенном тексте (веха M5c, задача 10, решение 30; FR-CAND-09) ---

test.each([
  ['ru', 'Выполните sudo systemctl restart smartup', 'command'],
  ['uz', "Serverda rm -rf /var/cache/smartup buyrug'ini bajaring", 'command'],
  ['en', 'Run curl -X POST https://smartup.uz/api/reset', 'command'],
  ['ru', 'Скачайте wget https://smartup.uz/fix.sh', 'command'],
  ['en', 'Open powershell and run Get-Service', 'command'],
  ['ru', 'Наберите cmd /c del report.tmp', 'command'],
  ['ru', 'Выполните DROP TABLE orders;', 'command'],
  ['en', 'Run delete from orders where id = 5', 'command'],
  ['uz', 'update orders set status = 2 where id = 5 ni bajaring', 'command'],
  ['ru', 'Затем truncate table journal', 'command'],
  ['ru', 'Введите `reset_cache()` в консоли', 'code'],
  ['en', 'Paste this:\n```\nselect * from users\n```', 'code'],
])('findCommands (%s): %s', (_locale, text, kind) => {
  expect(findCommands(text).map((f) => f.kind)).toContain(kind);
});

test.each(['Удалите строку из документа и сохраните', "Hujjatdan qatorni o'chiring", 'Delete the line and update the order status in the form', 'Обновите страницу и выберите склад'])('обычный текст не находка: %s', (text) => {
  expect(findCommands(text)).toEqual([]);
});
