import { expect, test } from 'vitest';
import { detectLanguage } from '@/modules/hda/language';

// Язык обращения определяет код (FR-AI-06, FR-AI-12; план M5b, задача 2, решение 16). Модель язык не выбирает.

test.each([
  ['русский', 'При печати накладной выходит пустой лист, что делать?', 'ru'],
  ['русский с кодом ошибки латиницей', 'Не проводится документ, ошибка ERR_PERIOD_CLOSED в модуле склада', 'ru'],
  ['узбекский кириллицей с буквами ў қ ғ ҳ', 'Ҳисобот очилмаяпти, қандай қилиб тўғрилаш мумкин?', 'uz'],
  ['узбекский кириллицей без особых букв, по частым словам', 'Бу хато чиқди ва ишламаяпти, ёрдам беринг илтимос', 'uz'],
  ['узбекский латиницей с апострофом', "Hisobot ochilmayapti, qanday qilib to'g'rilash mumkin?", 'uz'],
  ['узбекский латиницей с ʻ и ʼ', 'Buyurtma joʻnatilmadi, nima qilish kerak?', 'uz'],
  ['узбекский латиницей без апострофов', 'Hisobot ishlamayapti va xato chiqyapti, yordam bering', 'uz'],
  ['английский', 'The invoice prints an empty page, how can I fix it?', 'en'],
  ['смешанный: русский текст и английские слова', 'После обновления кнопка Save не работает и отчёт не открывается', 'ru'],
])('%s', (_name, text, expected) => {
  expect(detectLanguage(text, 'ru')).toBe(expected);
});

test('короче трёх слов: язык пользователя', () => {
  expect(detectLanguage('Помогите', 'uz')).toBe('uz');
  expect(detectLanguage('Error 500', 'ru')).toBe('ru');
});

test('чужая письменность или ни один словарь не набрал порога: null (передача language)', () => {
  expect(detectLanguage('فاتورة لا تطبع ما العمل الآن', 'ru')).toBeNull();
  expect(detectLanguage('发票打印不出来怎么办呢请帮忙', 'ru')).toBeNull();
  expect(detectLanguage('Rechnung wird nicht gedruckt bitte schnell beheben', 'ru')).toBeNull();
  expect(detectLanguage('Faktura nie drukuje się wcale niestety', 'ru')).toBeNull();
});
