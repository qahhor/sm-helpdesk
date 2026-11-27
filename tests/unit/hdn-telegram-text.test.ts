import { expect, test } from 'vitest';
import { TELEGRAM_TEMPLATES, telegramNoticeText } from '@/modules/hdn/core/telegram-text';

// Короткое сообщение клиенту в Telegram (FR-NT-15; план M4b, задача 2; решение 2 вехи M4b): номер, тема до 60 знаков,
// что произошло и кнопка "Открыть в портале". Текста ответа сотрудника нет.

const HUB = 'https://hub.example.test';
const ref = { number: 1042, title: 'Не печатается накладная', url: '/tickets/SUP-1042' };

test('ответ сотрудника: номер, тема, событие и кнопка, без текста ответа', () => {
  const notice = telegramNoticeText({ template: 'ticket_reply', ...ref, body: 'Секретный ответ: перезапустите сервер' }, 'ru', HUB);
  expect(notice.text).toBe('SUP-1042 · Не печатается накладная\nНовый ответ поддержки.');
  expect(notice.button).toEqual({ text: 'Открыть в портале', url: `${HUB}/ru/tickets/SUP-1042` });
  expect(notice.text).not.toContain('Секретный');
});

test('каждый шаблон и статус даёт своё событие', () => {
  const event = (payload: Parameters<typeof telegramNoticeText>[0]) => telegramNoticeText(payload, 'ru', HUB).text.split('\n')[1];
  expect(event({ template: 'ticket_created', ...ref, viaEmail: false })).toBe('Мы получили обращение.');
  expect(event({ template: 'ticket_status', ...ref, status: 'waiting_customer' })).toBe('Ждём вашего ответа.');
  expect(event({ template: 'ticket_status', ...ref, status: 'in_development' })).toBe('Передано в разработку. Напишем, когда будут новости.');
  expect(event({ template: 'ticket_status', ...ref, status: 'closed' })).toBe('Обращение закрыто.');
  expect(event({ template: 'ticket_status', ...ref, status: 'closed', auto: true })).toBe('Обращение закрыто: мы не получили ответа.');
  expect(event({ template: 'ticket_status', ...ref, status: 'closed', mergedInto: 1050 })).toBe('Объединено с SUP-1050. Переписка продолжится там.');
  expect(event({ template: 'ticket_resolved', ...ref })).toBe('Обращение решено. Оцените ответ или откройте обращение снова.');
  expect(event({ template: 'waiting_reminder', ...ref, closeInDays: 3 })).toBe('Ждём вашего ответа. Без ответа обращение закроется через 3 рабочих дня.');
  // Обновление по известной проблеме (веха M5c, FR-NT-14): только номер проблемы, текст рассылки в портале.
  expect(event({ template: 'problem_update', ...ref, body: 'Текст рассылки', problemRef: 'KP-12', problemStatus: 'fixing', closing: false })).toBe('Обновление по известной проблеме KP-12.');
  expect(event({ template: 'problem_update', ...ref, body: 'Итог', problemRef: 'KP-12', problemStatus: 'fixed', closing: true })).toBe('Известная проблема KP-12 исправлена. Обращение решено.');
  expect(event({ template: 'tez_notice', ...ref, notice: 'known_problem', noticeTitle: 'Не проводятся накладные', noticeBody: 'Текст', problemRef: 'KP-12', problemStatus: 'fixing' })).toBe('Тез: это известная проблема KP-12. Обращение у сотрудника.');
  expect(event({ template: 'tez_notice', ...ref, notice: 'outage', noticeTitle: 'Сбой', noticeBody: 'Текст' })).toBe('Тез: сейчас действует сбой. Обращение у сотрудника.');
  expect([...TELEGRAM_TEMPLATES].sort()).toEqual(['problem_update', 'tez_answer', 'tez_notice', 'ticket_created', 'ticket_reply', 'ticket_resolved', 'ticket_status', 'waiting_reminder']);
});

test('на языке пользователя: узбекский и английский', () => {
  const uz = telegramNoticeText({ template: 'ticket_reply', ...ref, body: '' }, 'uz', HUB);
  expect(uz.text).toBe("SUP-1042 · Не печатается накладная\nQo'llab-quvvatlashdan yangi javob.");
  expect(uz.button).toEqual({ text: 'Portalda ochish', url: `${HUB}/uz/tickets/SUP-1042` });
  const en = telegramNoticeText({ template: 'ticket_resolved', ...ref }, 'en', HUB);
  expect(en.text).toBe('SUP-1042 · Не печатается накладная\nThe request is resolved. Rate the answer or reopen the request.');
  expect(en.button.text).toBe('Open in the portal');
});

test('тема обрезана до 60 знаков, без переводов строк и ссылок, простым текстом', () => {
  const title = `<b>Срочно</b>\nсм. http://evil.example/login ${'очень длинная тема '.repeat(10)}`;
  const notice = telegramNoticeText({ template: 'ticket_reply', ...ref, title, body: '' }, 'ru', HUB);
  const shown = notice.text.split('\n')[0]!.replace('SUP-1042 · ', '');
  expect(Array.from(shown)).toHaveLength(60);
  expect(shown.endsWith('...')).toBe(true);
  expect(shown).not.toContain('://');
  expect(shown).not.toContain('evil.example');
  // Разметку Telegram не разбирает: режим разметки не задаётся, теги остаются текстом.
  expect(shown.startsWith('<b>Срочно</b> см')).toBe(true);
  expect(notice.text.split('\n')).toHaveLength(2);
});

test('ссылка только на портал: чужой адрес в данных строки кнопку не меняет', () => {
  const notice = telegramNoticeText({ template: 'ticket_reply', ...ref, url: 'https://evil.example/x', body: '' }, 'ru', HUB);
  expect(notice.button.url).toBe(`${HUB}/ru/tickets/SUP-1042`);
});

test('тема не становится нажимаемой в Telegram: домен в любом регистре, команда бота, упоминание и метка (M4b, мелкое 1)', () => {
  const text = (title: string) => telegramNoticeText({ template: 'ticket_created', number: 7, title, url: '/tickets/SUP-7', viaEmail: false }, 'ru', HUB).text.split('\n')[0] ?? '';
  // Telegram делает ссылкой домен в любом регистре букв.
  expect(text('Войдите на Login.Com срочно')).not.toMatch(/\w\.\w/);
  expect(text('Зайдите на EVIL.cOm')).not.toMatch(/\w\.\w/);
  // Команда бота, упоминание и метка в теме остаются текстом.
  expect(text('/unlink и /start помогут')).not.toMatch(/(^|\s)\/[a-z]/);
  expect(text('Пишите @smartup_admin')).not.toContain('@');
  expect(text('Смотрите #скидка')).not.toMatch(/(^|\s)#\p{L}/u);
  // Команда и метка после скобки, кавычки или запятой тоже остаются текстом (проверка волны 3).
  expect(text('Помогите (/unlink) срочно')).not.toMatch(/\/[a-z]/);
  expect(text('Тема,#скидка и "/start"')).not.toMatch(/#\p{L}|\/[a-z]/u);
  // Обычная тема не меняется: дробь, номер и знаки препинания остаются как были.
  expect(text('Счёт 5/7 не сходится, строка №3. Проверьте')).toBe('SUP-7 · Счёт 5/7 не сходится, строка №3. Проверьте');
});

// Новый ответ Теза (план M5b, задачи 2 и 6; FR-NT-11): общий путь M4b (номер, тема, "Открыть в портале"), заголовок
// решения обезврежен так же, как тема, и две кнопки с подписанными данными.
test('ответ Теза: номер, тема, заголовок решения без ссылок и команд, кнопки "Помогло" и "Нужен сотрудник"', () => {
  const notice = telegramNoticeText(
    { template: 'tez_answer', number: 7, title: 'Не печатается', url: '/tickets/SUP-7', introId: 'likely_solution', solutionTitle: 'Зайдите на Login.Com и /unlink', lines: ['Шаг'], solutionUrl: '/help/a/1', helpedData: 'tz:h:abc', staffData: 'tz:s:abc' },
    'ru',
    HUB,
  );
  const [first, second] = notice.text.split('\n');
  expect(first).toBe('SUP-7 · Не печатается');
  expect(second?.startsWith('Тез предложил решение: ')).toBe(true);
  expect(second).not.toMatch(/\w\.\w/);
  expect(second).not.toMatch(/(^|\s)\/[a-z]/);
  expect(notice.text).not.toContain('Шаг');
  expect(notice.button).toEqual({ text: 'Открыть в портале', url: `${HUB}/ru/tickets/SUP-7` });
  expect(notice.choices).toEqual([
    { text: 'Помогло', data: 'tz:h:abc' },
    { text: 'Нужен сотрудник', data: 'tz:s:abc' },
  ]);
  expect(TELEGRAM_TEMPLATES.has('tez_answer')).toBe(true);
});
