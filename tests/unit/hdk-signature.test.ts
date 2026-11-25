import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { errorSignature, findErrorLine, groupCorpus, normalizeErrorMessage, parseCorpus, signatureFromText, staffErrorSignature, ticketErrorSignature } from '@/modules/hdk/signature';

// Сигнатура ошибки (ТЗ 11.5, FR-SOL-07; план M5, задача 8, решение 7). Функции 11.5 повторены дословно, проверка на
// каждом правиле нормализации из ТЗ и на примерах в том же духе: одна ошибка с разными номерами, названиями, датами и
// идентификаторами даёт одну сигнатуру, разные ошибки с одним кодом Oracle дают разные.

test('11.5: нижний регистр, идентификатор, значения в кавычках, числа, пробелы', () => {
  expect(normalizeErrorMessage('Документ 2f1c9a7e-5b3d-4c2a-9e8f-0123456789ab НЕ найден')).toBe('документ <id> не найден');
  expect(normalizeErrorMessage('Товар "Молоко 3,2%" не найден на складе «Основной»')).toBe('товар <s> не найден на складе <s>');
  expect(normalizeErrorMessage(`Клиент 'ООО Ромашка' заблокирован`)).toBe('клиент <s> заблокирован');
  expect(normalizeErrorMessage('Клиент “Альфа” заблокирован')).toBe('клиент <s> заблокирован');
  expect(normalizeErrorMessage('Сумма 1250,50 больше лимита 1000.00 по заказу 4512')).toBe('сумма <n> больше лимита <n> по заказу <n>');
  expect(normalizeErrorMessage('  Период\tзакрыт \n\n до   31  ')).toBe('период закрыт до <n>');
});

test('11.5: значение в кавычках длиннее 80 знаков не заменяется целиком, текст обрезается до 300 знаков', () => {
  const long = `"${'а'.repeat(81)}"`;
  expect(normalizeErrorMessage(`значение ${long}`)).toBe(`значение ${long}`);
  expect(normalizeErrorMessage('ошибка '.repeat(100))).toHaveLength(300);
});

test('11.5: сигнатура это первые 32 знака sha256 от кода, текста и модуля через |', () => {
  const expected = createHash('sha256').update('ORA-20001|документ <n> не найден|').digest('hex').slice(0, 32);
  expect(errorSignature({ errorCode: ' ora-20001 ', errorMessage: 'Документ 15 не найден' })).toBe(expected);
  expect(errorSignature({ errorCode: 'ORA-20001', errorMessage: 'Документ 15 не найден' })).toMatch(/^[0-9a-f]{32}$/);
  // Модуль участвует в сигнатуре.
  expect(errorSignature({ errorCode: 'ORA-20001', errorMessage: 'x', moduleCode: 'sales' })).not.toBe(errorSignature({ errorCode: 'ORA-20001', errorMessage: 'x' }));
  // Только код или только текст: сигнатура есть. Ни того, ни другого: нет.
  expect(errorSignature({ errorCode: 'ORA-01403' })).toMatch(/^[0-9a-f]{32}$/);
  expect(errorSignature({ errorMessage: 'Период закрыт' })).toMatch(/^[0-9a-f]{32}$/);
  expect(errorSignature({})).toBeNull();
  expect(errorSignature()).toBeNull();
  expect(errorSignature({ errorCode: '  ', errorMessage: '' })).toBeNull();
});

test('одна ошибка с разными номерами, названиями, датами и идентификаторами: одна сигнатура', () => {
  const same = [
    'ORA-20001: Документ №4512 от 12.03.2026 не найден',
    'ORA-20001: Документ №17 от 01.11.2026 не найден',
    'ora-20001:   документ №900001 от 5.1.2025   не найден',
  ].map(signatureFromText);
  expect(new Set(same).size).toBe(1);
  expect(same[0]).toMatch(/^[0-9a-f]{32}$/);
  const named = [
    'ORA-20999: Товар "Молоко 3,2%" не найден на складе "Основной склад"',
    'ORA-20999: Товар "Кефир" не найден на складе "Филиал Чиланзар"',
  ].map(signatureFromText);
  expect(named[0]).toBe(named[1]);
  const ids = [
    'ORA-20001: Заказ 2f1c9a7e-5b3d-4c2a-9e8f-0123456789ab заблокирован пользователем «Иван»',
    'ORA-20001: Заказ 0a0b0c0d-1111-2222-3333-444455556666 заблокирован пользователем «Dilshod»',
  ].map(signatureFromText);
  expect(ids[0]).toBe(ids[1]);
});

test('разные ошибки с одним кодом Oracle: разные сигнатуры (ТЗ 11.5, ORA-20001)', () => {
  const a = signatureFromText('ORA-20001: Документ №4512 не найден');
  const b = signatureFromText('ORA-20001: Период 03.2026 закрыт для изменений');
  const c = signatureFromText('ORA-20001: Недостаточно остатка товара "Молоко" на складе');
  expect(new Set([a, b, c]).size).toBe(3);
  // Тот же текст с другим кодом тоже другая ошибка.
  expect(signatureFromText('ORA-20002: Документ №4512 не найден')).not.toBe(a);
});

test('строка ошибки в описании клиента: код Oracle, стек вызовов, подписи "Ошибка:" на трёх языках', () => {
  expect(findErrorLine('Здравствуйте!\nПри сохранении заказа выходит:\nORA-20001: Документ №15 не найден\nORA-06512: at "SALES.ORDER_PKG", line 120\nПомогите')).toEqual({
    code: 'ORA-20001',
    message: 'Документ №15 не найден',
  });
  // Код без текста на той же строке: текст берётся со следующей строки.
  expect(findErrorLine('Выходит ошибка ORA-01403\nданные не найдены')).toEqual({ code: 'ORA-01403', message: 'данные не найдены' });
  // Строка стека сама по себе ошибкой не считается.
  expect(findErrorLine('ORA-06512: at line 5')).toBeNull();
  expect(findErrorLine('Ошибка: Период закрыт для изменений')).toEqual({ code: '', message: 'Период закрыт для изменений' });
  expect(findErrorLine('Error: Price list is not active')).toEqual({ code: '', message: 'Price list is not active' });
  expect(findErrorLine('Xato: Ombor qoldig‘i yetarli emas')).toEqual({ code: '', message: 'Ombor qoldig‘i yetarli emas' });
  expect(findErrorLine('Хато: Омбор қолдиғи етарли эмас')).toEqual({ code: '', message: 'Омбор қолдиғи етарли эмас' });
});

test('без строки ошибки сигнатуры нет: обычное описание, номер обращения, короткая подпись', () => {
  expect(signatureFromText('Не могу распечатать накладную, принтер молчит')).toBeNull();
  expect(signatureFromText('Это продолжение SUP-1234, ошибка та же')).toBeNull();
  expect(signatureFromText('Ошибка: да')).toBeNull();
  expect(signatureFromText('')).toBeNull();
});

test('обращение: сначала код и текст ошибки из контекста, иначе строка в описании', () => {
  const fromContext = ticketErrorSignature({ context: { errorCode: 'ORA-20001', errorText: 'Документ 5 не найден' }, description: 'ORA-20002: другое' });
  expect(fromContext).toEqual({ signature: errorSignature({ errorCode: 'ORA-20001', errorMessage: 'Документ 5 не найден' }), code: 'ORA-20001', message: 'документ <n> не найден', raw: 'Документ 5 не найден' });
  const fromText = ticketErrorSignature({ context: null, description: 'При проведении:\nORA-20001: Документ 77 не найден' });
  expect(fromText?.signature).toBe(fromContext?.signature);
  expect(ticketErrorSignature({ context: {}, description: 'просто вопрос' })).toBeNull();
});

test('корпус: записи через пустую строку, метка в квадратных скобках, группы и сводка', () => {
  const entries = parseCorpus('# комментарий\n[a] ORA-20001: Документ 1 не найден\n\n[a] ORA-20001: Документ 2 не найден\nORA-06512: at line 3\n\n[b] ORA-20001: Период закрыт\n\n[c] Просто текст без ошибки\n');
  expect(entries).toEqual([
    { label: 'a', text: 'ORA-20001: Документ 1 не найден' },
    { label: 'a', text: 'ORA-20001: Документ 2 не найден\nORA-06512: at line 3' },
    { label: 'b', text: 'ORA-20001: Период закрыт' },
    { label: 'c', text: 'Просто текст без ошибки' },
  ]);
  const report = groupCorpus([...entries, { label: 'b', text: 'ORA-20001: Документ 3 не найден' }]);
  expect(report.total).toBe(5);
  expect(report.groups).toHaveLength(2);
  expect(report.groups[0]).toMatchObject({ code: 'ORA-20001', message: 'документ <n> не найден', labels: ['a', 'b'] });
  expect(report.groups[0]!.texts).toHaveLength(3);
  expect(report.unrecognized).toEqual([{ label: 'c', text: 'Просто текст без ошибки' }]);
  // Метка b попала в две группы, группа документа смешала метки a и b.
  expect(report.splitLabels).toEqual(['b']);
  expect(report.mixedGroups).toEqual([report.groups[0]!.signature]);
});

test('сотрудник в редакторе: код и текст отдельно или строка целиком дают сигнатуру обращения', () => {
  const ticket = signatureFromText('Выходит: ORA-20001: Документ 77 не найден');
  expect(staffErrorSignature({ code: 'ora-20001', text: 'Документ 12 не найден' })?.signature).toBe(ticket);
  expect(staffErrorSignature({ text: 'ORA-20001: Документ 3 не найден' })?.signature).toBe(ticket);
  // Текст без кода и подписи берётся целиком.
  expect(staffErrorSignature({ text: 'Период 03.2026 закрыт' })?.signature).toBe(errorSignature({ errorMessage: 'Период 1 закрыт' }));
  expect(staffErrorSignature({ text: '   ' })).toBeNull();
});
