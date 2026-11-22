import { expect, test } from 'vitest';
import { cleanSubject, emailToText, SUBJECT_MAX, stripQuote } from '@/modules/hdn/inbound/email-text';

// Письмо в текст (FR-EM-15, FR-NT-05, угроза T31, решение 0030): без скрытых элементов HTML, без цитаты прошлых
// писем, без невидимых знаков. Сотрудник и будущая модель видят один и тот же текст.

const SECRET = 'ИНСТРУКЦИЯ ДЛЯ МОДЕЛИ';

test.each([
  ['скрытый блок', `<p>Не печатается накладная</p><div style="display:none">${SECRET}</div>`],
  ['атрибут hidden', `<p>Не печатается накладная</p><span hidden>${SECRET}</span>`],
  ['нулевой шрифт', `<p>Не печатается накладная</p><span style="font-size:0px">${SECRET}</span>`],
  ['белый текст', `<p>Не печатается накладная</p><span style="color: #FFFFFF">${SECRET}</span>`],
  ['прозрачность', `<p>Не печатается накладная</p><span style="opacity:0">${SECRET}</span>`],
  ['visibility', `<p>Не печатается накладная</p><span style="visibility: hidden">${SECRET}</span>`],
  ['комментарий', `<p>Не печатается накладная</p><!-- ${SECRET} -->`],
  ['max-height:0', `<p>Не печатается накладная</p><div style="max-height:0;overflow:hidden">${SECRET}</div>`],
  ['стиль и скрипт', `<style>p{}</style><script>${SECRET}</script><p>Не печатается накладная</p>`],
  ['невидимые знаки Юникода', '<p>Не печатается​ накладная⁦</p>'],
])('%s: инструкции в итоговом тексте нет', (_name, html) => {
  const text = emailToText({ html, text: null });
  expect(text).toContain('Не печатается');
  expect(text).toContain('накладная');
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/[​⁦]/);
});

test('текстовая часть важнее HTML, ссылка показывает адрес', () => {
  expect(emailToText({ html: '<p>Другое</p>', text: 'Текстовая часть' })).toBe('Текстовая часть');
  expect(emailToText({ html: '<p>См. <a href="https://evil.example/x">портал</a></p>', text: null })).toBe('См. портал (https://evil.example/x)');
  expect(emailToText({ html: '<ul><li>Раз</li><li>Два</li></ul><p>Конец<br>строки</p>', text: '' })).toBe('- Раз\n- Два\n\nКонец\nстроки');
});

test.each([
  ['Gmail HTML', { html: '<div>Спасибо, заработало</div><div class="gmail_quote"><div>On Mon wrote:</div><blockquote>старое</blockquote></div>', text: null }],
  ['Outlook HTML', { html: '<p>Спасибо, заработало</p><div id="divRplyFwdMsg"><b>From:</b> Smartup</div><div>старое письмо</div>', text: null }],
  ['Apple Mail HTML', { html: '<div>Спасибо, заработало</div><blockquote type="cite">старое</blockquote>', text: null }],
  ['Gmail текст en', { html: null, text: 'Спасибо, заработало\n\nOn Mon, Nov 23, 2026 at 10:00 AM Smartup Hub <hub@mail.smartup24.com> wrote:\n> старое\n> письмо' }],
  ['Gmail текст на двух строках', { html: null, text: 'Спасибо, заработало\n\nOn Mon, Nov 23, 2026 at 10:00 AM Smartup Hub <hub@mail.smartup24.com>\nwrote:\n> старое' }],
  ['Яндекс ru', { html: null, text: 'Спасибо, заработало\n\n23.11.2026, 10:00, "Smartup Hub" <hub@mail.smartup24.com>:\n> старое' }],
  ['ru написал', { html: null, text: 'Спасибо, заработало\n\nПн, 23 нояб. 2026 г. в 10:00, Поддержка написал(а):\n> старое' }],
  ['uz yozdi', { html: null, text: 'Спасибо, заработало\n\n2026-yil 23-noyabr, Smartup yozdi:\n> старое' }],
  ['Outlook текст ru', { html: null, text: 'Спасибо, заработало\n\nОт: Smartup Hub <hub@mail.smartup24.com>\nОтправлено: 23 ноября 2026 г. 10:00\nТема: [SUP-1042]\n\nстарое' }],
  ['Outlook текст en', { html: null, text: 'Спасибо, заработало\n\n-----Original Message-----\nFrom: Smartup Hub\nSent: Monday\n\nстарое' }],
  ['наша черта', { html: null, text: 'Спасибо, заработало\n\nОтветьте на это письмо, ответ попадёт в обращение\n------------------------------\nстарое' }],
  ['подпись', { html: null, text: 'Спасибо, заработало\n-- \nИван Петров\n+998 90 000-00-00' }],
  ['Отправлено с iPhone', { html: null, text: 'Спасибо, заработало\n\nОтправлено с iPhone' }],
])('цитата %s: остаётся только новый текст', (_name, content) => {
  expect(emailToText(content)).toBe('Спасибо, заработало');
});

test('письмо только из цитаты даёт пустой текст', () => {
  expect(stripQuote('> старое\n> письмо')).toBe('');
  expect(emailToText({ html: '<blockquote type="cite">старое</blockquote>', text: null })).toBe('');
  expect(emailToText({ html: null, text: null })).toBe('');
});

test('Re:, Fwd:, RE[2]: снимаются, тема обрезается до 200, пустая тема', () => {
  expect(cleanSubject('Re: Fwd: RE[2]: Отв: Не печатается', 'ru')).toBe('Не печатается');
  expect(cleanSubject('Re: [SUP-1042] Не печатается', 'ru')).toBe('Не печатается');
  expect(Array.from(cleanSubject('а'.repeat(500), 'ru')).length).toBeLessThanOrEqual(SUBJECT_MAX);
  expect(cleanSubject('   ', 'ru')).toBe('Письмо без темы');
  expect(cleanSubject('Re:', 'uz')).toBe('Mavzusiz xat');
  expect(cleanSubject('', 'en')).toBe('Email without a subject');
  expect(cleanSubject('Тема​с⁦невидимыми', 'ru')).toBe('Темасневидимыми');
});
