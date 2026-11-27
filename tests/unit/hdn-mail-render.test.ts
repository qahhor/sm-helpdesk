import { expect, test } from 'vitest';
import type { Locale } from '@/i18n/locales';
import { loginLinkMail } from '@/modules/hdn/mail-text';
import { MAIL_TEMPLATES, type MailCommon, type MailData, type MailTemplate, REPLY_MARKERS, renderMail, ticketSubject } from '@/modules/hdn/mail/render';

// Шаблоны писем вехи M4 (решение 4): тексты в messages/*.json (mail.*), цвета из mail-tokens.json, к каждому письму
// текстовая часть. Тема писем обращения: [SUP-<номер>] <тема> (FR-EM-01). Внутренних слов нет (UX-C-13).

const LOCALES: Locale[] = ['ru', 'uz', 'en'];
/** Среднее и длинное тире (U+2013, U+2014): в текстах портала запрещены. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const common: MailCommon = { hubUrl: 'https://hub.example.test', supportAddress: 'support@smartup24.com', settingsUrl: 'https://hub.example.test/ru/settings' };
const ticket = { number: 1042, title: 'Не печатается накладная', url: 'https://hub.example.test/ru/tickets/1042' };

const SAMPLES: { [K in MailTemplate]: Omit<Extract<MailData, { template: K }>, keyof MailCommon> } = {
  ticket_created: { template: 'ticket_created', ...ticket, viaEmail: false },
  ticket_reply: { template: 'ticket_reply', ...ticket, body: 'Проверьте настройки печати.\n\n**Шаг 1.** Откройте раздел.' },
  ticket_status: { template: 'ticket_status', ...ticket, status: 'in_development' },
  ticket_resolved: { template: 'ticket_resolved', ...ticket },
  waiting_reminder: { template: 'waiting_reminder', ...ticket, closeInDays: 4 },
  unidentified_ack: { template: 'unidentified_ack', number: 1061, title: 'Не могу войти' },
  staff_mention: { template: 'staff_mention', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042', author: 'Анна' },
  staff_breach: { template: 'staff_breach', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042', kind: 'first_response' },
  staff_update_due: { template: 'staff_update_due', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042' },
  staff_dev_task_closed: { template: 'staff_dev_task_closed', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042', ref: 'DEV-501' },
  holidays_reminder: { template: 'holidays_reminder', year: 2027, url: 'https://hub.example.test/ru/agent/settings/sla' },
  oncall_p1: { template: 'oncall_p1', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042', orgName: 'ООО Клиент' },
  staff_rule: { template: 'staff_rule', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042', rule: 'P1 от категории A' },
  oncall_rule: { template: 'oncall_rule', number: 1042, url: 'https://hub.example.test/ru/agent/tickets/1042', rule: 'P1 от категории A' },
  staff_csat_low: { template: 'staff_csat_low', ...ticket, url: 'https://hub.example.test/ru/agent/tickets/1042', score: 2, orgName: 'ООО Клиент' },
  inbound_test: { template: 'inbound_test', address: 'support@greenwhite.uz', token: 'chk-7f3a' },
  ops_alert: { template: 'ops_alert', text: 'Smartup Hub: за час не отправлено писем и сообщений: 3.', url: 'https://hub.example.test/ru/agent' },
  idea_status: {
    template: 'idea_status',
    event: 'released',
    ideaId: '00000000-0000-0000-0000-000000000001',
    number: 204,
    title: 'Экспорт заказов в Excel',
    titles: { ru: 'Экспорт заказов в Excel', en: 'Export orders to Excel' },
    url: 'https://hub.example.test/ru/ideas/204',
  },
  staff_idea_moderation: { template: 'staff_idea_moderation', count: 3, url: 'https://hub.example.test/ru/agent/ideas' },
  staff_idea_cycle: { template: 'staff_idea_cycle', count: 5, url: 'https://hub.example.test/ru/agent/ideas/cycles' },
  staff_idea_dev_task_closed: { template: 'staff_idea_dev_task_closed', number: 204, title: 'Экспорт заказов в Excel', ref: 'DEV-501', url: 'https://hub.example.test/ru/agent/ideas/204' },
  tez_answer: {
    template: 'tez_answer',
    ...ticket,
    introId: 'likely_solution',
    solutionTitle: 'Пустой лист при печати накладной',
    lines: ['Откройте Настройки > Печать', 'Выберите шаблон "А4"'],
    solutionUrl: 'https://hub.example.test/ru/help/a/1042',
    helpedUrl: 'https://hub.example.test/ru/ai-answer?t=x',
    staffUrl: 'https://hub.example.test/ru/ai-answer?t=y',
  },
  tez_ack: { template: 'tez_ack', ...ticket, dueOn: '2026-11-30T03:00:00.000Z', startOn: '2026-11-30T03:00:00.000Z', timeZone: 'Asia/Tashkent' },
  // Обновление по известной проблеме (веха M5c): текст рассылки сотрудника, номер и статус проблемы.
  problem_update: { template: 'problem_update', ...ticket, body: 'Нашли причину. Исправление в версии **5.12.4**.', problemRef: 'KP-12', problemStatus: 'fixing', closing: false },
};

const TICKET_TEMPLATES: MailTemplate[] = [
  'ticket_created',
  'ticket_reply',
  'ticket_status',
  'ticket_resolved',
  'waiting_reminder',
  'unidentified_ack',
  'staff_mention',
  'staff_breach',
  'staff_update_due',
  'staff_dev_task_closed',
  'oncall_p1',
  'staff_rule',
  'oncall_rule',
  'staff_csat_low',
  'problem_update',
];

const cases = MAIL_TEMPLATES.flatMap((template) => LOCALES.map((locale) => [template, locale] as const));

test('перечень шаблонов совпадает с образцами теста', () => {
  expect([...MAIL_TEMPLATES].sort()).toEqual(Object.keys(SAMPLES).sort());
});

test.each(cases)('%s на %s: тема, HTML и текст без ключей перевода и подстановок', async (template, locale) => {
  const mail = await renderMail(template, locale, { ...SAMPLES[template], ...common } as MailData);
  if (TICKET_TEMPLATES.includes(template)) expect(mail.subject).toMatch(/^\[SUP-10(42|61)\] /);
  for (const part of [mail.subject, mail.html, mail.text]) {
    expect(part.length).toBeGreaterThan(0);
    expect(part).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(part).not.toMatch(/\bmail\.[a-zA-Z]+\./);
  }
  expect(mail.html).toMatch(/^<!DOCTYPE html>/);
  expect(mail.html).toContain('https://hub.example.test/brand/logo/smartup-logo-light-bg.png');
  expect(mail.html).toContain('support@smartup24.com');
  expect(mail.text).toContain('support@smartup24.com');
});

test('в письме нет внутренних слов и длинного тире', async () => {
  for (const [template, locale] of cases) {
    const mail = await renderMail(template, locale, { ...SAMPLES[template], ...common } as MailData);
    const all = `${mail.subject}\n${mail.html}\n${mail.text}`;
    expect(all).not.toMatch(/тикет|эскалац|очеред|\bлини[яи]\b|ticket\b|escalat|queue/i);
    // SLA отдельным словом и заглавными: узбекское "eslatishdi" содержит те же буквы.
    expect(all).not.toMatch(/\bSLA\b/);
    expect(all).not.toMatch(DASHES);
    expect(all).not.toMatch(/Smartup ERP|\bdala\b/i);
  }
});

test('текст ответа с HTML выводится текстом, а не разметкой', async () => {
  const body = '<script>alert(1)</script> **важно** [портал](https://hub.example.test/ru) [плохо](javascript:alert(1)) ![картинка](https://evil.example/x.png)';
  const mail = await renderMail('ticket_reply', 'ru', { ...SAMPLES.ticket_reply, body, ...common } as MailData);
  expect(mail.html).not.toContain('<script');
  expect(mail.html).toContain('&lt;script&gt;');
  expect(mail.html).toContain('<strong>важно</strong>');
  expect(mail.html).toContain('<a href="https://hub.example.test/ru"');
  expect(mail.html).not.toContain('javascript:');
  expect(mail.html).not.toMatch(/<img[^>]+evil\.example/);
  // Текстовая часть: исходный текст ответа без изменений, подпись "Поддержка Smartup".
  expect(mail.text).toContain(body);
  expect(mail.text).toContain('Поддержка Smartup');
  expect(mail.html).toContain('Поддержка Smartup');
});

test('тема обращения из письма клиента не ломает заголовки и экранируется в HTML', async () => {
  const title = 'Счёт\r\nBcc: evil@example.test <b>жирный</b>';
  const mail = await renderMail('ticket_created', 'ru', { ...SAMPLES.ticket_created, title, ...common } as MailData);
  expect(mail.subject).not.toMatch(/[\r\n]/);
  expect(mail.html).not.toContain('<b>жирный</b>');
});

test('тема длиннее 120 знаков обрезается', () => {
  const subject = ticketSubject(1042, 'а'.repeat(300));
  expect(subject.startsWith('[SUP-1042] ')).toBe(true);
  expect(Array.from(subject.slice('[SUP-1042] '.length)).length).toBeLessThanOrEqual(120);
  expect(ticketSubject(7, '  Тема\tс\nпереводом  ')).toBe('[SUP-7] Тема с переводом');
});

test('письма клиенту об обращении несут строку для ответа над чертой, письмо неопознанному без ссылок на портал', async () => {
  const reply = await renderMail('ticket_reply', 'uz', { ...SAMPLES.ticket_reply, ...common } as MailData);
  expect(REPLY_MARKERS.some((marker) => reply.text.includes(marker))).toBe(true);
  const ack = await renderMail('unidentified_ack', 'ru', { ...SAMPLES.unidentified_ack, ...common } as MailData);
  expect(ack.text).toContain('SUP-1061');
  expect(ack.html).not.toContain('/tickets/');
  expect(ack.text).not.toContain('/tickets/');
});

test('ссылка на настройки уведомлений только в отключаемых письмах', async () => {
  const watched = await renderMail('ticket_reply', 'ru', { ...SAMPLES.ticket_reply, ...common } as MailData);
  expect(watched.html).toContain('https://hub.example.test/ru/settings');
  const own = await renderMail('ticket_reply', 'ru', { ...SAMPLES.ticket_reply, ...common, settingsUrl: null } as MailData);
  expect(own.html).not.toContain('/ru/settings');
});

test('письмо входа по ссылке (M1) получает HTML в общей оболочке и прежний текст', () => {
  const url = 'https://hub.example.test/ru/login/link?token=abc&x=1';
  const mail = loginLinkMail('ru', url);
  expect(mail.text).toContain(url);
  expect(mail.text).toMatch(/^Здравствуйте!/);
  expect(mail.html).toMatch(/^<!DOCTYPE html>/);
  expect(mail.html).toContain('href="https://hub.example.test/ru/login/link?token=abc&amp;x=1"');
  expect(mail.html).toContain('https://hub.example.test/brand/logo/smartup-logo-light-bg.png');
});

test('подтверждение неопознанному: в теме и тексте только номер, без темы письма отправителя (угроза T32, итоговая проверка M4, I4)', async () => {
  const common = { hubUrl: 'https://hub.example.test', supportAddress: 'support@smartup24.com' };
  const bait = 'Доступ заблокирован, звоните +998 90 123 45 67';
  for (const locale of LOCALES) {
    const ack = await renderMail('unidentified_ack', locale, { template: 'unidentified_ack', number: 1061, title: bait, ...common } as MailData);
    expect(ack.subject).toMatch(/^\[SUP-1061\] /);
    for (const part of [ack.subject, ack.text, ack.html]) {
      expect(part).not.toContain('123 45 67');
      expect(part).not.toContain('заблокирован');
    }
  }
});

test('письмо о закрытии автору несёт пять ссылок оценки; без адреса оценки и у дубля ссылок нет (FR-TK-11)', async () => {
  const rateUrl = 'https://hub.example.test/ru/rate?t=1042.aa.bb';
  for (const locale of LOCALES) {
    const mail = await renderMail('ticket_status', locale, { ...common, template: 'ticket_status', ...ticket, status: 'closed', rateUrl });
    for (const score of [1, 2, 3, 4, 5]) {
      expect(mail.html, locale).toContain(`href="${rateUrl.replace('&', '&amp;')}&amp;score=${score}"`);
      expect(mail.text, locale).toContain(`${score}: ${rateUrl}&score=${score}`);
    }
  }
  const plainClosed = await renderMail('ticket_status', 'ru', { ...common, template: 'ticket_status', ...ticket, status: 'closed' });
  expect(plainClosed.html).not.toContain('/rate?');
  const merged = await renderMail('ticket_status', 'ru', { ...common, template: 'ticket_status', ...ticket, status: 'closed', mergedInto: 7, rateUrl });
  expect(merged.html).not.toContain('/rate?');
  expect(merged.text).not.toContain('/rate?');
  const waiting = await renderMail('ticket_status', 'ru', { ...common, template: 'ticket_status', ...ticket, status: 'waiting_customer', rateUrl });
  expect(waiting.html).not.toContain('/rate?');
});

test('письмо дежурным о P1 не несёт тему обращения: только номер, организация и ссылка (решение владельца 24.11.2026)', async () => {
  for (const locale of LOCALES) {
    const mail = await renderMail('oncall_p1', locale, { ...common, ...SAMPLES.oncall_p1 });
    expect(mail.subject, locale).not.toContain(ticket.title);
    expect(mail.html, locale).not.toContain(ticket.title);
    expect(mail.text, locale).not.toContain(ticket.title);
    expect(mail.text, locale).toContain('SUP-1042');
    expect(mail.text, locale).toContain('ООО Клиент');
    expect(mail.html, locale).toContain('https://hub.example.test/ru/agent/tickets/1042');
  }
});
